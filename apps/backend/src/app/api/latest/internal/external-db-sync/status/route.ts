import { Prisma } from "@/generated/prisma/client";
import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { getSafeExternalPostgresClientOptions } from "@/lib/ssrf-protection/external-db-sync";
import { globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { traceSpan } from "@/utils/telemetry";
import { KnownErrors } from "@hexclave/shared";
import type { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import {
  adaptSchema,
  adminAuthTypeSchema,
  yupArray,
  yupBoolean,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError, errorToNiceString, throwErr } from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import { Client } from "pg";

const STALE_CLAIM_INTERVAL_MINUTES = 5;

const sequenceStatsSchema = yupObject({
  total: yupString().defined(),
  pending: yupString().defined(),
  null_sequence_id: yupString().defined(),
  min_sequence_id: yupString().nullable().defined(),
  max_sequence_id: yupString().nullable().defined(),
});

const deletedRowByTableSchema = yupObject({
  table_name: yupString().defined(),
  total: yupString().defined(),
  pending: yupString().defined(),
  null_sequence_id: yupString().defined(),
  min_sequence_id: yupString().nullable().defined(),
  max_sequence_id: yupString().nullable().defined(),
});

const externalDbMetadataSchema = yupObject({
  mapping_name: yupString().defined(),
  last_synced_sequence_id: yupString().defined(),
  updated_at_millis: yupNumber().nullable().defined(),
});

const externalDbMappingStatusSchema = yupObject({
  mapping_id: yupString().defined(),
  internal_max_sequence_id: yupString().nullable().defined(),
  last_synced_sequence_id: yupString().nullable().defined(),
  updated_at_millis: yupNumber().nullable().defined(),
  backlog: yupString().nullable().defined(),
});

const externalDbSchema = yupObject({
  id: yupString().defined(),
  type: yupString().defined(),
  connection: yupObject({
    redacted: yupString().nullable().defined(),
    host: yupString().nullable().defined(),
    port: yupNumber().nullable().defined(),
    database: yupString().nullable().defined(),
    user: yupString().nullable().defined(),
  }).defined(),
  status: yupString().oneOf(["ok", "error"]).defined(),
  error: yupString().nullable().defined(),
  metadata: yupArray(externalDbMetadataSchema).defined(),
  users_table: yupObject({
    exists: yupBoolean().defined(),
    total_rows: yupString().nullable().defined(),
    min_signed_up_at_millis: yupNumber().nullable().defined(),
    max_signed_up_at_millis: yupNumber().nullable().defined(),
  }).defined(),
  mapping_status: yupArray(externalDbMappingStatusSchema).defined(),
});

const mappingSchema = yupObject({
  mapping_id: yupString().defined(),
  internal_min_sequence_id: yupString().nullable().defined(),
  internal_max_sequence_id: yupString().nullable().defined(),
  internal_pending_count: yupString().defined(),
});

const globalSchema = yupObject({
  tenancies_total: yupString().defined(),
  tenancies_with_db_sync: yupString().defined(),
  sequencer: yupObject({
    project_users: sequenceStatsSchema.defined(),
    contact_channels: sequenceStatsSchema.defined(),
    teams: sequenceStatsSchema.defined(),
    team_members: sequenceStatsSchema.defined(),
    team_permissions: sequenceStatsSchema.defined(),
    team_invitations: sequenceStatsSchema.defined(),
    email_outboxes: sequenceStatsSchema.defined(),
    project_permissions: sequenceStatsSchema.defined(),
    notification_preferences: sequenceStatsSchema.defined(),
    refresh_tokens: sequenceStatsSchema.defined(),
    connected_accounts: sequenceStatsSchema.defined(),
    deleted_rows: sequenceStatsSchema.shape({
      by_table: yupArray(deletedRowByTableSchema).defined(),
    }).defined(),
  }).defined(),
  poller: yupObject({
    total: yupString().defined(),
    pending: yupString().defined(),
    in_flight: yupString().defined(),
    stale: yupString().defined(),
    oldest_created_at_millis: yupNumber().nullable().defined(),
    newest_created_at_millis: yupNumber().nullable().defined(),
  }).defined(),
  sync_engine: yupObject({
    mappings: yupArray(mappingSchema).defined(),
  }).defined(),
});

const responseSchema = yupObject({
  statusCode: yupNumber().oneOf([200]).defined(),
  bodyType: yupString().oneOf(["json"]).defined(),
  body: yupObject({
    ok: yupBoolean().defined(),
    generated_at_millis: yupNumber().defined(),
    global: globalSchema.nullable().defined(),
    tenancy: yupObject({
      id: yupString().defined(),
      project_id: yupString().defined(),
      branch_id: yupString().defined(),
    }).defined(),
    sequencer: yupObject({
      project_users: sequenceStatsSchema.defined(),
      contact_channels: sequenceStatsSchema.defined(),
      teams: sequenceStatsSchema.defined(),
      team_members: sequenceStatsSchema.defined(),
      team_permissions: sequenceStatsSchema.defined(),
      team_invitations: sequenceStatsSchema.defined(),
      email_outboxes: sequenceStatsSchema.defined(),
      project_permissions: sequenceStatsSchema.defined(),
      notification_preferences: sequenceStatsSchema.defined(),
      refresh_tokens: sequenceStatsSchema.defined(),
      connected_accounts: sequenceStatsSchema.defined(),
      deleted_rows: sequenceStatsSchema.shape({
        by_table: yupArray(deletedRowByTableSchema).defined(),
      }).defined(),
    }).defined(),
    poller: yupObject({
      total: yupString().defined(),
      pending: yupString().defined(),
      in_flight: yupString().defined(),
      stale: yupString().defined(),
      oldest_created_at_millis: yupNumber().nullable().defined(),
      newest_created_at_millis: yupNumber().nullable().defined(),
    }).defined(),
    sync_engine: yupObject({
      mappings: yupArray(mappingSchema).defined(),
      external_databases: yupArray(externalDbSchema).defined(),
    }).defined(),
  }).defined(),
});

type SequenceStatsRow = {
  total: unknown,
  pending: unknown,
  null_sequence_id: unknown,
  min_sequence_id: unknown,
  max_sequence_id: unknown,
};

type DeletedRowStatsRow = SequenceStatsRow & {
  table_name: string,
};

type OutgoingStatsRow = {
  total: unknown,
  pending: unknown,
  in_flight: unknown,
  stale: unknown,
  oldest_created_at: unknown,
  newest_created_at: unknown,
};

type ExternalDbMetadataRow = {
  mapping_name: string,
  last_synced_sequence_id: unknown,
  updated_at: unknown,
};

type UsersTableStatsRow = {
  total_rows: unknown,
  min_signed_up_at: unknown,
  max_signed_up_at: unknown,
};

type CountRow = {
  total: unknown,
};

type SequenceStats = ReturnType<typeof formatSequenceStats>;
type DeletedRowSummary = SequenceStats & { table_name: string };

function toBigIntString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value).toString();
  if (typeof value === "string") return value;
  return null;
}

function parseBigIntStringOrThrow(value: unknown, label: string): string {
  return toBigIntString(value) ?? throwErr(`Expected ${label} to be a bigint-compatible value.`, { value });
}

function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
  return null;
}

function addBigIntStrings(a: string | null | undefined, b: string | null | undefined): string {
  const first = a ? BigInt(a) : 0n;
  const second = b ? BigInt(b) : 0n;
  return (first + second).toString();
}

function minBigIntString(values: Array<string | null | undefined>): string | null {
  let minValue: bigint | null = null;
  for (const value of values) {
    if (!value) continue;
    const parsed = BigInt(value);
    if (minValue === null || parsed < minValue) {
      minValue = parsed;
    }
  }
  return minValue === null ? null : minValue.toString();
}

function maxBigIntString(values: Array<string | null | undefined>): string | null {
  let maxValue: bigint | null = null;
  for (const value of values) {
    if (!value) continue;
    const parsed = BigInt(value);
    if (maxValue === null || parsed > maxValue) {
      maxValue = parsed;
    }
  }
  return maxValue === null ? null : maxValue.toString();
}

function buildMappingInternalStats(
  stats: {
    projectUsersStats: SequenceStats,
    contactChannelStats: SequenceStats,
    teamStats: SequenceStats,
    teamMemberStats: SequenceStats,
    teamPermissionStats: SequenceStats,
    teamInvitationStats: SequenceStats,
    emailOutboxStats: SequenceStats,
    projectPermissionStats: SequenceStats,
    notificationPreferenceStats: SequenceStats,
    refreshTokenStats: SequenceStats,
    connectedAccountStats: SequenceStats,
  },
  deletedRowsByTable: DeletedRowSummary[],
) {
  const mappingInternalStats = new Map<string, {
    mapping_id: string,
    internal_min_sequence_id: string | null,
    internal_max_sequence_id: string | null,
    internal_pending_count: string,
  }>();

  function addMapping(mappingId: string, primaryStats: SequenceStats, deletedRowTableName: string | null) {
    const deletedStats = deletedRowTableName
      ? deletedRowsByTable.find((row) => row.table_name === deletedRowTableName) ?? null
      : null;
    mappingInternalStats.set(mappingId, {
      mapping_id: mappingId,
      internal_min_sequence_id: minBigIntString([primaryStats.min_sequence_id, deletedStats?.min_sequence_id]),
      internal_max_sequence_id: maxBigIntString([primaryStats.max_sequence_id, deletedStats?.max_sequence_id]),
      internal_pending_count: addBigIntStrings(primaryStats.pending, deletedStats?.pending),
    });
  }

  addMapping("users", stats.projectUsersStats, "ProjectUser");
  addMapping("contact_channels", stats.contactChannelStats, "ContactChannel");
  addMapping("teams", stats.teamStats, "Team");
  addMapping("team_member_profiles", stats.teamMemberStats, "TeamMember");
  addMapping("team_permissions", stats.teamPermissionStats, "TeamMemberDirectPermission");
  addMapping("team_invitations", stats.teamInvitationStats, "VerificationCode_TEAM_INVITATION");
  addMapping("email_outboxes", stats.emailOutboxStats, "EmailOutbox");
  addMapping("project_permissions", stats.projectPermissionStats, "ProjectUserDirectPermission");
  addMapping("notification_preferences", stats.notificationPreferenceStats, "UserNotificationPreference");
  addMapping("refresh_tokens", stats.refreshTokenStats, "ProjectUserRefreshToken");
  addMapping("connected_accounts", stats.connectedAccountStats, "ProjectUserOAuthAccount");

  const mappings = Array.from(mappingInternalStats.values());
  const mappingStatuses = mappings.map((mapping) => ({
    mapping_id: mapping.mapping_id,
    internal_max_sequence_id: mapping.internal_max_sequence_id,
  }));

  return { mappings, mappingStatuses };
}

async function fetchInternalStats(tenancyId: string | null) {
  const tenancyWhere = tenancyId
    ? Prisma.sql`WHERE "tenancyId" = ${tenancyId}::uuid`
    : Prisma.sql``;

  const projectUserStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "ProjectUser"
    ${tenancyWhere}
  `).at(0) ?? throwErr("Project user stats query returned no rows.");

  const contactChannelStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "ContactChannel"
    ${tenancyWhere}
  `).at(0) ?? throwErr("Contact channel stats query returned no rows.");

  const teamStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "Team"
    ${tenancyWhere}
  `).at(0) ?? throwErr("Team stats query returned no rows.");

  const teamMemberStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "TeamMember"
    ${tenancyWhere}
  `).at(0) ?? throwErr("Team member stats query returned no rows.");

  const teamPermissionStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "TeamMemberDirectPermission"
    ${tenancyWhere}
  `).at(0) ?? throwErr("Team permission stats query returned no rows.");

  const teamInvitationStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "VerificationCode"
    ${tenancyId
      ? Prisma.sql`JOIN "Tenancy" ON "Tenancy"."projectId" = "VerificationCode"."projectId" AND "Tenancy"."branchId" = "VerificationCode"."branchId" WHERE "type" = 'TEAM_INVITATION' AND "Tenancy"."id" = ${tenancyId}::uuid`
      : Prisma.sql`WHERE "type" = 'TEAM_INVITATION'`}
  `).at(0) ?? throwErr("Team invitation stats query returned no rows.");

  const emailOutboxStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "EmailOutbox"
    ${tenancyWhere}
  `).at(0) ?? throwErr("Email outbox stats query returned no rows.");

  const projectPermissionStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "ProjectUserDirectPermission"
    ${tenancyWhere}
  `).at(0) ?? throwErr("Project permission stats query returned no rows.");

  const notificationPreferenceStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "UserNotificationPreference"
    ${tenancyWhere}
  `).at(0) ?? throwErr("Notification preference stats query returned no rows.");

  const refreshTokenStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "ProjectUserRefreshToken"
    ${tenancyWhere}
  `).at(0) ?? throwErr("Refresh token stats query returned no rows.");

  const connectedAccountStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "ProjectUserOAuthAccount"
    ${tenancyWhere}
  `).at(0) ?? throwErr("Connected account stats query returned no rows.");

  const deletedRowStatsRow = (await globalPrismaClient.$replica().$queryRaw<SequenceStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "DeletedRow"
    ${tenancyWhere}
  `).at(0) ?? throwErr("Deleted row stats query returned no rows.");

  const deletedRowsByTableRows = await globalPrismaClient.$replica().$queryRaw<DeletedRowStatsRow[]>`
    SELECT
      "tableName" AS "table_name",
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "sequenceId" IS NULL)::bigint AS "null_sequence_id",
      MIN("sequenceId") AS "min_sequence_id",
      MAX("sequenceId") AS "max_sequence_id"
    FROM "DeletedRow"
    ${tenancyWhere}
    GROUP BY "tableName"
    ORDER BY "tableName" ASC
  `;

  const outgoingTenancyFilter = tenancyId
    ? Prisma.sql`AND ("qstashOptions"->'body'->>'tenancyId') = ${tenancyId}`
    : Prisma.sql``;

  const outgoingStatsRow = (await globalPrismaClient.$replica().$queryRaw<OutgoingStatsRow[]>`
    SELECT
      COUNT(*)::bigint AS "total",
      COUNT(*) FILTER (WHERE "startedFulfillingAt" IS NULL)::bigint AS "pending",
      COUNT(*) FILTER (WHERE "startedFulfillingAt" IS NOT NULL)::bigint AS "in_flight",
      COUNT(*) FILTER (
        WHERE "startedFulfillingAt" < NOW() - (${STALE_CLAIM_INTERVAL_MINUTES} * INTERVAL '1 minute')
      )::bigint AS "stale",
      MIN("createdAt") AS "oldest_created_at",
      MAX("createdAt") AS "newest_created_at"
    FROM "OutgoingRequest"
    WHERE ("qstashOptions"->>'url') = '/api/latest/internal/external-db-sync/sync-engine'
    ${outgoingTenancyFilter}
  `).at(0) ?? throwErr("Outgoing request stats query returned no rows.");

  const projectUsersStats = formatSequenceStats(projectUserStatsRow);
  const contactChannelStats = formatSequenceStats(contactChannelStatsRow);
  const teamStats = formatSequenceStats(teamStatsRow);
  const teamMemberStats = formatSequenceStats(teamMemberStatsRow);
  const teamPermissionStats = formatSequenceStats(teamPermissionStatsRow);
  const teamInvitationStats = formatSequenceStats(teamInvitationStatsRow);
  const emailOutboxStats = formatSequenceStats(emailOutboxStatsRow);
  const projectPermissionStats = formatSequenceStats(projectPermissionStatsRow);
  const notificationPreferenceStats = formatSequenceStats(notificationPreferenceStatsRow);
  const refreshTokenStats = formatSequenceStats(refreshTokenStatsRow);
  const connectedAccountStats = formatSequenceStats(connectedAccountStatsRow);
  const deletedRowStats = formatSequenceStats(deletedRowStatsRow);

  const deletedRowsByTable = deletedRowsByTableRows.map((row) => ({
    table_name: row.table_name,
    ...formatSequenceStats(row),
  }));

  const { mappings, mappingStatuses } = buildMappingInternalStats({
    projectUsersStats,
    contactChannelStats,
    teamStats,
    teamMemberStats,
    teamPermissionStats,
    teamInvitationStats,
    emailOutboxStats,
    projectPermissionStats,
    notificationPreferenceStats,
    refreshTokenStats,
    connectedAccountStats,
  }, deletedRowsByTable);

  return {
    projectUsersStats,
    contactChannelStats,
    teamStats,
    teamMemberStats,
    teamPermissionStats,
    teamInvitationStats,
    emailOutboxStats,
    projectPermissionStats,
    notificationPreferenceStats,
    refreshTokenStats,
    connectedAccountStats,
    deletedRowStats,
    deletedRowsByTable,
    outgoingStatsRow,
    mappings,
    mappingStatuses,
  };
}

function formatPollerStats(outgoingStats: OutgoingStatsRow) {
  return {
    total: parseBigIntStringOrThrow(outgoingStats.total, "outgoing total"),
    pending: parseBigIntStringOrThrow(outgoingStats.pending, "outgoing pending"),
    in_flight: parseBigIntStringOrThrow(outgoingStats.in_flight, "outgoing in_flight"),
    stale: parseBigIntStringOrThrow(outgoingStats.stale, "outgoing stale"),
    oldest_created_at_millis: toMillis(outgoingStats.oldest_created_at),
    newest_created_at_millis: toMillis(outgoingStats.newest_created_at),
  };
}

function formatSequenceStats(row: SequenceStatsRow) {
  return {
    total: parseBigIntStringOrThrow(row.total, "sequence stats total"),
    pending: parseBigIntStringOrThrow(row.pending, "sequence stats pending"),
    null_sequence_id: parseBigIntStringOrThrow(row.null_sequence_id, "sequence stats null_sequence_id"),
    min_sequence_id: toBigIntString(row.min_sequence_id),
    max_sequence_id: toBigIntString(row.max_sequence_id),
  };
}

function formatError(error: unknown): string {
  return errorToNiceString(error);
}

function parseConnectionString(connectionString: string | null | undefined) {
  if (!connectionString) {
    return {
      redacted: null,
      host: null,
      port: null,
      database: null,
      user: null,
    };
  }

  const parsed = Result.fromThrowing(() => new URL(connectionString));
  if (parsed.status === "error") {
    return {
      redacted: null,
      host: null,
      port: null,
      database: null,
      user: null,
    };
  }

  const url = parsed.data;
  const user = url.username ? decodeURIComponent(url.username) : null;
  const host = url.hostname || null;
  const port = url.port ? Number.parseInt(url.port, 10) : null;
  const database = url.pathname ? url.pathname.replace(/^\//, "") : null;
  const redacted = `${url.protocol}//${url.username ? encodeURIComponent(url.username) : ""}${url.username ? ":" : ""}${url.password ? "***" : ""}${url.username ? "@" : ""}${url.hostname}${url.port ? ":" + url.port : ""}${url.pathname}${url.search}`;

  return {
    redacted,
    host,
    port: Number.isFinite(port ?? NaN) ? port : null,
    database,
    user,
  };
}

type ClickhouseMetadataRow = {
  mapping_name: string,
  last_synced_sequence_id: string,
  updated_at: string,
};

type ClickhouseUsersStatsRow = {
  total_rows: string,
  min_signed_up_at: string | null,
  max_signed_up_at: string | null,
};

async function fetchClickhouseDatabaseStatus(
  dbId: string,
  mappingStatuses: Array<{
    mapping_id: string,
    internal_max_sequence_id: string | null,
  }>,
  tenancy: {
    id: string,
    projectId: string,
    branchId: string,
  },
) {
  const clickhouseUrl = getEnvVariable("STACK_CLICKHOUSE_URL", "");
  const connection = parseConnectionString(clickhouseUrl);
  if (!clickhouseUrl) {
    return {
      id: dbId,
      type: "clickhouse",
      connection,
      status: "error" as const,
      error: "Missing STACK_CLICKHOUSE_URL",
      metadata: [],
      users_table: {
        exists: false,
        total_rows: null,
        min_signed_up_at_millis: null,
        max_signed_up_at_millis: null,
      },
      mapping_status: mappingStatuses.map((mapping) => ({
        mapping_id: mapping.mapping_id,
        internal_max_sequence_id: mapping.internal_max_sequence_id,
        last_synced_sequence_id: null,
        updated_at_millis: null,
        backlog: null,
      })),
    };
  }

  const client = getClickhouseAdminClient();
  let metadata: ClickhouseMetadataRow[] = [];
  let usersStats: ClickhouseUsersStatsRow | null = null;
  try {
    const metadataResult = await Result.fromPromise(client.query({
      query: `
        SELECT
          mapping_name,
          toString(argMax(last_synced_sequence_id, updated_at)) AS last_synced_sequence_id,
          toString(max(updated_at)) AS updated_at
        FROM analytics_internal._stack_sync_metadata
        WHERE tenancy_id = {tenancy_id:UUID}
        GROUP BY mapping_name
      `,
      query_params: {
        tenancy_id: tenancy.id,
      },
      format: "JSONEachRow",
    }));
    if (metadataResult.status === "error") {
      return {
        id: dbId,
        type: "clickhouse",
        connection,
        status: "error" as const,
        error: formatError(metadataResult.error),
        metadata: [],
        users_table: {
          exists: false,
          total_rows: null,
          min_signed_up_at_millis: null,
          max_signed_up_at_millis: null,
        },
        mapping_status: mappingStatuses.map((mapping) => ({
          mapping_id: mapping.mapping_id,
          internal_max_sequence_id: mapping.internal_max_sequence_id,
          last_synced_sequence_id: null,
          updated_at_millis: null,
          backlog: null,
        })),
      };
    }
    const metadataRows = await metadataResult.data.json<ClickhouseMetadataRow>();
    metadata = metadataRows;

    const usersStatsResult = await Result.fromPromise(client.query({
      query: `
        SELECT
          toString(count()) AS total_rows,
          toString(min(signed_up_at)) AS min_signed_up_at,
          toString(max(signed_up_at)) AS max_signed_up_at
        FROM analytics_internal.users FINAL
        WHERE project_id = {project_id:String}
          AND branch_id = {branch_id:String}
          AND sync_is_deleted = 0
      `,
      query_params: {
        project_id: tenancy.projectId,
        branch_id: tenancy.branchId,
      },
      format: "JSONEachRow",
    }));
    if (usersStatsResult.status === "error") {
      return {
        id: dbId,
        type: "clickhouse",
        connection,
        status: "error" as const,
        error: formatError(usersStatsResult.error),
        metadata: metadata.map((row) => ({
          mapping_name: row.mapping_name,
          last_synced_sequence_id: toBigIntString(row.last_synced_sequence_id) ?? "-1",
          updated_at_millis: toMillis(row.updated_at),
        })),
        users_table: {
          exists: false,
          total_rows: null,
          min_signed_up_at_millis: null,
          max_signed_up_at_millis: null,
        },
        mapping_status: mappingStatuses.map((mapping) => ({
          mapping_id: mapping.mapping_id,
          internal_max_sequence_id: mapping.internal_max_sequence_id,
          last_synced_sequence_id: null,
          updated_at_millis: null,
          backlog: null,
        })),
      };
    }

    const usersStatsRows = await usersStatsResult.data.json<ClickhouseUsersStatsRow>();
    usersStats = usersStatsRows[0] ?? {
      total_rows: "0",
      min_signed_up_at: null,
      max_signed_up_at: null,
    };
  } finally {
    await Result.fromPromise(client.close());
  }

  const metadataMap = new Map<string, { last_synced_sequence_id: string | null, updated_at_millis: number | null }>();
  const formattedMetadata = metadata.map((row) => {
    const lastSynced = toBigIntString(row.last_synced_sequence_id) ?? "-1";
    const updatedAt = toMillis(row.updated_at);
    metadataMap.set(row.mapping_name, { last_synced_sequence_id: lastSynced, updated_at_millis: updatedAt });
    return {
      mapping_name: row.mapping_name,
      last_synced_sequence_id: lastSynced,
      updated_at_millis: updatedAt,
    };
  });

  const mappingStatus = mappingStatuses.map((mapping) => {
    const external = metadataMap.get(mapping.mapping_id);
    const lastSynced = external?.last_synced_sequence_id ?? null;
    const updatedAt = external?.updated_at_millis ?? null;
    let backlog: string | null = null;
    if (mapping.internal_max_sequence_id && lastSynced) {
      backlog = (BigInt(mapping.internal_max_sequence_id) - BigInt(lastSynced)).toString();
    }
    return {
      mapping_id: mapping.mapping_id,
      internal_max_sequence_id: mapping.internal_max_sequence_id,
      last_synced_sequence_id: lastSynced,
      updated_at_millis: updatedAt,
      backlog,
    };
  });

  return {
    id: dbId,
    type: "clickhouse",
    connection,
    status: "ok" as const,
    error: null,
    metadata: formattedMetadata,
    users_table: {
      exists: true,
      total_rows: toBigIntString(usersStats.total_rows),
      min_signed_up_at_millis: toMillis(usersStats.min_signed_up_at),
      max_signed_up_at_millis: toMillis(usersStats.max_signed_up_at),
    },
    mapping_status: mappingStatus,
  };
}

async function fetchExternalDatabaseStatus(
  dbId: string,
  dbConfig: CompleteConfig["dbSync"]["externalDatabases"][string],
  mappingStatuses: Array<{
    mapping_id: string,
    internal_max_sequence_id: string | null,
  }>,
  tenancy: {
    id: string,
    projectId: string,
    branchId: string,
  },
) {
  const connection = parseConnectionString(dbConfig.connectionString ?? null);

  if (dbConfig.type !== "postgres") {
    return {
      id: dbId,
      type: String(dbConfig.type),
      connection,
      status: "error" as const,
      error: `Unsupported database type: ${String(dbConfig.type)}`,
      metadata: [],
      users_table: {
        exists: false,
        total_rows: null,
        min_signed_up_at_millis: null,
        max_signed_up_at_millis: null,
      },
      mapping_status: mappingStatuses.map((mapping) => ({
        mapping_id: mapping.mapping_id,
        internal_max_sequence_id: mapping.internal_max_sequence_id,
        last_synced_sequence_id: null,
        updated_at_millis: null,
        backlog: null,
      })),
    };
  }

  if (!dbConfig.connectionString) {
    return {
      id: dbId,
      type: dbConfig.type,
      connection,
      status: "error" as const,
      error: "Missing connection string",
      metadata: [],
      users_table: {
        exists: false,
        total_rows: null,
        min_signed_up_at_millis: null,
        max_signed_up_at_millis: null,
      },
      mapping_status: mappingStatuses.map((mapping) => ({
        mapping_id: mapping.mapping_id,
        internal_max_sequence_id: mapping.internal_max_sequence_id,
        last_synced_sequence_id: null,
        updated_at_millis: null,
        backlog: null,
      })),
    };
  }

  const clientOptionsResult = await Result.fromPromise(getSafeExternalPostgresClientOptions(dbConfig.connectionString));
  if (clientOptionsResult.status === "error") {
    return {
      id: dbId,
      type: dbConfig.type,
      connection,
      status: "error" as const,
      error: formatError(clientOptionsResult.error),
      metadata: [],
      users_table: {
        exists: false,
        total_rows: null,
        min_signed_up_at_millis: null,
        max_signed_up_at_millis: null,
      },
      mapping_status: mappingStatuses.map((mapping) => ({
        mapping_id: mapping.mapping_id,
        internal_max_sequence_id: mapping.internal_max_sequence_id,
        last_synced_sequence_id: null,
        updated_at_millis: null,
        backlog: null,
      })),
    };
  }

  const client = new Client(clientOptionsResult.data);
  // node-postgres treats an EventEmitter "error" without a listener as fatal to
  // the whole process; report connection loss to the error sink instead.
  client.on("error", (error) => captureError("external-db-status-client", error));
  const connectResult = await Result.fromPromise(client.connect());
  if (connectResult.status === "error") {
    await Result.fromPromise(client.end());
    return {
      id: dbId,
      type: dbConfig.type,
      connection,
      status: "error" as const,
      error: formatError(connectResult.error),
      metadata: [],
      users_table: {
        exists: false,
        total_rows: null,
        min_signed_up_at_millis: null,
        max_signed_up_at_millis: null,
      },
      mapping_status: mappingStatuses.map((mapping) => ({
        mapping_id: mapping.mapping_id,
        internal_max_sequence_id: mapping.internal_max_sequence_id,
        last_synced_sequence_id: null,
        updated_at_millis: null,
        backlog: null,
      })),
    };
  }

  let metadata: ExternalDbMetadataRow[] = [];
  let metadataExists = false;
  let usersExists = false;
  let usersStats: UsersTableStatsRow | null = null;

  try {
    const metadataExistsResult = await Result.fromPromise(client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = '_stack_sync_metadata'
      ) AS "exists";
    `));
    if (metadataExistsResult.status === "error") {
      return {
        id: dbId,
        type: dbConfig.type,
        connection,
        status: "error" as const,
        error: formatError(metadataExistsResult.error),
        metadata: [],
        users_table: {
          exists: false,
          total_rows: null,
          min_signed_up_at_millis: null,
          max_signed_up_at_millis: null,
        },
        mapping_status: mappingStatuses.map((mapping) => ({
          mapping_id: mapping.mapping_id,
          internal_max_sequence_id: mapping.internal_max_sequence_id,
          last_synced_sequence_id: null,
          updated_at_millis: null,
          backlog: null,
        })),
      };
    }
    metadataExists = metadataExistsResult.data.rows[0]?.exists === true;

    const usersExistsResult = await Result.fromPromise(client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'users'
      ) AS "exists";
    `));
    if (usersExistsResult.status === "error") {
      return {
        id: dbId,
        type: dbConfig.type,
        connection,
        status: "error" as const,
        error: formatError(usersExistsResult.error),
        metadata: [],
        users_table: {
          exists: false,
          total_rows: null,
          min_signed_up_at_millis: null,
          max_signed_up_at_millis: null,
        },
        mapping_status: mappingStatuses.map((mapping) => ({
          mapping_id: mapping.mapping_id,
          internal_max_sequence_id: mapping.internal_max_sequence_id,
          last_synced_sequence_id: null,
          updated_at_millis: null,
          backlog: null,
        })),
      };
    }
    usersExists = usersExistsResult.data.rows[0]?.exists === true;

    if (metadataExists) {
      const metadataResult = await Result.fromPromise(client.query<ExternalDbMetadataRow>(`
        SELECT "mapping_name", "last_synced_sequence_id", "updated_at"
        FROM "_stack_sync_metadata"
        ORDER BY "mapping_name" ASC;
      `));
      if (metadataResult.status === "error") {
        return {
          id: dbId,
          type: dbConfig.type,
          connection,
          status: "error" as const,
          error: formatError(metadataResult.error),
          metadata: [],
          users_table: {
            exists: usersExists,
            total_rows: null,
            min_signed_up_at_millis: null,
            max_signed_up_at_millis: null,
          },
          mapping_status: mappingStatuses.map((mapping) => ({
            mapping_id: mapping.mapping_id,
            internal_max_sequence_id: mapping.internal_max_sequence_id,
            last_synced_sequence_id: null,
            updated_at_millis: null,
            backlog: null,
          })),
        };
      }
      metadata = metadataResult.data.rows;
    }

    if (usersExists) {
      const usersStatsResult = await Result.fromPromise(client.query<UsersTableStatsRow>(`
        SELECT
          COUNT(*)::bigint AS "total_rows",
          MIN("signed_up_at") AS "min_signed_up_at",
          MAX("signed_up_at") AS "max_signed_up_at"
        FROM "users";
      `));
      if (usersStatsResult.status === "error") {
        return {
          id: dbId,
          type: dbConfig.type,
          connection,
          status: "error" as const,
          error: formatError(usersStatsResult.error),
          metadata: metadata.map((row) => ({
            mapping_name: row.mapping_name,
            last_synced_sequence_id: toBigIntString(row.last_synced_sequence_id) ?? "-1",
            updated_at_millis: toMillis(row.updated_at),
          })),
          users_table: {
            exists: usersExists,
            total_rows: null,
            min_signed_up_at_millis: null,
            max_signed_up_at_millis: null,
          },
          mapping_status: mappingStatuses.map((mapping) => ({
            mapping_id: mapping.mapping_id,
            internal_max_sequence_id: mapping.internal_max_sequence_id,
            last_synced_sequence_id: null,
            updated_at_millis: null,
            backlog: null,
          })),
        };
      }
      usersStats = usersStatsResult.data.rows[0] ?? null;
    }
  } finally {
    await Result.fromPromise(client.end());
  }

  const metadataMap = new Map<string, { last_synced_sequence_id: string | null, updated_at_millis: number | null }>();
  const formattedMetadata = metadata.map((row) => {
    const lastSynced = toBigIntString(row.last_synced_sequence_id) ?? "-1";
    const updatedAt = toMillis(row.updated_at);
    metadataMap.set(row.mapping_name, { last_synced_sequence_id: lastSynced, updated_at_millis: updatedAt });
    return {
      mapping_name: row.mapping_name,
      last_synced_sequence_id: lastSynced,
      updated_at_millis: updatedAt,
    };
  });

  const mappingStatus = mappingStatuses.map((mapping) => {
    const external = metadataMap.get(mapping.mapping_id);
    const lastSynced = external?.last_synced_sequence_id ?? null;
    const updatedAt = external?.updated_at_millis ?? null;
    let backlog: string | null = null;
    if (mapping.internal_max_sequence_id && lastSynced) {
      backlog = (BigInt(mapping.internal_max_sequence_id) - BigInt(lastSynced)).toString();
    }
    return {
      mapping_id: mapping.mapping_id,
      internal_max_sequence_id: mapping.internal_max_sequence_id,
      last_synced_sequence_id: lastSynced,
      updated_at_millis: updatedAt,
      backlog,
    };
  });

  return {
    id: dbId,
    type: dbConfig.type,
    connection,
    status: "ok" as const,
    error: null,
    metadata: formattedMetadata,
    users_table: {
      exists: usersExists,
      total_rows: toBigIntString(usersStats?.total_rows ?? null),
      min_signed_up_at_millis: toMillis(usersStats?.min_signed_up_at ?? null),
      max_signed_up_at_millis: toMillis(usersStats?.max_signed_up_at ?? null),
    },
    mapping_status: mappingStatus,
  };
}

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "External DB sync status",
    description: "Returns sequencing, queue, and external sync progress for the current tenancy. Optional global aggregate when scope=all.",
    tags: ["External DB Sync"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema,
      tenancy: adaptSchema,
    }).defined(),
    query: yupObject({
      scope: yupString().oneOf(["tenancy", "all"]).default("tenancy"),
    }).defined(),
    method: yupString().oneOf(["GET"]).defined(),
  }),
  response: responseSchema,
  handler: async ({ auth, query }) => {
    return await traceSpan({
      description: "external-db-sync.status",
      attributes: {
        "stack.external-db-sync.scope": query.scope,
        "stack.external-db-sync.tenancy-id": auth.tenancy.id,
      },
    }, async (span) => {
      if (auth.tenancy.project.id !== "internal") {
        throw new KnownErrors.ExpectedInternalProject();
      }
      const tenancyId = auth.tenancy.id;

      const shouldIncludeGlobal = query.scope === "all";
      span.setAttribute("stack.external-db-sync.include-global", shouldIncludeGlobal);

      const currentStats = await traceSpan({
        description: "external-db-sync.status.fetchInternalStats",
        attributes: {
          "stack.external-db-sync.scope": shouldIncludeGlobal ? "all" : "tenancy",
        },
      }, async () => shouldIncludeGlobal ? await fetchInternalStats(null) : await fetchInternalStats(tenancyId));

      const globalStats = shouldIncludeGlobal ? currentStats : null;
      const globalTenanciesCount = shouldIncludeGlobal
        ? (await globalPrismaClient.$replica().$queryRaw<CountRow[]>`
            SELECT COUNT(*)::bigint AS "total"
            FROM "Tenancy"
          `).at(0) ?? throwErr("Tenancy count query returned no rows.")
        : null;
      const globalDbSyncCount = shouldIncludeGlobal
        ? (await globalPrismaClient.$replica().$queryRaw<CountRow[]>`
            SELECT COUNT(*)::bigint AS "total"
            FROM "EnvironmentConfigOverride"
            WHERE ("config"->'dbSync'->'externalDatabases') IS NOT NULL
          `).at(0) ?? throwErr("DB sync config count query returned no rows.")
        : null;

      const externalDbStatuses = shouldIncludeGlobal
        ? []
        : await traceSpan("external-db-sync.status.fetchExternalDatabaseStatuses", async (externalSpan) => {
          const configStatuses = await Promise.all(
            Object.entries(
              auth.tenancy.config.dbSync.externalDatabases as CompleteConfig["dbSync"]["externalDatabases"],
            ).map(([dbId, dbConfig]) => fetchExternalDatabaseStatus(dbId, dbConfig, currentStats.mappingStatuses, {
              id: auth.tenancy.id,
              projectId: auth.tenancy.project.id,
              branchId: auth.tenancy.branchId,
            })),
          );

          const statuses: Array<Awaited<ReturnType<typeof fetchClickhouseDatabaseStatus>> | Awaited<ReturnType<typeof fetchExternalDatabaseStatus>>> = [...configStatuses];

          // Always include ClickHouse status if STACK_CLICKHOUSE_URL is set
          const clickhouseUrl = getEnvVariable("STACK_CLICKHOUSE_URL", "");
          if (clickhouseUrl) {
            const clickhouseStatus = await fetchClickhouseDatabaseStatus("clickhouse", currentStats.mappingStatuses, {
              id: auth.tenancy.id,
              projectId: auth.tenancy.project.id,
              branchId: auth.tenancy.branchId,
            });
            statuses.push(clickhouseStatus);
          }

          externalSpan.setAttribute("stack.external-db-sync.external-db-count", statuses.length);
          return statuses;
        });

      const outgoingStats = currentStats.outgoingStatsRow;

      return {
        statusCode: 200 as const,
        bodyType: "json" as const,
        body: {
          ok: true,
          generated_at_millis: Date.now(),
          global: shouldIncludeGlobal && globalStats && globalTenanciesCount && globalDbSyncCount ? {
            tenancies_total: parseBigIntStringOrThrow(globalTenanciesCount.total, "tenancies total"),
            tenancies_with_db_sync: parseBigIntStringOrThrow(globalDbSyncCount.total, "tenancies with db sync"),
            sequencer: {
              project_users: globalStats.projectUsersStats,
              contact_channels: globalStats.contactChannelStats,
              teams: globalStats.teamStats,
              team_members: globalStats.teamMemberStats,
              team_permissions: globalStats.teamPermissionStats,
              team_invitations: globalStats.teamInvitationStats,
              email_outboxes: globalStats.emailOutboxStats,
              project_permissions: globalStats.projectPermissionStats,
              notification_preferences: globalStats.notificationPreferenceStats,
              refresh_tokens: globalStats.refreshTokenStats,
              connected_accounts: globalStats.connectedAccountStats,
              deleted_rows: {
                ...globalStats.deletedRowStats,
                by_table: globalStats.deletedRowsByTable,
              },
            },
            poller: formatPollerStats(globalStats.outgoingStatsRow),
            sync_engine: {
              mappings: globalStats.mappings,
            },
          } : null,
          tenancy: {
            id: tenancyId,
            project_id: auth.tenancy.project.id,
            branch_id: auth.tenancy.branchId,
          },
          sequencer: {
            project_users: currentStats.projectUsersStats,
            contact_channels: currentStats.contactChannelStats,
            teams: currentStats.teamStats,
            team_members: currentStats.teamMemberStats,
            team_permissions: currentStats.teamPermissionStats,
            team_invitations: currentStats.teamInvitationStats,
            email_outboxes: currentStats.emailOutboxStats,
            project_permissions: currentStats.projectPermissionStats,
            notification_preferences: currentStats.notificationPreferenceStats,
            refresh_tokens: currentStats.refreshTokenStats,
            connected_accounts: currentStats.connectedAccountStats,
            deleted_rows: {
              ...currentStats.deletedRowStats,
              by_table: currentStats.deletedRowsByTable,
            },
          },
          poller: formatPollerStats(outgoingStats),
          sync_engine: {
            mappings: currentStats.mappings,
            external_databases: externalDbStatuses,
          },
        },
      };
    });
  },
});

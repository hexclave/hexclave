import { Tenancy } from "@/lib/tenancies";
import type { PrismaTransaction } from "@/lib/types";
import { getPrismaClientForTenancy, PrismaClientWithReplica } from "@/prisma-client";
import { Prisma } from "@/generated/prisma/client";
import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { getSafeExternalPostgresClientOptions } from "@/lib/ssrf-protection/external-db-sync";
import { DEFAULT_DB_SYNC_MAPPINGS } from "@hexclave/shared/dist/config/db-sync-mappings";
import type { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { captureError, HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { omit } from "@hexclave/shared/dist/utils/objects";
import { Result } from "@hexclave/shared/dist/utils/results";
import type { ClickHouseClient } from "@clickhouse/client";
import { Client } from 'pg';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCHES_PER_MAPPING_ENV = "STACK_EXTERNAL_DB_SYNC_MAX_BATCHES_PER_MAPPING";

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HexclaveAssertionError(`${label} must be a non-empty string.`);
  }
}

function assertUuid(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (!UUID_REGEX.test(value)) {
    throw new HexclaveAssertionError(`${label} must be a valid UUID. Received: ${JSON.stringify(value)}`);
  }
}

type ExternalDbSyncClient = PrismaTransaction | PrismaClientWithReplica;

type ExternalDbSyncTarget =
  | {
    tableName: "ProjectUser",
    tenancyId: string,
    projectUserId: string,
  }
  | {
    tableName: "EmailOutbox",
    tenancyId: string,
    emailOutboxId: string,
  }
  | {
    tableName: "ContactChannel",
    tenancyId: string,
    projectUserId: string,
    contactChannelId: string,
  }
  | {
    tableName: "Team",
    tenancyId: string,
    teamId: string,
  }
  | {
    tableName: "TeamMember",
    tenancyId: string,
    projectUserId: string,
    teamId: string,
  }
  | {
    tableName: "TeamMemberDirectPermission",
    tenancyId: string,
    permissionDbId: string,
  }
  | {
    tableName: "ProjectUserDirectPermission",
    tenancyId: string,
    permissionDbId: string,
  }
  | {
    tableName: "UserNotificationPreference",
    tenancyId: string,
    notificationPreferenceId: string,
  }
  | {
    tableName: "VerificationCode_TEAM_INVITATION",
    tenancyId: string,
    verificationCodeProjectId: string,
    verificationCodeBranchId: string,
    verificationCodeId: string,
  }
  | {
    tableName: "ProjectUserRefreshToken",
    tenancyId: string,
    refreshTokenId: string,
  }
  | {
    tableName: "ProjectUserOAuthAccount",
    tenancyId: string,
    oauthAccountId: string,
  };

type ExternalDbType = NonNullable<NonNullable<CompleteConfig["dbSync"]["externalDatabases"][string]>["type"]>;
type DbSyncMapping = typeof DEFAULT_DB_SYNC_MAPPINGS[keyof typeof DEFAULT_DB_SYNC_MAPPINGS];

export function withExternalDbSyncUpdate<T extends object>(data: T): T & { shouldUpdateSequenceId: true } {
  return {
    ...data,
    shouldUpdateSequenceId: true,
  };
}

export async function markProjectUserForExternalDbSync(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    projectUserId: string,
  }
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.projectUserId, "projectUserId");
  await tx.projectUser.update({
    where: {
      tenancyId_projectUserId: {
        tenancyId: options.tenancyId,
        projectUserId: options.projectUserId,
      },
    },
    data: {
      shouldUpdateSequenceId: true,
    },
  });
}

export async function recordExternalDbSyncDeletion(
  tx: ExternalDbSyncClient,
  target: ExternalDbSyncTarget,
): Promise<void> {
  assertUuid(target.tenancyId, "tenancyId");

  if (target.tableName === "ProjectUser") {
    assertUuid(target.projectUserId, "projectUserId");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DeletedRow" (
        "id",
        "tenancyId",
        "tableName",
        "primaryKey",
        "data",
        "deletedAt",
        "shouldUpdateSequenceId"
      )
      SELECT
        gen_random_uuid(),
        "tenancyId",
        'ProjectUser',
        jsonb_build_object('tenancyId', "tenancyId", 'projectUserId', "projectUserId"),
        to_jsonb("ProjectUser".*),
        NOW(),
        TRUE
      FROM "ProjectUser"
      WHERE "tenancyId" = ${target.tenancyId}::uuid
        AND "projectUserId" = ${target.projectUserId}::uuid
      FOR UPDATE
    `);

    return;
  }

  if (target.tableName === "EmailOutbox") {
    assertUuid(target.emailOutboxId, "emailOutboxId");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DeletedRow" (
        "id",
        "tenancyId",
        "tableName",
        "primaryKey",
        "data",
        "deletedAt",
        "shouldUpdateSequenceId"
      )
      SELECT
        gen_random_uuid(),
        "tenancyId",
        'EmailOutbox',
        jsonb_build_object('tenancyId', "tenancyId", 'id', "id"),
        to_jsonb("EmailOutbox".*),
        NOW(),
        TRUE
      FROM "EmailOutbox"
      WHERE "tenancyId" = ${target.tenancyId}::uuid
        AND "id" = ${target.emailOutboxId}::uuid
      FOR UPDATE
    `);

    return;
  }

  if (target.tableName === "ContactChannel") {
    assertUuid(target.projectUserId, "projectUserId");
    assertUuid(target.contactChannelId, "contactChannelId");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DeletedRow" (
        "id",
        "tenancyId",
        "tableName",
        "primaryKey",
        "data",
        "deletedAt",
        "shouldUpdateSequenceId"
      )
      SELECT
        gen_random_uuid(),
        "tenancyId",
        'ContactChannel',
        jsonb_build_object(
          'tenancyId',
          "tenancyId",
          'projectUserId',
          "projectUserId",
          'id',
          "id"
        ),
        to_jsonb("ContactChannel".*),
        NOW(),
        TRUE
      FROM "ContactChannel"
      WHERE "tenancyId" = ${target.tenancyId}::uuid
        AND "projectUserId" = ${target.projectUserId}::uuid
        AND "id" = ${target.contactChannelId}::uuid
      FOR UPDATE
    `);

    return;
  }

  if (target.tableName === "Team") {
    assertUuid(target.teamId, "teamId");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DeletedRow" (
        "id",
        "tenancyId",
        "tableName",
        "primaryKey",
        "data",
        "deletedAt",
        "shouldUpdateSequenceId"
      )
      SELECT
        gen_random_uuid(),
        "tenancyId",
        'Team',
        jsonb_build_object('tenancyId', "tenancyId", 'teamId', "teamId"),
        to_jsonb("Team".*),
        NOW(),
        TRUE
      FROM "Team"
      WHERE "tenancyId" = ${target.tenancyId}::uuid
        AND "teamId" = ${target.teamId}::uuid
      FOR UPDATE
    `);

    return;
  }

  if (target.tableName === "TeamMember") {
    assertUuid(target.projectUserId, "projectUserId");
    assertUuid(target.teamId, "teamId");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DeletedRow" (
        "id",
        "tenancyId",
        "tableName",
        "primaryKey",
        "data",
        "deletedAt",
        "shouldUpdateSequenceId"
      )
      SELECT
        gen_random_uuid(),
        "tenancyId",
        'TeamMember',
        jsonb_build_object('tenancyId', "tenancyId", 'projectUserId', "projectUserId", 'teamId', "teamId"),
        to_jsonb("TeamMember".*),
        NOW(),
        TRUE
      FROM "TeamMember"
      WHERE "tenancyId" = ${target.tenancyId}::uuid
        AND "projectUserId" = ${target.projectUserId}::uuid
        AND "teamId" = ${target.teamId}::uuid
      FOR UPDATE
    `);

    return;
  }

  if (target.tableName === "TeamMemberDirectPermission") {
    assertUuid(target.permissionDbId, "permissionDbId");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DeletedRow" (
        "id",
        "tenancyId",
        "tableName",
        "primaryKey",
        "data",
        "deletedAt",
        "shouldUpdateSequenceId"
      )
      SELECT
        gen_random_uuid(),
        "tenancyId",
        'TeamMemberDirectPermission',
        jsonb_build_object(
          'tenancyId', "tenancyId",
          'projectUserId', "projectUserId",
          'teamId', "teamId",
          'permissionId', "permissionId"
        ),
        to_jsonb("TeamMemberDirectPermission".*),
        NOW(),
        TRUE
      FROM "TeamMemberDirectPermission"
      WHERE "id" = ${target.permissionDbId}::uuid
        AND "tenancyId" = ${target.tenancyId}::uuid
      FOR UPDATE
    `);

    return;
  }

  if (target.tableName === "ProjectUserDirectPermission") {
    assertUuid(target.permissionDbId, "permissionDbId");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DeletedRow" (
        "id",
        "tenancyId",
        "tableName",
        "primaryKey",
        "data",
        "deletedAt",
        "shouldUpdateSequenceId"
      )
      SELECT
        gen_random_uuid(),
        "tenancyId",
        'ProjectUserDirectPermission',
        jsonb_build_object(
          'tenancyId', "tenancyId",
          'projectUserId', "projectUserId",
          'permissionId', "permissionId"
        ),
        to_jsonb("ProjectUserDirectPermission".*),
        NOW(),
        TRUE
      FROM "ProjectUserDirectPermission"
      WHERE "id" = ${target.permissionDbId}::uuid
        AND "tenancyId" = ${target.tenancyId}::uuid
      FOR UPDATE
    `);

    return;
  }

  if (target.tableName === "UserNotificationPreference") {
    assertUuid(target.notificationPreferenceId, "notificationPreferenceId");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DeletedRow" (
        "id",
        "tenancyId",
        "tableName",
        "primaryKey",
        "data",
        "deletedAt",
        "shouldUpdateSequenceId"
      )
      SELECT
        gen_random_uuid(),
        "tenancyId",
        'UserNotificationPreference',
        jsonb_build_object(
          'tenancyId', "tenancyId",
          'id', "id"
        ),
        to_jsonb("UserNotificationPreference".*),
        NOW(),
        TRUE
      FROM "UserNotificationPreference"
      WHERE "id" = ${target.notificationPreferenceId}::uuid
        AND "tenancyId" = ${target.tenancyId}::uuid
      FOR UPDATE
    `);

    return;
  }

  if (target.tableName === "ProjectUserRefreshToken") {
    assertUuid(target.refreshTokenId, "refreshTokenId");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DeletedRow" (
        "id",
        "tenancyId",
        "tableName",
        "primaryKey",
        "data",
        "deletedAt",
        "shouldUpdateSequenceId"
      )
      SELECT
        gen_random_uuid(),
        "tenancyId",
        'ProjectUserRefreshToken',
        jsonb_build_object('tenancyId', "tenancyId", 'id', "id"),
        to_jsonb("ProjectUserRefreshToken".*),
        NOW(),
        TRUE
      FROM "ProjectUserRefreshToken"
      WHERE "tenancyId" = ${target.tenancyId}::uuid
        AND "id" = ${target.refreshTokenId}::uuid
      FOR UPDATE
    `);

    return;
  }

  if (target.tableName === "ProjectUserOAuthAccount") {
    assertUuid(target.oauthAccountId, "oauthAccountId");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DeletedRow" (
        "id",
        "tenancyId",
        "tableName",
        "primaryKey",
        "data",
        "deletedAt",
        "shouldUpdateSequenceId"
      )
      SELECT
        gen_random_uuid(),
        "tenancyId",
        'ProjectUserOAuthAccount',
        jsonb_build_object('tenancyId', "tenancyId", 'id', "id"),
        to_jsonb("ProjectUserOAuthAccount".*),
        NOW(),
        TRUE
      FROM "ProjectUserOAuthAccount"
      WHERE "tenancyId" = ${target.tenancyId}::uuid
        AND "id" = ${target.oauthAccountId}::uuid
      FOR UPDATE
    `);

    return;
  }

  {
    const _verificationCodeTarget: { tableName: "VerificationCode_TEAM_INVITATION" } = target;
    assertNonEmptyString(target.verificationCodeProjectId, "verificationCodeProjectId");
    assertNonEmptyString(target.verificationCodeBranchId, "verificationCodeBranchId");
    assertUuid(target.verificationCodeId, "verificationCodeId");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "DeletedRow" (
        "id",
        "tenancyId",
        "tableName",
        "primaryKey",
        "data",
        "deletedAt",
        "shouldUpdateSequenceId"
      )
      SELECT
        gen_random_uuid(),
        "Tenancy"."id",
        'VerificationCode_TEAM_INVITATION',
        jsonb_build_object('id', "VerificationCode"."id"),
        to_jsonb("VerificationCode".*),
        NOW(),
        TRUE
      FROM "VerificationCode"
      JOIN "Tenancy" ON "Tenancy"."projectId" = "VerificationCode"."projectId"
        AND "Tenancy"."branchId" = "VerificationCode"."branchId"
      WHERE "Tenancy"."id" = ${target.tenancyId}::uuid
        AND "VerificationCode"."projectId" = ${target.verificationCodeProjectId}
        AND "VerificationCode"."branchId" = ${target.verificationCodeBranchId}
        AND "VerificationCode"."id" = ${target.verificationCodeId}::uuid
        AND "VerificationCode"."type" = 'TEAM_INVITATION'
      FOR UPDATE OF "VerificationCode"
    `);

    return;
  }
}

export async function recordExternalDbSyncContactChannelDeletionsForUser(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    projectUserId: string,
  },
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.projectUserId, "projectUserId");

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DeletedRow" (
      "id",
      "tenancyId",
      "tableName",
      "primaryKey",
      "data",
      "deletedAt",
      "shouldUpdateSequenceId"
    )
    SELECT
      gen_random_uuid(),
      "tenancyId",
      'ContactChannel',
      jsonb_build_object(
        'tenancyId',
        "tenancyId",
        'projectUserId',
        "projectUserId",
        'id',
        "id"
      ),
      to_jsonb("ContactChannel".*),
      NOW(),
      TRUE
    FROM "ContactChannel"
    WHERE "tenancyId" = ${options.tenancyId}::uuid
      AND "projectUserId" = ${options.projectUserId}::uuid
    FOR UPDATE
  `);
}

export async function recordExternalDbSyncTeamMemberDeletionsForTeam(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    teamId: string,
  },
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.teamId, "teamId");

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DeletedRow" (
      "id",
      "tenancyId",
      "tableName",
      "primaryKey",
      "data",
      "deletedAt",
      "shouldUpdateSequenceId"
    )
    SELECT
      gen_random_uuid(),
      "tenancyId",
      'TeamMember',
      jsonb_build_object('tenancyId', "tenancyId", 'projectUserId', "projectUserId", 'teamId', "teamId"),
      to_jsonb("TeamMember".*),
      NOW(),
      TRUE
    FROM "TeamMember"
    WHERE "tenancyId" = ${options.tenancyId}::uuid
      AND "teamId" = ${options.teamId}::uuid
    FOR UPDATE
  `);
}

export async function recordExternalDbSyncTeamPermissionDeletionsForTeamMember(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    projectUserId: string,
    teamId: string,
  },
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.projectUserId, "projectUserId");
  assertUuid(options.teamId, "teamId");

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DeletedRow" (
      "id",
      "tenancyId",
      "tableName",
      "primaryKey",
      "data",
      "deletedAt",
      "shouldUpdateSequenceId"
    )
    SELECT
      gen_random_uuid(),
      "tenancyId",
      'TeamMemberDirectPermission',
      jsonb_build_object(
        'tenancyId', "tenancyId",
        'projectUserId', "projectUserId",
        'teamId', "teamId",
        'permissionId', "permissionId"
      ),
      to_jsonb("TeamMemberDirectPermission".*),
      NOW(),
      TRUE
    FROM "TeamMemberDirectPermission"
    WHERE "tenancyId" = ${options.tenancyId}::uuid
      AND "projectUserId" = ${options.projectUserId}::uuid
      AND "teamId" = ${options.teamId}::uuid
    FOR UPDATE
  `);
}

export async function recordExternalDbSyncTeamPermissionDeletionsForTeam(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    teamId: string,
  },
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.teamId, "teamId");

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DeletedRow" (
      "id",
      "tenancyId",
      "tableName",
      "primaryKey",
      "data",
      "deletedAt",
      "shouldUpdateSequenceId"
    )
    SELECT
      gen_random_uuid(),
      "tenancyId",
      'TeamMemberDirectPermission',
      jsonb_build_object(
        'tenancyId', "tenancyId",
        'projectUserId', "projectUserId",
        'teamId', "teamId",
        'permissionId', "permissionId"
      ),
      to_jsonb("TeamMemberDirectPermission".*),
      NOW(),
      TRUE
    FROM "TeamMemberDirectPermission"
    WHERE "tenancyId" = ${options.tenancyId}::uuid
      AND "teamId" = ${options.teamId}::uuid
    FOR UPDATE
  `);
}

export async function recordExternalDbSyncTeamPermissionDeletionsForUser(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    projectUserId: string,
  },
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.projectUserId, "projectUserId");

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DeletedRow" (
      "id",
      "tenancyId",
      "tableName",
      "primaryKey",
      "data",
      "deletedAt",
      "shouldUpdateSequenceId"
    )
    SELECT
      gen_random_uuid(),
      "tenancyId",
      'TeamMemberDirectPermission',
      jsonb_build_object(
        'tenancyId', "tenancyId",
        'projectUserId', "projectUserId",
        'teamId', "teamId",
        'permissionId', "permissionId"
      ),
      to_jsonb("TeamMemberDirectPermission".*),
      NOW(),
      TRUE
    FROM "TeamMemberDirectPermission"
    WHERE "tenancyId" = ${options.tenancyId}::uuid
      AND "projectUserId" = ${options.projectUserId}::uuid
    FOR UPDATE
  `);
}

export async function recordExternalDbSyncTeamInvitationDeletionsForTeam(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    teamId: string,
  },
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.teamId, "teamId");

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DeletedRow" (
      "id",
      "tenancyId",
      "tableName",
      "primaryKey",
      "data",
      "deletedAt",
      "shouldUpdateSequenceId"
    )
    SELECT
      gen_random_uuid(),
      "Tenancy"."id",
      'VerificationCode_TEAM_INVITATION',
      jsonb_build_object('id', "VerificationCode"."id"),
      to_jsonb("VerificationCode".*),
      NOW(),
      TRUE
    FROM "VerificationCode"
    JOIN "Tenancy" ON "Tenancy"."projectId" = "VerificationCode"."projectId"
      AND "Tenancy"."branchId" = "VerificationCode"."branchId"
    WHERE "Tenancy"."id" = ${options.tenancyId}::uuid
      AND "VerificationCode"."type" = 'TEAM_INVITATION'
      AND "VerificationCode"."data"->>'team_id' = ${options.teamId}
    FOR UPDATE OF "VerificationCode"
  `);
}

export async function recordExternalDbSyncTeamMemberDeletionsForUser(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    projectUserId: string,
  },
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.projectUserId, "projectUserId");

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DeletedRow" (
      "id",
      "tenancyId",
      "tableName",
      "primaryKey",
      "data",
      "deletedAt",
      "shouldUpdateSequenceId"
    )
    SELECT
      gen_random_uuid(),
      "tenancyId",
      'TeamMember',
      jsonb_build_object('tenancyId', "tenancyId", 'projectUserId', "projectUserId", 'teamId', "teamId"),
      to_jsonb("TeamMember".*),
      NOW(),
      TRUE
    FROM "TeamMember"
    WHERE "tenancyId" = ${options.tenancyId}::uuid
      AND "projectUserId" = ${options.projectUserId}::uuid
    FOR UPDATE
  `);
}

export async function recordExternalDbSyncProjectPermissionDeletionsForUser(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    projectUserId: string,
  },
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.projectUserId, "projectUserId");

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DeletedRow" (
      "id",
      "tenancyId",
      "tableName",
      "primaryKey",
      "data",
      "deletedAt",
      "shouldUpdateSequenceId"
    )
    SELECT
      gen_random_uuid(),
      "tenancyId",
      'ProjectUserDirectPermission',
      jsonb_build_object(
        'tenancyId', "tenancyId",
        'projectUserId', "projectUserId",
        'permissionId', "permissionId"
      ),
      to_jsonb("ProjectUserDirectPermission".*),
      NOW(),
      TRUE
    FROM "ProjectUserDirectPermission"
    WHERE "tenancyId" = ${options.tenancyId}::uuid
      AND "projectUserId" = ${options.projectUserId}::uuid
    FOR UPDATE
  `);
}

export async function recordExternalDbSyncNotificationPreferenceDeletionsForUser(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    projectUserId: string,
  },
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.projectUserId, "projectUserId");

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DeletedRow" (
      "id",
      "tenancyId",
      "tableName",
      "primaryKey",
      "data",
      "deletedAt",
      "shouldUpdateSequenceId"
    )
    SELECT
      gen_random_uuid(),
      "tenancyId",
      'UserNotificationPreference',
      jsonb_build_object(
        'tenancyId', "tenancyId",
        'id', "id"
      ),
      to_jsonb("UserNotificationPreference".*),
      NOW(),
      TRUE
    FROM "UserNotificationPreference"
    WHERE "tenancyId" = ${options.tenancyId}::uuid
      AND "projectUserId" = ${options.projectUserId}::uuid
    FOR UPDATE
  `);
}

export async function recordExternalDbSyncRefreshTokenDeletionsForUser(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    projectUserId: string,
    excludeRefreshToken?: string,
  },
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.projectUserId, "projectUserId");

  const excludeCondition = options.excludeRefreshToken
    ? Prisma.sql`AND "refreshToken" != ${options.excludeRefreshToken}`
    : Prisma.sql``;

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DeletedRow" (
      "id",
      "tenancyId",
      "tableName",
      "primaryKey",
      "data",
      "deletedAt",
      "shouldUpdateSequenceId"
    )
    SELECT
      gen_random_uuid(),
      "tenancyId",
      'ProjectUserRefreshToken',
      jsonb_build_object('tenancyId', "tenancyId", 'id', "id"),
      to_jsonb("ProjectUserRefreshToken".*),
      NOW(),
      TRUE
    FROM "ProjectUserRefreshToken"
    WHERE "tenancyId" = ${options.tenancyId}::uuid
      AND "projectUserId" = ${options.projectUserId}::uuid
      ${excludeCondition}
    FOR UPDATE
  `);
}

export async function recordExternalDbSyncOAuthAccountDeletionsForUser(
  tx: ExternalDbSyncClient,
  options: {
    tenancyId: string,
    projectUserId: string,
  },
): Promise<void> {
  assertUuid(options.tenancyId, "tenancyId");
  assertUuid(options.projectUserId, "projectUserId");

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DeletedRow" (
      "id",
      "tenancyId",
      "tableName",
      "primaryKey",
      "data",
      "deletedAt",
      "shouldUpdateSequenceId"
    )
    SELECT
      gen_random_uuid(),
      "tenancyId",
      'ProjectUserOAuthAccount',
      jsonb_build_object('tenancyId', "tenancyId", 'id', "id"),
      to_jsonb("ProjectUserOAuthAccount".*),
      NOW(),
      TRUE
    FROM "ProjectUserOAuthAccount"
    WHERE "tenancyId" = ${options.tenancyId}::uuid
      AND "projectUserId" = ${options.projectUserId}::uuid
    FOR UPDATE
  `);
}

type PgErrorLike = {
  code?: string,
  constraint?: string,
  message?: string,
};

function isDuplicateTypeError(error: unknown): error is PgErrorLike {
  if (!error || typeof error !== "object") return false;
  const pgError = error as PgErrorLike;
  return pgError.code === "23505" && pgError.constraint === "pg_type_typname_nsp_index";
}

function isConcurrentUpdateError(error: unknown): error is PgErrorLike {
  if (!error || typeof error !== "object") return false;
  const pgError = error as PgErrorLike;
  // "tuple concurrently updated" occurs when multiple transactions race to modify
  // the same system catalog row (e.g., during concurrent CREATE TABLE IF NOT EXISTS)
  return typeof pgError.message === "string" && pgError.message.includes("tuple concurrently updated");
}

function getMaxBatchesPerMapping(): number | null {
  const rawValue = getEnvVariable(MAX_BATCHES_PER_MAPPING_ENV, "");
  if (!rawValue) return null;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HexclaveAssertionError(
      `${MAX_BATCHES_PER_MAPPING_ENV} must be a positive integer. Received: ${JSON.stringify(rawValue)}`
    );
  }
  return parsed;
}

async function ensureExternalSchema(
  externalClient: Client,
  tableSchemaSql: string,
  tableName: string,
) {
  try {
    await externalClient.query(tableSchemaSql);
  } catch (error) {
    // Concurrent CREATE TABLE can race and cause various errors:
    // - duplicate type error (23505 on pg_type_typname_nsp_index)
    // - tuple concurrently updated (system catalog row modified by another transaction)
    // If the table now exists, we can safely continue.
    if (!isDuplicateTypeError(error) && !isConcurrentUpdateError(error)) {
      throw error;
    }

    const existsResult = await externalClient.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = $1
      );
    `, [tableName]);
    if (existsResult.rows[0]?.exists === true) {
      return;
    }

    throw new HexclaveAssertionError(
      `Schema creation error while creating table ${JSON.stringify(tableName)}, but table does not exist.`
    );
  }
}

async function pushRowsToExternalDb(
  externalClient: Client,
  tableName: string,
  newRows: any[],
  upsertQuery: string,
  expectedTenancyId: string,
  mappingId: string,
) {
  assertNonEmptyString(tableName, "tableName");
  assertNonEmptyString(mappingId, "mappingId");
  assertUuid(expectedTenancyId, "expectedTenancyId");
  if (!Array.isArray(newRows)) {
    throw new HexclaveAssertionError(`newRows must be an array for table ${JSON.stringify(tableName)}.`);
  }
  if (newRows.length === 0) return;
  // Just for our own sanity, make sure that we have the right number of positional parameters
  // The last parameter is mapping_name for metadata tracking
  const placeholderMatches = upsertQuery.match(/\$\d+/g) ?? throwErr(`Could not find any positional parameters ($1, $2, ...) in the update SQL query.`);
  const expectedParamCount = Math.max(...placeholderMatches.map((m: string) => Number(m.slice(1))));
  const sampleRow = newRows[0];
  const orderedKeys = Object.keys(omit(sampleRow, ["tenancyId"]));
  // +1 for mapping_name parameter which is appended
  if (orderedKeys.length + 1 !== expectedParamCount) {
    throw new HexclaveAssertionError(`
      Column count mismatch for table ${JSON.stringify(tableName)}
       → upsertQuery expects ${expectedParamCount} parameters (last one should be mapping_name).
       → internalDbFetchQuery returned ${orderedKeys.length} columns (excluding tenancyId) + 1 for mapping_name = ${orderedKeys.length + 1}.
      Fix your SELECT column order or your SQL parameter order.
    `);
  }

  for (const row of newRows) {
    const { tenancyId, ...rest } = row;

    // Validate that all rows belong to the expected tenant
    if (tenancyId !== expectedTenancyId) {
      throw new HexclaveAssertionError(
        `Row has unexpected tenancyId. Expected ${expectedTenancyId}, got ${tenancyId}. ` +
        `This indicates a bug in the internalDbFetchQuery.`
      );
    }

    const rowKeys = Object.keys(rest);

    const validShape =
      rowKeys.length === orderedKeys.length &&
      rowKeys.every((k, i) => k === orderedKeys[i]);

    if (!validShape) {
      throw new HexclaveAssertionError(
        `  Row shape mismatch for table "${tableName}".\n` +
          `Expected column order: [${orderedKeys.join(", ")}]\n` +
          `Received column order: [${rowKeys.join(", ")}]\n` +
          `Your SELECT must be explicit, ordered, and NEVER use SELECT *.\n` +
          `Fix the SELECT in internalDbFetchQuery immediately.`
      );
    }

    // Append mapping_name as the last parameter for metadata tracking
    await externalClient.query(upsertQuery, [...Object.values(rest), mappingId]);
  }
}

function getInternalDbFetchQuery(mapping: DbSyncMapping) {
  return mapping.internalDbFetchQuery;
}

function normalizeClickhouseBoolean(value: unknown, label: string): number {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "bigint") {
    if (value === 0n) return 0;
    if (value === 1n) return 1;
  }
  if (value === 0 || value === 1) {
    return value;
  }
  throw new HexclaveAssertionError(`${label} must be a boolean or 0/1. Received: ${JSON.stringify(value)}`);
}

function normalizeClickhouseNullableBoolean(value: unknown, label: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeClickhouseBoolean(value, label);
}

function parseSequenceId(value: unknown, mappingId: string): number | null {
  if (value == null) {
    return null;
  }
  const seqNum = Number(value);
  if (!Number.isFinite(seqNum)) {
    throw new HexclaveAssertionError(
      `Invalid sequence_id for mapping ${mappingId}: ${JSON.stringify(value)}`
    );
  }
  return seqNum;
}

async function ensureClickhouseSchema(
  client: ClickHouseClient,
  tableSchemaSql: string,
  tableName: string,
) {
  assertNonEmptyString(tableSchemaSql, "tableSchemaSql");
  assertNonEmptyString(tableName, "tableName");
  const queries = tableSchemaSql
    .split(";")
    .map((query) => query.trim())
    .filter((query) => query.length > 0);
  for (const query of queries) {
    await client.exec({ query });
  }
}

// Map of target table name -> column normalizers for ClickHouse
// 'json' columns get JSON.stringify, 'boolean' columns get normalizeClickhouseBoolean, 'bigint' columns get Number()
export const CLICKHOUSE_COLUMN_NORMALIZERS: Record<string, Record<string, 'json' | 'boolean' | 'nullable_boolean' | 'bigint'>> = {
  users: {
    client_metadata: 'json',
    client_read_only_metadata: 'json',
    server_metadata: 'json',
    primary_email_verified: 'boolean',
    is_anonymous: 'boolean',
    restricted_by_admin: 'boolean',
    sync_is_deleted: 'boolean',
  },
  contact_channels: {
    is_primary: 'boolean',
    is_verified: 'boolean',
    used_for_auth: 'boolean',
    sync_is_deleted: 'boolean',
  },
  teams: {
    client_metadata: 'json',
    client_read_only_metadata: 'json',
    server_metadata: 'json',
    sync_is_deleted: 'boolean',
  },
  team_member_profiles: {
    sync_is_deleted: 'boolean',
  },
  team_permissions: {
    sync_is_deleted: 'boolean',
  },
  team_invitations: {
    expires_at_millis: 'bigint',
    sync_is_deleted: 'boolean',
  },
  email_outboxes: {
    is_high_priority: 'boolean',
    is_transactional: 'nullable_boolean',
    can_have_delivery_info: 'nullable_boolean',
    skipped_details: 'json',
    is_paused: 'boolean',
    sync_is_deleted: 'boolean',
  },
  project_permissions: {
    sync_is_deleted: 'boolean',
  },
  notification_preferences: {
    enabled: 'boolean',
    sync_is_deleted: 'boolean',
  },
  refresh_tokens: {
    is_impersonation: 'boolean',
    sync_is_deleted: 'boolean',
  },
  connected_accounts: {
    sync_is_deleted: 'boolean',
  },
};

async function pushRowsToClickhouse(
  client: ClickHouseClient,
  tableName: string,
  newRows: Array<Record<string, unknown>>,
  expectedTenancyId: string,
  mappingId: string,
) {
  assertNonEmptyString(tableName, "tableName");
  assertNonEmptyString(mappingId, "mappingId");
  assertUuid(expectedTenancyId, "expectedTenancyId");
  if (!Array.isArray(newRows)) {
    throw new HexclaveAssertionError(`newRows must be an array for table ${JSON.stringify(tableName)}.`);
  }
  if (newRows.length === 0) return;

  const sampleRow = newRows[0] ?? throwErr("Expected at least one row for ClickHouse sync.");
  const orderedKeys = Object.keys(omit(sampleRow, ["tenancyId"]));

  // Derive the target table name from the full tableName (e.g. "analytics_internal.users" -> "users")
  const targetTable = tableName.includes('.') ? tableName.split('.').pop()! : tableName;
  const normalizers = CLICKHOUSE_COLUMN_NORMALIZERS[targetTable] ?? {};

  const normalizedRows = newRows.map((row) => {
    const tenancyIdValue = row.tenancyId;
    if (typeof tenancyIdValue !== "string") {
      throw new HexclaveAssertionError(
        `Row has invalid tenancyId. Expected ${expectedTenancyId}, got ${JSON.stringify(tenancyIdValue)}.`
      );
    }
    if (tenancyIdValue !== expectedTenancyId) {
      throw new HexclaveAssertionError(
        `Row has unexpected tenancyId. Expected ${expectedTenancyId}, got ${tenancyIdValue}. ` +
        `This indicates a bug in the internalDbFetchQuery.`
      );
    }

    const rest = omit(row, ["tenancyId"]);
    const rowKeys = Object.keys(rest);

    const validShape =
      rowKeys.length === orderedKeys.length &&
      rowKeys.every((key, index) => key === orderedKeys[index]);

    if (!validShape) {
      throw new HexclaveAssertionError(
        `  Row shape mismatch for table "${tableName}".\n` +
          `Expected column order: [${orderedKeys.join(", ")}]\n` +
          `Received column order: [${rowKeys.join(", ")}]\n` +
          `Your SELECT must be explicit, ordered, and NEVER use SELECT *.\n` +
          `Fix the SELECT in internalDbFetchQuery immediately.`
      );
    }

    const sequenceId = parseSequenceId(rest.sync_sequence_id, mappingId);
    if (sequenceId === null) {
      throw new HexclaveAssertionError(
        `sync_sequence_id must be defined for ClickHouse sync. Mapping: ${mappingId}`
      );
    }

    const normalized: Record<string, unknown> = {
      ...rest,
      sync_sequence_id: sequenceId,
    };

    for (const [col, type] of Object.entries(normalizers)) {
      if (col in normalized) {
        if (type === 'json') {
          normalized[col] = JSON.stringify(normalized[col]);
        } else if (type === 'nullable_boolean') {
          normalized[col] = normalizeClickhouseNullableBoolean(normalized[col], col);
        } else if (type === 'bigint') {
          normalized[col] = Number(normalized[col]);
        } else {
          normalized[col] = normalizeClickhouseBoolean(normalized[col], col);
        }
      }
    }

    return normalized;
  });

  await client.insert({
    table: tableName,
    values: normalizedRows,
    format: "JSONEachRow",
    clickhouse_settings: {
      date_time_input_format: "best_effort",
    },
  });
}

async function getClickhouseLastSyncedSequenceId(
  client: ClickHouseClient,
  tenancyId: string,
  mappingId: string,
): Promise<number> {
  assertUuid(tenancyId, "tenancyId");
  assertNonEmptyString(mappingId, "mappingId");
  const resultSet = await client.query({
    query: `
      SELECT last_synced_sequence_id
      FROM analytics_internal._stack_sync_metadata
      WHERE tenancy_id = {tenancy_id:UUID}
        AND mapping_name = {mapping_name:String}
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    query_params: {
      tenancy_id: tenancyId,
      mapping_name: mappingId,
    },
    format: "JSONEachRow",
  });

  const result = await resultSet.json<{ last_synced_sequence_id: string }>();
  if (result.length === 0) {
    return -1;
  }
  const parsed = Number(result[0]?.last_synced_sequence_id);
  if (!Number.isFinite(parsed)) {
    throw new HexclaveAssertionError(
      `Invalid last_synced_sequence_id for mapping ${mappingId}: ${JSON.stringify(result[0]?.last_synced_sequence_id)}`
    );
  }
  return parsed;
}

async function updateClickhouseSyncMetadata(
  client: ClickHouseClient,
  tenancyId: string,
  mappingId: string,
  lastSequenceId: number,
) {
  assertUuid(tenancyId, "tenancyId");
  assertNonEmptyString(mappingId, "mappingId");
  if (!Number.isFinite(lastSequenceId)) {
    throw new HexclaveAssertionError(`lastSequenceId must be a finite number for mapping ${mappingId}.`);
  }
  await client.insert({
    table: "analytics_internal._stack_sync_metadata",
    values: [{
      tenancy_id: tenancyId,
      mapping_name: mappingId,
      last_synced_sequence_id: lastSequenceId,
    }],
    format: "JSONEachRow",
    clickhouse_settings: {
      date_time_input_format: "best_effort",
    },
  });
}


async function syncPostgresMapping(
  externalClient: Client,
  mappingId: string,
  mapping: DbSyncMapping,
  internalPrisma: PrismaClientWithReplica,
  dbId: string,
  tenancyId: string,
): Promise<boolean> {
  assertNonEmptyString(mappingId, "mappingId");
  assertNonEmptyString(mapping.targetTable, "mapping.targetTable");
  assertUuid(tenancyId, "tenancyId");
  const fetchQuery = getInternalDbFetchQuery(mapping);
  const updateQuery = mapping.externalDbUpdateQueries.postgres;
  const tableName = mapping.targetTable;
  assertNonEmptyString(fetchQuery, "internalDbFetchQuery");
  assertNonEmptyString(updateQuery, "externalDbUpdateQueries");
  if (!fetchQuery.includes("$1") || !fetchQuery.includes("$2")) {
    throw new HexclaveAssertionError(
      `internalDbFetchQuery must reference $1 (tenancyId) and $2 (lastSequenceId). Mapping: ${mappingId}`
    );
  }

  const tableSchema = mapping.targetTableSchemas.postgres;
  await ensureExternalSchema(externalClient, tableSchema, tableName);

  let lastSequenceId = -1;
  const metadataResult = await externalClient.query(
    `SELECT "last_synced_sequence_id" FROM "_stack_sync_metadata" WHERE "mapping_name" = $1`,
    [mappingId]
  );
  if (metadataResult.rows.length > 0) {
    lastSequenceId = Number(metadataResult.rows[0].last_synced_sequence_id);
  }
  if (!Number.isFinite(lastSequenceId)) {
    throw new HexclaveAssertionError(
      `Invalid last_synced_sequence_id for mapping ${mappingId}: ${JSON.stringify(metadataResult.rows[0]?.last_synced_sequence_id)}`
    );
  }

  const BATCH_LIMIT = 1000;
  const maxBatchesPerMapping = getMaxBatchesPerMapping();
  let batchesProcessed = 0;
  let throttled = false;

  while (true) {
    assertUuid(tenancyId, "tenancyId");
    if (!Number.isFinite(lastSequenceId)) {
      throw new HexclaveAssertionError(`lastSequenceId must be a finite number for mapping ${mappingId}.`);
    }
    const rows = await internalPrisma.$replica().$queryRawUnsafe<any[]>(fetchQuery, tenancyId, lastSequenceId);

    if (rows.length === 0) {
      break;
    }
    if (rows.length > 1) {
      console.log("db-sync-postgres: more than 1 row returned from source db fetch", { tenancyId, numRows: rows.length });
    }

    await pushRowsToExternalDb(
      externalClient,
      tableName,
      rows,
      updateQuery,
      tenancyId,
      mappingId,
    );

    // This watermark relies on sequencer allocation committing in sequence order; a visible
    // higher value must imply that every lower value is already visible to the source reader.
    let maxSeqInBatch = lastSequenceId;
    for (const row of rows) {
      const seqNum = parseSequenceId(row.sequence_id, mappingId);
      if (seqNum !== null && seqNum > maxSeqInBatch) {
        maxSeqInBatch = seqNum;
      }
    }
    lastSequenceId = maxSeqInBatch;

    if (rows.length < BATCH_LIMIT) {
      break;
    }

    batchesProcessed++;
    if (maxBatchesPerMapping !== null && batchesProcessed >= maxBatchesPerMapping) {
      throttled = true;
      break;
    }
  }

  return throttled;
}

async function syncClickhouseMapping(
  client: ClickHouseClient,
  mappingId: string,
  mapping: DbSyncMapping,
  internalPrisma: PrismaClientWithReplica,
  tenancyId: string,
): Promise<boolean> {
  assertNonEmptyString(mappingId, "mappingId");
  assertNonEmptyString(mapping.targetTable, "mapping.targetTable");
  assertUuid(tenancyId, "tenancyId");
  const fetchQuery = mapping.internalDbFetchQueries.clickhouse;
  if (!fetchQuery) {
    throw new HexclaveAssertionError(`Missing ClickHouse fetch query for mapping ${mappingId}.`);
  }
  const tableSchema = mapping.targetTableSchemas.clickhouse;
  if (!tableSchema) {
    throw new HexclaveAssertionError(`Missing ClickHouse table schema for mapping ${mappingId}.`);
  }
  assertNonEmptyString(fetchQuery, "internalDbFetchQuery");
  if (!fetchQuery.includes("$1") || !fetchQuery.includes("$2")) {
    throw new HexclaveAssertionError(
      `internalDbFetchQuery must reference $1 (tenancyId) and $2 (lastSequenceId). Mapping: ${mappingId}`
    );
  }

  const clickhouseTableName = `analytics_internal.${mapping.targetTable}`;
  let lastSequenceId = await getClickhouseLastSyncedSequenceId(client, tenancyId, mappingId);

  const BATCH_LIMIT = 1000;
  const maxBatchesPerMapping = getMaxBatchesPerMapping();
  let batchesProcessed = 0;
  let throttled = false;

  while (true) {
    assertUuid(tenancyId, "tenancyId");
    if (!Number.isFinite(lastSequenceId)) {
      throw new HexclaveAssertionError(`lastSequenceId must be a finite number for mapping ${mappingId}.`);
    }
    const rows = await internalPrisma.$replica().$queryRawUnsafe<Record<string, unknown>[]>(fetchQuery, tenancyId, lastSequenceId);

    if (rows.length === 0) {
      break;
    }
    if (rows.length > 1) {
      console.log("db-sync-clickhouse: more than 1 row returned from source db fetch", { tenancyId, numRows: rows.length });
    }

    await pushRowsToClickhouse(
      client,
      clickhouseTableName,
      rows,
      tenancyId,
      mappingId,
    );

    // This watermark relies on sequencer allocation committing in sequence order; a visible
    // higher value must imply that every lower value is already visible to the source reader.
    let maxSeqInBatch = lastSequenceId;
    for (const row of rows) {
      const seqNum = parseSequenceId(row.sync_sequence_id, mappingId);
      if (seqNum !== null && seqNum > maxSeqInBatch) {
        maxSeqInBatch = seqNum;
      }
    }
    lastSequenceId = maxSeqInBatch;
    await updateClickhouseSyncMetadata(client, tenancyId, mappingId, lastSequenceId);

    if (rows.length < BATCH_LIMIT) {
      break;
    }

    batchesProcessed++;
    if (maxBatchesPerMapping !== null && batchesProcessed >= maxBatchesPerMapping) {
      throttled = true;
      break;
    }
  }

  return throttled;
}


async function syncDatabase(
  dbId: string,
  dbConfig: CompleteConfig["dbSync"]["externalDatabases"][string],
  internalPrisma: PrismaClientWithReplica,
  tenancyId: string,
): Promise<boolean> {
  assertNonEmptyString(dbId, "dbId");
  assertUuid(tenancyId, "tenancyId");
  const dbType = dbConfig.type;
  if (dbType === "postgres") {
    if (!dbConfig.connectionString) {
      throw new HexclaveAssertionError(
        `Invalid configuration for external DB ${dbId}: 'connectionString' is missing.`
      );
    }
    assertNonEmptyString(dbConfig.connectionString, `external DB ${dbId} connectionString`);
    const externalClientOptions = await getSafeExternalPostgresClientOptions(dbConfig.connectionString);

    const externalClient = new Client(externalClientOptions);
    // node-postgres treats an EventEmitter "error" without a listener as fatal to
    // the whole process; report connection loss to the error sink instead.
    externalClient.on("error", (error) => captureError("external-db-sync-client", error));

    let needsResync = false;
    const syncResult = await Result.fromPromise((async () => {
      await externalClient.connect();

      // Always use DEFAULT_DB_SYNC_MAPPINGS - users cannot customize mappings
      // because internalDbFetchQuery runs against Hexclave's internal DB
      for (const [mappingId, mapping] of Object.entries(DEFAULT_DB_SYNC_MAPPINGS)) {
        const mappingThrottled = await syncPostgresMapping(
          externalClient,
          mappingId,
          mapping,
          internalPrisma,
          dbId,
          tenancyId,
        );
        if (mappingThrottled) {
          needsResync = true;
        }
      }
    })());

    const closeResult = await Result.fromPromise(externalClient.end());
    if (closeResult.status === "error") {
      captureError(`external-db-sync-${dbId}-close`, closeResult.error);
    }

    if (syncResult.status === "error") {
      captureError(`external-db-sync-${dbId}`, syncResult.error);
      return false;
    }

    return needsResync;
  }

  throw new HexclaveAssertionError(
    `Unsupported database type '${String(dbType)}' for external DB ${dbId}.`
  );
}


export async function syncExternalDatabases(tenancy: Tenancy): Promise<boolean> {
  assertUuid(tenancy.id, "tenancy.id");
  const externalDatabases = tenancy.config.dbSync.externalDatabases;
  const internalPrisma = await getPrismaClientForTenancy(tenancy);
  let needsResync = false;

  // Always sync to ClickHouse if STACK_CLICKHOUSE_URL is set (not driven by config)
  const clickhouseUrl = getEnvVariable("STACK_CLICKHOUSE_URL", "");
  if (clickhouseUrl) {
    const clickhouseClient = getClickhouseAdminClient();
    const syncResult = await Result.fromPromise((async () => {
      for (const [mappingId, mapping] of Object.entries(DEFAULT_DB_SYNC_MAPPINGS)) {
        const mappingThrottled = await syncClickhouseMapping(
          clickhouseClient,
          mappingId,
          mapping,
          internalPrisma,
          tenancy.id,
        );
        if (mappingThrottled) {
          needsResync = true;
        }
      }
    })());

    const closeResult = await Result.fromPromise(clickhouseClient.close());
    if (closeResult.status === "error") {
      captureError("external-db-sync-clickhouse-close", closeResult.error);
    }

    if (syncResult.status === "error") {
      captureError("external-db-sync-clickhouse", syncResult.error);
      needsResync = true;
    }
  }

  for (const [dbId, dbConfig] of Object.entries(externalDatabases)) {
    try {
      const databaseThrottled = await syncDatabase(dbId, dbConfig, internalPrisma, tenancy.id);
      if (databaseThrottled) {
        needsResync = true;
      }
    } catch (error) {
      // Log the error but continue syncing other databases
      // This ensures one bad database config doesn't block successful syncs to other databases
      captureError(`external-db-sync-${dbId}`, error);
    }
  }

  return needsResync;
}

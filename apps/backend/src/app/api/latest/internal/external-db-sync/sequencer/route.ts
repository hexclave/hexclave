import { getExternalDbSyncFusebox } from "@/lib/external-db-sync-metadata";
import { enqueueExternalDbSyncBatch } from "@/lib/external-db-sync-queue";
import { runSequenceAllocationInTransaction } from "@/lib/external-db-sync-sequencing";
import { Span } from "@opentelemetry/api";
import { Prisma } from "@/generated/prisma/client";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { traceSpan } from "@/utils/telemetry";
import {
  yupBoolean,
  yupNumber,
  yupObject,
  yupString,
  yupTuple,
} from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";

const DEFAULT_MAX_DURATION_MS = 3 * 60 * 1000;
const SEQUENCER_BATCH_SIZE_ENV = "STACK_EXTERNAL_DB_SYNC_SEQUENCER_BATCH_SIZE";
const DEFAULT_BATCH_SIZE = 1000;

async function runSequenceAllocation<T>(
  allocation: (tx: Prisma.TransactionClient) => Promise<T>,
  span: Span,
): Promise<T | null> {
  // Allocation batches can contain up to 1,000 rows; allow substantial headroom above
  // the normal sub-second case while keeping the globally locked transaction bounded.
  const result = await retryTransaction(
    globalPrismaClient,
    (tx) => runSequenceAllocationInTransaction(tx, allocation),
    { timeout: 30_000 },
  );
  if (result == null) span.setAttribute("stack.external-db-sync.sequence-allocation-skipped", true);
  return result;
}

function parseMaxDurationMs(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_DURATION_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new StatusError(400, "maxDurationMs must be a positive integer");
  }
  return parsed;
}

function getSequencerBatchSize(): number {
  const rawValue = getEnvVariable(SEQUENCER_BATCH_SIZE_ENV, "");
  if (!rawValue) return DEFAULT_BATCH_SIZE;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HexclaveAssertionError(
      `${SEQUENCER_BATCH_SIZE_ENV} must be a positive integer. Received: ${JSON.stringify(rawValue)}`
    );
  }
  return parsed;
}


// Assigns sequence IDs to rows that need them and queues sync requests for affected tenants.
// Processes up to batchSize rows at a time from each table.
async function backfillSequenceIds(batchSize: number): Promise<boolean> {
  return await traceSpan({
    description: "external-db-sync.sequencer.backfill",
    attributes: {
      "stack.external-db-sync.batch-size": batchSize,
    },
  }, async (span) => {
    let didUpdate = false;

    const projectUserTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string }[]>`
      WITH rows_to_update AS (
        SELECT "tenancyId", "projectUserId"
        FROM "ProjectUser"
        WHERE "shouldUpdateSequenceId" = TRUE
        ORDER BY "tenancyId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "ProjectUser" pu
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE pu."tenancyId"     = r."tenancyId"
          AND pu."projectUserId" = r."projectUserId"
        RETURNING pu."tenancyId"
      )
      SELECT DISTINCT "tenancyId" FROM updated_rows
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.project-user-tenants", projectUserTenants.length);

    // Enqueue sync for all affected tenants in a single batch query
    if (projectUserTenants.length > 0) {
      await enqueueExternalDbSyncBatch(projectUserTenants.map(t => t.tenancyId));
      didUpdate = true;
    }

    const contactChannelTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string }[]>`
      WITH rows_to_update AS (
        SELECT "tenancyId", "projectUserId", "id"
        FROM "ContactChannel"
        WHERE "shouldUpdateSequenceId" = TRUE
        ORDER BY "tenancyId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "ContactChannel" cc
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE cc."tenancyId"     = r."tenancyId"
          AND cc."projectUserId" = r."projectUserId"
          AND cc."id"            = r."id"
        RETURNING cc."tenancyId"
      )
      SELECT DISTINCT "tenancyId" FROM updated_rows
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.contact-channel-tenants", contactChannelTenants.length);

    if (contactChannelTenants.length > 0) {
      await enqueueExternalDbSyncBatch(contactChannelTenants.map(t => t.tenancyId));
      didUpdate = true;
    }

    const teamTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string, teamId: string }[]>`
      WITH rows_to_update AS (
        SELECT "tenancyId", "teamId"
        FROM "Team"
        WHERE "shouldUpdateSequenceId" = TRUE
        ORDER BY "tenancyId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "Team" t
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE t."tenancyId" = r."tenancyId"
          AND t."teamId"    = r."teamId"
        RETURNING t."tenancyId", t."teamId"
      )
      SELECT DISTINCT "tenancyId", "teamId" FROM updated_rows
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.team-tenants", teamTenants.length);

    if (teamTenants.length > 0) {
      await enqueueExternalDbSyncBatch(teamTenants.map(t => t.tenancyId));
      didUpdate = true;

      // Cascade: when a team changes, mark related TEAM_INVITATION verification codes for re-sync
      // so the team_display_name in team_invitations stays fresh
      await globalPrismaClient.$executeRaw`
        UPDATE "VerificationCode"
        SET "shouldUpdateSequenceId" = TRUE
        FROM (
          SELECT DISTINCT "Tenancy"."projectId", "Tenancy"."branchId", "Team"."teamId"
          FROM "Team"
          JOIN "Tenancy" ON "Tenancy"."id" = "Team"."tenancyId"
          WHERE "Team"."tenancyId" IN (${Prisma.join(teamTenants.map(t => t.tenancyId))})
            AND "Team"."shouldUpdateSequenceId" = FALSE
            AND "Team"."sequenceId" IS NOT NULL
        ) AS changed_teams
        WHERE "VerificationCode"."projectId" = changed_teams."projectId"
          AND "VerificationCode"."branchId" = changed_teams."branchId"
          AND "VerificationCode"."type" = 'TEAM_INVITATION'
          AND "VerificationCode"."data"->>'team_id' = changed_teams."teamId"::text
          AND "VerificationCode"."shouldUpdateSequenceId" = FALSE
      `;
    }

    const teamMemberTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string }[]>`
      WITH rows_to_update AS (
        SELECT "tenancyId", "projectUserId", "teamId"
        FROM "TeamMember"
        WHERE "shouldUpdateSequenceId" = TRUE
        ORDER BY "tenancyId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "TeamMember" tm
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE tm."tenancyId"     = r."tenancyId"
          AND tm."projectUserId" = r."projectUserId"
          AND tm."teamId"        = r."teamId"
        RETURNING tm."tenancyId"
      )
      SELECT DISTINCT "tenancyId" FROM updated_rows
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.team-member-tenants", teamMemberTenants.length);

    if (teamMemberTenants.length > 0) {
      await enqueueExternalDbSyncBatch(teamMemberTenants.map(t => t.tenancyId));
      didUpdate = true;
    }

    const teamPermissionTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string }[]>`
      WITH rows_to_update AS (
        SELECT "id"
        FROM "TeamMemberDirectPermission"
        WHERE "shouldUpdateSequenceId" = TRUE
        ORDER BY "tenancyId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "TeamMemberDirectPermission" tp
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE tp."id" = r."id"
        RETURNING tp."tenancyId"
      )
      SELECT DISTINCT "tenancyId" FROM updated_rows
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.team-permission-tenants", teamPermissionTenants.length);

    if (teamPermissionTenants.length > 0) {
      await enqueueExternalDbSyncBatch(teamPermissionTenants.map(t => t.tenancyId));
      didUpdate = true;
    }

    const teamInvitationTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string }[]>`
      WITH rows_to_update AS (
        SELECT "projectId", "branchId", "id"
        FROM "VerificationCode"
        WHERE "shouldUpdateSequenceId" = TRUE
          AND "type" = 'TEAM_INVITATION'
        ORDER BY "projectId", "branchId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "VerificationCode" vc
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE vc."projectId" = r."projectId"
          AND vc."branchId"  = r."branchId"
          AND vc."id"        = r."id"
        RETURNING vc."projectId", vc."branchId"
      )
      SELECT DISTINCT "Tenancy"."id" AS "tenancyId"
      FROM updated_rows
      JOIN "Tenancy" ON "Tenancy"."projectId" = updated_rows."projectId"
        AND "Tenancy"."branchId" = updated_rows."branchId"
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.team-invitation-tenants", teamInvitationTenants.length);

    if (teamInvitationTenants.length > 0) {
      await enqueueExternalDbSyncBatch(teamInvitationTenants.map(t => t.tenancyId));
      didUpdate = true;
    }

    const emailOutboxTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string }[]>`
      WITH rows_to_update AS (
        SELECT "tenancyId", "id"
        FROM "EmailOutbox"
        WHERE "shouldUpdateSequenceId" = TRUE
        ORDER BY "tenancyId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "EmailOutbox" eo
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE eo."tenancyId" = r."tenancyId"
          AND eo."id"        = r."id"
        RETURNING eo."tenancyId"
      )
      SELECT DISTINCT "tenancyId" FROM updated_rows
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.email-outbox-tenants", emailOutboxTenants.length);

    if (emailOutboxTenants.length > 0) {
      await enqueueExternalDbSyncBatch(emailOutboxTenants.map(t => t.tenancyId));
      didUpdate = true;
    }

    const projectPermissionTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string }[]>`
      WITH rows_to_update AS (
        SELECT "id"
        FROM "ProjectUserDirectPermission"
        WHERE "shouldUpdateSequenceId" = TRUE
        ORDER BY "tenancyId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "ProjectUserDirectPermission" pp
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE pp."id" = r."id"
        RETURNING pp."tenancyId"
      )
      SELECT DISTINCT "tenancyId" FROM updated_rows
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.project-permission-tenants", projectPermissionTenants.length);

    if (projectPermissionTenants.length > 0) {
      await enqueueExternalDbSyncBatch(projectPermissionTenants.map(t => t.tenancyId));
      didUpdate = true;
    }

    const notificationPreferenceTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string }[]>`
      WITH rows_to_update AS (
        SELECT "tenancyId", "id"
        FROM "UserNotificationPreference"
        WHERE "shouldUpdateSequenceId" = TRUE
        ORDER BY "tenancyId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "UserNotificationPreference" np
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE np."tenancyId" = r."tenancyId"
          AND np."id"        = r."id"
        RETURNING np."tenancyId"
      )
      SELECT DISTINCT "tenancyId" FROM updated_rows
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.notification-preference-tenants", notificationPreferenceTenants.length);

    if (notificationPreferenceTenants.length > 0) {
      await enqueueExternalDbSyncBatch(notificationPreferenceTenants.map(t => t.tenancyId));
      didUpdate = true;
    }

    const refreshTokenTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string }[]>`
      WITH rows_to_update AS (
        SELECT "tenancyId", "id"
        FROM "ProjectUserRefreshToken"
        WHERE "shouldUpdateSequenceId" = TRUE
        ORDER BY "tenancyId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "ProjectUserRefreshToken" rt
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE rt."tenancyId" = r."tenancyId"
          AND rt."id"        = r."id"
        RETURNING rt."tenancyId"
      )
      SELECT DISTINCT "tenancyId" FROM updated_rows
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.refresh-token-tenants", refreshTokenTenants.length);

    if (refreshTokenTenants.length > 0) {
      await enqueueExternalDbSyncBatch(refreshTokenTenants.map(t => t.tenancyId));
      didUpdate = true;
    }

    const oauthAccountTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string }[]>`
      WITH rows_to_update AS (
        SELECT "tenancyId", "id"
        FROM "ProjectUserOAuthAccount"
        WHERE "shouldUpdateSequenceId" = TRUE
        ORDER BY "tenancyId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "ProjectUserOAuthAccount" oa
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE oa."tenancyId" = r."tenancyId"
          AND oa."id"        = r."id"
        RETURNING oa."tenancyId"
      )
      SELECT DISTINCT "tenancyId" FROM updated_rows
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.oauth-account-tenants", oauthAccountTenants.length);

    if (oauthAccountTenants.length > 0) {
      await enqueueExternalDbSyncBatch(oauthAccountTenants.map(t => t.tenancyId));
      didUpdate = true;
    }

    const deletedRowTenants = (await runSequenceAllocation((tx) => tx.$queryRaw<{ tenancyId: string }[]>`
      WITH rows_to_update AS (
        SELECT "id", "tenancyId"
        FROM "DeletedRow"
        WHERE "shouldUpdateSequenceId" = TRUE
        ORDER BY "tenancyId"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "DeletedRow" dr
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE dr."id" = r."id"
        RETURNING dr."tenancyId"
      )
      SELECT DISTINCT "tenancyId" FROM updated_rows
    `, span)) ?? [];

    span.setAttribute("stack.external-db-sync.deleted-row-tenants", deletedRowTenants.length);

    if (deletedRowTenants.length > 0) {
      await enqueueExternalDbSyncBatch(deletedRowTenants.map(t => t.tenancyId));
      didUpdate = true;
    }

    span.setAttribute("stack.external-db-sync.did-update", didUpdate);
    if (didUpdate) {
      console.log(`[Sequencer] Backfilled sequence IDs: USR=${projectUserTenants.length}, CC=${contactChannelTenants.length}, TM=${teamTenants.length}, TMB=${teamMemberTenants.length}, TP=${teamPermissionTenants.length}, TI=${teamInvitationTenants.length}, EO=${emailOutboxTenants.length}, PP=${projectPermissionTenants.length}, NP=${notificationPreferenceTenants.length}, RT=${refreshTokenTenants.length}, CA=${oauthAccountTenants.length}, DR=${deletedRowTenants.length}`);
    }

    return didUpdate;
  });
}

// TODO: If we ever need to support non-hosted source-of-truth tenancies again,
// we'll need to implement a scalable way to iterate over them (pagination, etc.)
// instead of loading all tenancies into memory at once.

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Run sequence ID backfill",
    description:
      "Internal endpoint invoked by Vercel Cron to backfill null sequence IDs.",
    tags: ["External DB Sync"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({}).nullable().optional(),
    method: yupString().oneOf(["GET"]).defined(),
    headers: yupObject({
      authorization: yupTuple([yupString().defined()]).optional(),
    }).defined(),
    query: yupObject({
      maxDurationMs: yupString().optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      ok: yupBoolean().defined(),
      iterations: yupNumber().defined(),
    }).defined(),
  }),
  handler: async ({ headers, query, auth }) => {
    const isAdmin = auth?.type === "admin" && auth.project.id === "internal";
    const authHeader = headers.authorization?.[0];
    if (!isAdmin && authHeader !== `Bearer ${getEnvVariable("CRON_SECRET")}`) {
      throw new StatusError(401, "Unauthorized");
    }

    return await traceSpan("external-db-sync.sequencer", async (span) => {
      const startTime = performance.now();
      const maxDurationMs = parseMaxDurationMs(query.maxDurationMs);
      const pollIntervalMs = 50;
      const batchSize = getSequencerBatchSize();

      span.setAttribute("stack.external-db-sync.max-duration-ms", maxDurationMs);
      span.setAttribute("stack.external-db-sync.poll-interval-ms", pollIntervalMs);
      span.setAttribute("stack.external-db-sync.batch-size", batchSize);

      let iterations = 0;

      type SequencerIterationResult = {
        stopReason: "disabled" | null,
      };

      while (performance.now() - startTime < maxDurationMs) {
        const iterationResult = await traceSpan<SequencerIterationResult>({
          description: "external-db-sync.sequencer.iteration",
          attributes: {
            "stack.external-db-sync.iteration": iterations + 1,
          },
        }, async (iterationSpan) => {
          const fusebox = await getExternalDbSyncFusebox();
          iterationSpan.setAttribute("stack.external-db-sync.sequencer-enabled", fusebox.sequencerEnabled);
          if (!fusebox.sequencerEnabled) {
            return { stopReason: "disabled" };
          }

          try {
            const didUpdate = await backfillSequenceIds(batchSize);
            iterationSpan.setAttribute("stack.external-db-sync.did-update", didUpdate);
          } catch (error) {
            iterationSpan.setAttribute("stack.external-db-sync.iteration-error", true);
            captureError(
              `sequencer-iteration-error`,
              error,
            );
          }

          return { stopReason: null };
        });

        iterations++;
        await wait(pollIntervalMs);
      }

      span.setAttribute("stack.external-db-sync.iterations", iterations);

      return {
        statusCode: 200,
        bodyType: "json" as const,
        body: {
          ok: true,
          iterations,
        },
      };
    });
  },
});

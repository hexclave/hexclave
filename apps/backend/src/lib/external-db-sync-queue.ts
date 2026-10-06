import { globalPrismaClient, type PrismaClientTransaction } from "@/prisma-client";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || !UUID_REGEX.test(value)) {
    throw new HexclaveAssertionError(`${label} must be a valid UUID. Received: ${JSON.stringify(value)}`);
  }
}

// Queues a sync request for a specific tenant if one isn't already pending.
// The client is injectable so callers can run the insert on their own connection or transaction (e.g. an isolated schema in tests).
export async function enqueueExternalDbSync(tenancyId: string, client: PrismaClientTransaction = globalPrismaClient): Promise<void> {
  assertUuid(tenancyId, "tenancyId");
  await enqueueExternalDbSyncBatch([tenancyId], client);
}

// Queues sync requests for multiple tenants in a single query.
// Only inserts for tenants that don't already have a pending request.
export async function enqueueExternalDbSyncBatch(tenancyIds: string[], client: PrismaClientTransaction = globalPrismaClient): Promise<void> {
  if (tenancyIds.length === 0) return;

  for (const id of tenancyIds) {
    assertUuid(id, "tenancyId");
  }

  const sortedTenancyIds = [...new Set(tenancyIds)].sort();

  // Use unnest to pass array of UUIDs and insert all in one query
  await client.$executeRaw`
    INSERT INTO "OutgoingRequest" ("id", "createdAt", "qstashOptions", "startedFulfillingAt", "deduplicationKey")
    SELECT
      gen_random_uuid(),
      NOW(),
      json_build_object(
        'url',  '/api/latest/internal/external-db-sync/sync-engine',
        'body', json_build_object('tenancyId', t.tenancy_id),
        'job', json_build_object(
          'schemaVersion', 1,
          'jobId', 'sentinel-sync-key-' || t.tenancy_id,
          'jobType', 'external-db-sync',
          'tenancyId', t.tenancy_id,
          'deduplicationKey', 'sentinel-sync-key-' || t.tenancy_id,
          'payload', json_build_object('tenancyId', t.tenancy_id)
        ),
        'flowControl', json_build_object('key', 'sentinel-sync-key', 'parallelism', 20)
      ),
      NULL,
      'sentinel-sync-key-' || t.tenancy_id
    FROM unnest(${sortedTenancyIds}::uuid[]) AS t(tenancy_id)
    ORDER BY t.tenancy_id
    ON CONFLICT ("deduplicationKey") WHERE "startedFulfillingAt" IS NULL DO NOTHING
  `;
}

export type RecoverStaleResult = { resetIds: string[], deletedIds: string[] };

// Recovers OutgoingRequest rows that were claimed (startedFulfillingAt set)
// but never deleted — typically because the poller died mid-iteration. We
// can't naively reset every stale row because the partial unique index
// `OutgoingRequest_deduplicationKey_pending_key` would reject any reset that
// produces a duplicate among rows where startedFulfillingAt IS NULL.
//
// Per stale row:
//   - dedup key is NULL                    -> reset (NULLs don't enter the index)
//   - any active sibling exists for the    -> delete (the active sibling already
//     same key (pending OR fresh-in-flight)   represents the work; resetting would
//                                              create concurrent duplicate work)
//   - shares key with other stale rows     -> reset the oldest, delete the rest
//   - otherwise                            -> reset
//
// "Active sibling" includes both pending rows and rows currently being processed
// by another poller invocation — we don't want recovery to spawn a parallel
// sync alongside an already-in-flight one for the same tenancy.
//
// Concurrency notes (READ COMMITTED):
//   - Mutation CTEs repeat the staleness predicate so EvalPlanQual skips rows
//     another transaction reset/deleted/re-claimed during the lock wait —
//     otherwise we could clobber a freshly-claimed row back to pending.
//   - A concurrent sequencer INSERT for the same key between our EXISTS check
//     and UPDATE raises P2010 (SQLSTATE 23505). The poller call site catches
//     it so the rest of the iteration keeps processing; the next cron tick
//     re-runs recovery on a fresh snapshot.
export async function recoverStaleOutgoingRequests(staleThresholdMs: number): Promise<RecoverStaleResult> {
  type Row = { action: "reset" | "delete", id: string };
  const rows = await globalPrismaClient.$queryRaw<Row[]>`
      WITH stale AS (
        SELECT
          o."id",
          CASE
            WHEN o."deduplicationKey" IS NULL THEN 'reset'::text
            WHEN EXISTS (
              SELECT 1 FROM "OutgoingRequest" p
              WHERE p."deduplicationKey" = o."deduplicationKey"
                AND (
                  p."startedFulfillingAt" IS NULL
                  OR p."startedFulfillingAt" >= NOW() - ${staleThresholdMs} * INTERVAL '1 millisecond'
                )
            ) THEN 'delete'::text
            WHEN ROW_NUMBER() OVER (
              PARTITION BY o."deduplicationKey"
              ORDER BY o."createdAt" ASC, o."id" ASC
            ) = 1 THEN 'reset'::text
            ELSE 'delete'::text
          END AS action
        FROM "OutgoingRequest" o
        WHERE o."startedFulfillingAt" IS NOT NULL
          AND o."startedFulfillingAt" < NOW() - ${staleThresholdMs} * INTERVAL '1 millisecond'
        -- Drain oldest first; LIMIT caps each call so a backlog can't blow
        -- up one transaction. Subsequent poll iterations mop up the rest.
        ORDER BY o."startedFulfillingAt" ASC, o."id" ASC
        LIMIT 100
      ),
      -- Both mutation CTEs repeat the staleness predicate so that under
      -- READ COMMITTED, EvalPlanQual re-evaluates against the latest row
      -- version after any lock wait and skips rows that are no longer stale
      -- (because a concurrent recovery reset/deleted them or a poller
      -- re-claimed the row in the gap).
      deleted AS (
        DELETE FROM "OutgoingRequest" o
        USING stale s
        WHERE o."id" = s."id"
          AND s.action = 'delete'
          AND o."startedFulfillingAt" IS NOT NULL
          AND o."startedFulfillingAt" < NOW() - ${staleThresholdMs} * INTERVAL '1 millisecond'
        RETURNING o."id"
      ),
      reset AS (
        UPDATE "OutgoingRequest" o
        SET "startedFulfillingAt" = NULL
        FROM stale s
        WHERE o."id" = s."id"
          AND s.action = 'reset'
          AND o."startedFulfillingAt" IS NOT NULL
          AND o."startedFulfillingAt" < NOW() - ${staleThresholdMs} * INTERVAL '1 millisecond'
        RETURNING o."id"
      )
      -- Read from the mutation CTEs (not from the planning CTE) so the counts
      -- reflect rows that actually changed. Under concurrent recovery this
      -- matters: a row that was deleted/reset by another transaction between
      -- snapshot and execution would still appear in the planning CTE but
      -- not in the mutation CTEs.
      SELECT 'reset'::text AS action, "id" FROM reset
      UNION ALL
      SELECT 'delete'::text AS action, "id" FROM deleted
    `;
  return {
    resetIds: rows.filter(r => r.action === "reset").map(r => r.id),
    deletedIds: rows.filter(r => r.action === "delete").map(r => r.id),
  };
}

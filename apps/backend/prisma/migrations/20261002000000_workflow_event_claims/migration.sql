-- Workflow event dispatch: claims, and indexes that stay cheap under a backlog.
--
-- `claimedUntil` is the dispatch lease (see the column comment in
-- schema.prisma). Nullable with no default, so every existing event starts
-- unclaimed and nothing is rewritten.
--
-- The two indexes are partial over unprocessed rows only, so their size tracks
-- the backlog rather than the 30 days of processed history:
--   * WorkflowEvent_pending_idx is keyed ("tenancyId", "type", "scheduledAt").
--     The dispatcher never walks the backlog in global time order — that made
--     every claim step over all the rows of whichever tenancy was being
--     dispatched. It asks instead for "the oldest due events of THIS tenancy
--     for THIS event type", and the sweep asks "which (tenancy, type) pairs
--     have pending events at all"; both are a handful of index probes however
--     large the backlog is. The existing WorkflowEvent_outbox_idx
--     ("processedAt", "retryAt", "scheduledAt") can do neither.
--   * WorkflowEvent_pending_claim_idx holds only currently-claimed events and
--     answers "which tenancies are being dispatched right now".
--
-- Built CONCURRENTLY because every user/team/permission write inserts into
-- this table inside its own transaction; a plain build would block all of them
-- for as long as it takes to scan the table. Statements on this path can
-- commit before the migration is recorded, so each one is safe to re-run.
--
-- ADD COLUMN needs ACCESS EXCLUSIVE, if only for an instant. Without a lock
-- timeout it would queue behind any transaction that has touched the table —
-- and every insert (so every user write, on every project) would queue behind
-- IT. Failing fast and re-running the migration is the better outcome; the
-- remnant cleanup below runs in the same transaction and is covered too.
SET LOCAL lock_timeout = '3s';
ALTER TABLE "WorkflowEvent" ADD COLUMN IF NOT EXISTS "claimedUntil" TIMESTAMP(3);

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- An interrupted concurrent build leaves an INVALID index behind under the
-- final name, which IF NOT EXISTS below would then silently keep. Drop such a
-- remnant first; a valid index is left alone.
DO $$
DECLARE
  remnant RECORD;
BEGIN
  FOR remnant IN
    SELECT index_relation.relname AS index_name
    FROM pg_index index_metadata
    JOIN pg_class index_relation ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_class table_relation ON table_relation.oid = index_metadata.indrelid
    JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND table_relation.relname = 'WorkflowEvent'
      AND index_relation.relname IN ('WorkflowEvent_pending_idx', 'WorkflowEvent_pending_claim_idx')
      AND NOT (index_metadata.indisvalid AND index_metadata.indisready)
  LOOP
    EXECUTE format('DROP INDEX %I', remnant.index_name);
  END LOOP;
END
$$;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
-- A concurrent build scans the whole table twice, however small the partial
-- index ends up, and each build is ONE statement. Under a statement timeout it
-- would be cancelled on a large table, leave an invalid index, and do the same
-- on every re-run. Lifted for this session only and restored below; the
-- session is the migration runner's own and is closed when it finishes.
SET statement_timeout = 0;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WorkflowEvent_pending_idx"
  ON /* SCHEMA_NAME_SENTINEL */."WorkflowEvent"("tenancyId", "type", "scheduledAt")
  WHERE "processedAt" IS NULL;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WorkflowEvent_pending_claim_idx"
  ON /* SCHEMA_NAME_SENTINEL */."WorkflowEvent"("claimedUntil", "tenancyId")
  WHERE "processedAt" IS NULL AND "claimedUntil" IS NOT NULL;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
RESET statement_timeout;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
DO $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM pg_index index_metadata
    JOIN pg_class index_relation ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_class table_relation ON table_relation.oid = index_metadata.indrelid
    JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND table_relation.relname = 'WorkflowEvent'
      AND index_relation.relname IN ('WorkflowEvent_pending_idx', 'WorkflowEvent_pending_claim_idx')
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indpred IS NOT NULL
  ) <> 2 THEN
    RAISE EXCEPTION 'WorkflowEvent pending indexes did not finish as valid partial indexes';
  END IF;
END
$$;

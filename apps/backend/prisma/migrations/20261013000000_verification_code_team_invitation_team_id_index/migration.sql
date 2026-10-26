-- Lets the external DB sync find the TEAM_INVITATION codes of a specific team (the sequencer's
-- team -> invitation cascade, and recording invitation deletions when a team is deleted). Without
-- it, those lookups scan every verification code of the project (OTPs, password resets, MFA
-- attempts, ...), since neither the primary key nor the jsonb_path_ops GIN index on "data" can
-- serve a `"data"->>'team_id' = ...` predicate.
--
-- Prisma can't express expression indexes, so this index only exists in migrations (like the
-- "Event" data->>... indexes). Queries must use the exact expression `"data"->>'team_id'` and the
-- predicate `"type" = 'TEAM_INVITATION'` for the planner to pick it.
--
-- If a previous run failed mid-build, the index is left behind INVALID and IF NOT EXISTS would
-- silently keep it, so drop such a remnant first. A valid index (eg. pre-built by an operator) is
-- left alone.
-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
DO $$
DECLARE
  remnant RECORD;
BEGIN
  -- A plain DROP INDEX briefly needs ACCESS EXCLUSIVE on VerificationCode; fail fast instead of
  -- queueing every sign-in/OTP write behind it.
  PERFORM set_config('lock_timeout', '3s', true);
  FOR remnant IN
    SELECT index_relation.relname AS index_name
    FROM pg_index index_metadata
    JOIN pg_class index_relation ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_class table_relation ON table_relation.oid = index_metadata.indrelid
    JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND table_relation.relname = 'VerificationCode'
      AND index_relation.relname = 'VerificationCode_team_invitation_team_id_idx'
      AND NOT (index_metadata.indisvalid AND index_metadata.indisready)
  LOOP
    EXECUTE format('DROP INDEX %I', remnant.index_name);
  END LOOP;
END
$$;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
-- A concurrent build scans the whole table twice in one statement; VerificationCode is large, so
-- the default statement timeout could cancel it on every run. Lifted for this session only.
SET statement_timeout = 0;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "VerificationCode_team_invitation_team_id_idx"
  ON /* SCHEMA_NAME_SENTINEL */."VerificationCode" ("projectId", "branchId", ("data"->>'team_id'))
  WHERE "type" = 'TEAM_INVITATION';

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
RESET statement_timeout;

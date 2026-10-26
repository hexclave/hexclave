-- Serves every per-user lookup on refresh tokens (user deletion, password change, session listing, sign-out
-- of all sessions), which otherwise scan every refresh token of the tenancy via the (tenancyId, id) primary key.
-- If a previous run failed mid-build (eg. crash or statement timeout), CREATE INDEX CONCURRENTLY leaves an
-- INVALID index behind that the IF NOT EXISTS below would silently keep, and that the planner never uses.
-- Drop such a remnant first; a valid index (eg. pre-built out of band by an operator) is left alone.
-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
DO $$
BEGIN
  -- A plain DROP INDEX needs ACCESS EXCLUSIVE on the table, if only for an instant. Without a lock timeout it
  -- would queue behind any transaction touching refresh tokens, and every token refresh would queue behind IT.
  PERFORM set_config('lock_timeout', '3s', true);
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = idx.relnamespace
    WHERE n.nspname = current_schema()
      AND idx.relname = 'ProjectUserRefreshToken_tenancyId_projectUserId_idx'
      AND tbl.relname = 'ProjectUserRefreshToken'
      AND NOT (i.indisvalid AND i.indisready)
  ) THEN
    DROP INDEX "ProjectUserRefreshToken_tenancyId_projectUserId_idx";
  END IF;
END
$$;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
-- A concurrent build scans the whole table twice in ONE statement, so on a large refresh token table the
-- default statement timeout could cancel it on every run. Lifted for this session only and restored below.
SET statement_timeout = 0;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ProjectUserRefreshToken_tenancyId_projectUserId_idx"
  ON /* SCHEMA_NAME_SENTINEL */."ProjectUserRefreshToken"("tenancyId", "projectUserId");

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
RESET statement_timeout;

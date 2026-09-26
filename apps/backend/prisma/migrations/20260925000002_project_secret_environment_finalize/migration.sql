-- Drops the old (projectId, key) unique index, which would otherwise stop a
-- key from having both an `all` and a per-environment row, and validates the
-- environment check added NOT VALID in 20260925000000.

-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DROP INDEX CONCURRENTLY IF EXISTS /* SCHEMA_NAME_SENTINEL */."ProjectSecret_projectId_key_key";

-- SPLIT_STATEMENT_SENTINEL
ALTER TABLE "ProjectSecret" VALIDATE CONSTRAINT "ProjectSecret_environment_check";

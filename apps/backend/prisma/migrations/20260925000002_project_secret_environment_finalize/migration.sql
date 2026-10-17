-- Drops the old (projectId, key) unique index, which would otherwise stop a
-- key from having both a `DEFAULT` and a per-environment row.

-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DROP INDEX CONCURRENTLY IF EXISTS /* SCHEMA_NAME_SENTINEL */."ProjectSecret_projectId_key_key";

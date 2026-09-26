-- Builds the (projectId, key, environment) unique index concurrently. The old
-- (projectId, key) index stays until 20260925000002, so for the duration of
-- this migration a key still has at most one row (in practice, `all`).
--
-- An interrupted CREATE INDEX CONCURRENTLY leaves an INVALID index behind,
-- which `IF NOT EXISTS` would then silently accept. So an invalid remnant is
-- renamed aside and dropped first, and the result is verified at the end.

-- SINGLE_STATEMENT_SENTINEL
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = idx.relnamespace
    WHERE n.nspname = current_schema()
      AND idx.relname = 'ProjectSecret_projectId_key_environment_key'
      AND NOT (i.indisvalid AND i.indisready)
  ) THEN
    EXECUTE format('ALTER INDEX %I RENAME TO %I', 'ProjectSecret_projectId_key_environment_key', 'ProjectSecret_projectId_key_environment_key_invalid');
  END IF;
END
$$;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DROP INDEX CONCURRENTLY IF EXISTS /* SCHEMA_NAME_SENTINEL */."ProjectSecret_projectId_key_environment_key_invalid";

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ProjectSecret_projectId_key_environment_key"
  ON /* SCHEMA_NAME_SENTINEL */."ProjectSecret"("projectId", "key", "environment");

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = tbl.relnamespace
    WHERE n.nspname = current_schema()
      AND idx.relname = 'ProjectSecret_projectId_key_environment_key'
      AND tbl.relname = 'ProjectSecret'
      AND i.indisvalid
      AND i.indisready
      AND i.indisunique
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND (
        SELECT array_agg(a.attname::text ORDER BY k.ordinality)
        FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      ) = ARRAY['projectId', 'key', 'environment']
  ) THEN
    RAISE EXCEPTION 'ProjectSecret_projectId_key_environment_key did not finish with the expected valid unique definition';
  END IF;
END
$$;

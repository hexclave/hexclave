-- This unique index is the key that ExternalAuthMethod's composite foreign key (tenancyId, authMethodId,
-- projectUserId) references, so it must exist and be valid before that foreign key is added.
-- If a previous run of this migration failed mid-build (eg. crash or statement timeout), the index is
-- left behind in an INVALID state, and the CREATE below would silently skip it due to IF NOT EXISTS —
-- leaving the foreign key without a usable referenced key. Drop such a remnant first. A valid index is
-- left alone, so an index that was pre-built out of band (eg. by an operator, to keep the build out of
-- the deploy) is not thrown away and rebuilt.
-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
DO $$
DECLARE
  remnant RECORD;
BEGIN
  -- A plain DROP INDEX needs ACCESS EXCLUSIVE on AuthMethod, if only for an instant. Without a lock
  -- timeout it would queue behind any transaction that has touched the table, and every sign-in/sign-up
  -- write would queue behind IT. Failing fast and re-running the migration is the better outcome.
  PERFORM set_config('lock_timeout', '3s', true);
  FOR remnant IN
    SELECT index_relation.relname AS index_name
    FROM pg_index index_metadata
    JOIN pg_class index_relation ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_class table_relation ON table_relation.oid = index_metadata.indrelid
    JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND table_relation.relname = 'AuthMethod'
      AND index_relation.relname = 'AuthMethod_tenancyId_id_projectUserId_key'
      AND NOT (index_metadata.indisvalid AND index_metadata.indisready)
  LOOP
    EXECUTE format('DROP INDEX %I', remnant.index_name);
  END LOOP;
END
$$;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
-- A concurrent build scans the whole table twice, and each build is ONE statement. AuthMethod has a row
-- per auth method of every user, so under the default statement timeout the build could be cancelled,
-- leave an invalid index, and do the same on every re-run. Lifted for this session only and restored
-- below; the session is the migration runner's own and is closed when it finishes.
SET statement_timeout = 0;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "AuthMethod_tenancyId_id_projectUserId_key"
    ON /* SCHEMA_NAME_SENTINEL */."AuthMethod"("tenancyId", "id", "projectUserId");

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
RESET statement_timeout;

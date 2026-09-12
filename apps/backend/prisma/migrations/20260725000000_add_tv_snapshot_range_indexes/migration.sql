-- Fail before starting any expensive work if an unrelated relation already
-- occupies one of these names. A failed concurrent build is renamed below so
-- it can be dropped outside a transaction before the rebuild.
-- CREATE INDEX IF NOT EXISTS only checks the name, so it is not sufficient by itself.
-- SINGLE_STATEMENT_SENTINEL
DO $$
DECLARE
  expected RECORD;
  existing RECORD;
BEGIN
  FOR expected IN
    SELECT *
    FROM (VALUES
      ('SubscriptionInvoice_tenancyId_createdAt_idx', 'SubscriptionInvoice'),
      ('Subscription_tenancyId_createdAt_idx', 'Subscription'),
      ('EmailOutbox_tenancyId_createdAt_idx', 'EmailOutbox')
    ) AS expected_indexes(index_name, table_name)
  LOOP
    SELECT
      table_relation.relname AS table_name,
      index_metadata.indisvalid,
      index_metadata.indisready,
      index_metadata.indisunique,
      index_metadata.indpred IS NULL AS has_no_predicate,
      access_method.amname AS access_method,
      (
        SELECT array_agg(table_attribute.attname::text ORDER BY index_key.ordinality)
        FROM unnest(index_metadata.indkey::smallint[]) WITH ORDINALITY
          AS index_key(attribute_number, ordinality)
        JOIN pg_attribute table_attribute
          ON table_attribute.attrelid = index_metadata.indrelid
          AND table_attribute.attnum = index_key.attribute_number
        WHERE index_key.ordinality <= index_metadata.indnkeyatts
      ) AS key_columns
    INTO existing
    FROM pg_class index_relation
    JOIN pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    LEFT JOIN pg_index index_metadata
      ON index_metadata.indexrelid = index_relation.oid
    LEFT JOIN pg_class table_relation
      ON table_relation.oid = index_metadata.indrelid
    LEFT JOIN pg_am access_method
      ON access_method.oid = index_relation.relam
    WHERE index_namespace.nspname = current_schema()
      AND index_relation.relname = expected.index_name || '_invalid';

    IF FOUND AND (
      existing.table_name IS DISTINCT FROM expected.table_name
      OR (
        existing.indisvalid IS DISTINCT FROM FALSE
        AND existing.indisready IS DISTINCT FROM FALSE
      )
      OR existing.indisunique IS DISTINCT FROM FALSE
      OR existing.has_no_predicate IS DISTINCT FROM TRUE
      OR existing.access_method IS DISTINCT FROM 'btree'
      OR existing.key_columns IS DISTINCT FROM ARRAY['tenancyId', 'createdAt']
    ) THEN
      RAISE EXCEPTION
        'TV snapshot invalid-index remnant % exists but has an unexpected definition; refusing to drop it',
        expected.index_name || '_invalid';
    END IF;
  END LOOP;
END
$$;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DROP INDEX CONCURRENTLY IF EXISTS /* SCHEMA_NAME_SENTINEL */."SubscriptionInvoice_tenancyId_createdAt_idx_invalid";

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DROP INDEX CONCURRENTLY IF EXISTS /* SCHEMA_NAME_SENTINEL */."Subscription_tenancyId_createdAt_idx_invalid";

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DROP INDEX CONCURRENTLY IF EXISTS /* SCHEMA_NAME_SENTINEL */."EmailOutbox_tenancyId_createdAt_idx_invalid";

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
DO $$
DECLARE
  expected RECORD;
  existing RECORD;
BEGIN
  FOR expected IN
    SELECT *
    FROM (VALUES
      ('SubscriptionInvoice_tenancyId_createdAt_idx', 'SubscriptionInvoice'),
      ('Subscription_tenancyId_createdAt_idx', 'Subscription'),
      ('EmailOutbox_tenancyId_createdAt_idx', 'EmailOutbox')
    ) AS expected_indexes(index_name, table_name)
  LOOP
    SELECT
      table_relation.relname AS table_name,
      index_metadata.indisvalid,
      index_metadata.indisready,
      index_metadata.indisunique,
      index_metadata.indpred IS NULL AS has_no_predicate,
      access_method.amname AS access_method,
      (
        SELECT array_agg(table_attribute.attname::text ORDER BY index_key.ordinality)
        FROM unnest(index_metadata.indkey::smallint[]) WITH ORDINALITY
          AS index_key(attribute_number, ordinality)
        JOIN pg_attribute table_attribute
          ON table_attribute.attrelid = index_metadata.indrelid
          AND table_attribute.attnum = index_key.attribute_number
        WHERE index_key.ordinality <= index_metadata.indnkeyatts
      ) AS key_columns
    INTO existing
    FROM pg_class index_relation
    JOIN pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    LEFT JOIN pg_index index_metadata
      ON index_metadata.indexrelid = index_relation.oid
    LEFT JOIN pg_class table_relation
      ON table_relation.oid = index_metadata.indrelid
    LEFT JOIN pg_am access_method
      ON access_method.oid = index_relation.relam
    WHERE index_namespace.nspname = current_schema()
      AND index_relation.relname = expected.index_name;

    IF FOUND AND (
      existing.table_name IS DISTINCT FROM expected.table_name
      OR existing.indisunique IS DISTINCT FROM FALSE
      OR existing.has_no_predicate IS DISTINCT FROM TRUE
      OR existing.access_method IS DISTINCT FROM 'btree'
      OR existing.key_columns IS DISTINCT FROM ARRAY['tenancyId', 'createdAt']
    ) THEN
      RAISE EXCEPTION
        'TV snapshot index % already exists but is invalid or has an unexpected definition; drop it concurrently and retry',
        expected.index_name;
    ELSIF FOUND AND (
      existing.indisvalid IS DISTINCT FROM TRUE
      OR existing.indisready IS DISTINCT FROM TRUE
    ) THEN
      EXECUTE format(
        'ALTER INDEX %I RENAME TO %I',
        expected.index_name,
        expected.index_name || '_invalid'
      );
    END IF;
  END LOOP;
END
$$;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DROP INDEX CONCURRENTLY IF EXISTS /* SCHEMA_NAME_SENTINEL */."SubscriptionInvoice_tenancyId_createdAt_idx_invalid";

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SubscriptionInvoice_tenancyId_createdAt_idx"
  ON /* SCHEMA_NAME_SENTINEL */."SubscriptionInvoice"("tenancyId", "createdAt");

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DROP INDEX CONCURRENTLY IF EXISTS /* SCHEMA_NAME_SENTINEL */."Subscription_tenancyId_createdAt_idx_invalid";

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Subscription_tenancyId_createdAt_idx"
  ON /* SCHEMA_NAME_SENTINEL */."Subscription"("tenancyId", "createdAt");

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DROP INDEX CONCURRENTLY IF EXISTS /* SCHEMA_NAME_SENTINEL */."EmailOutbox_tenancyId_createdAt_idx_invalid";

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "EmailOutbox_tenancyId_createdAt_idx"
  ON /* SCHEMA_NAME_SENTINEL */."EmailOutbox"("tenancyId", "createdAt");

-- SPLIT_STATEMENT_SENTINEL
-- The migration runner records completion only after this postcondition succeeds.
-- This prevents a retry from silently accepting an invalid index left by PostgreSQL.
-- SINGLE_STATEMENT_SENTINEL
DO $$
DECLARE
  expected RECORD;
BEGIN
  FOR expected IN
    SELECT *
    FROM (VALUES
      ('SubscriptionInvoice_tenancyId_createdAt_idx', 'SubscriptionInvoice'),
      ('Subscription_tenancyId_createdAt_idx', 'Subscription'),
      ('EmailOutbox_tenancyId_createdAt_idx', 'EmailOutbox')
    ) AS expected_indexes(index_name, table_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index index_metadata
      JOIN pg_class index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_namespace index_namespace
        ON index_namespace.oid = index_relation.relnamespace
      JOIN pg_class table_relation
        ON table_relation.oid = index_metadata.indrelid
      JOIN pg_namespace table_namespace
        ON table_namespace.oid = table_relation.relnamespace
      JOIN pg_am access_method
        ON access_method.oid = index_relation.relam
      WHERE index_namespace.nspname = current_schema()
        AND table_namespace.nspname = current_schema()
        AND index_relation.relname = expected.index_name
        AND table_relation.relname = expected.table_name
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND NOT index_metadata.indisunique
        AND index_metadata.indpred IS NULL
        AND access_method.amname = 'btree'
        AND (
          SELECT array_agg(table_attribute.attname::text ORDER BY index_key.ordinality)
          FROM unnest(index_metadata.indkey::smallint[]) WITH ORDINALITY
            AS index_key(attribute_number, ordinality)
          JOIN pg_attribute table_attribute
            ON table_attribute.attrelid = index_metadata.indrelid
            AND table_attribute.attnum = index_key.attribute_number
          WHERE index_key.ordinality <= index_metadata.indnkeyatts
        ) = ARRAY['tenancyId', 'createdAt']
    ) THEN
      RAISE EXCEPTION
        'TV snapshot index % did not finish with the expected valid definition',
        expected.index_name;
    END IF;
  END LOOP;
END
$$;

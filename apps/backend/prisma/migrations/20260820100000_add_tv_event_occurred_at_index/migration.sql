-- TV event occurred-at index recovery tolerates invalid remnants from interrupted concurrent builds.
-- SINGLE_STATEMENT_SENTINEL
DO $$
DECLARE
  existing RECORD;
BEGIN
  SELECT
    table_relation.relname AS table_name,
    index_metadata.indisvalid,
    index_metadata.indisready,
    index_metadata.indnatts,
    index_metadata.indnkeyatts,
    index_metadata.indisunique,
    pg_index_column_has_property(index_relation.oid, 1, 'desc') AS first_key_is_desc,
    pg_index_column_has_property(index_relation.oid, 2, 'desc') AS second_key_is_desc,
    pg_index_column_has_property(index_relation.oid, 3, 'desc') AS third_key_is_desc,
    index_metadata.indpred IS NULL AS has_no_predicate,
    index_metadata.indexprs IS NULL AS has_no_expressions,
    pg_get_indexdef(index_relation.oid) AS index_definition,
    pg_get_expr(index_metadata.indpred, index_metadata.indrelid) AS predicate_definition,
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
  JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
  LEFT JOIN pg_index index_metadata ON index_metadata.indexrelid = index_relation.oid
  LEFT JOIN pg_class table_relation ON table_relation.oid = index_metadata.indrelid
  LEFT JOIN pg_am access_method ON access_method.oid = index_relation.relam
  WHERE index_namespace.nspname = current_schema()
    AND index_relation.relname = 'TvEventOccurrence_occurred_lookup_idx_invalid';

  IF FOUND AND (
    existing.table_name IS DISTINCT FROM 'TvEventOccurrence'
    -- An interrupted concurrent build can leave indisvalid=false with indisready=true, so a remnant only has to fail one of the two flags to be recognisable as ours; requiring both would make an interrupted migration unrecoverable.
    OR (
      existing.indisvalid IS DISTINCT FROM FALSE
      AND existing.indisready IS DISTINCT FROM FALSE
    )
    OR existing.indisunique IS DISTINCT FROM FALSE
    OR existing.indnatts IS DISTINCT FROM existing.indnkeyatts
    OR existing.has_no_predicate IS DISTINCT FROM TRUE
    OR existing.has_no_expressions IS DISTINCT FROM TRUE
    OR existing.access_method IS DISTINCT FROM 'btree'
    OR existing.first_key_is_desc IS DISTINCT FROM FALSE
    OR existing.second_key_is_desc IS DISTINCT FROM TRUE
    OR existing.third_key_is_desc IS DISTINCT FROM FALSE
    OR existing.key_columns IS DISTINCT FROM ARRAY['tenancyId', 'occurredAt', 'id']
  ) THEN
    RAISE EXCEPTION 'TV event occurred-at invalid-index remnant % exists but has an unexpected definition; refusing to drop it', 'TvEventOccurrence_occurred_lookup_idx_invalid';
  END IF;
END
$$;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DROP INDEX CONCURRENTLY IF EXISTS /* SCHEMA_NAME_SENTINEL */."TvEventOccurrence_occurred_lookup_idx_invalid";

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
DO $$
DECLARE
  existing RECORD;
BEGIN
  SELECT
    table_relation.relname AS table_name,
    index_metadata.indisvalid,
    index_metadata.indisready,
    index_metadata.indisunique,
    index_metadata.indpred IS NULL AS has_no_predicate,
    index_metadata.indexprs IS NULL AS has_no_expressions,
    pg_get_indexdef(index_relation.oid) AS index_definition,
    pg_get_expr(index_metadata.indpred, index_metadata.indrelid) AS predicate_definition,
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
  JOIN pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
  LEFT JOIN pg_index index_metadata ON index_metadata.indexrelid = index_relation.oid
  LEFT JOIN pg_class table_relation ON table_relation.oid = index_metadata.indrelid
  LEFT JOIN pg_am access_method ON access_method.oid = index_relation.relam
  WHERE index_namespace.nspname = current_schema()
    AND index_relation.relname = 'TvEventOccurrence_occurred_lookup_idx';

  IF FOUND AND (
    existing.table_name IS DISTINCT FROM 'TvEventOccurrence'
    OR existing.indisunique IS DISTINCT FROM FALSE
    OR existing.has_no_predicate IS DISTINCT FROM TRUE
    OR existing.has_no_expressions IS DISTINCT FROM TRUE
    OR existing.access_method IS DISTINCT FROM 'btree'
    OR existing.key_columns IS DISTINCT FROM ARRAY['tenancyId', 'occurredAt', 'id']
  ) THEN
    RAISE EXCEPTION 'TV event occurred-at index % already exists but is invalid or has an unexpected definition; refusing to drop it', 'TvEventOccurrence_occurred_lookup_idx';
  ELSIF FOUND AND (
    existing.indisvalid IS DISTINCT FROM TRUE
    OR existing.indisready IS DISTINCT FROM TRUE
  ) THEN
    EXECUTE format('ALTER INDEX %I RENAME TO %I', 'TvEventOccurrence_occurred_lookup_idx', 'TvEventOccurrence_occurred_lookup_idx_invalid');
  END IF;
END
$$;

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
DROP INDEX CONCURRENTLY IF EXISTS /* SCHEMA_NAME_SENTINEL */."TvEventOccurrence_occurred_lookup_idx_invalid";

-- SPLIT_STATEMENT_SENTINEL
-- SINGLE_STATEMENT_SENTINEL
-- RUN_OUTSIDE_TRANSACTION_SENTINEL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TvEventOccurrence_occurred_lookup_idx"
  ON /* SCHEMA_NAME_SENTINEL */."TvEventOccurrence"("tenancyId", "occurredAt" DESC, "id");


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
    JOIN pg_am access_method ON access_method.oid = idx.relam
    WHERE n.nspname = current_schema()
      AND idx.relname = 'TvEventOccurrence_occurred_lookup_idx'
      AND tbl.relname = 'TvEventOccurrence'
      AND i.indisvalid
      AND i.indisready
      AND NOT i.indisunique
      AND i.indnatts = i.indnkeyatts
      AND access_method.amname = 'btree'
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND pg_index_column_has_property(idx.oid, 1, 'desc') IS FALSE
      AND pg_index_column_has_property(idx.oid, 2, 'desc') IS TRUE
      AND pg_index_column_has_property(idx.oid, 3, 'desc') IS FALSE
      AND (
        SELECT array_agg(table_attribute.attname::text ORDER BY index_key.ordinality)
        FROM unnest(i.indkey::smallint[]) WITH ORDINALITY
          AS index_key(attribute_number, ordinality)
        JOIN pg_attribute table_attribute
          ON table_attribute.attrelid = i.indrelid
          AND table_attribute.attnum = index_key.attribute_number
        WHERE index_key.ordinality <= i.indnkeyatts
      ) = ARRAY['tenancyId', 'occurredAt', 'id']
  ) THEN
    RAISE EXCEPTION 'TV event occurred-at index did not finish with the expected valid definition';
  END IF;
END
$$;

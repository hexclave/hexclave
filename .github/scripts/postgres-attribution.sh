#!/usr/bin/env bash

set -euo pipefail

case "${1:-}" in
  reset|snapshot)
    ;;
  *)
    echo "Usage: $0 {reset|snapshot}" >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/docker/dependencies/docker.compose.yaml"

if [[ "$1" == reset ]]; then
  docker compose -f "$compose_file" exec -T db \
    psql --no-psqlrc --set=ON_ERROR_STOP=1 --username=postgres --dbname=stackframe \
    --command='SELECT pg_stat_statements_reset();'
  exit 0
fi

docker compose -f "$compose_file" exec -T db \
  psql --no-psqlrc --set=ON_ERROR_STOP=1 --username=postgres --dbname=stackframe <<'SQL'
\pset pager off
\pset format unaligned
\pset fieldsep '|'
\echo
\echo '========== PostgreSQL statement attribution =========='
\echo 'Statement statistics coverage since the previous snapshot'
\echo
WITH statements AS (
  SELECT calls, total_exec_time
  FROM pg_stat_statements
  WHERE query NOT ILIKE '%pg_stat_statements%'
),
totals AS (
  SELECT
    count(*) AS tracked_entries,
    sum(calls) AS total_calls,
    sum(total_exec_time) AS total_exec_time
  FROM statements
),
top_30 AS (
  SELECT sum(total_exec_time) AS total_exec_time
  FROM (
    SELECT total_exec_time
    FROM statements
    ORDER BY total_exec_time DESC
    LIMIT 30
  ) AS limited
)
SELECT
  tracked_entries,
  total_calls,
  round(coalesce(totals.total_exec_time, 0)::numeric, 1) AS all_statements_total_ms,
  round(coalesce(top_30.total_exec_time, 0)::numeric, 1) AS top_30_total_ms,
  round(
    (100 * coalesce(top_30.total_exec_time, 0) / nullif(totals.total_exec_time, 0))::numeric,
    1
  ) AS top_30_coverage_pct
FROM totals
CROSS JOIN top_30;
\echo
\echo 'pg_stat_statements eviction/reset status'
\echo
SELECT
  dealloc AS evicted_entries,
  stats_reset
FROM pg_stat_statements_info;
\echo
\echo 'Top statements by total execution time, split by database'
\echo
SELECT
  d.datname AS database_name,
  calls,
  round(total_exec_time::numeric, 1) AS total_ms,
  round(mean_exec_time::numeric, 1) AS mean_ms,
  rows,
  left(regexp_replace(query, E'[\\n\\r\\t]+', ' ', 'g'), 1000) AS query
FROM pg_stat_statements AS s
JOIN pg_database AS d ON d.oid = s.dbid
WHERE query NOT ILIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC
LIMIT 30;
\echo
\echo 'Top statements aggregated across databases by queryid'
\echo
WITH statements AS (
  SELECT
    queryid,
    calls,
    total_exec_time,
    rows,
    query
  FROM pg_stat_statements
  WHERE query NOT ILIKE '%pg_stat_statements%'
),
aggregated AS (
  SELECT
    queryid,
    sum(calls) AS calls,
    sum(total_exec_time) AS total_exec_time,
    sum(rows) AS rows,
    count(*) AS database_count,
    min(query) AS query
  FROM statements
  GROUP BY queryid
)
SELECT
  queryid,
  database_count,
  calls,
  round(total_exec_time::numeric, 1) AS total_ms,
  round((total_exec_time / nullif(calls, 0))::numeric, 1) AS mean_ms,
  rows,
  left(regexp_replace(query, E'[\\n\\r\\t]+', ' ', 'g'), 1000) AS query
FROM aggregated
ORDER BY total_exec_time DESC
LIMIT 30;
\echo
\echo 'Largest databases by on-disk size across the PostgreSQL cluster'
\echo
SELECT
  datname AS database_name,
  pg_size_pretty(pg_database_size(datname)) AS total_size,
  pg_database_size(datname) AS total_size_bytes
FROM pg_database
ORDER BY pg_database_size(datname) DESC;
\echo
\echo 'Largest tables in the stackframe database by on-disk relation size'
\echo
SELECT
  n.nspname AS schema,
  c.relname AS table_name,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
  pg_total_relation_size(c.oid) AS total_size_bytes,
  c.reltuples::bigint AS estimated_rows
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 30;
\echo
\echo 'Resetting pg_stat_statements for the next pass'
SELECT pg_stat_statements_reset();
SQL

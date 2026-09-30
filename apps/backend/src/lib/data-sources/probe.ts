import type { DataSourceCapabilities, DataSourceCursorCandidate, DataSourceTableInfo } from "@hexclave/shared/dist/data-sources/modes";
import type { Client } from "pg";
import { withDataSourceClient, type DataSourceCredentials } from "./postgres";

export type DataSourceColumn = {
  name: string,
  dataType: string,
  nullable: boolean,
};

export type ProbedTable = DataSourceTableInfo & {
  columns: DataSourceColumn[],
};

export type DataSourceProbeResult = {
  capabilities: DataSourceCapabilities,
  tables: ProbedTable[],
};

/** Schemas that are Postgres' own bookkeeping and never interesting to sync. */
const EXCLUDED_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

/**
 * Types a cursor column may have. A cursor must be monotonic under the
 * customer's own writes, which in practice means a timestamp or an ascending
 * integer key.
 *
 * Matched against `format_type()` output, which spells types out and carries the
 * type modifier: a Prisma `DateTime` column reads as
 * `timestamp(3) without time zone`, not `timestamptz`. Stripping the modifier
 * first is what makes those tables usable at all.
 */
const CURSOR_TYPE_PATTERN = /^(timestamp( with(out)? time zone)?|date|smallint|integer|bigint)$/i;

export function isCursorCandidateType(dataType: string): boolean {
  return CURSOR_TYPE_PATTERN.test(dataType.trim().replace(/\(\d+(,\s*\d+)?\)/, ""));
}

async function readCapabilities(client: Client): Promise<DataSourceCapabilities> {
  const { rows } = await client.query<{
    version: string,
    wal_level: string,
    in_recovery: boolean,
    has_replication: boolean,
  }>(`
    SELECT current_setting('server_version') AS version,
           current_setting('wal_level') AS wal_level,
           pg_is_in_recovery() AS in_recovery,
           COALESCE(
             (SELECT rolreplication OR rolsuper FROM pg_roles WHERE rolname = current_user)
             -- RDS and Cloud SQL grant slot creation through role membership while
             -- leaving rolreplication false, so the direct attribute is not enough.
             -- Looked up through pg_roles because pg_has_role() errors outright on
             -- a role name that does not exist, which is every self-hosted server.
             OR EXISTS (
               SELECT 1 FROM pg_roles r
               WHERE r.rolname IN ('rds_replication', 'cloudsqlsuperuser')
                 AND pg_has_role(current_user, r.oid, 'MEMBER')
             ),
             false
           ) AS has_replication
  `);
  const row = rows[0];

  // Slot accounting needs privileges some managed providers withhold. Not knowing
  // the budget must not fail the whole probe, so fall back to "none used" and let
  // slot creation surface the real error if it ever comes to that.
  let slotsUsed = 0;
  // Keep unknown explicit. Non-finite sentinels cannot survive either Prisma's
  // JSON column protocol or an API response without silently becoming null.
  let slotsMax: number | null = null;
  try {
    const slots = await client.query<{ used: string, max: string }>(`
      SELECT (SELECT count(*) FROM pg_replication_slots) AS used,
             current_setting('max_replication_slots') AS max
    `);
    slotsUsed = Number.parseInt(slots.rows[0].used, 10);
    const parsedSlotsMax = Number.parseInt(slots.rows[0].max, 10);
    slotsMax = Number.isFinite(parsedSlotsMax) ? parsedSlotsMax : null;
  } catch {
    // Some managed providers intentionally hide pg_replication_slots.
  }

  return {
    version: row.version,
    walLevel: row.wal_level,
    inRecovery: row.in_recovery,
    hasReplication: row.has_replication,
    slotsUsed: Number.isFinite(slotsUsed) ? slotsUsed : 0,
    slotsMax,
    probedAtMillis: Date.now(),
  };
}

async function readCatalog(client: Client): Promise<ProbedTable[]> {
  // Only tables the role can actually read: offering a table we would be denied
  // at sync time turns a permissions problem into a mysterious failure later.
  const tables = await client.query<{
    schema_name: string,
    table_name: string,
    approx_rows: string,
    replica_identity: string,
    is_logged: boolean,
    is_partitioned: boolean,
  }>(`
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           -- -1 means "never analyzed", which is not the same as empty. Kept
           -- distinct so the size-based mode gates can refuse to guess.
           c.reltuples::bigint::text AS approx_rows,
           c.relreplident AS replica_identity,
           (c.relpersistence = 'p') AS is_logged,
           (c.relkind = 'p') AS is_partitioned
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      -- Individual partitions are reachable through their parent, and listing
      -- both would sync the same rows into two destination tables.
      AND NOT c.relispartition
      AND n.nspname <> ALL($1::text[])
      AND n.nspname NOT LIKE 'pg\\_temp%'
      AND has_schema_privilege(n.oid, 'USAGE')
      AND has_table_privilege(c.oid, 'SELECT')
    ORDER BY n.nspname, c.relname
  `, [EXCLUDED_SCHEMAS]);

  const columns = await client.query<{
    schema_name: string,
    table_name: string,
    column_name: string,
    data_type: string,
    not_null: boolean,
    indexed: boolean,
  }>(`
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null,
           -- Only a LEADING index column makes a range scan cheap; a trailing
           -- one still reads the whole table, so calling it "indexed" would
           -- steer getDefaultCursorColumn straight at a sequential scan.
           EXISTS (
             SELECT 1 FROM pg_index ix
             WHERE ix.indrelid = c.oid
               AND ix.indisvalid
               AND ix.indpred IS NULL
               AND ix.indkey[0] = a.attnum
           ) AS indexed
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE a.attnum > 0
      AND NOT a.attisdropped
      AND c.relkind IN ('r', 'p')
      AND n.nspname <> ALL($1::text[])
      AND has_schema_privilege(n.oid, 'USAGE')
      AND has_table_privilege(c.oid, 'SELECT')
    ORDER BY n.nspname, c.relname, a.attnum
  `, [EXCLUDED_SCHEMAS]);

  const primaryKeys = await client.query<{
    schema_name: string,
    table_name: string,
    column_name: string,
  }>(`
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           a.attname AS column_name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE i.indisprimary
      -- indkey spans INCLUDE columns too; those are not part of the key and
      -- must not end up in ClickHouse's dedup ORDER BY.
      AND k.ord <= i.indnkeyatts
      AND n.nspname <> ALL($1::text[])
      AND has_schema_privilege(n.oid, 'USAGE')
      AND has_table_privilege(c.oid, 'SELECT')
    ORDER BY n.nspname, c.relname, k.ord
  `, [EXCLUDED_SCHEMAS]);

  const key = (schemaName: string, tableName: string) => `${schemaName}.${tableName}`;
  const columnsByTable = new Map<string, DataSourceColumn[]>();
  const cursorsByTable = new Map<string, DataSourceCursorCandidate[]>();
  for (const row of columns.rows) {
    const k = key(row.schema_name, row.table_name);
    if (!columnsByTable.has(k)) columnsByTable.set(k, []);
    columnsByTable.get(k)!.push({ name: row.column_name, dataType: row.data_type, nullable: !row.not_null });
    // A nullable cursor column would let rows sit permanently below any watermark.
    if (row.not_null && isCursorCandidateType(row.data_type)) {
      if (!cursorsByTable.has(k)) cursorsByTable.set(k, []);
      cursorsByTable.get(k)!.push({ column: row.column_name, dataType: row.data_type, indexed: row.indexed });
    }
  }
  const pkByTable = new Map<string, string[]>();
  for (const row of primaryKeys.rows) {
    const k = key(row.schema_name, row.table_name);
    if (!pkByTable.has(k)) pkByTable.set(k, []);
    pkByTable.get(k)!.push(row.column_name);
  }

  return tables.rows.map(row => {
    const k = key(row.schema_name, row.table_name);
    const rawRows = Number.parseInt(row.approx_rows, 10);
    return {
      schemaName: row.schema_name,
      tableName: row.table_name,
      // -1 is Postgres for "never analyzed". Reporting it as 0 would sneak an
      // arbitrarily large table past every size-based gate.
      approxRows: Number.isFinite(rawRows) && rawRows >= 0 ? rawRows : null,
      primaryKeyColumns: pkByTable.get(k) ?? [],
      cursorCandidates: cursorsByTable.get(k) ?? [],
      columns: columnsByTable.get(k) ?? [],
      replicaIdentity: row.replica_identity,
      isLogged: row.is_logged,
      isPartitioned: row.is_partitioned,
    };
  });
}

/**
 * Connects to the customer's database and reads everything the "choose tables"
 * screen needs: what the server can do, and what is in it. Runs on every sync as
 * well as on connect, so a customer who enables logical replication later is
 * offered CDC without re-adding the source.
 */
export async function probeDataSource(credentials: DataSourceCredentials): Promise<DataSourceProbeResult> {
  return await withDataSourceClient(credentials, async client => ({
    capabilities: await readCapabilities(client),
    tables: await readCatalog(client),
  }));
}

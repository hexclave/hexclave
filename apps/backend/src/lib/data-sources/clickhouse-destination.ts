import type { ClickHouseClient } from "@clickhouse/client";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { createHash } from "node:crypto";
import type { DataSourceColumn } from "./probe";

/** Metadata every destination table carries, whatever the source. */
export const EXTRACTED_AT_COLUMN = "_hexclave_extracted_at";
export const VERSION_COLUMN = "_hexclave_version";
export const DELETED_COLUMN = "_hexclave_deleted";

/**
 * Identifiers cannot be parameterized, so every name is interpolated into DDL and
 * this quoting is what makes that safe. Backslashes and backticks are escaped the
 * way ClickHouse expects; control characters are refused outright, since nothing
 * legitimate contains them and they have no escape we can rely on.
 *
 * Deliberately permissive about the rest: warehouse databases are named by project
 * UUID (so hyphens must survive), and column names come from the customer's own
 * schema, where a quoted "odd name" is perfectly legal.
 */
export function quoteClickhouseIdentifier(identifier: string): string {
  if (identifier.length === 0 || /[\u0000-\u001f\u007f]/.test(identifier)) {
    throw new HexclaveAssertionError(`Unsafe ClickHouse identifier: ${JSON.stringify(identifier)}`);
  }
  return `\`${identifier.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}

/**
 * Destination name for a source table. The readable prefix helps customers
 * recognise it, while the full source/table identity hash makes the name stable
 * and collision-resistant across sources and quoted Postgres identifiers.
 *
 * The identity must be part of every name, not only a collision fallback. Stream
 * metadata can be deleted while its destination table is deliberately retained;
 * allocating pretty names from only the currently configured streams could later
 * reuse that retained table and drop or mix the customer's existing data.
 */
export function getDestinationTableName(dataSourceId: string, schemaName: string, tableName: string): string {
  const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_]/g, "_");
  const readablePrefix = `${sanitize(schemaName)}_${sanitize(tableName)}`.slice(0, 96);
  const identity = createHash("sha256")
    .update(dataSourceId)
    .update("\0")
    .update(schemaName)
    .update("\0")
    .update(tableName)
    .digest("hex");
  return `${readablePrefix}_${identity}`;
}

const NUMERIC_WITH_PRECISION = /^numeric\((\d+),\s*(\d+)\)$/i;

/**
 * Postgres type -> ClickHouse type. Anything we do not recognise lands as
 * String: an unqueryable column is recoverable, a wrong one silently corrupts.
 */
export function mapPostgresTypeToClickhouse(dataType: string): string {
  const type = dataType.trim().toLowerCase();
  if (type.endsWith("[]")) return "String"; // JSON-encoded; ClickHouse arrays would need per-element mapping
  const numeric = NUMERIC_WITH_PRECISION.exec(type);
  if (numeric) {
    const precision = Number.parseInt(numeric[1], 10);
    const scale = Number.parseInt(numeric[2], 10);
    // Decimal is only safe when the source declared bounds we can honour.
    if (precision <= 76 && scale <= precision) return `Decimal(${precision}, ${scale})`;
    return "String";
  }
  if (/^character varying|^varchar|^character|^char|^text|^citext|^name$/.test(type)) return "String";
  if (/^smallint$|^int2$/.test(type)) return "Int16";
  if (/^integer$|^int4$|^serial$/.test(type)) return "Int32";
  if (/^bigint$|^int8$|^bigserial$/.test(type)) return "Int64";
  if (/^real$|^float4$/.test(type)) return "Float32";
  if (/^double precision$|^float8$/.test(type)) return "Float64";
  if (/^boolean$|^bool$/.test(type)) return "Bool";
  if (/^uuid$/.test(type)) return "UUID";
  if (/^date$/.test(type)) return "Date32";
  if (/^timestamp/.test(type)) return "DateTime64(6)";
  // Bare `numeric`, json, jsonb, bytea, time, interval, enums, geometry, ...
  return "String";
}

function columnDefinition(column: DataSourceColumn, isPrimaryKey: boolean): string {
  const baseType = mapPostgresTypeToClickhouse(column.dataType);
  // Every non-key column is Nullable regardless of the source's NOT NULL, because
  // a delete tombstone carries only the replica identity: Postgres sends the other
  // columns as SQL NULL. A non-Nullable column would coerce those to '' or 0 and,
  // depending on server settings, could reject the whole WAL batch.
  // ORDER BY columns must not be Nullable, and a key column is NOT NULL anyway.
  const type = isPrimaryKey ? baseType : `Nullable(${baseType})`;
  return `${quoteClickhouseIdentifier(column.name)} ${type}`;
}

export function buildCreateTableSql(options: {
  databaseName: string,
  tableName: string,
  columns: DataSourceColumn[],
  primaryKeyColumns: string[],
}): string {
  const { databaseName, tableName, columns, primaryKeyColumns } = options;
  const definitions = columns.map(c => columnDefinition(c, primaryKeyColumns.includes(c.name)));
  definitions.push(
    `${quoteClickhouseIdentifier(EXTRACTED_AT_COLUMN)} DateTime64(3)`,
    `${quoteClickhouseIdentifier(VERSION_COLUMN)} UInt64`,
    `${quoteClickhouseIdentifier(DELETED_COLUMN)} UInt8 DEFAULT 0`,
  );

  // With a key we can deduplicate: the highest version of a row wins, and a
  // tombstone removes it. Without one there is nothing to match on, so the table
  // is append-only and the customer picks the row they want at query time.
  const engine = primaryKeyColumns.length > 0
    ? `ReplacingMergeTree(${quoteClickhouseIdentifier(VERSION_COLUMN)}, ${quoteClickhouseIdentifier(DELETED_COLUMN)})`
    : "MergeTree";
  const orderBy = primaryKeyColumns.length > 0
    ? primaryKeyColumns.map(quoteClickhouseIdentifier).join(", ")
    : quoteClickhouseIdentifier(EXTRACTED_AT_COLUMN);

  return `CREATE TABLE IF NOT EXISTS ${quoteClickhouseIdentifier(databaseName)}.${quoteClickhouseIdentifier(tableName)} (
  ${definitions.join(",\n  ")}
) ENGINE = ${engine}
ORDER BY (${orderBy})`;
}

export async function ensureDestinationTable(
  client: ClickHouseClient,
  options: { databaseName: string, tableName: string, columns: DataSourceColumn[], primaryKeyColumns: string[] },
): Promise<void> {
  await client.command({ query: buildCreateTableSql(options) });

  // Additive schema drift: a column the source grew since the table was created
  // is added rather than quarantined, which covers the overwhelmingly common case.
  const existing = await client.query({
    query: `SELECT name FROM system.columns WHERE database = {db:String} AND table = {tbl:String}`,
    query_params: { db: options.databaseName, tbl: options.tableName },
    format: "JSONEachRow",
  });
  const existingNames = new Set((await existing.json<{ name: string }>()).map(r => r.name));
  for (const column of options.columns) {
    if (existingNames.has(column.name)) continue;
    await client.command({
      query: `ALTER TABLE ${quoteClickhouseIdentifier(options.databaseName)}.${quoteClickhouseIdentifier(options.tableName)}
              ADD COLUMN IF NOT EXISTS ${columnDefinition(column, false)}`,
    });
  }
}

/** Converts a `pg` value into something ClickHouse's JSONEachRow reader accepts. */
export function normalizeValueForClickhouse(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

export async function insertRows(
  client: ClickHouseClient,
  options: { databaseName: string, tableName: string, rows: Record<string, unknown>[] },
): Promise<void> {
  if (options.rows.length === 0) return;
  await client.insert({
    table: `${quoteClickhouseIdentifier(options.databaseName)}.${quoteClickhouseIdentifier(options.tableName)}`,
    values: options.rows,
    format: "JSONEachRow",
    clickhouse_settings: { date_time_input_format: "best_effort" },
  });
}

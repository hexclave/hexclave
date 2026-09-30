import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import {
  DELETED_COLUMN,
  EXTRACTED_AT_COLUMN,
  VERSION_COLUMN,
  mapPostgresTypeToClickhouse,
  normalizeValueForClickhouse,
} from "./clickhouse-destination";
import type { DataSourceColumn } from "./probe";

/**
 * Rows reach us two ways — as native `pg` values from a SELECT, and as text from
 * the WAL — and both have to land in the same typed ClickHouse columns. These
 * helpers are the single place that reconciles them.
 */

/** Converts a WAL text value to the JS type its destination column expects. */
export function coerceTextValue(text: string | null, postgresType: string): unknown {
  if (text === null) return null;
  const clickhouseType = mapPostgresTypeToClickhouse(postgresType);
  if (/^Int|^Float|^Decimal/.test(clickhouseType)) {
    const value = Number(text);
    // Int64 beyond 2^53 loses precision as a JS number; ClickHouse accepts the
    // decimal string for those, so keep it as text rather than round it.
    if (!Number.isSafeInteger(value) && /^Int64|^Decimal/.test(clickhouseType)) return text;
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (clickhouseType === "Bool") return text === "t" || text === "true" || text === "1";
  return text;
}

/**
 * Rebuilds a pg array-mode result as a prototype-safe object. pg's default row
 * parser assigns by property name on `{}`, so a legitimate PostgreSQL column
 * named `__proto__` mutates the object's prototype instead of becoming an own
 * field. Array mode preserves every value; Object.fromEntries defines even
 * prototype-sensitive names as ordinary data properties.
 */
export function buildSourceRow(columnNames: readonly string[], values: readonly unknown[]): Record<string, unknown> {
  if (columnNames.length !== values.length) {
    throw new HexclaveAssertionError(`Source row has ${values.length} values for ${columnNames.length} columns`);
  }
  return Object.fromEntries(columnNames.map((name, index) => [name, values[index]]));
}

export function buildDestinationRow(options: {
  values: Record<string, unknown>,
  columns: DataSourceColumn[],
  version: bigint,
  deleted: boolean,
  extractedAt: Date,
}): Record<string, unknown> {
  const row = new Map<string, unknown>();
  for (const column of options.columns) {
    // `undefined` means the WAL withheld an unchanged TOAST value. Writing null
    // would erase it, so those columns are simply omitted and ClickHouse's
    // default applies — the previous version of the row stays queryable.
    if (!Object.hasOwn(options.values, column.name)) continue;
    const value = options.values[column.name];
    if (value === undefined) continue;
    row.set(column.name, normalizeValueForClickhouse(value));
  }
  row.set(EXTRACTED_AT_COLUMN, options.extractedAt.toISOString());
  row.set(VERSION_COLUMN, options.version.toString());
  row.set(DELETED_COLUMN, options.deleted ? 1 : 0);
  return Object.fromEntries(row);
}

/**
 * Shifts timestamps so that dates before 1970 stay positive. The destination
 * version column is UInt64 — ClickHouse rejects a leading '-' outright, which
 * would fail the whole insert batch — and ORDER BY cursor ASC puts exactly those
 * oldest rows in the first batch, so an unshifted stream would never sync a
 * single row. Large enough for year 1 (~-6.2e16 µs) and far below UInt64's range.
 */
const TEMPORAL_VERSION_OFFSET = 100_000_000_000_000_000n;

/**
 * A monotonic UInt64 for ReplacingMergeTree to resolve duplicates with. Whatever
 * the mode, a later version of a row must produce a larger number than an
 * earlier one, or the wrong row wins.
 */
export function versionFromCursorValue(value: unknown): bigint {
  if (value instanceof Date) return temporalVersion(BigInt(value.getTime()) * 1000n);
  if (typeof value === "bigint") return integerVersion(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HexclaveAssertionError("Cursor value is not finite");
    return integerVersion(BigInt(Math.trunc(value)));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return integerVersion(BigInt(trimmed));
    const asDate = new Date(trimmed);
    if (!Number.isNaN(asDate.getTime())) return temporalVersion(BigInt(asDate.getTime()) * 1000n);
  }
  throw new HexclaveAssertionError(`Cannot derive a sync version from cursor value ${JSON.stringify(value)}`);
}

function temporalVersion(micros: bigint): bigint {
  const shifted = micros + TEMPORAL_VERSION_OFFSET;
  if (shifted < 0n) {
    throw new HexclaveAssertionError(`Cursor timestamp is too far in the past to version: ${micros}`);
  }
  return shifted;
}

/**
 * Negative integer cursors are legal in Postgres but cannot be represented. They
 * collapse to 0 rather than failing the stream: ordering only matters between two
 * versions of the same row, and a row appearing twice at two different negative
 * cursor values is far less likely than a table that simply contains some.
 */
function integerVersion(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

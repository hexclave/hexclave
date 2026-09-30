/**
 * Which sync modes a given source table can use, and which one we recommend.
 *
 * This lives in shared rather than the backend because the dashboard renders the
 * same verdicts while the customer is choosing modes, and the two must never
 * disagree — an option the dashboard offers but the backend rejects is the worst
 * possible outcome of this screen.
 */

export type DataSourceSyncMode = "cursor" | "cdc";

export const DATA_SOURCE_SYNC_MODES = ["cdc", "cursor"] as const satisfies readonly DataSourceSyncMode[];

/**
 * Cursor columns that carry a wall-clock time. These are the ones that behave the
 * way people expect: an application that touches the row bumps the timestamp, so
 * updates are picked up as well as inserts.
 *
 * A monotonic id is still a legal cursor and is often the right one for an
 * append-only log, but it only ever moves when a row is inserted — so edits to
 * existing rows are invisible. The picker warns about that rather than refusing
 * it, because the customer knows their write patterns and we do not.
 */
const TEMPORAL_CURSOR_TYPE = /^(timestamp( with(out)? time zone)?|date)$/i;

export function isTemporalCursorType(dataType: string): boolean {
  return TEMPORAL_CURSOR_TYPE.test(dataType.trim().replace(/\(\d+(,\s*\d+)?\)/, ""));
}

/** What the capability probe learned about the source server. */
export type DataSourceCapabilities = {
  version: string,
  /** `logical` is the only value that permits logical decoding. */
  walLevel: string,
  /** Whether the role we were given has REPLICATION (or is a superuser). */
  hasReplication: boolean,
  /** Slots cannot be created on a hot standby, whatever wal_level says. */
  inRecovery: boolean,
  slotsUsed: number,
  /** Null when the provider does not allow the slot budget to be inspected. */
  slotsMax: number | null,
  probedAtMillis: number,
};

export type DataSourceCursorCandidate = {
  column: string,
  dataType: string,
  /** An unindexed cursor still works, but every sync sequentially scans the table. */
  indexed: boolean,
};

export type DataSourceTableInfo = {
  schemaName: string,
  tableName: string,
  /** Null when the source has never been analyzed, which is not the same as empty. */
  approxRows: number | null,
  primaryKeyColumns: string[],
  cursorCandidates: DataSourceCursorCandidate[],
  /** `pg_class.relreplident`: 'd' default, 'n' nothing, 'f' full, 'i' using index. */
  replicaIdentity: string,
  /** Unlogged tables cannot be added to a publication at all. */
  isLogged: boolean,
  isPartitioned: boolean,
};

export type ModeAvailability = {
  available: boolean,
  /** Short, user-facing, and specific enough to act on. Null when available. */
  reason: string | null,
};

export function getCdcAvailability(
  capabilities: DataSourceCapabilities,
  table?: Pick<DataSourceTableInfo, "primaryKeyColumns" | "replicaIdentity" | "isLogged" | "isPartitioned">,
): ModeAvailability {
  if (capabilities.walLevel !== "logical") {
    return { available: false, reason: "needs wal_level=logical" };
  }
  if (!capabilities.hasReplication) {
    return { available: false, reason: "needs REPLICATION grant" };
  }
  if (capabilities.inRecovery) {
    return { available: false, reason: "not on a read replica" };
  }
  if (capabilities.slotsMax != null && capabilities.slotsUsed >= capabilities.slotsMax) {
    return { available: false, reason: "no replication slots free" };
  }
  if (table != null) {
    // Without a key, an UPDATE or DELETE in the WAL carries nothing we can match
    // a destination row on, so CDC would be no better than an append-only log.
    if (table.primaryKeyColumns.length === 0) {
      return { available: false, reason: "needs a primary key" };
    }
    // Adding a REPLICA IDENTITY NOTHING table to a publication makes the
    // customer's own UPDATEs and DELETEs start failing. Never worth it.
    if (table.replicaIdentity === "n") {
      return { available: false, reason: "needs a replica identity" };
    }
    // Postgres refuses to add these to a publication, and one of them would fail
    // the whole publication statement, taking every other CDC stream with it.
    if (!table.isLogged) {
      return { available: false, reason: "table is unlogged" };
    }
    // Changes are published under the leaf partition, not the parent we would be
    // subscribed to, so every change would be silently dropped.
    if (table.isPartitioned) {
      return { available: false, reason: "table is partitioned" };
    }
  }
  return { available: true, reason: null };
}

export function getModeAvailability(
  table: DataSourceTableInfo,
  capabilities: DataSourceCapabilities,
): Record<DataSourceSyncMode, ModeAvailability> {
  return {
    cdc: getCdcAvailability(capabilities, table),
    cursor: table.cursorCandidates.length > 0
      ? { available: true, reason: null }
      : { available: false, reason: "no usable column" },
  };
}

/**
 * Null when no mode applies — the table cannot be synced as it stands, and the
 * dashboard says so rather than silently omitting it.
 */
export function getRecommendedMode(
  table: DataSourceTableInfo,
  capabilities: DataSourceCapabilities,
): DataSourceSyncMode | null {
  const availability = getModeAvailability(table, capabilities);
  // CDC first wherever it is possible: it is cheaper in steady state than reading
  // rows back, and it is the only mode that sees deletes.
  if (availability.cdc.available) return "cdc";
  if (availability.cursor.available) return "cursor";
  return null;
}

/**
 * The cursor column we preselect. Indexed candidates first — an unindexed cursor
 * makes every sync a sequential scan — then the conventional names, so the common
 * case needs no thought from the customer.
 */
export function getDefaultCursorColumn(table: DataSourceTableInfo): string | null {
  const preferredNames = ["updated_at", "updatedat", "modified_at", "last_modified", "created_at", "createdat"];
  const ranked = [...table.cursorCandidates].sort((a, b) => {
    if (a.indexed !== b.indexed) return a.indexed ? -1 : 1;
    const aRank = preferredNames.indexOf(a.column.toLowerCase());
    const bRank = preferredNames.indexOf(b.column.toLowerCase());
    return (aRank === -1 ? preferredNames.length : aRank) - (bRank === -1 ? preferredNames.length : bRank);
  });
  return ranked[0]?.column ?? null;
}

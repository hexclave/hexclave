import type { ClickHouseClient } from "@clickhouse/client";
import { DatabaseError, type Client } from "pg";
import { StatusError, captureError } from "@hexclave/shared/dist/utils/errors";
import {
  DELETED_COLUMN,
  ensureDestinationTable,
  insertRows,
  quoteClickhouseIdentifier,
} from "./clickhouse-destination";
import { decodePgoutputMessage, formatLsn, parseLsn, type PgoutputRelation, type PgoutputTuple } from "./pgoutput";
import { quotePgIdentifier, quotePgQualifiedName, withDataSourceClient, type DataSourceCredentials } from "./postgres";
import type { DataSourceColumn, ProbedTable } from "./probe";
import { buildDestinationRow, buildSourceRow, coerceTextValue, versionFromCursorValue } from "./rows";

/** Rows per round trip. Large enough to amortise latency, small enough to bound memory. */
const READ_BATCH_SIZE = 10_000;
/** Stops one enormous, keyset-paginated table from monopolising a sync run. */
const MAX_BATCHES_PER_CURSOR_SYNC = 50;
/**
 * WAL messages decoded per peek. The peek materialises its whole result in
 * memory, so this bounds memory, not throughput: a sync keeps peeking until it
 * has caught up or runs out of time. Postgres always completes the transaction
 * it is in, so this is a floor.
 */
const MAX_WAL_CHANGES_PER_PEEK = 20_000;
/**
 * Time kept back from the deadline for the last round in flight and the
 * completion write. Snapshots and WAL rounds stop starting new work once inside it.
 */
const DEADLINE_RESERVE_MS = 30_000;
/** Keys per TOAST refetch. One IN list over tens of thousands of keys overflows Postgres' parser stack. */
const REFETCH_CHUNK_SIZE = 1_000;

/**
 * Reading up to `now()` would race the commit of a transaction that set its
 * timestamp earlier: its rows would become visible after we had already moved
 * the watermark past them, and would never be read again. Staying behind by this
 * much shrinks that window to transactions that run longer than it.
 */
const CURSOR_SAFETY_LAG_SECONDS = 10;

/** Alias the cursor's exact text is read back under; never written to the destination. */
const CURSOR_TEXT_COLUMN = "_hexclave_cursor_text";

export type StreamSyncPlan = {
  streamId: string,
  schemaName: string,
  tableName: string,
  mode: "cursor" | "cdc",
  cursorColumn: string | null,
  primaryKeyColumns: string[],
  destinationTable: string,
  syncCursor: SyncCursorState | null,
  /**
   * True until the stream has synced once in its current configuration. A mode or
   * cursor change resets it, because the destination's existing rows were versioned
   * on a scale the new mode cannot beat — full-refresh versions are epoch
   * microseconds, CDC versions are LSNs, and no real LSN ever reaches 1.7e15 — so
   * carrying them over would freeze the table forever.
   */
  isPending: boolean,
};

/**
 * `cursor`: the watermark of a cursor stream. `lsn`: a CDC stream whose snapshot
 * finished and which now follows the slot. `snapshot`: a CDC stream part way
 * through its initial load; `key` is where to resume it.
 */
export type SyncCursorState = {
  mode: string,
  value: string,
  /** JSON-encoded primary key of the last row read, for total-order resumption. */
  key?: string,
};

export type StreamSyncResult = {
  streamId: string,
  rowsSynced: number,
  syncCursor: SyncCursorState | null,
  error: string | null,
  /** The source truncated this table; only a fresh snapshot can represent that. */
  needsResnapshot?: boolean,
};

export type SyncContext = {
  credentials: DataSourceCredentials,
  clickhouse: ClickHouseClient,
  databaseName: string,
  /** Fresh catalog, keyed `schema.table`, so column lists match what we are about to read. */
  tablesByName: Map<string, ProbedTable>,
  slotName: string,
  publicationName: string,
  startedAt: Date,
  /** Epoch ms by which the sync must have returned; long CDC work stops early and resumes next time. */
  deadlineMs: number,
};

/**
 * Errors caused by the customer's database or configuration: connection failures,
 * missing grants, a publication we cannot manage. They are shown on the stream and
 * are not ours to fix, so they stay out of Sentry.
 */
export class DataSourceUserError extends Error {}

function isSourceSideError(error: unknown): boolean {
  if (error instanceof DataSourceUserError || error instanceof DatabaseError) return true;
  // withDataSourceClient reports a failed connect as a 400.
  if (error instanceof StatusError && error.statusCode < 500) return true;
  // Node socket errors (ECONNRESET, ETIMEDOUT, …) come from the network path to
  // their server. Matched by shape, because ClickHouse errors also carry a string
  // `code` (a numeric one) and those are ours.
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^E[A-Z]+$/.test(code);
}

/**
 * Stream errors are recorded on the stream either way; the ones that point at a
 * bug of ours (a ClickHouse insert, a decoding error) also go to Sentry.
 */
function reportUnexpectedSyncError(error: unknown): void {
  if (!isSourceSideError(error)) captureError("data-source-stream-sync", error);
}

function hasTimeLeft(context: SyncContext): boolean {
  return Date.now() < context.deadlineMs - DEADLINE_RESERVE_MS;
}

function tableKey(schemaName: string, tableName: string): string {
  return `${schemaName}.${tableName}`;
}

/**
 * Keyset pagination can stop at the fairness cap and resume strictly after the
 * last `(cursor, primary key)` pair. A keyless stream has to resume inclusively
 * so it does not skip late rows at the watermark. Capping that query could leave
 * it forever behind a tie larger than the cap, so correctness requires reading
 * it to exhaustion. The server-side cursor still bounds memory, but such a sync
 * can run substantially longer than a keyed one.
 */
export function getCursorSyncBatchLimit(primaryKeyColumns: readonly string[]): number | null {
  return primaryKeyColumns.length > 0 ? MAX_BATCHES_PER_CURSOR_SYNC : null;
}

async function prepareDestination(context: SyncContext, plan: StreamSyncPlan, table: ProbedTable): Promise<void> {
  if (plan.isPending) {
    // Rebuilt from scratch rather than merged into: see StreamSyncPlan.isPending.
    await context.clickhouse.command({
      query: `DROP TABLE IF EXISTS ${quoteClickhouseIdentifier(context.databaseName)}.${quoteClickhouseIdentifier(plan.destinationTable)}`,
    });
  }
  await ensureDestinationTable(context.clickhouse, {
    databaseName: context.databaseName,
    tableName: plan.destinationTable,
    columns: table.columns,
    primaryKeyColumns: plan.primaryKeyColumns,
  });
}

/** Streams a SELECT through a server-side cursor so memory stays bounded whatever the table size. */
async function forEachBatch(
  client: Client,
  query: string,
  params: unknown[],
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
  options: { maxBatches: number | null },
): Promise<number> {
  const cursorName = `hexclave_sync_${Math.random().toString(36).slice(2, 10)}`;
  let total = 0;
  await client.query("BEGIN");
  try {
    await client.query(`DECLARE ${quotePgIdentifier(cursorName)} NO SCROLL CURSOR FOR ${query}`, params);
    for (let batch = 0; options.maxBatches == null || batch < options.maxBatches; batch++) {
      // Array mode is required for prototype-sensitive PostgreSQL column names.
      // pg's default object parser cannot represent `__proto__` as an own field.
      const result = await client.query<unknown[]>({
        text: `FETCH ${READ_BATCH_SIZE} FROM ${quotePgIdentifier(cursorName)}`,
        rowMode: "array",
      });
      if (result.rows.length === 0) break;
      const columnNames = result.fields.map(field => field.name);
      await onBatch(result.rows.map(values => buildSourceRow(columnNames, values)));
      total += result.rows.length;
      if (result.rows.length < READ_BATCH_SIZE) break;
    }
  } finally {
    await client.query("COMMIT").catch(() => {
      // A cursor left open is closed by the connection ending moments later.
    });
  }
  return total;
}

/** Reads rows whose cursor column advanced past the last watermark. */
async function syncCursor(
  context: SyncContext,
  plan: StreamSyncPlan,
  table: ProbedTable,
  client: Client,
): Promise<StreamSyncResult> {
  const cursorColumn = plan.cursorColumn;
  if (cursorColumn == null) {
    return { streamId: plan.streamId, rowsSynced: 0, syncCursor: plan.syncCursor, error: "No cursor column is configured for this table." };
  }
  const candidate = table.cursorCandidates.find(c => c.column === cursorColumn);
  if (!candidate) {
    return { streamId: plan.streamId, rowsSynced: 0, syncCursor: plan.syncCursor, error: `Column ${cursorColumn} is no longer usable as a cursor.` };
  }

  await prepareDestination(context, plan, table);

  const quotedCursor = quotePgIdentifier(cursorColumn);
  const isTemporal = /^(timestamp|date)/i.test(candidate.dataType);
  const conditions: string[] = [];
  const params: unknown[] = [];
  const previous = plan.syncCursor?.mode === "cursor" ? plan.syncCursor.value : null;
  const previousKey = plan.syncCursor?.mode === "cursor" ? plan.syncCursor.key ?? null : null;

  // With a primary key, (cursor, key) is a total order, so the read can resume
  // strictly after the last row seen. That both removes the duplicate re-read of
  // the boundary and — the reason it matters — stops a group of rows sharing one
  // cursor value from livelocking: a bulk backfill that stamps 600k rows with the
  // same updated_at would otherwise re-read the same first batch forever.
  const useKeyset = plan.primaryKeyColumns.length > 0;
  const orderColumns = useKeyset
    ? [quotedCursor, ...plan.primaryKeyColumns.map(quotePgIdentifier)]
    : [quotedCursor];

  if (previous != null) {
    if (useKeyset && previousKey != null) {
      const keyValues = JSON.parse(previousKey) as unknown[];
      const placeholders = [previous, ...keyValues].map(value => {
        params.push(value);
        return `$${params.length}`;
      });
      conditions.push(`(${orderColumns.join(", ")}) > (${placeholders.join(", ")})`);
    } else {
      // No key to break ties with, so the watermark is re-read inclusively and the
      // overlap is tolerated rather than risking a skip.
      conditions.push(`${quotedCursor} >= $${params.length + 1}`);
      params.push(previous);
    }
  }
  if (isTemporal) {
    conditions.push(`${quotedCursor} <= now() - interval '${CURSOR_SAFETY_LAG_SECONDS} seconds'`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let maxCursor: string | null = previous;
  let maxKey: string | null = previousKey;
  const rowsSynced = await forEachBatch(
    client,
    // The cursor also comes back as text. `pg` materialises a timestamp as a JS
    // Date, which is millisecond-precision, so a watermark round-tripped through
    // one lands *below* the microsecond value it came from — and every sync then
    // re-reads the whole table. Text is exactly what Postgres stored, and it also
    // sidesteps `timestamp without time zone` being reinterpreted in the
    // process's local timezone on the way out and back.
    `SELECT *, (${quotedCursor})::text AS ${quotePgIdentifier(CURSOR_TEXT_COLUMN)}
     FROM ${quotePgQualifiedName(plan.schemaName, plan.tableName)} ${where}
     ORDER BY ${orderColumns.map(c => `${c} ASC`).join(", ")}`,
    params,
    async rows => {
      const destinationRows = rows.map(values => buildDestinationRow({
        values,
        columns: table.columns,
        version: versionFromCursorValue(values[cursorColumn]),
        deleted: false,
        extractedAt: context.startedAt,
      }));
      // The query is ORDER BY cursor ASC and batches arrive in order, so the last
      // row of the last batch is the maximum. Comparing values ourselves would
      // mean re-implementing Postgres' ordering per type — and comparing them as
      // strings, which is the obvious shortcut, puts "99" above "500".
      const last = rows[rows.length - 1];
      maxCursor = last[CURSOR_TEXT_COLUMN] as string;
      maxKey = useKeyset ? JSON.stringify(plan.primaryKeyColumns.map(column => last[column])) : null;
      await insertRows(context.clickhouse, {
        databaseName: context.databaseName,
        tableName: plan.destinationTable,
        rows: destinationRows,
      });
    },
    { maxBatches: getCursorSyncBatchLimit(plan.primaryKeyColumns) },
  );

  const nextValue = maxCursor;
  return {
    streamId: plan.streamId,
    rowsSynced,
    syncCursor: nextValue == null ? plan.syncCursor : { mode: "cursor", value: nextValue, key: maxKey ?? undefined },
    error: null,
  };
}

/**
 * Creates the publication and replication slot the CDC streams share. One slot
 * per source: slots are per-database, and a slot per table would multiply the
 * WAL-retention risk for no benefit.
 */
async function ensureCdcInfrastructure(
  client: Client,
  context: SyncContext,
  plans: StreamSyncPlan[],
): Promise<{ slotWasCreated: boolean }> {
  const tableList = plans
    .map(plan => quotePgQualifiedName(plan.schemaName, plan.tableName))
    .join(", ");

  const publication = quotePgIdentifier(context.publicationName);
  const existingPublication = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = $1) AS exists`,
    [context.publicationName],
  );
  const publicationExists = existingPublication.rows[0].exists;
  const wanted = new Set(plans.map(plan => tableKey(plan.schemaName, plan.tableName)));
  const published = new Set<string>();
  if (publicationExists) {
    const rows = await client.query<{ schemaname: string, tablename: string }>(
      `SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1`,
      [context.publicationName],
    );
    for (const row of rows.rows) published.add(tableKey(row.schemaname, row.tablename));
  }
  const coversWanted = [...wanted].every(key => published.has(key));

  // Altering only when the table list changed matters for more than saving a
  // statement: ALTER PUBLICATION needs ownership of the publication, so a
  // publication a DBA created for us — the fix our own error message asks for —
  // would otherwise fail on every sync.
  if (!publicationExists || !coversWanted || published.size !== wanted.size) {
    try {
      if (publicationExists) {
        // SET rather than ADD: a table the customer removed from the sync must stop
        // being decoded for changes nobody will read.
        await client.query(`ALTER PUBLICATION ${publication} SET TABLE ${tableList}`);
      } else {
        await client.query(`CREATE PUBLICATION ${publication} FOR TABLE ${tableList}`);
      }
    } catch (error) {
      // Extra tables only cost decoding work, so a publication that already
      // covers everything we need is good enough when we may not trim it.
      if (!coversWanted) {
        // Publication DDL needs ownership of the tables (and, to alter, of the
        // publication). Rather than fail opaquely, hand back the exact statement
        // a DBA can run.
        const statement = publicationExists
          ? `ALTER PUBLICATION ${publication} SET TABLE ${tableList};`
          : `CREATE PUBLICATION ${publication} FOR TABLE ${tableList};`;
        throw new DataSourceUserError(
          `Could not manage the publication for change data capture (${error instanceof Error ? error.message : String(error)}). ` +
          `Run this on your database as a user that owns the tables, then sync again: ${statement}`,
        );
      }
    }
  }

  const existingSlot = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = $1) AS exists`,
    [context.slotName],
  );
  if (existingSlot.rows[0].exists) {
    return { slotWasCreated: false };
  }
  await client.query(`SELECT pg_create_logical_replication_slot($1, 'pgoutput')`, [context.slotName]);
  return { slotWasCreated: true };
}

/**
 * Initial load for a CDC stream. Written at version 0 so that any WAL change for
 * the same row — which necessarily has a non-zero LSN — wins during merges. That
 * is what makes it safe to create the slot first and snapshot afterwards: the
 * overlap produces duplicates, which deduplicate, rather than a gap, which would
 * be silent data loss.
 *
 * Paged by primary key and stopped at the deadline, returning where it got to, so
 * a table too large for one function run is loaded over several syncs instead of
 * being restarted from zero every time. Resuming is safe for the same reason as
 * above: the slot has captured every change since before the first page, so a
 * row read late (newer data, still version 0) loses to its WAL entry, and a row
 * deleted before we reach it is simply never read. Each page is its own
 * statement, so no transaction stays open on the source across the whole load.
 */
async function snapshotForCdc(
  context: SyncContext,
  plan: StreamSyncPlan,
  table: ProbedTable,
  client: Client,
  resumeAfterKey: string | null,
): Promise<{ rowsSynced: number, lastKey: string | null, done: boolean }> {
  const keyColumns = plan.primaryKeyColumns;
  if (keyColumns.length === 0) {
    throw new DataSourceUserError("Change data capture needs a primary key, and this table no longer has one.");
  }
  const quotedKeys = keyColumns.map(quotePgIdentifier);
  // Keys are read back as text so the resume point is exactly what Postgres
  // stored, whatever the key type, and compare as that type when sent back.
  const keyAliases = keyColumns.map((_, index) => `_hexclave_snapshot_key_${index}`);
  const selectKeys = quotedKeys.map((column, index) => `(${column})::text AS ${quotePgIdentifier(keyAliases[index])}`).join(", ");

  let lastKey = resumeAfterKey;
  let rowsSynced = 0;
  do {
    const params = lastKey == null ? [] : JSON.parse(lastKey) as unknown[];
    const where = lastKey == null
      ? ""
      : `WHERE (${quotedKeys.join(", ")}) > (${params.map((_, index) => `$${index + 1}`).join(", ")})`;
    // Array mode for the same reason as forEachBatch: `__proto__` column names.
    const result = await client.query<unknown[]>({
      text: `SELECT *, ${selectKeys} FROM ${quotePgQualifiedName(plan.schemaName, plan.tableName)} ${where}
             ORDER BY ${quotedKeys.map(column => `${column} ASC`).join(", ")}
             LIMIT ${READ_BATCH_SIZE}`,
      values: params,
      rowMode: "array",
    });
    if (result.rows.length === 0) return { rowsSynced, lastKey, done: true };
    const columnNames = result.fields.map(field => field.name);
    const rows = result.rows.map(values => buildSourceRow(columnNames, values));
    await insertRows(context.clickhouse, {
      databaseName: context.databaseName,
      tableName: plan.destinationTable,
      rows: rows.map(values => buildDestinationRow({
        values, columns: table.columns, version: 0n, deleted: false, extractedAt: context.startedAt,
      })),
    });
    rowsSynced += rows.length;
    const last = rows[rows.length - 1];
    lastKey = JSON.stringify(keyAliases.map(alias => last[alias]));
    if (rows.length < READ_BATCH_SIZE) return { rowsSynced, lastKey, done: true };
  } while (hasTimeLeft(context));
  return { rowsSynced, lastKey, done: false };
}

/**
 * Re-reads rows whose WAL entry withheld an unchanged TOAST value.
 *
 * Postgres omits large unchanged column values from the WAL, so an UPDATE that
 * touched only `title` sends nothing for a multi-kilobyte `body`. There is no way
 * to express "leave this column alone" in a MergeTree insert — an omitted field
 * takes the column default and a NULL erases it — and the new row carries a higher
 * version, so it wins the merge either way. The only correct fix is to fetch the
 * current row and write it whole.
 */
async function refetchRowsByKey(
  client: Client,
  plan: StreamSyncPlan,
  keys: Record<string, unknown>[],
): Promise<Map<string, Record<string, unknown>>> {
  const byKey = new Map<string, Record<string, unknown>>();
  if (keys.length === 0 || plan.primaryKeyColumns.length === 0) return byKey;

  const keyColumns = plan.primaryKeyColumns;
  const quotedKeys = keyColumns.map(quotePgIdentifier).join(", ");
  // Chunked: one statement touching tens of thousands of rows would build an IN
  // list deep enough to fail with `stack depth limit exceeded` — on every retry,
  // since the same WAL batch comes back each time.
  for (let offset = 0; offset < keys.length; offset += REFETCH_CHUNK_SIZE) {
    const params: unknown[] = [];
    const tuples = keys.slice(offset, offset + REFETCH_CHUNK_SIZE).map(key => {
      const placeholders = keyColumns.map(column => {
        params.push(key[column]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    const result = await client.query(
      `SELECT * FROM ${quotePgQualifiedName(plan.schemaName, plan.tableName)}
       WHERE (${quotedKeys}) IN (${tuples.join(", ")})`,
      params,
    );
    for (const row of result.rows as Record<string, unknown>[]) {
      byKey.set(keyColumns.map(column => String(row[column])).join("\u0000"), row);
    }
  }
  return byKey;
}

function tupleToValues(tuple: PgoutputTuple, relation: PgoutputRelation, table: ProbedTable): Record<string, unknown> {
  const typesByColumn = new Map(table.columns.map(c => [c.name, c.dataType]));
  const values: Record<string, unknown> = {};
  for (const column of relation.columns) {
    const raw = tuple[column.name];
    // Absent means an unchanged TOAST value; leaving the key out preserves it.
    if (raw === undefined) continue;
    values[column.name] = coerceTextValue(raw, typesByColumn.get(column.name) ?? "text");
  }
  return values;
}

/**
 * Reads the WAL accumulated since the last sync and applies it. Peek rather than
 * get: `pg_logical_slot_get_changes` consumes as it returns, so a failure between
 * reading and writing to ClickHouse would lose those changes permanently. We
 * advance the slot only once the destination write has succeeded.
 *
 * One bounded round; the caller repeats it until `caughtUp`.
 */
async function consumeWalRound(
  context: SyncContext,
  plans: StreamSyncPlan[],
  client: Client,
): Promise<{ rowsByStream: Map<string, number>, advancedTo: bigint | null, caughtUp: boolean, truncatedStreams: Set<string> }> {
  const planByTable = new Map(plans.map(plan => [tableKey(plan.schemaName, plan.tableName), plan]));
  // Read up to a fixed point rather than "whatever is there". On PG15+ pgoutput
  // omits transactions that touch none of our tables entirely, so a quiet set of
  // tables on a busy database yields no commit to advance to — and the slot would
  // hold back all of that other WAL until the customer's disk fills. Knowing the
  // point we read up to lets us advance to it whenever the read was complete.
  const target = await client.query<{ lsn: string }>(`SELECT pg_current_wal_lsn()::text AS lsn`);
  const targetLsn = target.rows[0].lsn;
  const changes = await client.query<{ lsn: string, data: Buffer }>(
    `SELECT lsn::text AS lsn, data
     FROM pg_logical_slot_peek_binary_changes($1, $2::pg_lsn, $3, 'proto_version', '1', 'publication_names', $4)`,
    [context.slotName, targetLsn, MAX_WAL_CHANGES_PER_PEEK, context.publicationName],
  );
  // Below the cap means the peek stopped at the target, not at the cap.
  const caughtUp = changes.rows.length < MAX_WAL_CHANGES_PER_PEEK;

  const relations = new Map<number, PgoutputRelation>();
  const rowsByDestination = new Map<string, Record<string, unknown>[]>();
  const rowsByStream = new Map<string, number>();
  // Rows whose WAL entry withheld an unchanged TOAST value, to be re-read whole.
  const toastedByStream = new Map<string, { plan: StreamSyncPlan, rows: Record<string, unknown>[] }>();
  let lastCommitLsn: bigint | null = null;
  let currentCommitLsn = 0n;
  const truncatedStreams = new Set<string>();

  for (const change of changes.rows) {
    const message = decodePgoutputMessage(change.data, relations);
    if (message.type === "begin") {
      // Every row in the transaction is versioned by where the transaction ends,
      // which is the order the rows actually became visible.
      currentCommitLsn = message.finalLsn;
      continue;
    }
    if (message.type === "commit") {
      lastCommitLsn = message.endLsn;
      continue;
    }
    if (message.type === "truncate") {
      // There is no tombstone that expresses "every row is gone", and leaving them
      // in place would silently diverge from the source. The stream is flagged for
      // a rebuild instead.
      for (const relationId of message.relationIds) {
        const truncated = relations.get(relationId);
        if (truncated == null) continue;
        const truncatedPlan = planByTable.get(tableKey(truncated.schemaName, truncated.tableName));
        if (truncatedPlan != null) truncatedStreams.add(truncatedPlan.streamId);
      }
      continue;
    }
    if (message.type !== "insert" && message.type !== "update" && message.type !== "delete") continue;

    const relation = relations.get(message.relationId);
    if (!relation) continue;
    const plan = planByTable.get(tableKey(relation.schemaName, relation.tableName));
    if (!plan) continue;
    const table = context.tablesByName.get(tableKey(plan.schemaName, plan.tableName));
    if (!table) continue;

    const deleted = message.type === "delete";
    const tuple = deleted ? message.keyRow : message.row;
    if (!rowsByDestination.has(plan.destinationTable)) rowsByDestination.set(plan.destinationTable, []);
    const destinationRows = rowsByDestination.get(plan.destinationTable)!;

    // An UPDATE that moves the primary key sends the old key alongside the new
    // row. Without a tombstone for it the pre-update row stays in the warehouse
    // forever, under a key the source no longer has.
    if (message.type === "update" && message.keyRow != null) {
      const oldKey = tupleToValues(message.keyRow, relation, table);
      const movedKey = plan.primaryKeyColumns.some(
        column => oldKey[column] !== undefined && String(oldKey[column]) !== String(message.row[column]),
      );
      if (movedKey) {
        destinationRows.push(buildDestinationRow({
          values: oldKey, columns: table.columns, version: currentCommitLsn, deleted: true, extractedAt: context.startedAt,
        }));
      }
    }

    const values = tupleToValues(tuple, relation, table);
    const row = buildDestinationRow({
      values,
      columns: table.columns,
      version: currentCommitLsn,
      deleted,
      extractedAt: context.startedAt,
    });
    destinationRows.push(row);
    rowsByStream.set(plan.streamId, (rowsByStream.get(plan.streamId) ?? 0) + 1);

    // 'u' in the tuple means an unchanged TOAST value the server did not send.
    if (!deleted && relation.columns.some(column => tuple[column.name] === undefined)) {
      if (!toastedByStream.has(plan.streamId)) toastedByStream.set(plan.streamId, { plan, rows: [] });
      toastedByStream.get(plan.streamId)!.rows.push(values);
    }
  }

  // Written after the WAL rows, at the same commit version, so the complete row
  // is what a merge keeps: ReplacingMergeTree takes the last inserted row when
  // versions tie.
  for (const { plan, rows } of toastedByStream.values()) {
    const table = context.tablesByName.get(tableKey(plan.schemaName, plan.tableName));
    if (table == null) continue;
    const complete = await refetchRowsByKey(client, plan, rows);
    const destinationRows = rowsByDestination.get(plan.destinationTable) ?? [];
    for (const partial of rows) {
      const key = plan.primaryKeyColumns.map(column => String(partial[column])).join("\u0000");
      const full = complete.get(key);
      // Absent means the row was deleted again later in the same batch; the
      // tombstone we already queued is the correct final state.
      if (full == null) continue;
      destinationRows.push(buildDestinationRow({
        values: full, columns: table.columns, version: currentCommitLsn, deleted: false, extractedAt: context.startedAt,
      }));
    }
    rowsByDestination.set(plan.destinationTable, destinationRows);
  }

  for (const [destinationTable, rows] of rowsByDestination) {
    await insertRows(context.clickhouse, { databaseName: context.databaseName, tableName: destinationTable, rows });
  }

  // A complete read covers everything up to the target, including transactions
  // pgoutput skipped; a capped one only up to the last commit it returned.
  const advancedTo = caughtUp ? parseLsn(targetLsn) : lastCommitLsn;
  if (advancedTo != null) {
    // Guarded because advancing below the slot's confirmed position is an error,
    // and a target read on a quiet database can equal it.
    await client.query(
      `SELECT pg_replication_slot_advance(slot_name, $2::pg_lsn)
       FROM pg_replication_slots
       WHERE slot_name = $1 AND confirmed_flush_lsn < $2::pg_lsn`,
      [context.slotName, formatLsn(advancedTo)],
    );
  }
  return { rowsByStream, advancedTo, caughtUp, truncatedStreams };
}

async function syncCdcStreams(
  context: SyncContext,
  plans: StreamSyncPlan[],
  client: Client,
): Promise<StreamSyncResult[]> {
  const { slotWasCreated } = await ensureCdcInfrastructure(client, context, plans);

  // Every sync, not just the snapshot: the WAL carries no DDL, so a column the
  // customer added since the stream started only reaches the destination table
  // through this. Without it ClickHouse silently drops the unknown field and the
  // new column stays empty forever.
  for (const plan of plans) {
    const table = context.tablesByName.get(tableKey(plan.schemaName, plan.tableName));
    if (table != null) await prepareDestination(context, plan, table);
  }

  const results = new Map<string, StreamSyncResult>();
  for (const plan of plans) {
    results.set(plan.streamId, { streamId: plan.streamId, rowsSynced: 0, syncCursor: plan.syncCursor, error: null });
  }

  // Snapshot anything not fully loaded yet. Done after the slot exists, so
  // changes made during the snapshot are captured by the WAL as well.
  for (const plan of plans) {
    // A slot we had to create while a stream already had progress relative to one
    // (following it, or part way through a snapshot it was covering) means the old
    // slot is gone — dropped, failed over, or restored from a backup. A new slot
    // starts at the current WAL position, so everything in between is missing and
    // only a fresh snapshot can recover it.
    const cursor = plan.syncCursor;
    const lostSlot = slotWasCreated && (cursor?.mode === "lsn" || cursor?.mode === "snapshot");
    if (cursor?.mode === "lsn" && !lostSlot) continue;
    const table = context.tablesByName.get(tableKey(plan.schemaName, plan.tableName));
    if (!table) continue;
    const resumeAfterKey = cursor?.mode === "snapshot" && !lostSlot ? cursor.key ?? null : null;
    const snapshot = await snapshotForCdc(context, plan, table, client, resumeAfterKey);
    results.set(plan.streamId, {
      streamId: plan.streamId,
      rowsSynced: snapshot.rowsSynced,
      syncCursor: snapshot.done
        ? { mode: "lsn", value: "0/0" }
        : { mode: "snapshot", value: "", key: snapshot.lastKey ?? undefined },
      error: null,
    });
  }

  // Rounds until caught up, not one fixed-size read: a single peek per sync caps
  // throughput at one peek per interval, and a source writing faster than that
  // would fall behind forever while its slot retained the backlog.
  const rowsByStream = new Map<string, number>();
  const truncatedStreams = new Set<string>();
  let advancedTo: bigint | null = null;
  do {
    const round = await consumeWalRound(context, plans, client);
    for (const [streamId, rows] of round.rowsByStream) {
      rowsByStream.set(streamId, (rowsByStream.get(streamId) ?? 0) + rows);
    }
    for (const streamId of round.truncatedStreams) truncatedStreams.add(streamId);
    if (round.advancedTo != null) advancedTo = round.advancedTo;
    if (round.caughtUp) break;
  } while (hasTimeLeft(context));

  if (advancedTo != null) {
    const lsnText = formatLsn(advancedTo);
    for (const plan of plans) {
      const existing = results.get(plan.streamId)!;
      results.set(plan.streamId, {
        ...existing,
        rowsSynced: existing.rowsSynced + (rowsByStream.get(plan.streamId) ?? 0),
        // A stream still mid-snapshot keeps its resume point; its WAL changes were
        // applied all the same and win over whatever the snapshot reads later.
        syncCursor: existing.syncCursor?.mode === "snapshot" ? existing.syncCursor : { mode: "lsn", value: lsnText },
        needsResnapshot: truncatedStreams.has(plan.streamId),
      });
    }
  }
  return [...results.values()];
}

/**
 * Runs every configured stream. One stream failing must not stop the others:
 * a permissions change on one table is not a reason to stop syncing the rest.
 */
export async function runStreamSyncs(context: SyncContext, plans: StreamSyncPlan[]): Promise<StreamSyncResult[]> {
  const results: StreamSyncResult[] = [];
  const cdcPlans = plans.filter(plan => plan.mode === "cdc");
  const pullPlans = plans.filter(plan => plan.mode !== "cdc");

  if (pullPlans.length > 0) {
    await withDataSourceClient(context.credentials, async client => {
      for (const plan of pullPlans) {
        const table = context.tablesByName.get(tableKey(plan.schemaName, plan.tableName));
        if (!table) {
          results.push({ streamId: plan.streamId, rowsSynced: 0, syncCursor: plan.syncCursor, error: "The table no longer exists, or our role can no longer read it." });
          continue;
        }
        try {
          results.push(await syncCursor(context, plan, table, client));
        } catch (error) {
          reportUnexpectedSyncError(error);
          results.push({
            streamId: plan.streamId,
            rowsSynced: 0,
            syncCursor: plan.syncCursor,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  }

  if (cdcPlans.length > 0) {
    try {
      // Slot management is refused inside a read-only transaction, so the CDC
      // connection opts out of it. Everything it runs is still only reads plus
      // the slot calls themselves.
      const cdcResults = await withDataSourceClient(
        context.credentials,
        async client => await syncCdcStreams(context, cdcPlans, client),
        { allowWrites: true },
      );
      results.push(...cdcResults);
    } catch (error) {
      reportUnexpectedSyncError(error);
      const message = error instanceof Error ? error.message : String(error);
      for (const plan of cdcPlans) {
        results.push({ streamId: plan.streamId, rowsSynced: 0, syncCursor: plan.syncCursor, error: message });
      }
    }
  }

  return results;
}

export { DELETED_COLUMN };

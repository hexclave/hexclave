import { isShallowEqual } from "@hexclave/shared/dist/utils/arrays";
import { inspect } from "node:util";
import { shouldSuppressPeriodicBulldozerLogs } from "../../logging.js";
import { traceSpan } from "../../otel.js";
import { DatabaseSeq } from "../index.js";
import type { LowLevelDatabaseDebugSnapshot } from "../low-level/index.js";
import { AugmentedTreeMap, AugmentedTreeMultiMap } from "../piledriver/data-structures/augmented-tree-map.js";
import { ConcatTreeList } from "../piledriver/data-structures/concat-tree-list.js";
import { PiledriverGarbageCollectionResult } from "../piledriver/gc.js";
import { isPiledriverHeapObjectSymbol, PiledriverDatabase, PiledriverDatabaseDebugSnapshot, PiledriverObject, piledriverObjectEquals } from "../piledriver/index.js";

// Code-unit comparison; localeCompare would persist trees whose order depends on the runtime locale.
function compareStrings(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function fromAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

/**
 * Canonical string encoding of a group key, used wherever group key *identity* (as defined by
 * piledriverObjectEquals) is needed on top of a compareGroupKeys ordering: two group keys map
 * to the same string iff they are piledriverObjectEquals-equal. Object keys are sorted so that
 * key insertion order does not matter.
 *
 * Memoized by object identity: this function is called from B-tree comparators (twice per key
 * comparison, O(log n) comparisons per tree operation), and CPU profiling showed it at ~5% of
 * process CPU during backfills. Piledriver objects are immutable, so caching by identity is
 * safe; the WeakMap lets group key objects be collected normally.
 */
const canonicalGroupKeyStringCache = new WeakMap<object, string>();
function canonicalGroupKeyString(groupKey: PiledriverObject): string {
  if (groupKey !== null && typeof groupKey === "object") {
    const cached = canonicalGroupKeyStringCache.get(groupKey);
    if (cached !== undefined) return cached;
    if (isPiledriverHeapObjectSymbol in groupKey) throw new Error("Group keys must not contain heap objects");
    const result = Array.isArray(groupKey)
      ? "[" + groupKey.map(canonicalGroupKeyString).join(",") + "]"
      : "{" + Object.entries(groupKey).sort(([a], [b]) => compareStrings(a, b)).map(([k, v]) => JSON.stringify(k) + ":" + canonicalGroupKeyString(v)).join(",") + "}";
    canonicalGroupKeyStringCache.set(groupKey, result);
    return result;
  }
  return JSON.stringify(groupKey);
}

type Range = { lte?: PiledriverObject, gte?: PiledriverObject, lt?: PiledriverObject, gt?: PiledriverObject, limit?: number, reverse?: boolean };
function isInRange(value: PiledriverObject, range: Range, comparator: (a: PiledriverObject, b: PiledriverObject) => number): boolean {
  return (range.gte === undefined || comparator(value, range.gte) >= 0)
    && (range.gt === undefined || comparator(value, range.gt) > 0)
    && (range.lte === undefined || comparator(value, range.lte) <= 0)
    && (range.lt === undefined || comparator(value, range.lt) < 0);
}

type TableChanges = {
  addedRows: {
    groupKey: PiledriverObject,
    // Row identifiers are unique across the entire table, not just within a group.
    rowIdentifier: string,
    rowSortKey: PiledriverObject,
    rowData: PiledriverObject,
  }[],
  modifiedRows: {
    groupKey: PiledriverObject,
    rowIdentifier: string,
    oldRowSortKey: PiledriverObject,
    newRowSortKey: PiledriverObject,
    oldRowData: PiledriverObject,
    newRowData: PiledriverObject,
  }[],
  deletedRows: {
    groupKey: PiledriverObject,
    rowIdentifier: string,
    oldRowSortKey: PiledriverObject,
    oldRowData: PiledriverObject,
  }[],

  addedGroups: {
    groupKey: PiledriverObject,
  }[],
  /**
   * NOTE: Groups can only be deleted if they have no rows.
   */
  deletedGroups: {
    groupKey: PiledriverObject,
  }[],
};
type GroupChanges = Omit<TableChanges, "addedGroups" | "deletedGroups">;
export type TableChangesDebugInfo = {
  addedRows: number,
  modifiedRows: number,
  deletedRows: number,
  addedGroups: number,
  deletedGroups: number,
  rowChanges: number,
  groupChanges: number,
};
export type BulldozerTableMutationDebugInfo = {
  tableId: string,
  phase: "source" | "downstream",
  durationMs: number,
  inputChangeCountsByInputTable: Record<string, TableChangesDebugInfo>,
  outputChangeCounts: TableChangesDebugInfo,
};
export type BulldozerAffectedTableDebugInfo = {
  tableId: string,
  operationCount: number,
  sourceOperationCount: number,
  emitInputChangesOperationCount: number,
  totalDurationMs: number,
  sourceDurationMs: number,
  emitInputChangesDurationMs: number,
  inputChangeCountsByInputTable: Record<string, TableChangesDebugInfo>,
  totalInputChangeCounts: TableChangesDebugInfo,
  outputChangeCounts: TableChangesDebugInfo,
};
export type BulldozerSnapshotMutationDebugInfo = {
  operation: "setOrDeleteRow" | "setOrDeleteRows" | "tick" | "applyTableMutation",
  sourceTableId?: string,
  rowsSetOrDeleted: number,
  durationMs: number,
  tableOperations: BulldozerTableMutationDebugInfo[],
  affectedTableIds: string[],
  affectedTables: Record<string, BulldozerAffectedTableDebugInfo>,
  totalOutputChangeCounts: TableChangesDebugInfo,
};
export type BulldozerSnapshotMutationResult = {
  newSnapshot: BulldozerDatabaseSnapshot,
  debugInfo: BulldozerSnapshotMutationDebugInfo,
};

function appendAll<T>(target: T[], values: Iterable<T>) {
  for (const value of values) target.push(value);
}

function tableChangesDebugInfo(changes: TableChanges): TableChangesDebugInfo {
  return {
    addedRows: changes.addedRows.length,
    modifiedRows: changes.modifiedRows.length,
    deletedRows: changes.deletedRows.length,
    addedGroups: changes.addedGroups.length,
    deletedGroups: changes.deletedGroups.length,
    rowChanges: changes.addedRows.length + changes.modifiedRows.length + changes.deletedRows.length,
    groupChanges: changes.addedGroups.length + changes.deletedGroups.length,
  };
}

function emptyTableChangesDebugInfo(): TableChangesDebugInfo {
  return {
    addedRows: 0,
    modifiedRows: 0,
    deletedRows: 0,
    addedGroups: 0,
    deletedGroups: 0,
    rowChanges: 0,
    groupChanges: 0,
  };
}

function mergeTableChangesDebugInfo(target: TableChangesDebugInfo, value: TableChangesDebugInfo) {
  target.addedRows += value.addedRows;
  target.modifiedRows += value.modifiedRows;
  target.deletedRows += value.deletedRows;
  target.addedGroups += value.addedGroups;
  target.deletedGroups += value.deletedGroups;
  target.rowChanges += value.rowChanges;
  target.groupChanges += value.groupChanges;
}

function inputChangeCountsByInputTable(changes: Record<string, TableChanges>): Record<string, TableChangesDebugInfo> {
  return Object.fromEntries(Object.entries(changes).map(([inputTableKey, tableChanges]) => [inputTableKey, tableChangesDebugInfo(tableChanges)]));
}

function emptyAffectedTableDebugInfo(tableId: string): BulldozerAffectedTableDebugInfo {
  return {
    tableId,
    operationCount: 0,
    sourceOperationCount: 0,
    emitInputChangesOperationCount: 0,
    totalDurationMs: 0,
    sourceDurationMs: 0,
    emitInputChangesDurationMs: 0,
    inputChangeCountsByInputTable: {},
    totalInputChangeCounts: emptyTableChangesDebugInfo(),
    outputChangeCounts: emptyTableChangesDebugInfo(),
  };
}

function mergeInputChangeCounts(
  target: Record<string, TableChangesDebugInfo>,
  totalTarget: TableChangesDebugInfo,
  value: Record<string, TableChangesDebugInfo>,
) {
  for (const [inputTableKey, counts] of Object.entries(value)) {
    target[inputTableKey] ??= emptyTableChangesDebugInfo();
    mergeTableChangesDebugInfo(target[inputTableKey], counts);
    mergeTableChangesDebugInfo(totalTarget, counts);
  }
}

function affectedTablesDebugInfo(tableOperations: BulldozerTableMutationDebugInfo[]): Record<string, BulldozerAffectedTableDebugInfo> {
  const result = new Map<string, BulldozerAffectedTableDebugInfo>();
  for (const operation of tableOperations) {
    let table = result.get(operation.tableId);
    if (table === undefined) {
      table = emptyAffectedTableDebugInfo(operation.tableId);
      result.set(operation.tableId, table);
    }

    table.operationCount++;
    table.totalDurationMs += operation.durationMs;
    if (operation.phase === "source") {
      table.sourceOperationCount++;
      table.sourceDurationMs += operation.durationMs;
    } else {
      table.emitInputChangesOperationCount++;
      table.emitInputChangesDurationMs += operation.durationMs;
    }
    mergeInputChangeCounts(table.inputChangeCountsByInputTable, table.totalInputChangeCounts, operation.inputChangeCountsByInputTable);
    mergeTableChangesDebugInfo(table.outputChangeCounts, operation.outputChangeCounts);
  }
  return Object.fromEntries(result);
}

function logSnapshotMutationDebugInfo(value: {
  operation: BulldozerSnapshotMutationDebugInfo["operation"],
  tableId: string | null,
  rowsSetOrDeleted: number,
  debugInfo: BulldozerSnapshotMutationDebugInfo,
}) {
  if (shouldSuppressPeriodicBulldozerLogs) return;
  if (value.rowsSetOrDeleted <= 0) return;
  console.debug("bulldozer-js snapshot mutation", inspect(value, {
    depth: null,
    colors: false,
    maxArrayLength: null,
    breakLength: 160,
  }));
}

function validateTableChanges(changes: TableChanges, context: string) {
  const deletedGroupKeys = new Set(changes.deletedGroups.map(group => canonicalGroupKeyString(group.groupKey)));
  const readdedGroup = changes.addedGroups.find(group => deletedGroupKeys.has(canonicalGroupKeyString(group.groupKey)));
  if (readdedGroup) throw new Error(`${context} violates the table changes contract: group ${JSON.stringify(readdedGroup.groupKey)} was both deleted and added in the same change batch`);
}

function normalizeGroupLifecycle(outputChanges: TableChanges) {
  const addedByKey = new Map(outputChanges.addedGroups.map(group => [canonicalGroupKeyString(group.groupKey), group]));
  const deletedByKey = new Map(outputChanges.deletedGroups.map(group => [canonicalGroupKeyString(group.groupKey), group]));
  outputChanges.addedGroups = outputChanges.addedGroups.filter(group => !deletedByKey.has(canonicalGroupKeyString(group.groupKey)));
  outputChanges.deletedGroups = outputChanges.deletedGroups.filter(group => !addedByKey.has(canonicalGroupKeyString(group.groupKey)));
}

/** Concatenates `from` into `into`, in place. Used to fold a batch of per-row source-table outputs into one change set before cascading. */
function mergeTableChanges(into: TableChanges, from: TableChanges) {
  into.addedRows.push(...from.addedRows);
  into.modifiedRows.push(...from.modifiedRows);
  into.deletedRows.push(...from.deletedRows);
  into.addedGroups.push(...from.addedGroups);
  into.deletedGroups.push(...from.deletedGroups);
}

function changedRowsFromTableChanges(changes: Pick<TableChanges, "addedRows" | "modifiedRows" | "deletedRows">): {
  old: undefined | {
    groupKey: PiledriverObject,
    rowIdentifier: string,
    rowSortKey: PiledriverObject,
    rowData: PiledriverObject,
  },
  new: undefined | {
    groupKey: PiledriverObject,
    rowIdentifier: string,
    rowSortKey: PiledriverObject,
    rowData: PiledriverObject,
  },
}[] {
  // Order matters for consumers that apply these changes to a tree: deletions first so that
  // additions can re-use a deleted identifier and sort key (e.g. flatMap modifications,
  // transduce value changes), and modifications last so they can target rows added in the
  // same batch (e.g. a reduce group created and filled in one batch).
  return [
    ...changes.deletedRows.map(row => ({ old: { groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.oldRowSortKey, rowData: row.oldRowData }, new: undefined })),
    ...changes.addedRows.map(row => ({ old: undefined, new: { groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.rowSortKey, rowData: row.rowData } })),
    ...changes.modifiedRows.map(row => ({ old: { groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.oldRowSortKey, rowData: row.oldRowData }, new: { groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.newRowSortKey, rowData: row.newRowData } })),
  ];
}

function changedRowsToGroupChanges(changes: {
  old: undefined | {
    groupKey: PiledriverObject,
    rowIdentifier: string,
    rowSortKey: PiledriverObject,
    rowData: PiledriverObject,
  },
  new: undefined | {
    groupKey: PiledriverObject,
    rowIdentifier: string,
    rowSortKey: PiledriverObject,
    rowData: PiledriverObject,
  },
}[]): GroupChanges {
  const res: GroupChanges = { addedRows: [], modifiedRows: [], deletedRows: [] };
  for (const row of changes) {
    if (row.old === undefined) {
      if (row.new === undefined) throw new Error("Added row has no new sort key");
      res.addedRows.push({ groupKey: row.new.groupKey, rowIdentifier: row.new.rowIdentifier, rowSortKey: row.new.rowSortKey, rowData: row.new.rowData });
    } else if (row.new === undefined) {
      res.deletedRows.push({ groupKey: row.old.groupKey, rowIdentifier: row.old.rowIdentifier, oldRowSortKey: row.old.rowSortKey, oldRowData: row.old.rowData });
    } else {
      if (!piledriverObjectEquals(row.old.groupKey, row.new.groupKey)) throw new Error("Group key changed");
      if (row.old.rowIdentifier !== row.new.rowIdentifier) throw new Error("Row identifier changed");
      res.modifiedRows.push({ groupKey: row.new.groupKey, rowIdentifier: row.new.rowIdentifier, oldRowSortKey: row.old.rowSortKey, newRowSortKey: row.new.rowSortKey, oldRowData: row.old.rowData, newRowData: row.new.rowData });
    }
  }
  return res;
}

function changedRowsToTableChanges(
  changes: Parameters<typeof changedRowsToGroupChanges>[0],
  groupChanges: Pick<TableChanges, "addedGroups" | "deletedGroups">,
): TableChanges {
  return {
    ...changedRowsToGroupChanges(changes),
    addedGroups: groupChanges.addedGroups,
    deletedGroups: groupChanges.deletedGroups,
  };
}

type BulldozerTableImplementationInputTable = {
  listGroups(options: {
    range: Range,
  }): AsyncIterable<{ groupKey: PiledriverObject }>,

  listRowsInGroup(options: {
    groupKey: PiledriverObject,
    range: Range,
  }): AsyncIterable<{ groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }>,

  compareGroupKeys(options: {
    a: PiledriverObject,
    b: PiledriverObject,
  }): number,
  compareSortKeys(options: {
    a: PiledriverObject,
    b: PiledriverObject,
  }): number,
};

type BulldozerTableImplementation = {
  /**
   * If true, the table keeps no materialized state derived from its inputs (all reads are
   * computed lazily from the inputs), so migrations skip the input backfill when the table
   * is created over already-populated inputs.
   */
  isStateless?: boolean,

  init(options: {
    inputTables: Record<string, BulldozerTableImplementationInputTable>,
  }): { serializedTable: PiledriverObject },

  listGroups(options: {
    serializedTable: PiledriverObject,
    inputTables: Record<string, BulldozerTableImplementationInputTable>,
    range: Range,
  }): AsyncIterable<{ groupKey: PiledriverObject }>,

  listRowsInGroup(options: {
    serializedTable: PiledriverObject,
    inputTables: Record<string, BulldozerTableImplementationInputTable>,
    groupKey: PiledriverObject,
    range: Range,
  }): AsyncIterable<{ groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }>,

  setOrDeleteRow?(options: {
    serializedTable: PiledriverObject,
    inputTables: Record<string, BulldozerTableImplementationInputTable>,
    rowIdentifier: string,
    newRowData: PiledriverObject | undefined,
  }): Promise<{ newSerializedTable: PiledriverObject, outputChanges: TableChanges }>,

  tick?(options: {
    serializedTable: PiledriverObject,
    inputTables: Record<string, BulldozerTableImplementationInputTable>,
    now: Date,
  }): Promise<{ newSerializedTable: PiledriverObject, outputChanges: TableChanges }>,

  emitInputChanges(options: {
    serializedTable: PiledriverObject,
    inputTables: Record<string, BulldozerTableImplementationInputTable>,
    changes: Record<string, TableChanges>,
  }): Promise<{ newSerializedTable: PiledriverObject, outputChanges: TableChanges }>,

  /**
   * Negative values indicate that a < b, positive values indicate that a > b, and zero indicates that a ~ b (even if a !== b) and the order is implementation-defined (and may differ from execution to execution).
   */
  compareGroupKeys(options: {
    serializedTable: PiledriverObject,
    inputTables: Record<string, BulldozerTableImplementationInputTable>,
    a: PiledriverObject,
    b: PiledriverObject,
  }): number,
  compareSortKeys(options: {
    serializedTable: PiledriverObject,
    inputTables: Record<string, BulldozerTableImplementationInputTable>,
    groupKey: PiledriverObject,
    a: PiledriverObject,
    b: PiledriverObject,
  }): number,
};

type BulldozerTableState = {
  table: BulldozerTableImplementation,
  outputTables: { tableId: string, inputTableKey: string }[],
  inputTableIds: { [key in string]: string },
  debugMetadata?: BulldozerTableDebugMetadata,
};
type BulldozerDatabaseTablesState = {
  tables: Record<string, BulldozerTableState>,
  mostRecentlyCompletedMigrationIndex: number,
};

type BulldozerDatabaseSnapshotSerialized = {
  serializedTables: Record<string, PiledriverObject>,
  mostRecentlyCompletedMigrationIndex: number,
  uniqueSnapshotIdentifier: string,
};

function createInputTables(
  tables: Record<string, BulldozerTableState>,
  getSerializedTable: (tableId: string) => PiledriverObject,
  tableId: string,
): Record<string, BulldozerTableImplementationInputTable> {
  return Object.fromEntries(Object.entries(tables[tableId].inputTableIds).map(([inputTableKey, inputTableId]) => {
    const inputTable = tables[inputTableId].table;
    const inputTables = () => createInputTables(tables, getSerializedTable, inputTableId);
    return [inputTableKey, {
      listGroups: ({ range }) => inputTable.listGroups({ serializedTable: getSerializedTable(inputTableId), inputTables: inputTables(), range }),
      listRowsInGroup: ({ groupKey, range }) => inputTable.listRowsInGroup({
        serializedTable: getSerializedTable(inputTableId),
        inputTables: inputTables(),
        groupKey,
        range,
      }),
      compareGroupKeys: ({ a, b }) => inputTable.compareGroupKeys({ serializedTable: getSerializedTable(inputTableId), inputTables: inputTables(), a, b }),
      compareSortKeys: ({ a, b }) => inputTable.compareSortKeys({ serializedTable: getSerializedTable(inputTableId), inputTables: inputTables(), groupKey: null, a, b }),
    } satisfies BulldozerTableImplementationInputTable];
  }));
}

async function reconstructTableOutputChangesForBackfill(
  tables: Record<string, BulldozerTableState>,
  getSerializedTable: (tableId: string) => PiledriverObject,
  tableId: string,
): Promise<TableChanges> {
  const table = tables[tableId].table;
  const inputTables = createInputTables(tables, getSerializedTable, tableId);
  try {
    const changes: TableChanges = { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] };
    for await (const { groupKey } of table.listGroups({ serializedTable: getSerializedTable(tableId), inputTables, range: {} })) {
      changes.addedGroups.push({ groupKey });
      for await (const row of table.listRowsInGroup({ serializedTable: getSerializedTable(tableId), inputTables, groupKey, range: {} })) {
        changes.addedRows.push(row);
      }
    }
    return changes;
  } catch (error) {
    // Lazy operators still expose listRowsInGroup, but they or their inputs may intentionally reject
    // the read. Backfill can reconstruct that chain from change propagation instead.
    if (!(error instanceof Error) || !error.message.includes("does not support listing rows")) throw error;
  }

  const inputChanges = Object.fromEntries(await Promise.all(
    Object.entries(tables[tableId].inputTableIds).map(async ([inputTableKey, inputTableId]) => [
      inputTableKey,
      await reconstructTableOutputChangesForBackfill(tables, getSerializedTable, inputTableId),
    ]),
  ));
  const { serializedTable } = table.init({ inputTables });
  const result = await table.emitInputChanges({ serializedTable, inputTables, changes: inputChanges });
  validateTableChanges(result.outputChanges, `Reconstructed output of ${tableId}`);
  return result.outputChanges;
}

/**
 * Brings a freshly initialized table up to date with its inputs' existing data by replaying
 * everything as one change batch (all groups created, all rows added). Without this, stateful
 * tables (materialize/sort/reduce/...) created by a later migration over non-empty inputs
 * would start empty and permanently diverge.
 */
async function backfillTableFromInputs(
  tableId: string,
  tables: Record<string, BulldozerTableState>,
  getSerializedTable: (tableId: string) => PiledriverObject,
  table: BulldozerTableImplementation,
  serializedTable: PiledriverObject,
  inputTables: Record<string, BulldozerTableImplementationInputTable>,
): Promise<PiledriverObject> {
  if (table.isStateless) return serializedTable;
  const changes: Record<string, TableChanges> = {};
  let hasChanges = false;
  for (const [inputTableKey, inputTableId] of Object.entries(tables[tableId].inputTableIds)) {
    const inputChanges = await reconstructTableOutputChangesForBackfill(tables, getSerializedTable, inputTableId);
    changes[inputTableKey] = inputChanges;
    hasChanges ||= inputChanges.addedGroups.length > 0 || inputChanges.addedRows.length > 0;
  }
  if (!hasChanges) return serializedTable;
  // Output changes are discarded: the table has no consumers yet, and tables created by later
  // steps will backfill from this table's (already updated) state themselves.
  const result = await table.emitInputChanges({ serializedTable, inputTables, changes });
  validateTableChanges(result.outputChanges, "Backfill output");
  return result.newSerializedTable;
}

class BulldozerDatabaseSnapshot {
  private constructor(
    private readonly serialized: BulldozerDatabaseSnapshotSerialized,
    private readonly tablesState: BulldozerDatabaseTablesState,
  ) {
    // ensure that the serialized snapshot has completed exactly the migrations this tables state was built from
    if (serialized.mostRecentlyCompletedMigrationIndex < tablesState.mostRecentlyCompletedMigrationIndex) {
      throw new Error("Snapshot has fewer completed migrations than the tables schema — did you forget to run applyRemainingMigrations?");
    }
    if (serialized.mostRecentlyCompletedMigrationIndex > tablesState.mostRecentlyCompletedMigrationIndex) {
      throw new Error("Snapshot has more completed migrations than this database knows about — was it created by newer code?");
    }

    // ensure that the tables in the tablesState are the same as the serialized tables
    if (!isShallowEqual(Object.keys(serialized.serializedTables).sort(), Object.keys(tablesState.tables).sort())) {
      throw new Error("Serialized tables and tables state do not match");
    }
  }

  toPiledriverObject(): PiledriverObject {
    return this.serialized;
  }

  static fromPiledriverObject(serialized: BulldozerDatabaseSnapshotSerialized, options: { tablesState: BulldozerDatabaseTablesState }): BulldozerDatabaseSnapshot {
    return new BulldozerDatabaseSnapshot(serialized, options.tablesState);
  }

  private _getInputTablesFrom(serializedTables: Record<string, PiledriverObject>, tableId: string): Record<string, BulldozerTableImplementationInputTable> {
    return createInputTables(this.tablesState.tables, id => serializedTables[id], tableId);
  }

  private _getInputTables(tableId: string): Record<string, BulldozerTableImplementationInputTable> {
    return this._getInputTablesFrom(this.serialized.serializedTables, tableId);
  }

  listGroups(options: {
    tableId: string,
    range: Range,
  }): AsyncIterable<{ groupKey: PiledriverObject }> {
    if (!(options.tableId in this.tablesState.tables)) throw new Error(`Table ${options.tableId} does not exist`);
    return this.tablesState.tables[options.tableId].table.listGroups({
      serializedTable: this.serialized.serializedTables[options.tableId],
      inputTables: this._getInputTables(options.tableId),
      range: options.range,
    });
  }

  listRowsInGroup(options: {
    tableId: string,
    groupKey: PiledriverObject,
    range: Range,
  }): AsyncIterable<{ groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }> {
    if (!(options.tableId in this.tablesState.tables)) throw new Error(`Table ${options.tableId} does not exist`);
    const table = this.tablesState.tables[options.tableId].table;
    return table.listRowsInGroup({
      serializedTable: this.serialized.serializedTables[options.tableId],
      inputTables: this._getInputTables(options.tableId),
      groupKey: options.groupKey,
      range: options.range,
    });
  }

  async setOrDeleteRow(options: {
    tableId: string,
    rowIdentifier: string,
    newRowData: PiledriverObject | undefined,
  }): Promise<BulldozerSnapshotMutationResult> {
    if (!(options.tableId in this.tablesState.tables)) throw new Error(`Table ${options.tableId} does not exist`);
    const setOrDeleteRow = this.tablesState.tables[options.tableId].table.setOrDeleteRow;
    if (!setOrDeleteRow) throw new Error("Table is not mutable");

    const result = await this._applyTableMutation({
      operation: "setOrDeleteRow",
      tableId: options.tableId,
      mutate: ({ serializedTable, inputTables }) => setOrDeleteRow({
        serializedTable,
        inputTables,
        rowIdentifier: options.rowIdentifier,
        newRowData: options.newRowData,
      }),
    });
    logSnapshotMutationDebugInfo({
      operation: "setOrDeleteRow",
      tableId: options.tableId,
      rowsSetOrDeleted: result.debugInfo.rowsSetOrDeleted,
      debugInfo: result.debugInfo,
    });
    return result;
  }

  /**
   * Applies many source-table mutations and cascades downstream exactly once.
   *
   * Each row is applied to the source (stored) table in turn, threading its
   * serialized state forward, and the per-row output changes are folded into a
   * single change set. The downstream DAG then runs once over that combined set
   * instead of once per row — collapsing N cascades (and N root reads/writes at
   * the snapshot layer) into one. This is the throughput path for bulk ingestion
   * such as the Postgres->bulldozer backfill.
   *
   * Soundness relies on every row touching a distinct identifier: merging an
   * add+modify (or add+delete) for the same id would feed the cascade
   * contradictory events. Callers ingesting primary keys satisfy this; we assert
   * rather than silently dedupe. (Group add/delete churn within the batch is
   * reconciled by `normalizeGroupLifecycle`, since the source table only ever has
   * the single null group.)
   */
  async setOrDeleteRows(options: {
    tableId: string,
    rows: { rowIdentifier: string, newRowData: PiledriverObject | undefined }[],
  }): Promise<BulldozerSnapshotMutationResult> {
    if (!(options.tableId in this.tablesState.tables)) throw new Error(`Table ${options.tableId} does not exist`);
    const setOrDeleteRow = this.tablesState.tables[options.tableId].table.setOrDeleteRow;
    if (!setOrDeleteRow) throw new Error("Table is not mutable");
    if (options.rows.length === 0) {
      const debugInfo: BulldozerSnapshotMutationDebugInfo = {
        operation: "setOrDeleteRows",
        sourceTableId: options.tableId,
        rowsSetOrDeleted: 0,
        durationMs: 0,
        tableOperations: [],
        affectedTableIds: [],
        affectedTables: {},
        totalOutputChangeCounts: emptyTableChangesDebugInfo(),
      };
      const result = { newSnapshot: this, debugInfo };
      logSnapshotMutationDebugInfo({
        operation: "setOrDeleteRows",
        tableId: options.tableId,
        rowsSetOrDeleted: 0,
        debugInfo,
      });
      return result;
    }

    const seenIdentifiers = new Set<string>();
    for (const row of options.rows) {
      if (seenIdentifiers.has(row.rowIdentifier)) throw new Error(`Duplicate row identifier ${row.rowIdentifier} in batch for table ${options.tableId}`);
      seenIdentifiers.add(row.rowIdentifier);
    }

    const result = await this._applyTableMutation({
      operation: "setOrDeleteRows",
      tableId: options.tableId,
      mutate: async ({ serializedTable, inputTables }) => {
        let currentSerializedTable = serializedTable;
        const combined: TableChanges = { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] };
        for (const row of options.rows) {
          const result = await setOrDeleteRow({
            serializedTable: currentSerializedTable,
            inputTables,
            rowIdentifier: row.rowIdentifier,
            newRowData: row.newRowData,
          });
          currentSerializedTable = result.newSerializedTable;
          mergeTableChanges(combined, result.outputChanges);
        }
        normalizeGroupLifecycle(combined);
        return { newSerializedTable: currentSerializedTable, outputChanges: combined };
      },
    });
    logSnapshotMutationDebugInfo({
      operation: "setOrDeleteRows",
      tableId: options.tableId,
      rowsSetOrDeleted: result.debugInfo.rowsSetOrDeleted,
      debugInfo: result.debugInfo,
    });
    return result;
  }

  async tick(now: Date): Promise<BulldozerSnapshotMutationResult> {
    const startedAt = performance.now();
    let snapshot: BulldozerDatabaseSnapshot = this;
    const tableOperations: BulldozerTableMutationDebugInfo[] = [];
    const affectedTableIds = new Set<string>();
    const totalOutputChangeCounts = emptyTableChangesDebugInfo();
    let rowsSetOrDeleted = 0;
    for (const [tableId, tableState] of Object.entries(this.tablesState.tables)) {
      const tick = tableState.table.tick;
      if (!tick) continue;
      const result = await snapshot._applyTableMutation({
        operation: "tick",
        tableId,
        mutate: ({ serializedTable, inputTables }) => tick({ serializedTable, inputTables, now }),
      });
      snapshot = result.newSnapshot;
      tableOperations.push(...result.debugInfo.tableOperations);
      for (const affectedTableId of result.debugInfo.affectedTableIds) affectedTableIds.add(affectedTableId);
      mergeTableChangesDebugInfo(totalOutputChangeCounts, result.debugInfo.totalOutputChangeCounts);
      rowsSetOrDeleted += result.debugInfo.rowsSetOrDeleted;
    }
    const debugInfo: BulldozerSnapshotMutationDebugInfo = {
      operation: "tick",
      rowsSetOrDeleted,
      durationMs: performance.now() - startedAt,
      tableOperations,
      affectedTableIds: [...affectedTableIds],
      affectedTables: affectedTablesDebugInfo(tableOperations),
      totalOutputChangeCounts,
    };
    logSnapshotMutationDebugInfo({
      operation: "tick",
      tableId: null,
      rowsSetOrDeleted,
      debugInfo,
    });
    return { newSnapshot: snapshot, debugInfo };
  }

  private async _applyTableMutation(options: {
    operation: BulldozerSnapshotMutationDebugInfo["operation"],
    tableId: string,
    mutate: (options: {
      serializedTable: PiledriverObject,
      inputTables: Record<string, BulldozerTableImplementationInputTable>,
    }) => Promise<{ newSerializedTable: PiledriverObject, outputChanges: TableChanges }>,
  }): Promise<BulldozerSnapshotMutationResult> {
    const startedAt = performance.now();
    return await traceSpan({ description: "bulldozer-js.bulldozer.applyTableMutation", attributes: { "bulldozer.table_id": options.tableId } }, async () => {
      const tablesState = this.tablesState;
      const serializedTables = { ...this.serialized.serializedTables };
      const pending = new Map<string, Record<string, TableChanges>>();
      const remainingInputs = new Map<string, number>();
      const tableOperations: BulldozerTableMutationDebugInfo[] = [];
      const affectedTableIds = new Set<string>();
      const totalOutputChangeCounts = emptyTableChangesDebugInfo();
      const inputTables = (id: string) => createInputTables(tablesState.tables, inputId => serializedTables[inputId], id);

      const emptyChanges = (): TableChanges => ({ addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] });
      const hasChanges = (changes: TableChanges) => changes.addedRows.length || changes.modifiedRows.length || changes.deletedRows.length || changes.addedGroups.length || changes.deletedGroups.length;
      const addPending = (tableId: string, inputTableKey: string, changes: TableChanges) => {
        if (!hasChanges(changes)) return;
        pending.set(tableId, { ...pending.get(tableId), [inputTableKey]: changes });
      };

      for (const queue = [options.tableId], seen = new Set<string>([options.tableId]); queue.length;) {
        for (const outputTable of tablesState.tables[queue.shift()!].outputTables) {
          remainingInputs.set(outputTable.tableId, (remainingInputs.get(outputTable.tableId) ?? 0) + 1);
          if (!seen.has(outputTable.tableId)) {
            seen.add(outputTable.tableId);
            queue.push(outputTable.tableId);
          }
        }
      }

      const sourceStartedAt = performance.now();
      const first = await traceSpan({ description: "bulldozer-js.bulldozer.mutateSourceTable", attributes: { "bulldozer.table_id": options.tableId } }, async () => await options.mutate({ serializedTable: serializedTables[options.tableId], inputTables: inputTables(options.tableId) }));
      validateTableChanges(first.outputChanges, `Table ${options.tableId} output`);
      const sourceOutputChangeCounts = tableChangesDebugInfo(first.outputChanges);
      tableOperations.push({
        tableId: options.tableId,
        phase: "source",
        durationMs: performance.now() - sourceStartedAt,
        inputChangeCountsByInputTable: {},
        outputChangeCounts: sourceOutputChangeCounts,
      });
      affectedTableIds.add(options.tableId);
      mergeTableChangesDebugInfo(totalOutputChangeCounts, sourceOutputChangeCounts);
      serializedTables[options.tableId] = first.newSerializedTable;
      for (const outputTable of tablesState.tables[options.tableId].outputTables) addPending(outputTable.tableId, outputTable.inputTableKey, first.outputChanges);

      for (const queue = tablesState.tables[options.tableId].outputTables.map(outputTable => outputTable.tableId); queue.length;) {
        const downstreamTableId = queue.shift()!;
        const left = (remainingInputs.get(downstreamTableId) ?? 1) - 1;
        remainingInputs.set(downstreamTableId, left);
        if (left > 0) continue;
        const table = tablesState.tables[downstreamTableId];
        const changes = pending.get(downstreamTableId);
        if (changes) {
          const normalizedChanges = Object.fromEntries(Object.keys(table.inputTableIds).map(inputTableKey => [inputTableKey, changes[inputTableKey] ?? emptyChanges()]));
          const downstreamStartedAt = performance.now();
          const result = await traceSpan({ description: "bulldozer-js.bulldozer.emitInputChanges", attributes: { "bulldozer.table_id": downstreamTableId } }, async () => await table.table.emitInputChanges({
            serializedTable: serializedTables[downstreamTableId],
            inputTables: inputTables(downstreamTableId),
            changes: normalizedChanges,
          }));
          validateTableChanges(result.outputChanges, `Table ${downstreamTableId} output`);
          const outputChangeCounts = tableChangesDebugInfo(result.outputChanges);
          tableOperations.push({
            tableId: downstreamTableId,
            phase: "downstream",
            durationMs: performance.now() - downstreamStartedAt,
            inputChangeCountsByInputTable: inputChangeCountsByInputTable(normalizedChanges),
            outputChangeCounts,
          });
          affectedTableIds.add(downstreamTableId);
          mergeTableChangesDebugInfo(totalOutputChangeCounts, outputChangeCounts);
          serializedTables[downstreamTableId] = result.newSerializedTable;
          for (const outputTable of table.outputTables) addPending(outputTable.tableId, outputTable.inputTableKey, result.outputChanges);
        }
        for (const outputTable of table.outputTables) {
          queue.push(outputTable.tableId);
        }
      }

      const debugInfo: BulldozerSnapshotMutationDebugInfo = {
        operation: options.operation,
        sourceTableId: options.tableId,
        rowsSetOrDeleted: totalOutputChangeCounts.rowChanges,
        durationMs: performance.now() - startedAt,
        tableOperations,
        affectedTableIds: [...affectedTableIds],
        affectedTables: affectedTablesDebugInfo(tableOperations),
        totalOutputChangeCounts,
      };
      return {
        newSnapshot: new BulldozerDatabaseSnapshot({ ...this.serialized, serializedTables, uniqueSnapshotIdentifier: crypto.randomUUID() }, this.tablesState),
        debugInfo,
      };
    });
  }
}

export type BulldozerTableDebugMetadata = Record<string, unknown>;
export type BulldozerDatabaseTableDescriptor = {
  tableId: string,
  inputTableIds: Record<string, string>,
  outputTables: { tableId: string, inputTableKey: string }[],
  supportsSetRow: boolean,
  supportsDeleteRow: boolean,
  supportsTick: boolean,
  debugMetadata?: BulldozerTableDebugMetadata,
};

type BulldozerDatabaseMigrationStep = (
  | { type: "initTable", tableId: string, table: BulldozerTableImplementation, inputTables: Record<string, string>, debugMetadata?: BulldozerTableDebugMetadata }
  | { type: "deleteTable", tableId: string }
);
type BulldozerDatabaseMigration = readonly BulldozerDatabaseMigrationStep[];
function createTablesStateFromMigrations(migrations: readonly BulldozerDatabaseMigration[]): BulldozerDatabaseTablesState {
  const state: BulldozerDatabaseTablesState = { tables: {}, mostRecentlyCompletedMigrationIndex: 0 };
  for (const migration of migrations) {
    for (const step of migration) {
      switch (step.type) {
        case "initTable": {
          if (step.tableId in state.tables) {
            throw new Error(`Table ${step.tableId} already exists`);
          }
          const tableState: BulldozerTableState = {
            table: step.table,
            outputTables: [],
            inputTableIds: { ...step.inputTables },
            debugMetadata: step.debugMetadata,
          };
          for (const [inputTableKey, inputTableId] of Object.entries(step.inputTables)) {
            if (!(inputTableId in state.tables)) {
              throw new Error(`Input table ${inputTableId} does not exist`);
            }
            const inputTableState = state.tables[inputTableId];
            inputTableState.outputTables.push({ tableId: step.tableId, inputTableKey });
          }
          state.tables[step.tableId] = tableState;
          break;
        }
        case "deleteTable": {
          if (!(step.tableId in state.tables)) {
            throw new Error(`Table ${step.tableId} does not exist`);
          }
          if (state.tables[step.tableId].outputTables.length > 0) {
            throw new Error(`Table ${step.tableId} has output tables`);
          }
          for (const inputTableId of Object.values(state.tables[step.tableId].inputTableIds)) {
            state.tables[inputTableId].outputTables = state.tables[inputTableId].outputTables.filter(outputTable => outputTable.tableId !== step.tableId);
          }
          delete state.tables[step.tableId];
          break;
        }
      }
    }
    state.mostRecentlyCompletedMigrationIndex++;
  }
  return state;
}

export type BulldozerDatabase = {
  getDebugInfo(): any,
  getPiledriverDatabase(): PiledriverDatabase,
  listTables(): BulldozerDatabaseTableDescriptor[],
  debugPiledriverSnapshot?(): Promise<PiledriverDatabaseDebugSnapshot>,
  debugLowLevelSnapshot?(): Promise<LowLevelDatabaseDebugSnapshot>,
  getSnapshot(): Promise<{ snapshot: BulldozerDatabaseSnapshot, seq: DatabaseSeq }>,
  withSnapshot(updateSnapshot: (snapshot: BulldozerDatabaseSnapshot) => Promise<BulldozerDatabaseSnapshot | BulldozerSnapshotMutationResult>): Promise<{ snapshot: BulldozerDatabaseSnapshot, seq: DatabaseSeq }>,
  withSnapshotConsistent(updateSnapshot: (snapshot: BulldozerDatabaseSnapshot) => Promise<BulldozerDatabaseSnapshot | BulldozerSnapshotMutationResult>): Promise<{ snapshot: BulldozerDatabaseSnapshot, seq: DatabaseSeq }>,
  waitUntilCurrentStateDurable(): Promise<void>,
  waitUntilCurrentStateConsistent(): Promise<void>,
  getPiledriverGarbageCollectionProcessStartedAtMillis(): number,
  collectPiledriverGarbage(cutoffTimestampMillis: number, maxObjects?: number): Promise<PiledriverGarbageCollectionResult>,
  close(): Promise<void>,
  applyRemainingMigrations(): Promise<{ seq: DatabaseSeq }>,
  debugWriteLockStats(): { heldMs: number, waitMs: number, acquisitions: number },
};

type BulldozerDatabaseRootSerialized = {
  snapshot: PiledriverObject,
};
export function declareBulldozerDatabase(piledriverDatabase: PiledriverDatabase, options: { migrations: readonly BulldozerDatabaseMigration[] }): BulldozerDatabase {
  const rootKey = new TextEncoder().encode("bulldozer-database-root").buffer;
  let latestRootWriteSeq = piledriverDatabase.initialSeq;
  const getRoot = async () => await piledriverDatabase.getRootObject(rootKey) as { object: BulldozerDatabaseRootSerialized, seq: DatabaseSeq };
  const setRoot = async (root: BulldozerDatabaseRootSerialized) => {
    const result = await piledriverDatabase.setRootObject(rootKey, root);
    // Keep the exact instant-availability sequence alive even after its cached
    // value is evicted. Re-reading the root can return initialSeq before the
    // corresponding LMDB flush has made this write durable.
    latestRootWriteSeq = result.seq;
    return result;
  };
  const tablesState = createTablesStateFromMigrations(options.migrations);
  let currentOperation: Promise<unknown> | null = null;
  let closePromise: Promise<void> | null = null;
  let writeLockHeldMs = 0;
  let writeLockWaitMs = 0;
  let writeLockAcquisitions = 0;

  const withWriteLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const waitStartedAt = performance.now();
    while (currentOperation !== null) {
      await currentOperation.catch(() => {});
    }
    // This includes acquisition overhead; it is meaningful as contention wait only when another operation held the lock.
    writeLockWaitMs += performance.now() - waitStartedAt;
    writeLockAcquisitions++;
    const operationPromise = Promise.resolve().then(operation);
    currentOperation = operationPromise;
    const heldStartedAt = performance.now();
    try {
      return await operationPromise;
    } finally {
      writeLockHeldMs += performance.now() - heldStartedAt;
      if (currentOperation === operationPromise) currentOperation = null;
    }
  };

  const deserializeSnapshot = (serialized: BulldozerDatabaseSnapshotSerialized) => BulldozerDatabaseSnapshot.fromPiledriverObject(
    serialized,
    { tablesState },
  );

  const getSnapshot = async () => await traceSpan("bulldozer-js.bulldozer.getSnapshot", async () => {
    const root = await getRoot();
    return {
      snapshot: deserializeSnapshot(root.object.snapshot as BulldozerDatabaseSnapshotSerialized),
      seq: root.seq,
    };
  });
  const withSnapshot = async (
    updateSnapshot: (snapshot: BulldozerDatabaseSnapshot) => Promise<BulldozerDatabaseSnapshot | BulldozerSnapshotMutationResult>,
    options: { consistent: boolean },
  ) => {
    return await traceSpan({ description: "bulldozer-js.bulldozer.withSnapshot", attributes: { "bulldozer.consistent": options.consistent } }, async () => {
      const startedAt = performance.now();
      let writeLockWaitMs = 0;
      let getSnapshotMs = 0;
      let updateSnapshotMs = 0;
      let toPiledriverObjectMs = 0;
      let setRootMs = 0;
      let waitUntilAvailableMs = 0;
      let waitUntilConsistentMs = 0;
      let mutationDebugInfo: BulldozerSnapshotMutationDebugInfo | undefined;
      const writeLockWaitStartedAt = performance.now();
      const result = await withWriteLock(async () => {
        writeLockWaitMs = performance.now() - writeLockWaitStartedAt;
        const getSnapshotStartedAt = performance.now();
        const { snapshot } = await getSnapshot();
        getSnapshotMs = performance.now() - getSnapshotStartedAt;
        const updateSnapshotStartedAt = performance.now();
        const updateResult = await updateSnapshot(snapshot);
        updateSnapshotMs = performance.now() - updateSnapshotStartedAt;
        mutationDebugInfo = updateResult instanceof BulldozerDatabaseSnapshot ? undefined : updateResult.debugInfo;
        const newSnapshot = updateResult instanceof BulldozerDatabaseSnapshot ? updateResult : updateResult.newSnapshot;
        const toPiledriverObjectStartedAt = performance.now();
        const newSnapshotPiledriverObject = newSnapshot.toPiledriverObject();
        toPiledriverObjectMs = performance.now() - toPiledriverObjectStartedAt;
        const setRootStartedAt = performance.now();
        const { seq } = await setRoot({ snapshot: newSnapshotPiledriverObject });
        setRootMs = performance.now() - setRootStartedAt;
        const waitUntilAvailableStartedAt = performance.now();
        await piledriverDatabase.waitUntilAvailable(seq);
        waitUntilAvailableMs = performance.now() - waitUntilAvailableStartedAt;
        return { snapshot: newSnapshot, seq };
      });
      if (options.consistent) {
        const waitUntilConsistentStartedAt = performance.now();
        await piledriverDatabase.waitUntilConsistent(result.seq);
        waitUntilConsistentMs = performance.now() - waitUntilConsistentStartedAt;
      }
      if (!shouldSuppressPeriodicBulldozerLogs) {
        console.debug("bulldozer-js withSnapshot timing", inspect({
          consistent: options.consistent,
          elapsedMs: performance.now() - startedAt,
          writeLockWaitMs,
          getSnapshotMs,
          updateSnapshotMs,
          toPiledriverObjectMs,
          setRootMs,
          waitUntilAvailableMs,
          waitUntilConsistentMs,
          mutation: mutationDebugInfo === undefined ? undefined : {
            operation: mutationDebugInfo.operation,
            sourceTableId: mutationDebugInfo.sourceTableId,
            rowsSetOrDeleted: mutationDebugInfo.rowsSetOrDeleted,
            durationMs: mutationDebugInfo.durationMs,
          },
        }, { depth: null, maxArrayLength: null }));
      }
      return result;
    });
  };

  return {
    getDebugInfo() {
      return {
        backend: "bulldozer",
        constructorArguments: { piledriverDatabase, options },
        piledriverDatabase,
        rootKey,
        getRoot,
        setRoot,
        latestRootWriteSeq,
        tablesState,
        currentOperation,
        closePromise,
      };
    },
    getPiledriverDatabase: () => piledriverDatabase,
    debugWriteLockStats: () => ({ heldMs: writeLockHeldMs, waitMs: writeLockWaitMs, acquisitions: writeLockAcquisitions }),
    listTables: () => Object.entries(tablesState.tables).map(([tableId, tableState]) => ({
      tableId,
      inputTableIds: { ...tableState.inputTableIds },
      outputTables: tableState.outputTables.map(outputTable => ({ ...outputTable })),
      supportsSetRow: tableState.table.setOrDeleteRow !== undefined,
      supportsDeleteRow: tableState.table.setOrDeleteRow !== undefined,
      supportsTick: tableState.table.tick !== undefined,
      debugMetadata: tableState.debugMetadata === undefined ? undefined : { ...tableState.debugMetadata },
    })),
    debugPiledriverSnapshot: async () => await piledriverDatabase.debugSnapshot?.() ?? { roots: [], heap: [] },
    debugLowLevelSnapshot: async () => await piledriverDatabase.debugLowLevelSnapshot?.() ?? { stores: {}, dumps: {} },
    getSnapshot,
    withSnapshot: async (updateSnapshot) => await withSnapshot(updateSnapshot, { consistent: false }),
    withSnapshotConsistent: async (updateSnapshot) => await withSnapshot(updateSnapshot, { consistent: true }),
    waitUntilCurrentStateDurable: async () => await traceSpan("bulldozer-js.bulldozer.waitUntilCurrentStateDurable", async () => await withWriteLock(async () => {
      // Taking the write lock makes this a barrier for every earlier mutation.
      // Waiting on the retained write sequence avoids the eviction race where a
      // fresh read sees initialSeq while the original LMDB flush is still pending.
      await piledriverDatabase.waitUntilDurable(latestRootWriteSeq);
    })),
    waitUntilCurrentStateConsistent: async () => await traceSpan("bulldozer-js.bulldozer.waitUntilCurrentStateConsistent", async () => await withWriteLock(async () => {
      // Use the retained write sequence for the same reason as the durability barrier above:
      // reading a fresh snapshot can lose an evicted instant-availability sequence.
      await piledriverDatabase.waitUntilConsistent(latestRootWriteSeq);
    })),
    getPiledriverGarbageCollectionProcessStartedAtMillis: () => piledriverDatabase.getGarbageCollectionProcessStartedAtMillis(),
    collectPiledriverGarbage: async (cutoffTimestampMillis, maxObjects) => {
      if (closePromise !== null) throw new Error("Bulldozer database is closing and cannot start garbage collection");
      return await withWriteLock(async () => {
        // Recheck after waiting for the lock: close may have started while GC was queued.
        if (closePromise !== null) throw new Error("Bulldozer database is closing and cannot start garbage collection");
        return await piledriverDatabase.collectGarbage(cutoffTimestampMillis, maxObjects);
      });
    },
    close() {
      if (closePromise === null) {
        closePromise = traceSpan("bulldozer-js.bulldozer.close", async () => await withWriteLock(async () => {
          try {
            await piledriverDatabase.waitUntilDurable(latestRootWriteSeq);
          } finally {
            await piledriverDatabase.close();
          }
        }));
      }
      return closePromise;
    },
    applyRemainingMigrations: async () => await traceSpan("bulldozer-js.bulldozer.applyRemainingMigrations", async () => await withWriteLock(async () => {
      let snapshot: BulldozerDatabaseSnapshotSerialized;
      let currentSeq = piledriverDatabase.initialSeq;
      let foundExistingRoot = true;
      try {
        const root = await getRoot();
        snapshot = root.object.snapshot as BulldozerDatabaseSnapshotSerialized;
        currentSeq = root.seq;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Root object not found") throw error;
        foundExistingRoot = false;
        snapshot = {
          serializedTables: {},
          mostRecentlyCompletedMigrationIndex: 0,
          uniqueSnapshotIdentifier: crypto.randomUUID(),
        };
      }

      if (snapshot.mostRecentlyCompletedMigrationIndex > options.migrations.length) {
        throw new Error("Snapshot has more completed migrations than this database knows about");
      }
      if (snapshot.mostRecentlyCompletedMigrationIndex === options.migrations.length) {
        if (foundExistingRoot) return { seq: currentSeq };
        const { seq } = await setRoot({ snapshot });
        await piledriverDatabase.waitUntilConsistent(seq);
        return { seq };
      }

      const serializedTables = { ...snapshot.serializedTables };
      for (let i = snapshot.mostRecentlyCompletedMigrationIndex; i < options.migrations.length; i++) {
        const stepsSoFar: BulldozerDatabaseMigrationStep[] = [];
        for (const step of options.migrations[i]) {
          stepsSoFar.push(step);
          switch (step.type) {
            case "initTable": {
              if (step.tableId in serializedTables) throw new Error(`Table ${step.tableId} already exists in snapshot`);
              // Build the state from only the steps applied so far: using the whole migration
              // would omit tables that a later step in the same migration deletes.
              const currentTablesState = createTablesStateFromMigrations([...options.migrations.slice(0, i), stepsSoFar]);
              const inputTables = createInputTables(currentTablesState.tables, id => serializedTables[id], step.tableId);
              const { serializedTable } = step.table.init({ inputTables });
              serializedTables[step.tableId] = await backfillTableFromInputs(
                step.tableId,
                currentTablesState.tables,
                id => serializedTables[id],
                step.table,
                serializedTable,
                inputTables,
              );
              break;
            }
            case "deleteTable": {
              if (!(step.tableId in serializedTables)) throw new Error(`Table ${step.tableId} does not exist in snapshot`);
              delete serializedTables[step.tableId];
              break;
            }
          }
        }
      }

      const { seq } = await setRoot({
        snapshot: {
          serializedTables,
          mostRecentlyCompletedMigrationIndex: options.migrations.length,
          uniqueSnapshotIdentifier: crypto.randomUUID(),
        },
      });
      await piledriverDatabase.waitUntilConsistent(seq);
      return { seq };
    })),
  };
}


type BulldozerGroupwiseTableImplementationInputGroup = {
  groupIdentifier: string,
  groupKey: PiledriverObject,
  listRows(options: {
    groupKey: PiledriverObject,
    range: Range,
  }): AsyncIterable<{ rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }>,
  compareSortKeys(options: {
    a: PiledriverObject,
    b: PiledriverObject,
  }): number,
};
function createGroupwiseTableImplementation(options: {
  init(options: {
    inputGroup: BulldozerGroupwiseTableImplementationInputGroup,
  }): { serializedGroup: PiledriverObject },

  listRows(options: {
    serializedGroup: PiledriverObject,
    inputGroup: BulldozerGroupwiseTableImplementationInputGroup,
    range: Range,
  }): AsyncIterable<{ rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }>,

  emitInputChanges(options: {
    serializedGroup: PiledriverObject,
    inputGroup: BulldozerGroupwiseTableImplementationInputGroup,
    changes: GroupChanges,
  }): Promise<{ newSerializedGroup: PiledriverObject, outputChanges: GroupChanges }>,

  emitInputGroupCreation(options: {
    serializedGroup: PiledriverObject,
    inputGroup: BulldozerGroupwiseTableImplementationInputGroup,
  }): Promise<{ newSerializedGroup: PiledriverObject, outputChanges: GroupChanges }>,

  emitInputGroupDeletion(options: {
    serializedGroup: PiledriverObject,
    inputGroup: BulldozerGroupwiseTableImplementationInputGroup,
  }): Promise<{ newSerializedGroup: PiledriverObject, outputChanges: GroupChanges }>,

  compareSortKeys(options: {
    inputTable: BulldozerTableImplementationInputTable,
    a: PiledriverObject,
    b: PiledriverObject,
  }): number,
}): BulldozerTableImplementation {
  const mapOptions = (inputTables: Record<string, BulldozerTableImplementationInputTable>): ConstructorParameters<typeof AugmentedTreeMap<PiledriverObject, { groupIdentifier: string, serializedGroup: PiledriverObject }, null>>[0] => ({
    // compareGroupKeys may return 0 for keys that merely sort equivalently (per its contract),
    // but this map needs key *identity*; the canonical-string tie-break keeps
    // piledriverObjectEquals-distinct group keys in distinct entries.
    comparator: (a: PiledriverObject, b: PiledriverObject) => inputTables.input.compareGroupKeys({ a, b }) || compareStrings(canonicalGroupKeyString(a), canonicalGroupKeyString(b)),
    extractAugmentation: (value) => null,
    mergeAugmentations: (...augmentations) => null,
  });
  const serialize = (map: AugmentedTreeMap<PiledriverObject, { groupIdentifier: string, serializedGroup: PiledriverObject }, null>) => ({
    version: 1,
    map: map.toPiledriverObject(),
  });
  const deserialize = (serialized: PiledriverObject, inputTables: Record<string, BulldozerTableImplementationInputTable>) => {
    if (typeof serialized !== "object" || serialized === null) throw new Error("Invalid serialized table");
    if (!("version" in serialized && serialized.version === 1) || !(typeof serialized.map === "object" && serialized.map !== null)) throw new Error("Invalid serialized table");
    return AugmentedTreeMap.fromPiledriverObject(serialized.map, mapOptions(inputTables));
  };
  const inputGroup = (inputTables: Record<string, BulldozerTableImplementationInputTable>, groupIdentifier: string, groupKey: PiledriverObject): BulldozerGroupwiseTableImplementationInputGroup => ({
    groupIdentifier,
    groupKey,
    listRows(options) {
      return inputTables.input.listRowsInGroup({ groupKey, range: options.range });
    },
    compareSortKeys: inputTables.input.compareSortKeys,
  });

  return {
    init({ inputTables }) {
      return { serializedTable: serialize(new AugmentedTreeMap(mapOptions(inputTables))) };
    },
    async * listGroups({ serializedTable, inputTables, range }) {
      const map = deserialize(serializedTable, inputTables);
      for await (const groupKey of map.keys(range)) {
        yield { groupKey };
      }
    },
    async * listRowsInGroup({ serializedTable, inputTables, groupKey, range }) {
      const map = deserialize(serializedTable, inputTables);
      const mapEntry = await map.get(groupKey);
      if (mapEntry === undefined) return;
      const { serializedGroup, groupIdentifier } = mapEntry;
      for await (const row of options.listRows({ serializedGroup, inputGroup: inputGroup(inputTables, groupIdentifier, groupKey), range })) {
        yield { groupKey, ...row };
      }
    },
    async emitInputChanges({ serializedTable, inputTables, changes }) {
      let map = deserialize(serializedTable, inputTables);
      const outputChanges: TableChanges = { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] };
      const groups = new Map<string, { groupKey: PiledriverObject, changes: GroupChanges }>();
      const group = (groupKey: PiledriverObject) => {
        const canonicalKey = canonicalGroupKeyString(groupKey);
        let existing = groups.get(canonicalKey);
        if (!existing) groups.set(canonicalKey, existing = { groupKey, changes: { addedRows: [], modifiedRows: [], deletedRows: [] } });
        return existing.changes;
      };

      for (const row of changes.input.addedRows) group(row.groupKey).addedRows.push(row);
      for (const row of changes.input.modifiedRows) group(row.groupKey).modifiedRows.push(row);
      for (const row of changes.input.deletedRows) group(row.groupKey).deletedRows.push(row);

      for (const { groupKey } of changes.input.addedGroups) {
        outputChanges.addedGroups.push({ groupKey });
        if (await map.has(groupKey)) throw new Error(`Group ${JSON.stringify(groupKey)} already exists`);
        const groupIdentifier = crypto.randomUUID();
        const group = inputGroup(inputTables, groupIdentifier, groupKey);
        const serializedGroup = options.init({ inputGroup: group }).serializedGroup;
        map = await map.set(groupKey, { groupIdentifier, serializedGroup });
        const creationEmitResult = await options.emitInputGroupCreation({ serializedGroup, inputGroup: group });
        map = await map.set(groupKey, { groupIdentifier, serializedGroup: creationEmitResult.newSerializedGroup });
        appendAll(outputChanges.addedRows, creationEmitResult.outputChanges.addedRows.map(row => ({ ...row, groupKey })));
        appendAll(outputChanges.modifiedRows, creationEmitResult.outputChanges.modifiedRows.map(row => ({ ...row, groupKey })));
        appendAll(outputChanges.deletedRows, creationEmitResult.outputChanges.deletedRows.map(row => ({ ...row, groupKey })));
      }

      for (const { groupKey, changes } of groups.values()) {
        const mapEntry = await map.get(groupKey);
        if (mapEntry === undefined) throw new Error(`Group ${JSON.stringify(groupKey)} does not exist`);
        const { serializedGroup, groupIdentifier } = mapEntry;
        const result = await options.emitInputChanges({
          serializedGroup,
          inputGroup: inputGroup(inputTables, groupIdentifier, groupKey),
          changes,
        });
        map = await map.set(groupKey, { groupIdentifier, serializedGroup: result.newSerializedGroup });
        const groupOutputChanges = {
          addedRows: result.outputChanges.addedRows.map(row => ({ ...row, groupKey })),
          modifiedRows: result.outputChanges.modifiedRows.map(row => ({ ...row, groupKey })),
          deletedRows: result.outputChanges.deletedRows.map(row => ({ ...row, groupKey })),
        };
        appendAll(outputChanges.addedRows, groupOutputChanges.addedRows);
        appendAll(outputChanges.modifiedRows, groupOutputChanges.modifiedRows);
        appendAll(outputChanges.deletedRows, groupOutputChanges.deletedRows);
      }

      for (const { groupKey } of changes.input.deletedGroups) {
        const mapEntry = await map.get(groupKey);
        if (mapEntry === undefined) throw new Error(`Group ${JSON.stringify(groupKey)} does not exist`);
        const deletionEmitResult = await options.emitInputGroupDeletion({
          serializedGroup: mapEntry.serializedGroup,
          inputGroup: inputGroup(inputTables, mapEntry.groupIdentifier, groupKey),
        });
        appendAll(outputChanges.addedRows, deletionEmitResult.outputChanges.addedRows.map(row => ({ ...row, groupKey })));
        appendAll(outputChanges.modifiedRows, deletionEmitResult.outputChanges.modifiedRows.map(row => ({ ...row, groupKey })));
        appendAll(outputChanges.deletedRows, deletionEmitResult.outputChanges.deletedRows.map(row => ({ ...row, groupKey })));
        map = await map.delete(groupKey);
        outputChanges.deletedGroups.push({ groupKey });
      }

      return {
        newSerializedTable: serialize(map),
        outputChanges,
      };
    },
    compareGroupKeys({ inputTables, a, b }): number {
      return inputTables.input.compareGroupKeys({ a, b });
    },
    compareSortKeys({ inputTables, groupKey, a, b }): number {
      return options.compareSortKeys({
        inputTable: inputTables.input,
        a,
        b,
      });
    },
  };
}


function createGroupwiseTreeTableImplementation<Key extends PiledriverObject, Value extends PiledriverObject, Augmentation extends PiledriverObject, EntryId extends PiledriverObject = string>(options: {
  getMapOptions(options: {
    inputGroup: BulldozerGroupwiseTableImplementationInputGroup,
  }): ConstructorParameters<typeof AugmentedTreeMultiMap<Key, Value, Augmentation, EntryId>>[0],

  listRows(options: {
    map: AugmentedTreeMultiMap<Key, Value, Augmentation, EntryId>,
    inputGroup: BulldozerGroupwiseTableImplementationInputGroup,
    range: Range,
  }): AsyncIterable<{ rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }>,

  emitInputChanges(options: {
    map: AugmentedTreeMultiMap<Key, Value, Augmentation, EntryId>,
    inputGroup: BulldozerGroupwiseTableImplementationInputGroup,
    changes: GroupChanges,
  }): Promise<{ newMap: AugmentedTreeMultiMap<Key, Value, Augmentation, EntryId>, outputChanges: GroupChanges }>,

  emitInputGroupCreation(options: {
    map: AugmentedTreeMultiMap<Key, Value, Augmentation, EntryId>,
    inputGroup: BulldozerGroupwiseTableImplementationInputGroup,
  }): Promise<{ newMap: AugmentedTreeMultiMap<Key, Value, Augmentation, EntryId>, outputChanges: GroupChanges }>,

  emitInputGroupDeletion(options: {
    map: AugmentedTreeMultiMap<Key, Value, Augmentation, EntryId>,
    inputGroup: BulldozerGroupwiseTableImplementationInputGroup,
  }): Promise<{ newMap: AugmentedTreeMultiMap<Key, Value, Augmentation, EntryId>, outputChanges: GroupChanges }>,

  compareSortKeys(options: {
    inputTable: BulldozerTableImplementationInputTable,
    a: PiledriverObject,
    b: PiledriverObject,
  }): number,
}): BulldozerTableImplementation {
  const serialize = (map: AugmentedTreeMultiMap<Key, Value, Augmentation, EntryId>) => ({
    version: 1,
    map: map.toPiledriverObject(),
  });
  const deserialize = (serialized: PiledriverObject, inputGroup: BulldozerGroupwiseTableImplementationInputGroup) => {
    if (typeof serialized !== "object" || serialized === null) throw new Error("Invalid serialized table");
    if (!("version" in serialized && serialized.version === 1) || !(typeof serialized.map === "object" && serialized.map !== null)) throw new Error("Invalid serialized table");
    return AugmentedTreeMultiMap.fromPiledriverObject(serialized.map, options.getMapOptions({ inputGroup }));
  };

  return createGroupwiseTableImplementation({
    init({ inputGroup }) {
      return { serializedGroup: serialize(new AugmentedTreeMultiMap(options.getMapOptions({ inputGroup }))) };
    },
    async * listRows({ serializedGroup, inputGroup, range }) {
      const map = deserialize(serializedGroup, inputGroup);
      yield* options.listRows({ map, inputGroup, range });
    },
    async emitInputChanges({ serializedGroup, inputGroup, changes }) {
      const map = deserialize(serializedGroup, inputGroup);
      const { newMap, outputChanges } = await options.emitInputChanges({ map, inputGroup, changes });
      return {
        newSerializedGroup: serialize(newMap),
        outputChanges,
      };
    },
    async emitInputGroupCreation({ serializedGroup, inputGroup }) {
      const map = deserialize(serializedGroup, inputGroup);
      const { newMap, outputChanges } = await options.emitInputGroupCreation({ map, inputGroup });
      return {
        newSerializedGroup: serialize(newMap),
        outputChanges,
      };
    },
    async emitInputGroupDeletion({ serializedGroup, inputGroup }) {
      const map = deserialize(serializedGroup, inputGroup);
      const { newMap, outputChanges } = await options.emitInputGroupDeletion({ map, inputGroup });
      return {
        newSerializedGroup: serialize(newMap),
        outputChanges,
      };
    },
    compareSortKeys({ inputTable, a, b }) {
      return options.compareSortKeys({ inputTable, a, b });
    },
  });
}


/**
 * Defines a mutable source table.
 *
 * Stored tables are the trust boundary of a Bulldozer database: bad source rows can poison every
 * derived table downstream. Pass `assertRowChange` for production tables to validate both row shape
 * and allowed transitions before a mutation is committed. For example, use it to reject malformed
 * rows, immutable-field changes, invalid state transitions, or deletes that your schema does not
 * permit. If the assertion throws, the write is aborted and the error is propagated to the caller.
 */
export function defineStoredTable(options: {
  assertRowChange?: (change: { rowIdentifier: string, oldRowData: PiledriverObject | undefined, newRowData: PiledriverObject | undefined }) => Promise<void>,
} = {}): BulldozerTableImplementation {
  const mapOptions: ConstructorParameters<typeof AugmentedTreeMap<string, PiledriverObject, null>>[0] = {
    comparator: compareStrings,
    extractAugmentation: (value) => null,
    mergeAugmentations: (...augmentations) => null,
  };
  const emptyMap = new AugmentedTreeMap(mapOptions);

  // Stored tables always use a null sort key (`compareSortKeys` is constantly 0).
  // Range bounds are sort-key ranges — same contract as derived tables / timefold —
  // so identity/flatMap pushdown of null bounds keeps working. Identifier-ordered
  // pagination belongs on a derived sort table (see payments-manual-transactions-sorted).
  const serialize = (map: typeof emptyMap) => ({
    version: 1,
    map: map.toPiledriverObject(),
  });
  const deserialize = (serialized: PiledriverObject) => {
    if (typeof serialized !== "object" || serialized === null) throw new Error("Invalid serialized table");
    if (!("version" in serialized && serialized.version === 1) || !(typeof serialized.map === "object" && serialized.map !== null)) throw new Error("Invalid serialized table");
    return AugmentedTreeMap.fromPiledriverObject(serialized.map, mapOptions);
  };

  return {
    init({ inputTables }) {
      return { serializedTable: serialize(emptyMap) };
    },
    async * listGroups({ serializedTable, range }) {
      if (range.gt !== undefined || range.lt !== undefined || range.limit === 0) return;
      // The group only exists once it has rows, matching the addedGroups/deletedGroups events
      // emitted by setOrDeleteRow.
      if (await deserialize(serializedTable).size() === 0) return;
      yield { groupKey: null };
    },
    async * listRowsInGroup({ serializedTable, groupKey, range }) {
      if (groupKey !== null || !isInRange(null, range, () => 0) || range.limit === 0) return;
      const map = deserialize(serializedTable);
      for await (const [rowIdentifier, rowData] of map.entries({
        reverse: range.reverse,
        limit: range.limit,
      })) {
        yield { groupKey: null, rowIdentifier, rowSortKey: null, rowData };
      }
    },
    async setOrDeleteRow({ serializedTable, rowIdentifier, newRowData }) {
      let map = deserialize(serializedTable);
      const oldSize = await map.size();
      const oldRowData = await map.get(rowIdentifier);
      await options.assertRowChange?.({ rowIdentifier, oldRowData, newRowData });
      const outputChanges: TableChanges = { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] };
      if (newRowData === undefined) {
        map = await map.delete(rowIdentifier);
        if (oldRowData !== undefined) {
          outputChanges.deletedRows.push({ groupKey: null, rowIdentifier, oldRowSortKey: null, oldRowData });
          if (await map.size() === 0) outputChanges.deletedGroups.push({ groupKey: null });
        }
      } else {
        map = await map.set(rowIdentifier, newRowData);
        if (oldRowData !== undefined) {
          outputChanges.modifiedRows.push({ groupKey: null, rowIdentifier, oldRowSortKey: null, newRowSortKey: null, oldRowData, newRowData });
        } else {
          if (oldSize === 0) outputChanges.addedGroups.push({ groupKey: null });
          outputChanges.addedRows.push({ groupKey: null, rowIdentifier, rowSortKey: null, rowData: newRowData });
        }
      }
      return {
        newSerializedTable: {
          version: 1,
          map: map.toPiledriverObject(),
        },
        outputChanges,
      };
    },
    async emitInputChanges({ serializedTable, changes }) {
      throw new Error("Called emitInputChanges on table without inputs");
    },
    compareGroupKeys(): number {
      return 0;
    },
    compareSortKeys(): number {
      return 0;
    },
  };
}


export function defineIdentityTable(): BulldozerTableImplementation {
  return {
    isStateless: true,
    init({ inputTables }) {
      return { serializedTable: null };
    },
    async * listGroups({ inputTables, range }) {
      yield* inputTables.input.listGroups({ range });
    },
    async * listRowsInGroup({ inputTables, groupKey, range }) {
      yield* inputTables.input.listRowsInGroup({ groupKey, range });
    },
    async emitInputChanges({ serializedTable, changes }) {
      return {
        newSerializedTable: serializedTable,
        outputChanges: changes.input,
      };
    },
    compareGroupKeys({ serializedTable, inputTables, a, b }): number {
      return inputTables.input.compareGroupKeys({ a, b });
    },
    compareSortKeys({ serializedTable, inputTables, a, b }): number {
      return inputTables.input.compareSortKeys({ a, b });
    },
  };
}


export function defineFilterTable(filter: (row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }) => boolean): BulldozerTableImplementation {
  return {
    isStateless: true,
    init({ inputTables }) {
      return { serializedTable: null };
    },
    async * listGroups({ inputTables, range }) {
      yield* inputTables.input.listGroups({ range });
    },
    async * listRowsInGroup({ inputTables, groupKey, range }) {
      if (range.limit === 0) return;
      let yielded = 0;
      const inputRange = { ...range, limit: undefined };
      for await (const row of inputTables.input.listRowsInGroup({ groupKey, range: inputRange })) {
        if (filter(row)) {
          yield row;
          if (range.limit !== undefined && ++yielded >= range.limit) return;
        }
      }
    },
    async emitInputChanges({ serializedTable, changes }) {
      const outputChanges: TableChanges = {
        addedRows: changes.input.addedRows.filter(filter),
        modifiedRows: [],
        deletedRows: changes.input.deletedRows.filter(row => filter({ groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.oldRowSortKey, rowData: row.oldRowData })),
        addedGroups: changes.input.addedGroups,
        deletedGroups: changes.input.deletedGroups,
      };
      for (const row of changes.input.modifiedRows) {
        const oldRow = { groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.oldRowSortKey, rowData: row.oldRowData };
        const newRow = { groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.newRowSortKey, rowData: row.newRowData };
        const hadOld = filter(oldRow);
        const hasNew = filter(newRow);
        if (hadOld && hasNew) outputChanges.modifiedRows.push(row);
        else if (hadOld) outputChanges.deletedRows.push({ groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, oldRowSortKey: row.oldRowSortKey, oldRowData: row.oldRowData });
        else if (hasNew) outputChanges.addedRows.push({ groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.newRowSortKey, rowData: row.newRowData });
      }
      return {
        newSerializedTable: serializedTable,
        outputChanges,
      };
    },
    compareGroupKeys({ serializedTable, inputTables, a, b }): number {
      return inputTables.input.compareGroupKeys({ a, b });
    },
    compareSortKeys({ serializedTable, inputTables, a, b }): number {
      return inputTables.input.compareSortKeys({ a, b });
    },
  };
}

export function defineMapTable(mapper: (row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }) => PiledriverObject): BulldozerTableImplementation {
  return {
    isStateless: true,
    init({ inputTables }) {
      return { serializedTable: null };
    },
    async * listGroups({ inputTables, range }) {
      yield* inputTables.input.listGroups({ range });
    },
    async * listRowsInGroup({ inputTables, groupKey, range }) {
      for await (const row of inputTables.input.listRowsInGroup({ groupKey, range })) {
        yield {
          groupKey: row.groupKey,
          rowIdentifier: row.rowIdentifier,
          rowSortKey: row.rowSortKey,
          rowData: mapper(row),
        };
      }
    },
    async emitInputChanges({ serializedTable, changes }) {
      const changedRows = changedRowsFromTableChanges(changes.input);
      const newChangedRows = changedRows.map(row => ({
        old: row.old && {
          ...row.old,
          rowData: mapper(row.old),
        },
        new: row.new && {
          ...row.new,
          rowData: mapper(row.new),
        },
      }));
      return {
        newSerializedTable: serializedTable,
        outputChanges: changedRowsToTableChanges(newChangedRows, changes.input),
      };
    },
    compareGroupKeys({ serializedTable, inputTables, a, b }): number {
      return inputTables.input.compareGroupKeys({ a, b });
    },
    compareSortKeys({ serializedTable, inputTables, a, b }): number {
      return inputTables.input.compareSortKeys({ a, b });
    },
  };
}

export function defineFlatMapTable(mapper: (row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }) => Iterable<PiledriverObject>): BulldozerTableImplementation {
  const outputRows = (row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }) => {
    return Array.from(mapper(row), (rowData, elementIndex) => ({
      groupKey: row.groupKey,
      rowIdentifier: JSON.stringify([row.rowIdentifier, elementIndex]),
      rowSortKey: [row.rowSortKey, elementIndex],
      rowData,
    }));
  };
  const compareOutputSortKeys = (inputTables: Record<string, BulldozerTableImplementationInputTable>, a: PiledriverObject, b: PiledriverObject) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2 || typeof a[1] !== "number" || typeof b[1] !== "number") {
      throw new Error("Invalid flatMap sort key");
    }
    return inputTables.input.compareSortKeys({ a: a[0], b: b[0] }) || a[1] - b[1];
  };

  return {
    isStateless: true,
    init({ inputTables }) {
      return { serializedTable: null };
    },
    async * listGroups({ inputTables, range }) {
      yield* inputTables.input.listGroups({ range });
    },
    async * listRowsInGroup({ inputTables, groupKey, range }) {
      if (range.limit === 0) return;
      let yielded = 0;
      const inputCompare = (a: PiledriverObject, b: PiledriverObject) => inputTables.input.compareSortKeys({ a, b });
      const boundInputKey = (bound: PiledriverObject | undefined) => {
        if (bound === undefined) return [];
        if (!Array.isArray(bound) || bound.length !== 2) throw new Error("Invalid flatMap sort key");
        return [bound[0]];
      };
      // Output sort keys are [inputSortKey, elementIndex], ordered by input sort key first, so
      // each bound's input component can be pushed down (inclusively even for gt/lt: the
      // boundary row may still contribute elements inside the range; the per-output range
      // check below filters those). Element indexes only matter at the boundary key.
      const lowerInputKeys = [...boundInputKey(range.gte), ...boundInputKey(range.gt)];
      const upperInputKeys = [...boundInputKey(range.lte), ...boundInputKey(range.lt)];
      const lowerInputKey = lowerInputKeys.length ? lowerInputKeys.reduce((a, b) => inputCompare(a, b) >= 0 ? a : b) : undefined;
      const upperInputKey = upperInputKeys.length ? upperInputKeys.reduce((a, b) => inputCompare(a, b) <= 0 ? a : b) : undefined;
      const inputRange: Range = { reverse: range.reverse, gte: lowerInputKey, lte: upperInputKey };
      for await (const row of inputTables.input.listRowsInGroup({ groupKey, range: inputRange })) {
        // Inputs yield rows in sort-key order, so once a row passes the end of the range no
        // later row can produce matching outputs.
        if (!range.reverse && upperInputKey !== undefined && inputCompare(row.rowSortKey, upperInputKey) > 0) return;
        if (range.reverse && lowerInputKey !== undefined && inputCompare(row.rowSortKey, lowerInputKey) < 0) return;
        const outputs = outputRows(row);
        if (range.reverse) outputs.reverse();
        for (const output of outputs) {
          if (isInRange(output.rowSortKey, range, (a, b) => compareOutputSortKeys(inputTables, a, b))) {
            yield output;
            if (range.limit !== undefined && ++yielded >= range.limit) return;
          }
        }
      }
    },
    async emitInputChanges({ serializedTable, changes }) {
      const outputChanges: TableChanges = { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: changes.input.addedGroups, deletedGroups: changes.input.deletedGroups };
      for (const row of changes.input.addedRows) appendAll(outputChanges.addedRows, outputRows(row));
      for (const row of changes.input.deletedRows) appendAll(outputChanges.deletedRows, outputRows({ groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.oldRowSortKey, rowData: row.oldRowData }).map(output => ({
        groupKey: output.groupKey,
        rowIdentifier: output.rowIdentifier,
        oldRowSortKey: output.rowSortKey,
        oldRowData: output.rowData,
      })));
      for (const row of changes.input.modifiedRows) {
        // Element indexes are stable across a modification (the identifier is [rowIdentifier,
        // elementIndex]), so diff positionally: shared indexes become modifications (skipped
        // entirely when unchanged), and only the length difference becomes adds/deletes. This
        // keeps downstream work proportional to what actually changed.
        const oldOutputs = outputRows({ groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.oldRowSortKey, rowData: row.oldRowData });
        const newOutputs = outputRows({ groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.newRowSortKey, rowData: row.newRowData });
        const sharedLength = Math.min(oldOutputs.length, newOutputs.length);
        for (let i = 0; i < sharedLength; i++) {
          const oldOutput = oldOutputs[i];
          const newOutput = newOutputs[i];
          if (piledriverObjectEquals(oldOutput.rowSortKey, newOutput.rowSortKey) && piledriverObjectEquals(oldOutput.rowData, newOutput.rowData)) continue;
          outputChanges.modifiedRows.push({ groupKey: newOutput.groupKey, rowIdentifier: newOutput.rowIdentifier, oldRowSortKey: oldOutput.rowSortKey, newRowSortKey: newOutput.rowSortKey, oldRowData: oldOutput.rowData, newRowData: newOutput.rowData });
        }
        for (let i = sharedLength; i < oldOutputs.length; i++) {
          outputChanges.deletedRows.push({ groupKey: oldOutputs[i].groupKey, rowIdentifier: oldOutputs[i].rowIdentifier, oldRowSortKey: oldOutputs[i].rowSortKey, oldRowData: oldOutputs[i].rowData });
        }
        for (let i = sharedLength; i < newOutputs.length; i++) {
          outputChanges.addedRows.push(newOutputs[i]);
        }
      }
      return {
        newSerializedTable: serializedTable,
        outputChanges,
      };
    },
    compareGroupKeys({ serializedTable, inputTables, a, b }): number {
      return inputTables.input.compareGroupKeys({ a, b });
    },
    compareSortKeys({ serializedTable, inputTables, a, b }): number {
      return compareOutputSortKeys(inputTables, a, b);
    },
  };
}

export function defineConcatTable(): BulldozerTableImplementation {
  const inputKeys = (inputTables: Record<string, BulldozerTableImplementationInputTable>) => Object.keys(inputTables).sort();
  const compareGroupKeysOf = (
    inputTables: Record<string, BulldozerTableImplementationInputTable>,
    keys: string[],
    a: PiledriverObject,
    b: PiledriverObject,
  ) => {
    const inputTableKey = keys.at(0);
    if (inputTableKey === undefined) throw new Error("Concat table must have at least one input");
    // Concat inputs descend from a common ancestor table, so their group orderings agree; the
    // first sorted input key is a deterministic comparator authority for the whole concat.
    return inputTables[inputTableKey].compareGroupKeys({ a, b });
  };
  const rowIdentifier = (inputTableKey: string, id: string) => JSON.stringify([inputTableKey, id]);
  const rowSortKey = (concatIndex: number, sortKey: PiledriverObject): PiledriverObject => [concatIndex, sortKey];
  const concatIndex = (keys: string[], inputTableKey: string) => {
    const index = keys.indexOf(inputTableKey);
    if (index < 0) throw new Error(`Unknown concat input table ${inputTableKey}`);
    return index;
  };
  const outputRowChangesFor = (keys: string[], inputTableKey: string, changes: TableChanges): GroupChanges => {
    const index = concatIndex(keys, inputTableKey);
    return {
      addedRows: changes.addedRows.map(row => ({ ...row, rowIdentifier: rowIdentifier(inputTableKey, row.rowIdentifier), rowSortKey: rowSortKey(index, row.rowSortKey) })),
      modifiedRows: changes.modifiedRows.map(row => ({ ...row, rowIdentifier: rowIdentifier(inputTableKey, row.rowIdentifier), oldRowSortKey: rowSortKey(index, row.oldRowSortKey), newRowSortKey: rowSortKey(index, row.newRowSortKey) })),
      deletedRows: changes.deletedRows.map(row => ({ ...row, rowIdentifier: rowIdentifier(inputTableKey, row.rowIdentifier), oldRowSortKey: rowSortKey(index, row.oldRowSortKey) })),
    };
  };

  // The concat table's group set is the *union* of its inputs' group sets, so it has to track
  // which inputs currently contain each group: a group is created downstream only when its
  // first input joins it and deleted only when its last input leaves it.
  type GroupMembership = { groupKey: PiledriverObject, inputTableKeys: string[] };
  const membershipMapOptions: ConstructorParameters<typeof AugmentedTreeMap<string, GroupMembership, null>>[0] = {
    comparator: compareStrings,
    extractAugmentation: () => null,
    mergeAugmentations: () => null,
  };
  const serialize = (map: AugmentedTreeMap<string, GroupMembership, null>) => ({
    version: 1,
    map: map.toPiledriverObject(),
  });
  const deserialize = (serialized: PiledriverObject) => {
    if (typeof serialized !== "object" || serialized === null || Array.isArray(serialized)) throw new Error("Invalid serialized table");
    if (!("version" in serialized && serialized.version === 1) || typeof serialized.map !== "object" || serialized.map === null) throw new Error("Invalid serialized table");
    return AugmentedTreeMap.fromPiledriverObject<string, GroupMembership, null>(serialized.map, membershipMapOptions);
  };
  const parseSortKey = (key: PiledriverObject): [number, PiledriverObject] => {
    if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== "number") throw new Error("Invalid concat sort key");
    return [key[0], key[1]];
  };
  const compareOutputSortKeys = (inputTables: Record<string, BulldozerTableImplementationInputTable>, keys: string[], a: PiledriverObject, b: PiledriverObject) => {
    const [aIndex, aSortKey] = parseSortKey(a);
    const [bIndex, bSortKey] = parseSortKey(b);
    if (aIndex !== bIndex) return aIndex - bIndex;
    const inputTableKey = keys.at(aIndex);
    if (inputTableKey === undefined) throw new Error("Invalid concat input index");
    return inputTables[inputTableKey].compareSortKeys({ a: aSortKey, b: bSortKey });
  };

  return {
    init({ inputTables }) {
      return { serializedTable: serialize(new AugmentedTreeMap(membershipMapOptions)) };
    },
    async * listGroups({ inputTables, range }) {
      if (range.limit === 0) return;
      let yielded = 0;
      const inputRange = { ...range, limit: undefined };
      const keys = inputKeys(inputTables);
      const comparatorInputKey = keys.at(0);
      if (comparatorInputKey === undefined) throw new Error("Concat table must have at least one input");
      const compareTotal = (a: PiledriverObject, b: PiledriverObject) =>
        compareGroupKeysOf(inputTables, keys, a, b) || compareStrings(canonicalGroupKeyString(a), canonicalGroupKeyString(b));
      type InputState = {
        inputTableKey: string,
        iterator: AsyncIterator<{ groupKey: PiledriverObject }>,
        current: { groupKey: PiledriverObject } | undefined,
        previousGroupKey: PiledriverObject | undefined,
        done: boolean,
      };
      const states: InputState[] = [];
      const advance = async (state: InputState) => {
        const next = await state.iterator.next();
        if (next.done) {
          state.done = true;
          state.current = undefined;
          return;
        }
        state.done = false;
        if (
          state.previousGroupKey !== undefined
          && (range.reverse
            ? compareTotal(state.previousGroupKey, next.value.groupKey) < 0
            : compareTotal(state.previousGroupKey, next.value.groupKey) > 0)
        ) {
          throw new Error(`Concat input table ${state.inputTableKey} yielded group keys out of order according to input table ${comparatorInputKey}'s comparator. Concat requires all of its inputs to agree on group key ordering, because it pushes group range bounds down into each input.`);
        }
        state.previousGroupKey = next.value.groupKey;
        state.current = next.value;
      };
      try {
        for (const inputTableKey of keys) {
          states.push({
            inputTableKey,
            iterator: inputTables[inputTableKey].listGroups({ range: inputRange })[Symbol.asyncIterator](),
            current: undefined,
            previousGroupKey: undefined,
            done: false,
          });
        }
        await Promise.all(states.map(advance));
        let previousCanonicalKey: string | undefined;
        for (;;) {
          let selected: { state: InputState, groupKey: PiledriverObject } | undefined;
          for (const state of states) {
            const current = state.current;
            if (current === undefined) continue;
            if (
              selected === undefined
              || (range.reverse
                ? compareTotal(current.groupKey, selected.groupKey) > 0
                : compareTotal(current.groupKey, selected.groupKey) < 0)
            ) {
              selected = { state, groupKey: current.groupKey };
            }
          }
          if (selected === undefined) return;
          // Equal group keys are adjacent in the merged stream (the canonical-string tie-break makes
          // the order total), so comparing against the previously yielded key is enough to dedupe
          // groups that several inputs share — no set of all seen keys needed.
          const canonicalKey = canonicalGroupKeyString(selected.groupKey);
          if (canonicalKey !== previousCanonicalKey) {
            previousCanonicalKey = canonicalKey;
            yield { groupKey: selected.groupKey };
            if (range.limit !== undefined && ++yielded >= range.limit) return;
          }
          await advance(selected.state);
        }
      } finally {
        // Manual async-iterator use does not provide for-await's automatic cleanup on early return.
        await Promise.all(states.map(async state => {
          if (!state.done) await state.iterator.return?.(undefined);
        }));
      }
    },
    async * listRowsInGroup({ inputTables, groupKey, range }) {
      if (range.limit === 0) return;
      let yielded = 0;
      const keys = inputKeys(inputTables);
      const compare = (a: PiledriverObject, b: PiledriverObject) => compareOutputSortKeys(inputTables, keys, a, b);
      const gte = range.gte === undefined ? undefined : parseSortKey(range.gte);
      const gt = range.gt === undefined ? undefined : parseSortKey(range.gt);
      const lte = range.lte === undefined ? undefined : parseSortKey(range.lte);
      const lt = range.lt === undefined ? undefined : parseSortKey(range.lt);
      // Inputs yield rows in sort-key order, so once a row passes the end of the range no later
      // row of the same input (or any later input) can match.
      const pastEnd = (sortKey: PiledriverObject) => range.reverse
        ? (range.gte !== undefined && compare(sortKey, range.gte) < 0) || (range.gt !== undefined && compare(sortKey, range.gt) <= 0)
        : (range.lte !== undefined && compare(sortKey, range.lte) > 0) || (range.lt !== undefined && compare(sortKey, range.lt) >= 0);

      const orderedKeys = range.reverse ? [...keys].reverse() : keys;
      for (const inputTableKey of orderedKeys) {
        const index = concatIndex(keys, inputTableKey);
        // Output sort keys are [inputIndex, inputSortKey], so a bound decomposes exactly: skip
        // inputs entirely outside the bound's index, push the sort key component down to the
        // boundary input, and leave inputs strictly inside the range unconstrained.
        if (gte !== undefined && index < gte[0]) continue;
        if (gt !== undefined && index < gt[0]) continue;
        if (lte !== undefined && index > lte[0]) continue;
        if (lt !== undefined && index > lt[0]) continue;
        const inputRange: Range = {
          reverse: range.reverse,
          gte: gte !== undefined && index === gte[0] ? gte[1] : undefined,
          gt: gt !== undefined && index === gt[0] ? gt[1] : undefined,
          lte: lte !== undefined && index === lte[0] ? lte[1] : undefined,
          lt: lt !== undefined && index === lt[0] ? lt[1] : undefined,
          limit: range.limit === undefined ? undefined : range.limit - yielded,
        };
        for await (const row of inputTables[inputTableKey].listRowsInGroup({ groupKey, range: inputRange })) {
          const sortKey = rowSortKey(index, row.rowSortKey);
          if (pastEnd(sortKey)) return;
          if (isInRange(sortKey, range, compare)) {
            yield { groupKey: row.groupKey, rowIdentifier: rowIdentifier(inputTableKey, row.rowIdentifier), rowSortKey: sortKey, rowData: row.rowData };
            if (range.limit !== undefined && ++yielded >= range.limit) return;
          }
        }
      }
    },
    async emitInputChanges({ serializedTable, inputTables, changes }) {
      const keys = inputKeys(inputTables);
      let map = deserialize(serializedTable);
      const outputChanges: TableChanges = { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] };
      for (const [inputTableKey, inputChanges] of Object.entries(changes)) {
        const next = outputRowChangesFor(keys, inputTableKey, inputChanges);
        appendAll(outputChanges.addedRows, next.addedRows);
        appendAll(outputChanges.modifiedRows, next.modifiedRows);
        appendAll(outputChanges.deletedRows, next.deletedRows);

        for (const { groupKey } of inputChanges.addedGroups) {
          const membershipKey = canonicalGroupKeyString(groupKey);
          const existing = await map.get(membershipKey);
          if (existing?.inputTableKeys.includes(inputTableKey)) throw new Error(`Group ${JSON.stringify(groupKey)} already exists in concat input ${inputTableKey}`);
          if (!existing) outputChanges.addedGroups.push({ groupKey });
          map = await map.set(membershipKey, { groupKey, inputTableKeys: [...existing?.inputTableKeys ?? [], inputTableKey] });
        }
        for (const { groupKey } of inputChanges.deletedGroups) {
          const membershipKey = canonicalGroupKeyString(groupKey);
          const existing = await map.get(membershipKey);
          if (!existing?.inputTableKeys.includes(inputTableKey)) throw new Error(`Group ${JSON.stringify(groupKey)} does not exist in concat input ${inputTableKey}`);
          const remaining = existing.inputTableKeys.filter(key => key !== inputTableKey);
          if (remaining.length) {
            map = await map.set(membershipKey, { groupKey, inputTableKeys: remaining });
          } else {
            map = await map.delete(membershipKey);
            outputChanges.deletedGroups.push({ groupKey });
          }
        }
      }
      normalizeGroupLifecycle(outputChanges);
      return {
        newSerializedTable: serialize(map),
        outputChanges,
      };
    },
    compareGroupKeys({ serializedTable, inputTables, a, b }): number {
      return compareGroupKeysOf(inputTables, inputKeys(inputTables), a, b);
    },
    compareSortKeys({ serializedTable, inputTables, a, b }): number {
      return compareOutputSortKeys(inputTables, inputKeys(inputTables), a, b);
    },
  };
}

export function defineMaterializeTable(): BulldozerTableImplementation {
  return createGroupwiseTreeTableImplementation({
    getMapOptions({ inputGroup }) {
      return {
        comparator: (a: PiledriverObject, b: PiledriverObject) => inputGroup.compareSortKeys({ a, b }),
        extractAugmentation: (value) => null,
        mergeAugmentations: (...augmentations) => null,
      };
    },
    async * listRows({ map, inputGroup, range }) {
      for await (const [rowSortKey, rowIdentifier, rowData] of map.entries(range)) {
        yield { rowIdentifier, rowSortKey, rowData };
      }
    },
    async emitInputChanges({ map, inputGroup, changes }) {
      const changedRows = changedRowsFromTableChanges(changes);
      for (const row of changedRows) {
        if (row.old) map = await map.delete(row.old.rowSortKey, row.old.rowIdentifier);
        if (row.new) map = await map.add(row.new.rowSortKey, row.new.rowIdentifier, row.new.rowData);
      }
      return {
        newMap: map,
        outputChanges: changedRowsToGroupChanges(changedRows),
      };
    },
    async emitInputGroupCreation({ map, inputGroup }) {
      return {
        newMap: map,
        outputChanges: { addedRows: [], modifiedRows: [], deletedRows: [] },
      };
    },
    async emitInputGroupDeletion({ map, inputGroup }) {
      return {
        newMap: map,
        outputChanges: { addedRows: [], modifiedRows: [], deletedRows: [] },
      };
    },
    compareSortKeys({ inputTable, a, b }) {
      return inputTable.compareSortKeys({ a, b });
    },
  });
}

export function defineSortTable(options: {
  sortKeyExtractor: (row: { groupKey: PiledriverObject, rowIdentifier: string, rowData: PiledriverObject }) => PiledriverObject,
  sortKeyComparator: (a: PiledriverObject, b: PiledriverObject) => number,
}): BulldozerTableImplementation {
  return {
    isStateless: true,
    init() {
      return { serializedTable: null };
    },
    async * listGroups({ inputTables, range }) {
      yield* inputTables.input.listGroups({ range });
    },
    async * listRowsInGroup() {
      throw new Error("Sort table does not support listing rows; add a materialize table before reading from it");
    },
    async emitInputChanges({ changes }) {
      const changedRows = changedRowsFromTableChanges(changes.input);
      const newChangedRows = changedRows.map(row => ({
        old: row.old && {
          ...row.old,
          rowSortKey: options.sortKeyExtractor(row.old),
        },
        new: row.new && {
          ...row.new,
          rowSortKey: options.sortKeyExtractor(row.new),
        },
      }));
      return {
        newSerializedTable: null,
        outputChanges: changedRowsToTableChanges(newChangedRows, changes.input),
      };
    },
    compareGroupKeys({ inputTables, a, b }) {
      return inputTables.input.compareGroupKeys({ a, b });
    },
    compareSortKeys({ a, b }) {
      return options.sortKeyComparator(a, b);
    },
  };
}

export function defineReduceTable(options: {
  valueExtractor: (row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }) => Promise<PiledriverObject>,
  // Aggregations are maintained in an augmented tree, so this reducer must be
  // associative and produce the same result for any tree-shaped grouping.
  valueReducer: (...values: PiledriverObject[]) => Promise<PiledriverObject>,
}): BulldozerTableImplementation {
  return createGroupwiseTreeTableImplementation({
    getMapOptions({ inputGroup }) {
      return {
        comparator: (a: PiledriverObject, b: PiledriverObject) => inputGroup.compareSortKeys({ a, b }),
        extractAugmentation: async (rowData, rowSortKey, rowIdentifier) => await options.valueExtractor({ groupKey: inputGroup.groupKey, rowIdentifier, rowSortKey, rowData }),
        mergeAugmentations: async (...augmentations) => await options.valueReducer(...augmentations),
      };
    },
    async * listRows({ map, inputGroup, range }) {
      if (range.lt !== undefined || range.gt !== undefined || range.limit === 0) return;
      yield {
        rowIdentifier: inputGroup.groupIdentifier,
        rowSortKey: null,
        rowData: await map.getAugmentation({}),
      };
    },
    async emitInputChanges({ map, inputGroup, changes }) {
      const changedRows = changedRowsFromTableChanges(changes);
      const oldRowData = await map.getAugmentation({});
      for (const row of changedRows) {
        if (row.old) map = await map.delete(row.old.rowSortKey, row.old.rowIdentifier);
        if (row.new) map = await map.add(row.new.rowSortKey, row.new.rowIdentifier, row.new.rowData);
      }
      const newRowData = await map.getAugmentation({});
      return {
        newMap: map,
        outputChanges: piledriverObjectEquals(oldRowData, newRowData) ? { addedRows: [], modifiedRows: [], deletedRows: [] } : {
          addedRows: [],
          modifiedRows: [{
            groupKey: inputGroup.groupKey,
            rowIdentifier: inputGroup.groupIdentifier,
            oldRowSortKey: null,
            newRowSortKey: null,
            oldRowData: oldRowData,
            newRowData,
          }],
          deletedRows: [],
        },
      };
    },
    async emitInputGroupCreation({ map, inputGroup }) {
      return {
        newMap: map,
        outputChanges: {
          addedRows: [{
            groupKey: inputGroup.groupKey,
            rowIdentifier: inputGroup.groupIdentifier,
            rowSortKey: null,
            rowData: await map.getAugmentation({}),
          }],
          modifiedRows: [],
          deletedRows: [],
        },
      };
    },
    async emitInputGroupDeletion({ map, inputGroup }) {
      return {
        newMap: map,
        outputChanges: {
          addedRows: [],
          modifiedRows: [],
          deletedRows: [{
            groupKey: inputGroup.groupKey,
            rowIdentifier: inputGroup.groupIdentifier,
            oldRowSortKey: null,
            oldRowData: await map.getAugmentation({}),
          }],
        },
      };
    },
    compareSortKeys({ inputTable, a, b }) {
      return 0;
    },
  });
}

export function defineTransduceTable<T extends PiledriverObject>(options: {
  valueExtractor: (row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }) => Promise<ConcatTreeList<T>>,
  // Aggregations are maintained in an augmented tree, so this reducer must be
  // associative and order-preserving. Use ConcatTreeList.concat for plain concatenation.
  valueReducer: (...values: ConcatTreeList<T>[]) => Promise<ConcatTreeList<T>>,
}): BulldozerTableImplementation {
  const listFrom = (object: PiledriverObject) => ConcatTreeList.fromPiledriverObject<PiledriverObject>(object);

  return createGroupwiseTreeTableImplementation({
    getMapOptions({ inputGroup }) {
      return {
        comparator: (a: PiledriverObject, b: PiledriverObject) => inputGroup.compareSortKeys({ a, b }),
        initialAugmentation: ConcatTreeList.empty().toPiledriverObject(),
        extractAugmentation: async (rowData, rowSortKey, rowIdentifier) => (await options.valueExtractor({ groupKey: inputGroup.groupKey, rowIdentifier, rowSortKey, rowData })).toPiledriverObject(),
        mergeAugmentations: async (...augmentations) => (await options.valueReducer(...augmentations.map(augmentation => ConcatTreeList.fromPiledriverObject<T>(augmentation)))).toPiledriverObject(),
      };
    },
    async * listRows({ map, inputGroup, range }) {
      if (range.lt !== undefined || range.gt !== undefined || range.limit === 0) return;
      const list = listFrom(await map.getAugmentation({}));
      let i = 0;
      for await (const [id, rowData] of list.entries({ reverse: range.reverse })) {
        yield {
          rowIdentifier: id,
          rowSortKey: null,
          rowData,
        };
        i++;
        if (range.limit !== undefined && i >= range.limit) break;
      }
    },
    async emitInputChanges({ map, inputGroup, changes }) {
      const oldList = await map.getAugmentation({});
      for (const row of changedRowsFromTableChanges(changes)) {
        if (row.old) map = await map.delete(row.old.rowSortKey, row.old.rowIdentifier);
        if (row.new) map = await map.add(row.new.rowSortKey, row.new.rowIdentifier, row.new.rowData);
      }
      const newList = await map.getAugmentation({});

      // Calculate outputChanges by diffing the old and new lists
      const diff = await ConcatTreeList.diff(listFrom(oldList), listFrom(newList));
      const outputChanges: GroupChanges = { addedRows: [], modifiedRows: [], deletedRows: [] };
      const addedById = new Map(diff.added.map(added => [added.id, added]));
      for (const missing of diff.missing) {
        const added = addedById.get(missing.id);
        if (added) {
          addedById.delete(missing.id);
          if (!piledriverObjectEquals(missing.value, added.value)) {
            outputChanges.modifiedRows.push({ groupKey: inputGroup.groupKey, rowIdentifier: missing.id, oldRowSortKey: null, newRowSortKey: null, oldRowData: missing.value, newRowData: added.value });
          }
          continue;
        }
        outputChanges.deletedRows.push({ groupKey: inputGroup.groupKey, rowIdentifier: missing.id, oldRowSortKey: null, oldRowData: missing.value });
      }
      for (const added of addedById.values()) {
        outputChanges.addedRows.push({ groupKey: inputGroup.groupKey, rowIdentifier: added.id, rowSortKey: null, rowData: added.value });
      }

      return {
        newMap: map,
        outputChanges,
      };
    },
    async emitInputGroupCreation({ map, inputGroup }) {
      const rows = await fromAsync(listFrom(await map.getAugmentation({})).entries());
      return {
        newMap: map,
        outputChanges: {
          addedRows: rows.map(([id, value]) => ({
            groupKey: inputGroup.groupKey,
            rowIdentifier: id,
            rowSortKey: null,
            rowData: value,
          })),
          modifiedRows: [],
          deletedRows: [],
        },
      };
    },
    async emitInputGroupDeletion({ map, inputGroup }) {
      const rows = await fromAsync(listFrom(await map.getAugmentation({})).entries());
      return {
        newMap: map,
        outputChanges: {
          addedRows: [],
          modifiedRows: [],
          deletedRows: rows.map(([id, value]) => ({
            groupKey: inputGroup.groupKey,
            rowIdentifier: id,
            oldRowSortKey: null,
            oldRowData: value,
          })),
        },
      };
    },
    compareSortKeys() {
      return 0;
    },
  });
}


export function defineCompactTable(options: {
  compactor: (a: PiledriverObject, b: PiledriverObject) => Iterable<{ newRowData: PiledriverObject }>,
}): BulldozerTableImplementation {
  return defineTransduceTable({
    valueExtractor: async row => ConcatTreeList.fromEntries([[row.rowIdentifier, row.rowData]]),
    valueReducer: async (...lists) => {
      let compacted = ConcatTreeList.empty();
      for (const list of lists) {
        compacted = await ConcatTreeList.concatWithMergedBoundaries([compacted, list], {
          mergeBoundary: (left, right) => Array.from(options.compactor(left, right), row => row.newRowData),
        });
      }
      return compacted;
    },
  });
}

export function declareGroupByTable(options: {
  groupKeyExtractor: (row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }) => Promise<PiledriverObject>,
  groupKeyComparator: (a: PiledriverObject, b: PiledriverObject) => number,
}): BulldozerTableImplementation {
  type InputRow = { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject };
  // The rows variant is accepted for snapshots written before GroupBy stopped materializing rows.
  // Touched groups are rewritten to the count-only representation.
  type SerializedGroup =
    | { groupKey: PiledriverObject, count: number }
    | { groupKey: PiledriverObject, rows: PiledriverObject };
  const outputAdded = (groupKey: PiledriverObject, row: InputRow) => ({ groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.rowSortKey, rowData: row.rowData });
  const outputDeleted = (groupKey: PiledriverObject, row: InputRow) => ({ groupKey, rowIdentifier: row.rowIdentifier, oldRowSortKey: row.rowSortKey, oldRowData: row.rowData });
  const outputModified = (groupKey: PiledriverObject, oldRow: InputRow, newRow: InputRow) => ({
    groupKey,
    rowIdentifier: oldRow.rowIdentifier,
    oldRowSortKey: oldRow.rowSortKey,
    newRowSortKey: newRow.rowSortKey,
    oldRowData: oldRow.rowData,
    newRowData: newRow.rowData,
  });
  const groupMapOptions: ConstructorParameters<typeof AugmentedTreeMap<PiledriverObject, SerializedGroup, null>>[0] = {
    comparator: (a, b) => options.groupKeyComparator(a, b) || compareStrings(canonicalGroupKeyString(a), canonicalGroupKeyString(b)),
    extractAugmentation: () => null,
    mergeAugmentations: () => null,
  };
  const serialize = (map: AugmentedTreeMap<PiledriverObject, SerializedGroup, null>) => ({
    version: 1,
    map: map.toPiledriverObject(),
  });
  const deserialize = (serialized: PiledriverObject) => {
    if (typeof serialized !== "object" || serialized === null || Array.isArray(serialized)) throw new Error("Invalid serialized table");
    if (!("version" in serialized && serialized.version === 1) || typeof serialized.map !== "object" || serialized.map === null) throw new Error("Invalid serialized table");
    return AugmentedTreeMap.fromPiledriverObject<PiledriverObject, SerializedGroup, null>(serialized.map, groupMapOptions);
  };
  const legacyRowMapOptions = (inputTables: Record<string, BulldozerTableImplementationInputTable>): ConstructorParameters<typeof AugmentedTreeMultiMap<PiledriverObject, PiledriverObject, null, string>>[0] => ({
    comparator: (a, b) => inputTables.input.compareSortKeys({ a, b }),
    extractAugmentation: () => null,
    mergeAugmentations: () => null,
    entryIdComparator: compareStrings,
  });
  const groupCount = async (group: SerializedGroup, inputTables: Record<string, BulldozerTableImplementationInputTable>) =>
    "count" in group
      ? group.count
      : await AugmentedTreeMultiMap.fromPiledriverObject<PiledriverObject, PiledriverObject, null, string>(group.rows, legacyRowMapOptions(inputTables)).size();

  return {
    init() {
      return { serializedTable: serialize(new AugmentedTreeMap(groupMapOptions)) };
    },
    async * listGroups({ serializedTable, range }) {
      const map = deserialize(serializedTable);
      for await (const groupKey of map.keys(range)) yield { groupKey };
    },
    async * listRowsInGroup() {
      throw new Error("GroupBy table does not support listing rows; add a materialize table before reading from it");
    },
    async emitInputChanges({ serializedTable, inputTables, changes }) {
      let map = deserialize(serializedTable);
      const outputChanges: TableChanges = { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] };
      const loadGroup = async (groupKey: PiledriverObject) => {
        const existing = await map.get(groupKey);
        return existing
          ? { groupKey: existing.groupKey, count: await groupCount(existing, inputTables) }
          : { groupKey, count: 0 };
      };
      const saveGroup = async (lookupKey: PiledriverObject, group: { groupKey: PiledriverObject, count: number }, newCount: number) => {
        if (newCount < 0) throw new Error(`Group ${JSON.stringify(lookupKey)} has a negative row count`);
        if (newCount === 0) {
          if (group.count > 0) outputChanges.deletedGroups.push({ groupKey: group.groupKey });
          map = await map.delete(lookupKey);
        } else {
          if (group.count === 0) outputChanges.addedGroups.push({ groupKey: group.groupKey });
          map = await map.set(lookupKey, { groupKey: group.groupKey, count: newCount });
        }
      };
      const deleteRow = async (row: InputRow) => {
        const groupKey = await options.groupKeyExtractor(row);
        const group = await loadGroup(groupKey);
        if (group.count === 0) throw new Error(`Group ${JSON.stringify(groupKey)} does not exist`);
        outputChanges.deletedRows.push(outputDeleted(group.groupKey, row));
        await saveGroup(groupKey, group, group.count - 1);
      };
      const addRow = async (row: InputRow) => {
        const groupKey = await options.groupKeyExtractor(row);
        const group = await loadGroup(groupKey);
        await saveGroup(groupKey, group, group.count + 1);
        outputChanges.addedRows.push(outputAdded(group.groupKey, row));
      };

      for (const row of changedRowsFromTableChanges(changes.input)) {
        if (row.old && row.new) {
          const oldGroupKey = await options.groupKeyExtractor(row.old);
          const newGroupKey = await options.groupKeyExtractor(row.new);
          if (piledriverObjectEquals(oldGroupKey, newGroupKey)) {
            const group = await loadGroup(oldGroupKey);
            if (group.count === 0) throw new Error(`Group ${JSON.stringify(oldGroupKey)} does not exist`);
            await saveGroup(oldGroupKey, group, group.count);
            if (!piledriverObjectEquals(row.old.rowSortKey, row.new.rowSortKey) || !piledriverObjectEquals(row.old.rowData, row.new.rowData)) {
              outputChanges.modifiedRows.push(outputModified(group.groupKey, row.old, row.new));
            }
          } else {
            await deleteRow(row.old);
            await addRow(row.new);
          }
        } else if (row.old) {
          await deleteRow(row.old);
        } else if (row.new) {
          await addRow(row.new);
        }
      }

      normalizeGroupLifecycle(outputChanges);
      return {
        newSerializedTable: serialize(map),
        outputChanges,
      };
    },
    compareGroupKeys({ a, b }): number {
      return options.groupKeyComparator(a, b);
    },
    compareSortKeys({ inputTables, a, b }): number {
      return inputTables.input.compareSortKeys({ a, b });
    },
  };
}

export function declareLeftJoinTable(options: {
  leftJoinKeyExtractor: (row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }) => Promise<PiledriverObject>,
  rightJoinKeyExtractor: (row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }) => Promise<PiledriverObject>,
  joinKeyComparator: (a: PiledriverObject, b: PiledriverObject) => number,
  joiner: (
    left: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject },
    right: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject } | null,
  ) => Promise<PiledriverObject>,
}): BulldozerTableImplementation {
  type InputRow = { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject };
  type StoredRow = InputRow & { joinKey: PiledriverObject };
  type OutputGroup = { rows: PiledriverObject };
  type State = {
    leftRows: AugmentedTreeMap<string, StoredRow, null>,
    rightRows: AugmentedTreeMap<string, StoredRow, null>,
    leftByJoinKey: AugmentedTreeMultiMap<PiledriverObject, string, null, string>,
    rightByJoinKey: AugmentedTreeMultiMap<PiledriverObject, string, null, string>,
    outputGroups: AugmentedTreeMap<PiledriverObject, OutputGroup, null>,
  };
  const stringMapOptions: ConstructorParameters<typeof AugmentedTreeMap<string, StoredRow, null>>[0] = {
    comparator: compareStrings,
    extractAugmentation: () => null,
    mergeAugmentations: () => null,
  };
  const joinIndexOptions: ConstructorParameters<typeof AugmentedTreeMultiMap<PiledriverObject, string, null, string>>[0] = {
    comparator: (a, b) => options.joinKeyComparator(a, b) || compareStrings(canonicalGroupKeyString(a), canonicalGroupKeyString(b)),
    extractAugmentation: () => null,
    mergeAugmentations: () => null,
    entryIdComparator: compareStrings,
  };
  const outputGroupOptions = (inputTables: Record<string, BulldozerTableImplementationInputTable>): ConstructorParameters<typeof AugmentedTreeMap<PiledriverObject, OutputGroup, null>>[0] => ({
    comparator: (a, b) => inputTables.left.compareGroupKeys({ a, b }) || compareStrings(canonicalGroupKeyString(a), canonicalGroupKeyString(b)),
    extractAugmentation: () => null,
    mergeAugmentations: () => null,
  });
  const compareOutputSortKeys = (inputTables: Record<string, BulldozerTableImplementationInputTable>, a: PiledriverObject, b: PiledriverObject) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) throw new Error("Invalid left join sort key");
    const leftComparison = inputTables.left.compareSortKeys({ a: a[0], b: b[0] });
    if (leftComparison) return leftComparison;
    if (a[1] === null || b[1] === null) return a[1] === b[1] ? 0 : a[1] === null ? -1 : 1;
    return inputTables.right.compareSortKeys({ a: a[1], b: b[1] });
  };
  const outputRowsOptions = (inputTables: Record<string, BulldozerTableImplementationInputTable>): ConstructorParameters<typeof AugmentedTreeMultiMap<PiledriverObject, PiledriverObject, null, string>>[0] => ({
    comparator: (a, b) => compareOutputSortKeys(inputTables, a, b),
    extractAugmentation: () => null,
    mergeAugmentations: () => null,
    entryIdComparator: compareStrings,
  });
  const emptyState = (inputTables: Record<string, BulldozerTableImplementationInputTable>): State => ({
    leftRows: new AugmentedTreeMap(stringMapOptions),
    rightRows: new AugmentedTreeMap(stringMapOptions),
    leftByJoinKey: new AugmentedTreeMultiMap(joinIndexOptions),
    rightByJoinKey: new AugmentedTreeMultiMap(joinIndexOptions),
    outputGroups: new AugmentedTreeMap(outputGroupOptions(inputTables)),
  });
  const emptyOutputRows = (inputTables: Record<string, BulldozerTableImplementationInputTable>) => new AugmentedTreeMultiMap(outputRowsOptions(inputTables));
  const serialize = (state: State) => ({
    version: 1,
    leftRows: state.leftRows.toPiledriverObject(),
    rightRows: state.rightRows.toPiledriverObject(),
    leftByJoinKey: state.leftByJoinKey.toPiledriverObject(),
    rightByJoinKey: state.rightByJoinKey.toPiledriverObject(),
    outputGroups: state.outputGroups.toPiledriverObject(),
  });
  const deserialize = (serialized: PiledriverObject, inputTables: Record<string, BulldozerTableImplementationInputTable>): State => {
    if (typeof serialized !== "object" || serialized === null || Array.isArray(serialized)) throw new Error("Invalid serialized table");
    if (!("version" in serialized && serialized.version === 1)
      || typeof serialized.leftRows !== "object" || serialized.leftRows === null
      || typeof serialized.rightRows !== "object" || serialized.rightRows === null
      || typeof serialized.leftByJoinKey !== "object" || serialized.leftByJoinKey === null
      || typeof serialized.rightByJoinKey !== "object" || serialized.rightByJoinKey === null
      || typeof serialized.outputGroups !== "object" || serialized.outputGroups === null) throw new Error("Invalid serialized table");
    return {
      leftRows: AugmentedTreeMap.fromPiledriverObject<string, StoredRow, null>(serialized.leftRows, stringMapOptions),
      rightRows: AugmentedTreeMap.fromPiledriverObject<string, StoredRow, null>(serialized.rightRows, stringMapOptions),
      leftByJoinKey: AugmentedTreeMultiMap.fromPiledriverObject<PiledriverObject, string, null, string>(serialized.leftByJoinKey, joinIndexOptions),
      rightByJoinKey: AugmentedTreeMultiMap.fromPiledriverObject<PiledriverObject, string, null, string>(serialized.rightByJoinKey, joinIndexOptions),
      outputGroups: AugmentedTreeMap.fromPiledriverObject<PiledriverObject, OutputGroup, null>(serialized.outputGroups, outputGroupOptions(inputTables)),
    };
  };
  const rowObject = (row: StoredRow): InputRow => ({ groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.rowSortKey, rowData: row.rowData });
  const outputRowIdentifier = (left: StoredRow, right: StoredRow | null) => JSON.stringify([left.rowIdentifier, right?.rowIdentifier ?? null]);
  const outputSortKey = (left: StoredRow, right: StoredRow | null): PiledriverObject => [left.rowSortKey, right?.rowSortKey ?? null];

  return {
    init({ inputTables }) {
      return { serializedTable: serialize(emptyState(inputTables)) };
    },
    async * listGroups({ serializedTable, inputTables, range }) {
      const state = deserialize(serializedTable, inputTables);
      for await (const groupKey of state.outputGroups.keys(range)) yield { groupKey };
    },
    async * listRowsInGroup({ serializedTable, inputTables, groupKey, range }) {
      const state = deserialize(serializedTable, inputTables);
      const group = await state.outputGroups.get(groupKey);
      if (!group) return;
      const rows = AugmentedTreeMultiMap.fromPiledriverObject<PiledriverObject, PiledriverObject, null, string>(group.rows, outputRowsOptions(inputTables));
      for await (const [rowSortKey, rowIdentifier, rowData] of rows.entries(range)) yield { groupKey, rowIdentifier, rowSortKey, rowData };
    },
    async emitInputChanges({ serializedTable, inputTables, changes }) {
      let state = deserialize(serializedTable, inputTables);
      const outputChanges: TableChanges = { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] };
      const touchedGroups = new Map<string, { groupKey: PiledriverObject, existed: boolean }>();
      const touchGroup = async (groupKey: PiledriverObject) => {
        const key = canonicalGroupKeyString(groupKey);
        if (!touchedGroups.has(key)) touchedGroups.set(key, { groupKey, existed: await state.outputGroups.has(groupKey) });
      };
      const loadOutputRows = async (groupKey: PiledriverObject) => {
        await touchGroup(groupKey);
        const group = await state.outputGroups.get(groupKey);
        return group
          ? AugmentedTreeMultiMap.fromPiledriverObject<PiledriverObject, PiledriverObject, null, string>(group.rows, outputRowsOptions(inputTables))
          : emptyOutputRows(inputTables);
      };
      const saveOutputRows = async (groupKey: PiledriverObject, rows: AugmentedTreeMultiMap<PiledriverObject, PiledriverObject, null, string>) => {
        state = {
          ...state,
          outputGroups: await rows.size() === 0
            ? await state.outputGroups.delete(groupKey)
            : await state.outputGroups.set(groupKey, { rows: rows.toPiledriverObject() }),
        };
      };
      const rightMatches = async (joinKey: PiledriverObject) => await Promise.all((await state.rightByJoinKey.getAll(joinKey)).map(async ([id]) => (await state.rightRows.get(id))!));
      const leftMatches = async (joinKey: PiledriverObject) => await Promise.all((await state.leftByJoinKey.getAll(joinKey)).map(async ([id]) => (await state.leftRows.get(id))!));
      const addOutput = async (left: StoredRow, right: StoredRow | null) => {
        const rows = await loadOutputRows(left.groupKey);
        const rowIdentifier = outputRowIdentifier(left, right);
        const rowSortKey = outputSortKey(left, right);
        const rowData = await options.joiner(rowObject(left), right && rowObject(right));
        await saveOutputRows(left.groupKey, await rows.add(rowSortKey, rowIdentifier, rowData));
        outputChanges.addedRows.push({ groupKey: left.groupKey, rowIdentifier, rowSortKey, rowData });
      };
      const deleteOutput = async (left: StoredRow, right: StoredRow | null) => {
        const rows = await loadOutputRows(left.groupKey);
        const rowIdentifier = outputRowIdentifier(left, right);
        const oldRowSortKey = outputSortKey(left, right);
        const oldRowData = await options.joiner(rowObject(left), right && rowObject(right));
        await saveOutputRows(left.groupKey, await rows.delete(oldRowSortKey, rowIdentifier));
        outputChanges.deletedRows.push({ groupKey: left.groupKey, rowIdentifier, oldRowSortKey, oldRowData });
      };
      const addLeft = async (row: InputRow) => {
        const left: StoredRow = { ...row, joinKey: await options.leftJoinKeyExtractor(row) };
        state = { ...state, leftRows: await state.leftRows.set(left.rowIdentifier, left), leftByJoinKey: await state.leftByJoinKey.add(left.joinKey, left.rowIdentifier, left.rowIdentifier) };
        const rights = await rightMatches(left.joinKey);
        if (!rights.length) await addOutput(left, null);
        else for (const right of rights) await addOutput(left, right);
      };
      const deleteLeft = async (row: InputRow) => {
        const left = await state.leftRows.get(row.rowIdentifier);
        if (!left) return;
        const rights = await rightMatches(left.joinKey);
        if (!rights.length) await deleteOutput(left, null);
        else for (const right of rights) await deleteOutput(left, right);
        state = { ...state, leftRows: await state.leftRows.delete(left.rowIdentifier), leftByJoinKey: await state.leftByJoinKey.delete(left.joinKey, left.rowIdentifier) };
      };
      const addRight = async (row: InputRow) => {
        const right: StoredRow = { ...row, joinKey: await options.rightJoinKeyExtractor(row) };
        const lefts = await leftMatches(right.joinKey);
        // hasAny (O(depth)) instead of getAll().length: many rows can share one join key (e.g.
        // a null-ish key on most rows), and materializing all of them per inserted row makes
        // bulk ingestion O(n^2). The check is only needed when there are matching lefts whose
        // left-with-null output row must be retracted.
        if (lefts.length > 0 && !(await state.rightByJoinKey.hasAny(right.joinKey))) for (const left of lefts) await deleteOutput(left, null);
        state = { ...state, rightRows: await state.rightRows.set(right.rowIdentifier, right), rightByJoinKey: await state.rightByJoinKey.add(right.joinKey, right.rowIdentifier, right.rowIdentifier) };
        for (const left of lefts) await addOutput(left, right);
      };
      const deleteRight = async (row: InputRow) => {
        const right = await state.rightRows.get(row.rowIdentifier);
        if (!right) return;
        const lefts = await leftMatches(right.joinKey);
        for (const left of lefts) await deleteOutput(left, right);
        state = { ...state, rightRows: await state.rightRows.delete(right.rowIdentifier), rightByJoinKey: await state.rightByJoinKey.delete(right.joinKey, right.rowIdentifier) };
        if (lefts.length > 0 && !(await state.rightByJoinKey.hasAny(right.joinKey))) for (const left of lefts) await addOutput(left, null);
      };

      for (const row of changedRowsFromTableChanges(changes.left)) {
        if (row.old) await deleteLeft(row.old);
        if (row.new) await addLeft(row.new);
      }
      for (const row of changedRowsFromTableChanges(changes.right)) {
        if (row.old && row.new) {
          const oldRight = await state.rightRows.get(row.old.rowIdentifier);
          const newJoinKey = await options.rightJoinKeyExtractor(row.new);
          if (oldRight && piledriverObjectEquals(oldRight.joinKey, newJoinKey)) {
            const newRight: StoredRow = { ...row.new, joinKey: newJoinKey };
            const lefts = await leftMatches(oldRight.joinKey);
            for (const left of lefts) await deleteOutput(left, oldRight);
            state = { ...state, rightRows: await state.rightRows.set(newRight.rowIdentifier, newRight) };
            for (const left of lefts) await addOutput(left, newRight);
          } else {
            await deleteRight(row.old);
            await addRight(row.new);
          }
        } else {
          if (row.old) await deleteRight(row.old);
          if (row.new) await addRight(row.new);
        }
      }
      for (const { groupKey, existed } of touchedGroups.values()) {
        const exists = await state.outputGroups.has(groupKey);
        if (!existed && exists) outputChanges.addedGroups.push({ groupKey });
        if (existed && !exists) outputChanges.deletedGroups.push({ groupKey });
      }
      return { newSerializedTable: serialize(state), outputChanges };
    },
    compareGroupKeys({ inputTables, a, b }) {
      return inputTables.left.compareGroupKeys({ a, b });
    },
    compareSortKeys({ inputTables, a, b }) {
      return compareOutputSortKeys(inputTables, a, b);
    },
  };
}

/**
 * Materialized left-fold table.
 *
 * For each input group, folds source rows in sort-key order. Output rows keep the source
 * rowIdentifier and rowSortKey; rowData is the reducer output for that row.
 *
 * On source changes, only the affected suffix of a touched group is recomputed. The row before
 * the suffix stores its post-row fold state, so recomputation can resume without replaying the
 * whole prefix.
 */
export function declareLeftFoldTable(options: {
  initialState: PiledriverObject,
  reducer: (state: PiledriverObject, row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject }) => Promise<{ newState: PiledriverObject, newRowData: PiledriverObject }>,
}): BulldozerTableImplementation {
  type FoldedRow = {
    inputRowData: PiledriverObject,
    outputRowData: PiledriverObject,
    stateAfter: PiledriverObject,
  };
  type OutputRow = { rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject };
  const emptyGroupChanges = (): GroupChanges => ({ addedRows: [], modifiedRows: [], deletedRows: [] });
  const pendingFoldedRow = (inputRowData: PiledriverObject): FoldedRow => ({
    inputRowData,
    outputRowData: null,
    stateAfter: options.initialState,
  });
  const outputRow = ([rowSortKey, rowIdentifier, row]: [PiledriverObject, string, FoldedRow]): OutputRow => ({
    rowIdentifier,
    rowSortKey,
    rowData: row.outputRowData,
  });
  // Groupwise helpers use null here; the outer wrapper replaces it with the real group key.
  const diffOutputRows = (oldRows: OutputRow[], newRows: OutputRow[]): GroupChanges => {
    const outputChanges = emptyGroupChanges();
    const newById = new Map(newRows.map(row => [row.rowIdentifier, row]));
    for (const oldRow of oldRows) {
      const newRow = newById.get(oldRow.rowIdentifier);
      if (!newRow) {
        outputChanges.deletedRows.push({ groupKey: null, rowIdentifier: oldRow.rowIdentifier, oldRowSortKey: oldRow.rowSortKey, oldRowData: oldRow.rowData });
      } else {
        newById.delete(oldRow.rowIdentifier);
        if (!piledriverObjectEquals(oldRow.rowSortKey, newRow.rowSortKey) || !piledriverObjectEquals(oldRow.rowData, newRow.rowData)) {
          outputChanges.modifiedRows.push({ groupKey: null, rowIdentifier: oldRow.rowIdentifier, oldRowSortKey: oldRow.rowSortKey, newRowSortKey: newRow.rowSortKey, oldRowData: oldRow.rowData, newRowData: newRow.rowData });
        }
      }
    }
    appendAll(outputChanges.addedRows, [...newById.values()].map(row => ({ groupKey: null, ...row })));
    return outputChanges;
  };
  const earliestChangedSortKey = (inputGroup: BulldozerGroupwiseTableImplementationInputGroup, rows: ReturnType<typeof changedRowsFromTableChanges>) => {
    let earliest: PiledriverObject | undefined;
    for (const row of rows) {
      for (const changed of [row.old, row.new]) {
        if (!changed) continue;
        if (earliest === undefined || inputGroup.compareSortKeys({ a: changed.rowSortKey, b: earliest }) < 0) earliest = changed.rowSortKey;
      }
    }
    return earliest;
  };
  const collectOutputRows = async (map: AugmentedTreeMultiMap<PiledriverObject, FoldedRow, null>, range: Range) =>
    (await fromAsync(map.entries(range))).map(outputRow);
  const stateBefore = async (map: AugmentedTreeMultiMap<PiledriverObject, FoldedRow, null>, sortKey: PiledriverObject) => {
    for await (const [, , row] of map.entries({ lt: sortKey, reverse: true, limit: 1 })) return row.stateAfter;
    return options.initialState;
  };
  const applyInputChanges = async (map: AugmentedTreeMultiMap<PiledriverObject, FoldedRow, null>, rows: ReturnType<typeof changedRowsFromTableChanges>) => {
    for (const row of rows) {
      if (row.old) map = await map.delete(row.old.rowSortKey, row.old.rowIdentifier);
      if (row.new) map = await map.add(row.new.rowSortKey, row.new.rowIdentifier, pendingFoldedRow(row.new.rowData));
    }
    return map;
  };
  const refoldSuffix = async (map: AugmentedTreeMultiMap<PiledriverObject, FoldedRow, null>, inputGroup: BulldozerGroupwiseTableImplementationInputGroup, startSortKey: PiledriverObject) => {
    let state = await stateBefore(map, startSortKey);
    const rows: OutputRow[] = [];
    for await (const [rowSortKey, rowIdentifier, row] of map.entries({ gte: startSortKey })) {
      const { newState, newRowData } = await options.reducer(state, { groupKey: inputGroup.groupKey, rowIdentifier, rowSortKey, rowData: row.inputRowData });
      state = newState;
      map = await map.set(rowSortKey, rowIdentifier, { inputRowData: row.inputRowData, outputRowData: newRowData, stateAfter: newState });
      rows.push({ rowIdentifier, rowSortKey, rowData: newRowData });
    }
    return { map, rows };
  };

  return createGroupwiseTreeTableImplementation<PiledriverObject, FoldedRow, null>({
    getMapOptions({ inputGroup }) {
      return {
        comparator: (a, b) => inputGroup.compareSortKeys({ a, b }),
        extractAugmentation: () => null,
        mergeAugmentations: () => null,
      };
    },
    async * listRows({ map, range }) {
      for await (const entry of map.entries(range)) yield outputRow(entry);
    },
    async emitInputChanges({ map, inputGroup, changes }) {
      const changedRows = changedRowsFromTableChanges(changes);
      const firstChangedSortKey = earliestChangedSortKey(inputGroup, changedRows);
      if (firstChangedSortKey === undefined) return { newMap: map, outputChanges: emptyGroupChanges() };

      const oldRows = await collectOutputRows(map, { gte: firstChangedSortKey });
      map = await applyInputChanges(map, changedRows);
      const { map: newMap, rows: newRows } = await refoldSuffix(map, inputGroup, firstChangedSortKey);

      return { newMap, outputChanges: diffOutputRows(oldRows, newRows) };
    },
    async emitInputGroupCreation({ map, inputGroup }) {
      // The surrounding groupwise table emits row additions for the newly-created group in the
      // same batch, so creation itself only creates the empty group state.
      return { newMap: map, outputChanges: emptyGroupChanges() };
    },
    async emitInputGroupDeletion({ map }) {
      return {
        newMap: map,
        outputChanges: {
          addedRows: [],
          modifiedRows: [],
          deletedRows: (await collectOutputRows(map, {})).map(row => ({ groupKey: null, rowIdentifier: row.rowIdentifier, oldRowSortKey: row.rowSortKey, oldRowData: row.rowData })),
        },
      };
    },
    compareSortKeys({ inputTable, a, b }) {
      return inputTable.compareSortKeys({ a, b });
    },
  });
}

/**
 * Materialized time-aware fold.
 *
 * Each input row runs once immediately with `triggerTimeIfRepeated = null`. If the reducer
 * returns `nextTriggerTime`, database/snapshot `tick(now)` processes queued rows whose trigger
 * time is due. Timed reruns append output rows for that source row.
 *
 * Source-row updates come in two flavors:
 * - Without `onSourceRowChanged`, an update resets that source row's emitted outputs and fold
 *   state and re-runs the reducer from `initialState` — previously emitted outputs are deleted
 *   and past trigger times replay (against the *new* row data) on subsequent ticks.
 * - With `onSourceRowChanged`, an update keeps the row's emitted outputs, fold state, and timer
 *   progress; the hook folds the new row data into the existing state and returns the next
 *   trigger time, optionally appending one emitted output row (`appendRowData`) in the same
 *   write — for events the update itself implies (e.g. an immediate end) that same-transaction
 *   readers must see without waiting for a tick. Use this when emitted outputs are append-only
 *   facts (e.g. a ledger) that a source rewrite must not retract or rederive.
 */
export function declareTimeFoldTable(options: {
  initialState: PiledriverObject,
  reducer: (
    state: PiledriverObject,
    row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject },
    triggerTimeIfRepeated: Date | null,
  ) => Promise<{ newState: PiledriverObject, newRowData: PiledriverObject, nextTriggerTime: Date | null }>,
  onSourceRowChanged?: (
    state: PiledriverObject,
    row: { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject },
    previous: { rowData: PiledriverObject, nextTriggerTime: Date | null },
  ) => Promise<{ newState: PiledriverObject, nextTriggerTime: Date | null, appendRowData?: PiledriverObject }>,
}): BulldozerTableImplementation {
  type SourceRow = { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject };
  type RowState = SourceRow & {
    state: PiledriverObject,
    nextTriggerTimeMs: number | null,
    emittedRows: PiledriverObject[],
  };
  type GroupState = { outputRows: PiledriverObject };
  type State = {
    rows: AugmentedTreeMap<string, RowState, null>,
    groups: AugmentedTreeMap<PiledriverObject, GroupState, null>,
    queue: AugmentedTreeMultiMap<number, string, null, string>,
  };
  const outputRowIdentifier = (sourceRowIdentifier: string, outputIndex: number) => JSON.stringify([sourceRowIdentifier, outputIndex]);
  const emptyTableChanges = (): TableChanges => ({ addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] });
  const rowsOptions: ConstructorParameters<typeof AugmentedTreeMap<string, RowState, null>>[0] = {
    comparator: compareStrings,
    extractAugmentation: () => null,
    mergeAugmentations: () => null,
  };
  const groupOptions = (inputTables: Record<string, BulldozerTableImplementationInputTable>): ConstructorParameters<typeof AugmentedTreeMap<PiledriverObject, GroupState, null>>[0] => ({
    comparator: (a, b) => inputTables.input.compareGroupKeys({ a, b }) || compareStrings(canonicalGroupKeyString(a), canonicalGroupKeyString(b)),
    extractAugmentation: () => null,
    mergeAugmentations: () => null,
  });
  const outputRowsOptions: ConstructorParameters<typeof AugmentedTreeMap<string, PiledriverObject, null>>[0] = {
    comparator: compareStrings,
    extractAugmentation: () => null,
    mergeAugmentations: () => null,
  };
  const queueOptions: ConstructorParameters<typeof AugmentedTreeMultiMap<number, string, null, string>>[0] = {
    comparator: (a, b) => a - b,
    extractAugmentation: () => null,
    mergeAugmentations: () => null,
    entryIdComparator: compareStrings,
  };
  const emptyOutputRows = () => new AugmentedTreeMap(outputRowsOptions);
  const emptyState = (inputTables: Record<string, BulldozerTableImplementationInputTable>): State => ({
    rows: new AugmentedTreeMap(rowsOptions),
    groups: new AugmentedTreeMap(groupOptions(inputTables)),
    queue: new AugmentedTreeMultiMap(queueOptions),
  });
  const serialize = (state: State) => ({
    version: 1,
    rows: state.rows.toPiledriverObject(),
    groups: state.groups.toPiledriverObject(),
    queue: state.queue.toPiledriverObject(),
  });
  const deserialize = (serialized: PiledriverObject, inputTables: Record<string, BulldozerTableImplementationInputTable>): State => {
    if (typeof serialized !== "object" || serialized === null || Array.isArray(serialized)) throw new Error("Invalid serialized table");
    if (!("version" in serialized && serialized.version === 1)
      || typeof serialized.rows !== "object" || serialized.rows === null
      || typeof serialized.groups !== "object" || serialized.groups === null
      || typeof serialized.queue !== "object" || serialized.queue === null) throw new Error("Invalid serialized table");
    return {
      rows: AugmentedTreeMap.fromPiledriverObject<string, RowState, null>(serialized.rows, rowsOptions),
      groups: AugmentedTreeMap.fromPiledriverObject<PiledriverObject, GroupState, null>(serialized.groups, groupOptions(inputTables)),
      queue: AugmentedTreeMultiMap.fromPiledriverObject<number, string, null, string>(serialized.queue, queueOptions),
    };
  };
  const outputRowsFrom = (object: PiledriverObject) => AugmentedTreeMap.fromPiledriverObject<string, PiledriverObject, null>(object, outputRowsOptions);
  const toTimestampMs = (date: Date | null) => date === null ? null : date.getTime();
  const sourceRow = (row: RowState): SourceRow => ({ groupKey: row.groupKey, rowIdentifier: row.rowIdentifier, rowSortKey: row.rowSortKey, rowData: row.rowData });
  const runReducer = async (row: SourceRow, state: PiledriverObject, triggerTime: Date | null): Promise<RowState> => {
    const result = await options.reducer(state, row, triggerTime);
    return { ...row, state: result.newState, nextTriggerTimeMs: toTimestampMs(result.nextTriggerTime), emittedRows: [result.newRowData] };
  };
  const appendTimedOutput = async (row: RowState, triggerTimeMs: number): Promise<RowState> => {
    const result = await options.reducer(row.state, sourceRow(row), new Date(triggerTimeMs));
    const nextTriggerTimeMs = toTimestampMs(result.nextTriggerTime);
    if (nextTriggerTimeMs !== null && nextTriggerTimeMs <= triggerTimeMs) throw new Error("Time fold nextTriggerTime must move forward");
    return { ...row, state: result.newState, nextTriggerTimeMs, emittedRows: [...row.emittedRows, result.newRowData] };
  };
  const loadOutputRows = async (state: State, groupKey: PiledriverObject) => {
    const group = await state.groups.get(groupKey);
    return group ? outputRowsFrom(group.outputRows) : emptyOutputRows();
  };
  const saveOutputRows = async (state: State, groupKey: PiledriverObject, outputRows: AugmentedTreeMap<string, PiledriverObject, null>) => ({
    ...state,
    groups: await state.groups.set(groupKey, { outputRows: outputRows.toPiledriverObject() }),
  });
  const removeQueuedTrigger = async (state: State, row: RowState | undefined) => row?.nextTriggerTimeMs === null || row === undefined
    ? state
    : { ...state, queue: await state.queue.delete(row.nextTriggerTimeMs, row.rowIdentifier) };
  const addQueuedTrigger = async (state: State, row: RowState) => row.nextTriggerTimeMs === null
    ? state
    : { ...state, queue: await state.queue.add(row.nextTriggerTimeMs, row.rowIdentifier, row.rowIdentifier) };
  const emittedOutput = (row: RowState, index: number) => ({
    groupKey: row.groupKey,
    rowIdentifier: outputRowIdentifier(row.rowIdentifier, index),
    rowSortKey: null,
    rowData: row.emittedRows[index],
  });
  const emittedOutputs = (row: RowState | undefined) => row?.emittedRows.map((_, index) => emittedOutput(row, index)) ?? [];
  const replaceOutputs = async (state: State, oldRow: RowState | undefined, newRow: RowState | undefined, outputChanges: TableChanges) => {
    const groupKey = newRow !== undefined ? newRow.groupKey : oldRow?.groupKey;
    if (groupKey === undefined) return state;
    let outputRows = await loadOutputRows(state, groupKey);
    const oldOutputs = emittedOutputs(oldRow);
    const newOutputs = emittedOutputs(newRow);
    const sharedLength = Math.min(oldOutputs.length, newOutputs.length);

    for (let i = 0; i < sharedLength; i++) {
      const oldOutput = oldOutputs[i];
      const newOutput = newOutputs[i];
      if (!piledriverObjectEquals(oldOutput.rowData, newOutput.rowData)) {
        outputRows = await outputRows.set(newOutput.rowIdentifier, newOutput.rowData);
        outputChanges.modifiedRows.push({ groupKey, rowIdentifier: newOutput.rowIdentifier, oldRowSortKey: null, newRowSortKey: null, oldRowData: oldOutput.rowData, newRowData: newOutput.rowData });
      }
    }
    for (let i = sharedLength; i < oldOutputs.length; i++) {
      const oldOutput = oldOutputs[i];
      outputRows = await outputRows.delete(oldOutput.rowIdentifier);
      outputChanges.deletedRows.push({ groupKey, rowIdentifier: oldOutput.rowIdentifier, oldRowSortKey: null, oldRowData: oldOutput.rowData });
    }
    for (let i = sharedLength; i < newOutputs.length; i++) {
      const newOutput = newOutputs[i];
      outputRows = await outputRows.set(newOutput.rowIdentifier, newOutput.rowData);
      outputChanges.addedRows.push(newOutput);
    }
    return await saveOutputRows(state, groupKey, outputRows);
  };
  const setSourceRow = async (state: State, row: SourceRow, outputChanges: TableChanges) => {
    const oldRow = await state.rows.get(row.rowIdentifier);
    state = await removeQueuedTrigger(state, oldRow);
    const newRow = await runReducer(row, options.initialState, null);
    state = { ...state, rows: await state.rows.set(row.rowIdentifier, newRow) };
    state = await replaceOutputs(state, oldRow, newRow, outputChanges);
    return await addQueuedTrigger(state, newRow);
  };
  const updateSourceRow = async (state: State, row: SourceRow, outputChanges: TableChanges, onSourceRowChanged: NonNullable<typeof options.onSourceRowChanged>) => {
    const oldRow = await state.rows.get(row.rowIdentifier);
    if (oldRow === undefined) return await setSourceRow(state, row, outputChanges);
    state = await removeQueuedTrigger(state, oldRow);
    const result = await onSourceRowChanged(oldRow.state, row, {
      rowData: oldRow.rowData,
      nextTriggerTime: oldRow.nextTriggerTimeMs === null ? null : new Date(oldRow.nextTriggerTimeMs),
    });
    const emittedRows = result.appendRowData === undefined ? oldRow.emittedRows : [...oldRow.emittedRows, result.appendRowData];
    const newRow: RowState = { ...row, state: result.newState, nextTriggerTimeMs: toTimestampMs(result.nextTriggerTime), emittedRows };
    state = { ...state, rows: await state.rows.set(row.rowIdentifier, newRow) };
    // Prior emittedRows are carried over verbatim (and modified rows never change group), so the
    // only possible output change is the appended row; without one, the materialized output rows
    // are untouched and no output changes are emitted.
    if (result.appendRowData !== undefined) state = await replaceOutputs(state, oldRow, newRow, outputChanges);
    return await addQueuedTrigger(state, newRow);
  };
  const deleteSourceRow = async (state: State, rowIdentifier: string, outputChanges: TableChanges) => {
    const oldRow = await state.rows.get(rowIdentifier);
    if (!oldRow) return state;
    state = await removeQueuedTrigger(state, oldRow);
    state = { ...state, rows: await state.rows.delete(rowIdentifier) };
    return await replaceOutputs(state, oldRow, undefined, outputChanges);
  };
  const processDue = async (state: State, now: Date, outputChanges: TableChanges) => {
    const dueThroughMs = now.getTime();
    if (!Number.isFinite(dueThroughMs)) throw new Error("Invalid time fold tick Date");
    for (;;) {
      const next = (await fromAsync(state.queue.entries({ lte: dueThroughMs, limit: 1 }))).at(0);
      if (!next) return state;
      const [triggerTimeMs, , rowIdentifier] = next;
      const oldRow = await state.rows.get(rowIdentifier);
      state = { ...state, queue: await state.queue.delete(triggerTimeMs, rowIdentifier) };
      if (!oldRow || oldRow.nextTriggerTimeMs !== triggerTimeMs) continue;
      const newRow = await appendTimedOutput(oldRow, triggerTimeMs);
      state = { ...state, rows: await state.rows.set(rowIdentifier, newRow) };
      state = await replaceOutputs(state, oldRow, newRow, outputChanges);
      state = await addQueuedTrigger(state, newRow);
    }
  };

  return {
    init({ inputTables }) {
      return { serializedTable: serialize(emptyState(inputTables)) };
    },
    async * listGroups({ serializedTable, inputTables, range }) {
      const state = deserialize(serializedTable, inputTables);
      for await (const groupKey of state.groups.keys(range)) yield { groupKey };
    },
    async * listRowsInGroup({ serializedTable, inputTables, groupKey, range }) {
      if (!isInRange(null, range, () => 0) || range.limit === 0) return;
      const state = deserialize(serializedTable, inputTables);
      const outputRows = await loadOutputRows(state, groupKey);
      let yielded = 0;
      for await (const [rowIdentifier, rowData] of outputRows.entries({ reverse: range.reverse })) {
        yield { groupKey, rowIdentifier, rowSortKey: null, rowData };
        if (range.limit !== undefined && ++yielded >= range.limit) return;
      }
    },
    async tick({ serializedTable, inputTables, now }) {
      const state = deserialize(serializedTable, inputTables);
      const outputChanges = emptyTableChanges();
      const nextState = await processDue(state, now, outputChanges);
      return { newSerializedTable: serialize(nextState), outputChanges };
    },
    async emitInputChanges({ serializedTable, inputTables, changes }) {
      let state = deserialize(serializedTable, inputTables);
      const outputChanges = emptyTableChanges();
      for (const { groupKey } of changes.input.addedGroups) outputChanges.addedGroups.push({ groupKey });
      for (const row of changedRowsFromTableChanges(changes.input)) {
        if (row.old && row.new && options.onSourceRowChanged) {
          state = await updateSourceRow(state, row.new, outputChanges, options.onSourceRowChanged);
          continue;
        }
        if (row.old) state = await deleteSourceRow(state, row.old.rowIdentifier, outputChanges);
        if (row.new) state = await setSourceRow(state, row.new, outputChanges);
      }
      for (const { groupKey } of changes.input.deletedGroups) {
        state = { ...state, groups: await state.groups.delete(groupKey) };
        outputChanges.deletedGroups.push({ groupKey });
      }
      return { newSerializedTable: serialize(state), outputChanges };
    },
    compareGroupKeys({ inputTables, a, b }) {
      return inputTables.input.compareGroupKeys({ a, b });
    },
    compareSortKeys() {
      return 0;
    },
  };
}

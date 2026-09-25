import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { declareInMemoryLowLevelDatabase } from "../low-level/implementations/in-memory.js";
import { declareInstantAvailabilityLowLevelDatabase } from "../low-level/implementations/instant-availability.js";
import { declareLmdbLowLevelDatabase } from "../low-level/implementations/lmdb.js";
import { ConcatTreeList } from "../piledriver/data-structures/concat-tree-list.js";
import { declareBasePiledriverDatabase } from "../piledriver/implementations/base.js";
import { declareBreezyPiledriverDatabase } from "../piledriver/implementations/breezy/index.js";
import type { PiledriverObject } from "../piledriver/index.js";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import {
  declareBulldozerDatabase,
  declareGroupByTable,
  declareLeftFoldTable,
  declareLeftJoinTable,
  declareTimeFoldTable,
  defineCompactTable,
  defineConcatTable,
  defineFilterTable,
  defineFlatMapTable,
  defineIdentityTable,
  defineMapTable,
  defineMaterializeTable,
  defineReduceTable,
  defineSortTable,
  defineStoredTable,
  defineTransduceTable,
} from "./index.js";

type Migration = Parameters<typeof declareBulldozerDatabase>[1]["migrations"];
type Snapshot = Awaited<ReturnType<typeof initializedSnapshot>>;
type Row = { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject };
type TableChanges = {
  addedRows: Row[],
  modifiedRows: Array<Row & { oldRowSortKey: PiledriverObject, newRowSortKey: PiledriverObject, oldRowData: PiledriverObject, newRowData: PiledriverObject }>,
  deletedRows: Array<Row & { oldRowSortKey: PiledriverObject, oldRowData: PiledriverObject }>,
  addedGroups: { groupKey: PiledriverObject }[],
  deletedGroups: { groupKey: PiledriverObject }[],
};
type PerfMeasurement = { work: number, details?: string };
type PerfScenario = {
  table: string,
  operation: string,
  expectation: "polylog" | "known-linear",
  measure(size: number): Promise<PerfMeasurement>,
};
type PerfDatabase = ReturnType<typeof declareBulldozerDatabase>;
type SnapshotUpdater = Parameters<PerfDatabase["withSnapshot"]>[0];
type WorkloadOperation =
  | { type: "upsert", rowIdentifier: string, team: string | null, value: number }
  | { type: "delete", rowIdentifier: string };

const smallSize = 32;
const largeSize = 512;
const oldCompatibleRowCounts = (process.env.BULLDOZER_OLD_COMPAT_ROW_COUNTS ?? "256,1024")
  .split(",")
  .map(value => Number(value.trim()))
  .filter(value => Number.isInteger(value) && value > 0);
const oldCompatibleWarmupOps = 20;
const oldCompatibleMeasuredOps = 80;
const lmdbTempPaths: string[] = [];
const databases: PerfDatabase[] = [];
const perfBackend = process.env.BULLDOZER_PERF_BACKEND ?? "lmdb-instant";
const perfSnapshotMode = process.env.BULLDOZER_PERF_SNAPSHOT_MODE ?? "plain";
const piledriverImplementation = process.env.STACK_BULLDOZER_PILEDRIVER_IMPLEMENTATION ?? "base";
if (piledriverImplementation !== "base" && piledriverImplementation !== "breezy") throw new Error("STACK_BULLDOZER_PILEDRIVER_IMPLEMENTATION must be base or breezy");
const emptyChanges = (): TableChanges => ({ addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] });
const trackDatabase = (db: PerfDatabase) => {
  databases.push(db);
  return db;
};
const changedRowCount = (changes: Pick<TableChanges, "addedRows" | "modifiedRows" | "deletedRows">) =>
  changes.addedRows.length + changes.modifiedRows.length + changes.deletedRows.length;
const collect = async <T>(iterable: AsyncIterable<T>) => {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
};
const newLowLevelDb = () => {
  if (perfBackend === "lmdb" || perfBackend === "lmdb-instant") {
    const path = mkdtempSync(join(tmpdir(), "bulldozer-perf-lmdb-"));
    lmdbTempPaths.push(path);
    const lmdb = declareLmdbLowLevelDatabase({ path, dbId: crypto.randomUUID() });
    return perfBackend === "lmdb-instant"
      ? declareInstantAvailabilityLowLevelDatabase(lmdb)
      : lmdb;
  }
  return declareInMemoryLowLevelDatabase(crypto.randomUUID());
};
const newPiledriverDb = () => {
  if (piledriverImplementation === "base") return declareBasePiledriverDatabase(newLowLevelDb());
  if (perfBackend !== "lmdb") throw new Error("Breezy requires the lmdb performance backend");
  const path = mkdtempSync(join(tmpdir(), "bulldozer-perf-lmdb-"));
  lmdbTempPaths.push(path);
  return declareBreezyPiledriverDatabase({ path, dbId: crypto.randomUUID() });
};
afterAll(async () => {
  // An unclosed LMDB environment keeps native handles alive, preventing Vitest's worker and main process from exiting; remove its mapped directory only after closing it.
  for (const db of databases.reverse()) await db.close();
  for (const path of lmdbTempPaths) rmSync(path, { recursive: true, force: true });
});
const newDb = (migrations: Migration) =>
  trackDatabase(declareBulldozerDatabase(newPiledriverDb(), { migrations }));
const writeSnapshot = async (db: PerfDatabase, updateSnapshot: SnapshotUpdater) =>
  perfSnapshotMode === "plain"
    ? await db.withSnapshot(updateSnapshot)
    : await db.withSnapshotConsistent(updateSnapshot);
async function initializedSnapshot(migrations: Migration) {
  const db = newDb(migrations);
  await db.applyRemainingMigrations();
  return (await db.getSnapshot()).snapshot;
}
const set = async (snapshot: Snapshot, tableId: string, rowIdentifier: string, newRowData: PiledriverObject | undefined) =>
  (await snapshot.setOrDeleteRow({ tableId, rowIdentifier, newRowData })).newSnapshot;
const seedRows = async (
  snapshot: Snapshot,
  tableId: string,
  count: number,
  rowData: (index: number) => PiledriverObject = index => index,
) => {
  for (let i = 0; i < count; i++) {
    snapshot = await set(snapshot, tableId, `r${i}`, rowData(i));
  }
  return snapshot;
};
const complexEventRow = (index: number, amount = index + 1) => ({
  account: `acct-${index % 32}`,
  asset: `asset-${index % 8}`,
  amount,
  active: index % 5 !== 0,
  bucket: index % 16,
});
const timed = async <T>(operation: () => Promise<T>) => {
  const start = performance.now();
  const value = await operation();
  return { value, durationMs: performance.now() - start };
};
const logOldCompatibleMetric = (label: string, durationMs: number, suffix = "") => {
  process.stdout.write(`\n[bulldozer-perf-new] ${label}: ${durationMs.toFixed(2)}ms${suffix}\n`);
};

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function choose<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)] ?? values[0];
}

function createWorkload(seed: number, operationCount: number): WorkloadOperation[] {
  const rng = createRng(seed);
  const identifiers = ["u1", "u2", "u3", "u4", "u:5", "u 6", "u/7", "u'8"] as const;
  const teams = ["alpha", "beta", "gamma", null] as const;
  const existing = new Set<string>();
  const operations: WorkloadOperation[] = [];

  for (let i = 0; i < operationCount; i++) {
    const roll = rng();
    if (roll < 0.74) {
      const rowIdentifier = choose(rng, identifiers);
      const team = choose(rng, teams);
      const value = Math.floor(rng() * 100);
      operations.push({ type: "upsert", rowIdentifier, team, value });
      existing.add(rowIdentifier);
    } else {
      const rowIdentifier = existing.size > 0 ? choose(rng, [...existing]) : choose(rng, identifiers);
      operations.push({ type: "delete", rowIdentifier });
      existing.delete(rowIdentifier);
    }
  }

  return operations;
}

async function executeWorkload(
  db: ReturnType<typeof declareBulldozerDatabase>,
  operations: WorkloadOperation[],
  tableId = "users",
) {
  for (const operation of operations) {
    await writeSnapshot(db, async snapshot => operation.type === "upsert"
      ? await set(snapshot, tableId, operation.rowIdentifier, { team: operation.team, value: operation.value })
      : await set(snapshot, tableId, operation.rowIdentifier, undefined));
  }
}

async function countRows(snapshot: Snapshot, tableId: string) {
  let count = 0;
  for await (const { groupKey } of snapshot.listGroups({ tableId, range: {} })) {
    for await (const _row of snapshot.listRowsInGroup({ tableId, groupKey, range: {} })) count++;
  }
  return count;
}

async function collectRows(snapshot: Snapshot, tableId: string, groupKey: PiledriverObject, range: Record<string, PiledriverObject | number | boolean | undefined> = {}) {
  return await collect(snapshot.listRowsInGroup({ tableId, groupKey, range }));
}

async function createPrefilledOldCompatibleBase(rowCount: number) {
  const piledriver = newPiledriverDb();
  const baseMigration: Migration[number] = [
    { type: "initTable", tableId: "users", table: defineStoredTable(), inputTables: {} },
    { type: "initTable", tableId: "rules", table: defineStoredTable(), inputTables: {} },
  ];
  const migrations: Migration = [baseMigration];
  const db = trackDatabase(declareBulldozerDatabase(piledriver, { migrations }));
  await db.applyRemainingMigrations();
  const { durationMs } = await timed(async () => {
    await writeSnapshot(db, async snapshot => {
      for (let i = 0; i < rowCount; i++) {
        snapshot = await set(snapshot, "users", `seed-${i}`, {
          team: i % 4 === 0 ? null : i % 4 === 1 ? "alpha" : i % 4 === 2 ? "beta" : "gamma",
          value: i % 1000,
        });
      }
      for (const [rowIdentifier, rowData] of [
        ["rule-alpha", { team: "alpha", threshold: 0, label: "alpha-rule" }],
        ["rule-beta", { team: "beta", threshold: 0, label: "beta-rule" }],
        ["rule-gamma", { team: "gamma", threshold: 0, label: "gamma-rule" }],
        ["rule-null", { team: null, threshold: 0, label: "null-rule" }],
      ] as const) {
        snapshot = await set(snapshot, "rules", rowIdentifier, rowData);
      }
      return snapshot;
    });
  });
  logOldCompatibleMetric(`load prefill (${rowCount} rows)`, durationMs);
  return { piledriver, migrations };
}

function oldCompatibleDerivedSteps(): Array<{ label: string, steps: Migration[number] }> {
  return [
    {
      label: "load init groupedByTeam",
      steps: [{
        type: "initTable",
        tableId: "groupedByTeam",
        table: declareGroupByTable({
          groupKeyExtractor: async row => (row.rowData as { team: string | null }).team,
          groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
        }),
        inputTables: { input: "users" },
      }],
    },
    {
      label: "load init leftJoinRulesByTeam",
      steps: [{
        type: "initTable",
        tableId: "leftJoinRulesByTeam",
        table: declareGroupByTable({
          groupKeyExtractor: async row => (row.rowData as { team: string | null }).team,
          groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
        }),
        inputTables: { input: "rules" },
      }],
    },
    {
      label: "load init mappedByTeam",
      steps: [{
        type: "initTable",
        tableId: "mappedByTeam",
        table: defineMapTable(row => {
          const user = row.rowData as { team: string | null, value: number };
          const valuePlusTen = user.value + 10;
          return { team: user.team, valuePlusTen, bucket: valuePlusTen >= 700 ? "high" : "low" };
        }),
        inputTables: { input: "groupedByTeam" },
      }],
    },
    {
      label: "load init mappedTwice",
      steps: [{
        type: "initTable",
        tableId: "mappedTwice",
        table: defineMapTable(row => {
          const user = row.rowData as { team: string | null, bucket: string, valuePlusTen: number };
          return { team: user.team, bucket: user.bucket, valueScaled: user.valuePlusTen * 2 };
        }),
        inputTables: { input: "mappedByTeam" },
      }],
    },
    {
      label: "load init groupedByBucket",
      steps: [{
        type: "initTable",
        tableId: "groupedByBucket",
        table: declareGroupByTable({
          groupKeyExtractor: async row => (row.rowData as { bucket: string }).bucket,
          groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
        }),
        inputTables: { input: "mappedTwice" },
      }],
    },
    {
      label: "load init filteredHighValue",
      steps: [{
        type: "initTable",
        tableId: "filteredHighValue",
        table: defineFilterTable(row => (row.rowData as { value: number }).value >= 700),
        inputTables: { input: "groupedByTeam" },
      }],
    },
    {
      label: "load init concatenatedByTeam",
      steps: [{
        type: "initTable",
        tableId: "concatenatedByTeam",
        table: defineConcatTable(),
        inputTables: { grouped: "groupedByTeam", filtered: "filteredHighValue" },
      }],
    },
    {
      label: "load init expandedByTeam",
      steps: [{
        type: "initTable",
        tableId: "expandedByTeam",
        table: defineFlatMapTable(row => {
          const user = row.rowData as { team: string | null, value: number };
          return [
            { team: user.team, kind: "base", mappedValue: user.value + 10 },
            { team: user.team, kind: "double", mappedValue: user.value * 2 },
          ];
        }),
        inputTables: { input: "groupedByTeam" },
      }],
    },
    {
      label: "load init sortedHighValueByTeam",
      steps: [{
        type: "initTable",
        tableId: "sortedHighValueByTeam",
        table: defineSortTable({
          sortKeyExtractor: row => (row.rowData as { value: number }).value,
          sortKeyComparator: (a, b) => Number(a) - Number(b),
        }),
        inputTables: { input: "filteredHighValue" },
      }],
    },
    {
      label: "load init foldedHighValueByTeam",
      steps: [{
        type: "initTable",
        tableId: "foldedHighValueByTeam",
        table: declareLeftFoldTable({
          initialState: 0,
          reducer: async (state, row) => {
            const next = Number(state) + (row.rowData as { value: number }).value;
            return { newState: next, newRowData: { ...(row.rowData as object), runningTotal: next } };
          },
        }),
        inputTables: { input: "sortedHighValueByTeam" },
      }],
    },
    {
      label: "load init timedExposureByTeam",
      steps: [{
        type: "initTable",
        tableId: "timedExposureByTeam",
        table: declareTimeFoldTable({
          initialState: 0,
          reducer: async (_state, row, triggerTimeIfRepeated) => ({
            newState: (row.rowData as { value: number }).value,
            newRowData: { ...(row.rowData as object), timestamp: triggerTimeIfRepeated?.toISOString() ?? null },
            nextTriggerTime: triggerTimeIfRepeated === null ? new Date("2100-01-01T00:00:00.000Z") : null,
          }),
        }),
        inputTables: { input: "groupedByTeam" },
      }],
    },
    {
      label: "load init leftJoinedByTeam",
      steps: [{
        type: "initTable",
        tableId: "leftJoinedByTeam",
        table: declareLeftJoinTable({
          leftJoinKeyExtractor: async row => (row.rowData as { team: string | null }).team,
          rightJoinKeyExtractor: async row => (row.rowData as { team: string | null }).team,
          joinKeyComparator: (a, b) => stringCompare(String(a), String(b)),
          joiner: async (left, right) => ({ leftRowData: left.rowData, rightRowData: right?.rowData ?? null }),
        }),
        inputTables: { left: "groupedByTeam", right: "leftJoinRulesByTeam" },
      }],
    },
    {
      label: "load init compactedByTeam",
      steps: [{
        type: "initTable",
        tableId: "compactedByTeam",
        table: defineCompactTable({
          compactor: () => [],
        }),
        inputTables: { input: "sortedHighValueByTeam" },
      }],
    },
    {
      label: "load init reducedByTeam",
      steps: [{
        type: "initTable",
        tableId: "reducedByTeam",
        table: defineReduceTable({
          valueExtractor: async row => (row.rowData as { value: number }).value,
          valueReducer: async (...values) => values.reduce((sum, value) => Number(sum) + Number(value), 0),
        }),
        inputTables: { input: "groupedByTeam" },
      }],
    },
    {
      label: "load init transducedByTeam",
      steps: [{
        type: "initTable",
        tableId: "transducedByTeam",
        table: defineTransduceTable({
          valueExtractor: async row => ConcatTreeList.fromEntries([[row.rowIdentifier, (row.rowData as { value: number }).value]]),
          valueReducer: async (...lists) => ConcatTreeList.concat(lists),
        }),
        inputTables: { input: "groupedByTeam" },
      }],
    },
  ];
}

function expectPolylogScaling(small: PerfMeasurement, large: PerfMeasurement) {
  const budget = small.work * 8 + 32;
  expect(large.work, `small=${small.work}; large=${large.work}; ${large.details ?? ""}`).toBeLessThanOrEqual(budget);
}

function expectKnownLinearScaling(small: PerfMeasurement, large: PerfMeasurement) {
  const budget = small.work * 8 + 32;
  expect(large.work, `small=${small.work}; large=${large.work}; ${large.details ?? ""}`).toBeGreaterThan(budget);
}

function spyTable(onChanges: (changes: TableChanges) => void): any {
  return {
    init: () => ({ serializedTable: null }),
    async * listGroups() {},
    async * listRowsInGroup() {},
    async emitInputChanges({ serializedTable, changes }: { serializedTable: PiledriverObject, changes: Record<string, TableChanges> }) {
      onChanges(changes.input);
      return { newSerializedTable: serializedTable, outputChanges: emptyChanges() };
    },
    compareGroupKeys: () => 0,
    compareSortKeys: () => 0,
  };
}

function countedStaticSource(size: number, counters: { rowsRead: number }): any {
  return {
    init: () => ({ serializedTable: null }),
    async * listGroups({ range }: { range: { limit?: number } }) {
      if (range.limit === 0) return;
      yield { groupKey: null };
    },
    async * listRowsInGroup({ range }: { range: { limit?: number, reverse?: boolean } }) {
      const indexes = Array.from({ length: size }, (_, index) => index);
      if (range.reverse) indexes.reverse();
      let yielded = 0;
      for (const index of indexes) {
        counters.rowsRead++;
        yield { groupKey: null, rowIdentifier: `r${index}`, rowSortKey: index, rowData: index };
        if (range.limit !== undefined && ++yielded >= range.limit) return;
      }
    },
    async emitInputChanges() {
      throw new Error("Static source does not accept input changes");
    },
    compareGroupKeys: () => 0,
    compareSortKeys: ({ a, b }: { a: PiledriverObject, b: PiledriverObject }) => Number(a) - Number(b),
  };
}

async function boundedReadWork(table: unknown, size: number) {
  const counters = { rowsRead: 0 };
  const snapshot = await initializedSnapshot([[
    { type: "initTable", tableId: "source", table: countedStaticSource(size, counters), inputTables: {} },
    { type: "initTable", tableId: "tested", table: table as ReturnType<typeof defineIdentityTable>, inputTables: { input: "source" } },
  ]]);
  const rows = await collect(snapshot.listRowsInGroup({ tableId: "tested", groupKey: null, range: { limit: 3 } }));
  return { work: counters.rowsRead, details: `rows returned=${rows.length}` };
}

const scenarios: PerfScenario[] = [
  {
    table: "Stored",
    operation: "modify one row in a large stored table; downstream should receive only that row change",
    expectation: "polylog",
    measure: async size => {
      let downstreamChanges = 0;
      let snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "spy", table: spyTable(changes => downstreamChanges += changedRowCount(changes)), inputTables: { input: "store" } },
      ]]);
      snapshot = await seedRows(snapshot, "store", size);
      downstreamChanges = 0;
      await set(snapshot, "store", `r${Math.floor(size / 2)}`, size + 1);
      return { work: downstreamChanges, details: `downstream changes=${downstreamChanges}` };
    },
  },
  {
    table: "Identity",
    operation: "read the first three rows; input rows pulled should be bounded by the limit",
    expectation: "polylog",
    measure: size => boundedReadWork(defineIdentityTable(), size),
  },
  {
    table: "Filter",
    operation: "read the first three passing rows; predicate calls should be bounded by the limit for common passing predicates",
    expectation: "polylog",
    measure: async size => {
      let calls = 0;
      await boundedReadWork(defineFilterTable(() => {
        calls++;
        return true;
      }), size);
      return { work: calls, details: `predicate calls=${calls}` };
    },
  },
  {
    table: "Map",
    operation: "modify one source row; mapper should run only for old/new row images",
    expectation: "polylog",
    measure: async size => {
      let calls = 0;
      let snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "tested", table: defineMapTable(row => {
          calls++;
          return Number(row.rowData) * 2;
        }), inputTables: { input: "store" } },
      ]]);
      snapshot = await seedRows(snapshot, "store", size);
      calls = 0;
      await set(snapshot, "store", `r${Math.floor(size / 2)}`, size + 1);
      return { work: calls, details: `mapper calls=${calls}` };
    },
  },
  {
    table: "FlatMap",
    operation: "modify one source row; flat mapper and emitted changes should scale with per-row fanout only",
    expectation: "polylog",
    measure: async size => {
      let calls = 0;
      let downstreamChanges = 0;
      let snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "tested", table: defineFlatMapTable(row => {
          calls++;
          return [row.rowData, Number(row.rowData) + 1, Number(row.rowData) + 2];
        }), inputTables: { input: "store" } },
        { type: "initTable", tableId: "spy", table: spyTable(changes => downstreamChanges += changedRowCount(changes)), inputTables: { input: "tested" } },
      ]]);
      snapshot = await seedRows(snapshot, "store", size);
      calls = 0;
      downstreamChanges = 0;
      await set(snapshot, "store", `r${Math.floor(size / 2)}`, size + 1);
      return { work: calls + downstreamChanges, details: `mapper calls=${calls}; downstream changes=${downstreamChanges}` };
    },
  },
  {
    table: "Concat",
    operation: "read a limited prefix from the first input; later inputs should not be read",
    expectation: "polylog",
    measure: async size => {
      const left = { rowsRead: 0 };
      const right = { rowsRead: 0 };
      const snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "left", table: countedStaticSource(size, left), inputTables: {} },
        { type: "initTable", tableId: "right", table: countedStaticSource(size, right), inputTables: {} },
        { type: "initTable", tableId: "tested", table: defineConcatTable(), inputTables: { a: "left", b: "right" } },
      ]]);
      left.rowsRead = 0;
      right.rowsRead = 0;
      await collect(snapshot.listRowsInGroup({ tableId: "tested", groupKey: null, range: { limit: 3 } }));
      return { work: left.rowsRead + right.rowsRead, details: `left reads=${left.rowsRead}; right reads=${right.rowsRead}` };
    },
  },
  {
    table: "Materialize",
    operation: "modify one source row; materialized output changes should include only that row",
    expectation: "polylog",
    measure: async size => {
      let downstreamChanges = 0;
      let snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "tested", table: defineMaterializeTable(), inputTables: { input: "store" } },
        { type: "initTable", tableId: "spy", table: spyTable(changes => downstreamChanges += changedRowCount(changes)), inputTables: { input: "tested" } },
      ]]);
      snapshot = await seedRows(snapshot, "store", size);
      downstreamChanges = 0;
      await set(snapshot, "store", `r${Math.floor(size / 2)}`, size + 1);
      return { work: downstreamChanges, details: `downstream changes=${downstreamChanges}` };
    },
  },
  {
    table: "Sort",
    operation: "modify one source row; sort-key extraction and output changes should touch only old/new row images",
    expectation: "polylog",
    measure: async size => {
      let extractorCalls = 0;
      let downstreamChanges = 0;
      let snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "tested", table: defineSortTable({
          sortKeyExtractor: row => {
            extractorCalls++;
            return row.rowData;
          },
          sortKeyComparator: (a, b) => Number(a) - Number(b),
        }), inputTables: { input: "store" } },
        { type: "initTable", tableId: "spy", table: spyTable(changes => downstreamChanges += changedRowCount(changes)), inputTables: { input: "tested" } },
      ]]);
      snapshot = await seedRows(snapshot, "store", size);
      extractorCalls = 0;
      downstreamChanges = 0;
      await set(snapshot, "store", `r${Math.floor(size / 2)}`, size + 1);
      return { work: extractorCalls + downstreamChanges, details: `extractor calls=${extractorCalls}; downstream changes=${downstreamChanges}` };
    },
  },
  {
    table: "Reduce",
    operation: "modify one source row; augmented reduction should recompute a logarithmic number of aggregate nodes",
    expectation: "polylog",
    measure: async size => {
      let extractorCalls = 0;
      let reducerCalls = 0;
      let snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "tested", table: defineReduceTable({
          valueExtractor: async row => {
            extractorCalls++;
            return row.rowData;
          },
          valueReducer: async (...values) => {
            reducerCalls++;
            return values.reduce((sum, value) => Number(sum) + Number(value), 0);
          },
        }), inputTables: { input: "store" } },
      ]]);
      snapshot = await seedRows(snapshot, "store", size);
      extractorCalls = 0;
      reducerCalls = 0;
      await set(snapshot, "store", `r${Math.floor(size / 2)}`, size + 1);
      return { work: extractorCalls + reducerCalls, details: `extractor calls=${extractorCalls}; reducer calls=${reducerCalls}` };
    },
  },
  {
    table: "Transduce",
    operation: "modify one source row; tree aggregation and ConcatTreeList diff should avoid scanning the whole group",
    expectation: "polylog",
    measure: async size => {
      let extractorCalls = 0;
      let reducerCalls = 0;
      let downstreamChanges = 0;
      let snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "tested", table: defineTransduceTable({
          valueExtractor: async row => {
            extractorCalls++;
            return ConcatTreeList.fromEntries([[row.rowIdentifier, row.rowData]]);
          },
          valueReducer: async (...lists) => {
            reducerCalls++;
            return ConcatTreeList.concat(lists);
          },
        }), inputTables: { input: "store" } },
        { type: "initTable", tableId: "spy", table: spyTable(changes => downstreamChanges += changedRowCount(changes)), inputTables: { input: "tested" } },
      ]]);
      snapshot = await seedRows(snapshot, "store", size);
      extractorCalls = 0;
      reducerCalls = 0;
      downstreamChanges = 0;
      await set(snapshot, "store", `r${Math.floor(size / 2)}`, size + 1);
      return { work: extractorCalls + reducerCalls + downstreamChanges, details: `extractor calls=${extractorCalls}; reducer calls=${reducerCalls}; downstream changes=${downstreamChanges}` };
    },
  },
  {
    table: "Compact",
    operation: "read a limited output from the transduce-backed compact list without recompacting the group",
    expectation: "polylog",
    measure: async size => {
      let compactorCalls = 0;
      const sourceReads = { rowsRead: 0 };
      const snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "source", table: countedStaticSource(size, sourceReads), inputTables: {} },
        { type: "initTable", tableId: "tested", table: defineCompactTable({
          compactor: (a, b) => {
            compactorCalls++;
            return [];
          },
        }), inputTables: { input: "source" } },
      ]]);
      compactorCalls = 0;
      await collect(snapshot.listRowsInGroup({ tableId: "tested", groupKey: null, range: { limit: 3 } }));
      return { work: compactorCalls, details: `compactor calls=${compactorCalls}` };
    },
  },
  {
    table: "GroupBy",
    operation: "modify one source row without changing its group; group-key extraction should touch only old/new row images",
    expectation: "polylog",
    measure: async size => {
      let extractorCalls = 0;
      let downstreamChanges = 0;
      let snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "tested", table: declareGroupByTable({
          groupKeyExtractor: async row => {
            extractorCalls++;
            return Number(row.rowData) % 2;
          },
          groupKeyComparator: (a, b) => Number(a) - Number(b),
        }), inputTables: { input: "store" } },
        { type: "initTable", tableId: "spy", table: spyTable(changes => downstreamChanges += changedRowCount(changes)), inputTables: { input: "tested" } },
      ]]);
      snapshot = await seedRows(snapshot, "store", size, index => index * 2);
      extractorCalls = 0;
      downstreamChanges = 0;
      await set(snapshot, "store", `r${Math.floor(size / 2)}`, size * 4);
      return { work: extractorCalls + downstreamChanges, details: `extractor calls=${extractorCalls}; downstream changes=${downstreamChanges}` };
    },
  },
  {
    table: "LeftJoin",
    operation: "modify one left row with one matching right row; join work should scale with match fanout, not table size",
    expectation: "polylog",
    measure: async size => {
      let extractorCalls = 0;
      let joinerCalls = 0;
      let downstreamChanges = 0;
      let snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "left", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "right", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "tested", table: declareLeftJoinTable({
          leftJoinKeyExtractor: async row => {
            extractorCalls++;
            return (row.rowData as { key: number }).key;
          },
          rightJoinKeyExtractor: async row => {
            extractorCalls++;
            return (row.rowData as { key: number }).key;
          },
          joinKeyComparator: (a, b) => Number(a) - Number(b),
          joiner: async (left, right) => {
            joinerCalls++;
            return { left: left.rowIdentifier, right: right?.rowIdentifier ?? null };
          },
        }), inputTables: { left: "left", right: "right" } },
        { type: "initTable", tableId: "spy", table: spyTable(changes => downstreamChanges += changedRowCount(changes)), inputTables: { input: "tested" } },
      ]]);
      for (let i = 0; i < size; i++) snapshot = await set(snapshot, "right", `r${i}`, { key: i });
      for (let i = 0; i < size; i++) snapshot = await set(snapshot, "left", `l${i}`, { key: i });
      extractorCalls = 0;
      joinerCalls = 0;
      downstreamChanges = 0;
      await set(snapshot, "left", `l${Math.floor(size / 2)}`, { key: Math.floor(size / 2), updated: true });
      return { work: extractorCalls + joinerCalls + downstreamChanges, details: `extractor calls=${extractorCalls}; joiner calls=${joinerCalls}; downstream changes=${downstreamChanges}` };
    },
  },
  {
    table: "TimeFold",
    operation: "tick one due queued row among many future rows; reducer calls should be proportional to due work",
    expectation: "polylog",
    measure: async size => {
      let reducerCalls = 0;
      let snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "tested", table: declareTimeFoldTable({
          initialState: 0,
          reducer: async (state, row, triggerTimeIfRepeated) => {
            reducerCalls++;
            return {
              newState: Number(state) + 1,
              newRowData: row.rowData,
              nextTriggerTime: triggerTimeIfRepeated === null
                ? new Date(row.rowIdentifier === "r0" ? "2020-01-01T00:00:00.000Z" : "2100-01-01T00:00:00.000Z")
                : null,
            };
          },
        }), inputTables: { input: "store" } },
      ]]);
      snapshot = await seedRows(snapshot, "store", size);
      reducerCalls = 0;
      await snapshot.tick(new Date("2020-01-01T00:00:00.000Z"));
      return { work: reducerCalls, details: `reducer calls=${reducerCalls}` };
    },
  },
];

describe("Bulldozer old-compatible performance", () => {
  it("reports ops/sec for baseline and composed example setup", async () => {
    const warmupOperations = createWorkload(111, oldCompatibleWarmupOps);
    const measuredOperations = createWorkload(222, oldCompatibleMeasuredOps);
    const benchmark = async (name: string, migration: Migration[number], validationTableId: string) => {
      const db = newDb([migration]);
      await db.applyRemainingMigrations();
      await executeWorkload(db, warmupOperations);
      const { durationMs } = await timed(async () => await executeWorkload(db, measuredOperations));
      const operationsPerSecond = measuredOperations.length / (durationMs / 1000);
      const snapshot = (await db.getSnapshot()).snapshot;
      expect(await countRows(snapshot, validationTableId)).toBeGreaterThan(0);
      process.stdout.write(`\n[bulldozer-perf-new] ${name}: ${operationsPerSecond.toFixed(1)} ops/s (${measuredOperations.length} ops in ${durationMs.toFixed(2)}ms)\n`);
      return operationsPerSecond;
    };

    const baselineOps = await benchmark("stored-table baseline", [
      { type: "initTable", tableId: "users", table: defineStoredTable(), inputTables: {} },
    ], "users");
    const composedOps = await benchmark("group+map+group composed pipeline", [
      { type: "initTable", tableId: "users", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "groupedByTeam", table: declareGroupByTable({
        groupKeyExtractor: async row => (row.rowData as { team: string | null }).team,
        groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
      }), inputTables: { input: "users" } },
      { type: "initTable", tableId: "mapped", table: defineMapTable(row => {
        const user = row.rowData as { team: string | null, value: number };
        const valuePlusTen = user.value + 10;
        return { team: user.team, valuePlusTen, bucket: valuePlusTen >= 40 ? "high" : "low" };
      }), inputTables: { input: "groupedByTeam" } },
      { type: "initTable", tableId: "groupedByBucket", table: declareGroupByTable({
        groupKeyExtractor: async row => (row.rowData as { bucket: string }).bucket,
        groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
      }), inputTables: { input: "mapped" } },
      { type: "initTable", tableId: "groupedByBucketReadModel", table: defineMaterializeTable(), inputTables: { input: "groupedByBucket" } },
    ], "groupedByBucketReadModel");

    process.stdout.write(`\n[bulldozer-perf-new] slowdown factor (baseline/composed): ${(baselineOps / composedOps).toFixed(2)}x\n`);
    expect(baselineOps).toBeGreaterThan(0);
    expect(composedOps).toBeGreaterThan(0);
  });

  it("regression: stacked group-map-group mutations avoid single-operation cliffs", async () => {
    const db = newDb([[
      { type: "initTable", tableId: "users", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "groupedByTeam", table: declareGroupByTable({
        groupKeyExtractor: async row => (row.rowData as { team: string | null }).team,
        groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
      }), inputTables: { input: "users" } },
      { type: "initTable", tableId: "mappedLevel1", table: defineMapTable(row => {
        const user = row.rowData as { team: string | null, value: number };
        const value = user.value + 1;
        return { team: user.team, value, bucket: value % 2 === 0 ? "even" : "odd" };
      }), inputTables: { input: "groupedByTeam" } },
      { type: "initTable", tableId: "mappedLevel2", table: defineMapTable(row => {
        const user = row.rowData as { team: string | null, bucket: string, value: number };
        return { team: user.team, bucket: user.bucket, score: user.value * 3 };
      }), inputTables: { input: "mappedLevel1" } },
      { type: "initTable", tableId: "groupedByBucket", table: declareGroupByTable({
        groupKeyExtractor: async row => (row.rowData as { bucket: string }).bucket,
        groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
      }), inputTables: { input: "mappedLevel2" } },
    ]]);
    await db.applyRemainingMigrations();
    await writeSnapshot(db, async snapshot => {
      for (const [rowIdentifier, rowData] of [
        ["u1", { team: "alpha", value: 5 }],
        ["u2", { team: "beta", value: 7 }],
        ["u3", { team: "gamma", value: 9 }],
        ["u:4", { team: "alpha", value: 11 }],
        ["u 5", { team: null, value: 13 }],
      ] as const) snapshot = await set(snapshot, "users", rowIdentifier, rowData);
      return snapshot;
    });
    await writeSnapshot(db, async snapshot => await set(snapshot, "users", "u1", { team: "alpha", value: 15 }));

    const setRowMutation = await timed(async () => {
      await writeSnapshot(db, async snapshot => await set(snapshot, "users", "u2", { team: "beta", value: 19 }));
    });
    logOldCompatibleMetric("regression stacked pipeline setRow", setRowMutation.durationMs);
    const deleteMutation = await timed(async () => {
      await writeSnapshot(db, async snapshot => await set(snapshot, "users", "u3", undefined));
    });
    logOldCompatibleMetric("regression stacked pipeline deleteRow", deleteMutation.durationMs);

    expect(setRowMutation.durationMs).toBeLessThan(5_000);
    expect(deleteMutation.durationMs).toBeLessThan(5_000);
  });

  it("regression: concat queries stay fast after initializing grouped inputs", async () => {
    const rowCount = Math.min(1024, Math.max(...oldCompatibleRowCounts));
    const piledriver = newPiledriverDb();
    const baseMigration: Migration[number] = [
      { type: "initTable", tableId: "usersA", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "usersB", table: defineStoredTable(), inputTables: {} },
    ];
    const dbV1 = trackDatabase(declareBulldozerDatabase(piledriver, { migrations: [baseMigration] }));
    await dbV1.applyRemainingMigrations();
    await writeSnapshot(dbV1, async snapshot => {
      for (let i = 0; i < rowCount; i++) {
        const rowData = { team: i % 2 === 0 ? "alpha" : "beta", value: i };
        snapshot = await set(snapshot, "usersA", `a-${i}`, rowData);
        snapshot = await set(snapshot, "usersB", `b-${i}`, rowData);
      }
      return snapshot;
    });

    const derivedMigration: Migration[number] = [
      { type: "initTable", tableId: "groupedA", table: declareGroupByTable({
        groupKeyExtractor: async row => (row.rowData as { team: string }).team,
        groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
      }), inputTables: { input: "usersA" } },
      { type: "initTable", tableId: "groupedB", table: declareGroupByTable({
        groupKeyExtractor: async row => (row.rowData as { team: string }).team,
        groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
      }), inputTables: { input: "usersB" } },
      { type: "initTable", tableId: "concatenated", table: defineConcatTable(), inputTables: { a: "groupedA", b: "groupedB" } },
      { type: "initTable", tableId: "concatenatedReadModel", table: defineMaterializeTable(), inputTables: { input: "concatenated" } },
    ];
    const dbV2 = trackDatabase(declareBulldozerDatabase(piledriver, { migrations: [baseMigration, derivedMigration] }));
    const init = await timed(async () => await dbV2.applyRemainingMigrations());
    logOldCompatibleMetric("virtual concat init equivalent", init.durationMs);
    const snapshot = (await dbV2.getSnapshot()).snapshot;
    const count = await timed(async () => await countRows(snapshot, "concatenatedReadModel"));
    logOldCompatibleMetric("virtual concat count query", count.durationMs, `; rows=${count.value}`);

    expect(count.value).toBe(rowCount * 2);
    expect(count.durationMs).toBeLessThan(5_000);
  });

  it.each(oldCompatibleRowCounts)("load test: prefilled stored table and derived views stay comparable (%i rows)", async rowCount => {
    const fixture = await createPrefilledOldCompatibleBase(rowCount);
    let db = trackDatabase(declareBulldozerDatabase(fixture.piledriver, { migrations: fixture.migrations }));
    let snapshot = (await db.getSnapshot()).snapshot;

    const storedCount = await timed(async () => await countRows(snapshot, "users"));
    logOldCompatibleMetric("load count via listRowsInGroup", storedCount.durationMs, `; rows=${storedCount.value}`);
    expect(storedCount.value).toBe(rowCount);

    const setRowTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const measured = await timed(async () => {
        await writeSnapshot(db, async snapshot => await set(snapshot, "users", `seed-${Math.floor(rowCount / 2) + i}`, { team: "beta", value: 777 + i }));
      });
      setRowTimes.push(measured.durationMs);
    }
    const setRowAverageMs = setRowTimes.reduce((sum, value) => sum + value, 0) / setRowTimes.length;
    process.stdout.write(`\n[bulldozer-perf-new] load setRow average (5 iterations): ${setRowAverageMs.toFixed(2)}ms\n`);

    const onlineInsertTimes: number[] = [];
    const onlineUpdateTimes: number[] = [];
    const onlineDeleteTimes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const rowIdentifier = `perf-online-row-${i}`;
      onlineInsertTimes.push((await timed(async () => {
        await writeSnapshot(db, async snapshot => await set(snapshot, "users", rowIdentifier, { team: "beta", value: 111 + i }));
      })).durationMs);
      onlineUpdateTimes.push((await timed(async () => {
        await writeSnapshot(db, async snapshot => await set(snapshot, "users", rowIdentifier, { team: "beta", value: 211 + i }));
      })).durationMs);
      onlineDeleteTimes.push((await timed(async () => {
        await writeSnapshot(db, async snapshot => await set(snapshot, "users", rowIdentifier, undefined));
      })).durationMs);
    }
    process.stdout.write(`\n[bulldozer-perf-new] load online setRow insert average (3 iterations): ${(onlineInsertTimes.reduce((a, b) => a + b, 0) / onlineInsertTimes.length).toFixed(2)}ms\n`);
    process.stdout.write(`[bulldozer-perf-new] load online setRow update average (3 iterations): ${(onlineUpdateTimes.reduce((a, b) => a + b, 0) / onlineUpdateTimes.length).toFixed(2)}ms\n`);
    process.stdout.write(`[bulldozer-perf-new] load online deleteRow average (3 iterations): ${(onlineDeleteTimes.reduce((a, b) => a + b, 0) / onlineDeleteTimes.length).toFixed(2)}ms\n`);

    const pointDelete = await timed(async () => {
      await writeSnapshot(db, async snapshot => await set(snapshot, "users", `seed-${Math.floor(rowCount / 2) - 1}`, undefined));
    });
    logOldCompatibleMetric("load point delete (deleteRow existing)", pointDelete.durationMs);

    let migrations = fixture.migrations;
    for (const derived of oldCompatibleDerivedSteps()) {
      migrations = [...migrations, derived.steps];
      db = trackDatabase(declareBulldozerDatabase(fixture.piledriver, { migrations }));
      const init = await timed(async () => await db.applyRemainingMigrations());
      logOldCompatibleMetric(derived.label, init.durationMs);
    }
    const readModelInputs = [
      "groupedByTeam",
      "mappedTwice",
      "groupedByBucket",
      "filteredHighValue",
      "concatenatedByTeam",
      "expandedByTeam",
      "sortedHighValueByTeam",
    ];
    migrations = [...migrations, readModelInputs.map(tableId => ({
      type: "initTable" as const,
      tableId: `${tableId}ReadModel`,
      table: defineMaterializeTable(),
      inputTables: { input: tableId },
    }))];
    db = declareBulldozerDatabase(fixture.piledriver, { migrations });
    const readModelInit = await timed(async () => await db.applyRemainingMigrations());
    logOldCompatibleMetric("load init explicit read models", readModelInit.durationMs);

    snapshot = (await db.getSnapshot()).snapshot;
    const countLabels = [
      ...readModelInputs.map(tableId => `${tableId}ReadModel`),
      "foldedHighValueByTeam",
      "timedExposureByTeam",
      "leftJoinedByTeam",
      "compactedByTeam",
      "reducedByTeam",
      "transducedByTeam",
    ];
    const derivedCounts = await timed(async () => await Promise.all(countLabels.map(async tableId => [tableId, await countRows(snapshot, tableId)] as const)));
    logOldCompatibleMetric("load count derived tables", derivedCounts.durationMs, `; ${derivedCounts.value.map(([tableId, count]) => `${tableId}=${count}`).join(", ")}`);
    expect(Object.fromEntries(derivedCounts.value).groupedByTeamReadModel).toBe(rowCount - 1);
    expect(Object.fromEntries(derivedCounts.value).expandedByTeamReadModel).toBe((rowCount - 1) * 2);

    const groupedSubset = await timed(async () => await collectRows(snapshot, "groupedByTeamReadModel", "beta", { limit: Math.min(100, rowCount) }));
    logOldCompatibleMetric("load iterate groupedByTeam subset from start", groupedSubset.durationMs, `; rows=${groupedSubset.value.length}`);
    expect(groupedSubset.value.length).toBeGreaterThan(0);

    const sortedSubsetFromStart = await timed(async () => await collectRows(snapshot, "sortedHighValueByTeamReadModel", "beta", { gte: 700, limit: Math.min(100, rowCount) }));
    logOldCompatibleMetric("load iterate sortedHighValueByTeam subset from start", sortedSubsetFromStart.durationMs, `; rows=${sortedSubsetFromStart.value.length}`);
    const sortedSubsetFromSortKey = await timed(async () => await collectRows(snapshot, "sortedHighValueByTeamReadModel", "beta", { gte: 900, limit: Math.min(100, rowCount), reverse: true }));
    logOldCompatibleMetric("load iterate sortedHighValueByTeam subset from sort-key cursor", sortedSubsetFromSortKey.durationMs, `; rows=${sortedSubsetFromSortKey.value.length}`);

    const deltaMutation = await timed(async () => {
      await writeSnapshot(db, async snapshot => await set(snapshot, "users", "seed-100000", { team: "delta", value: 999 }));
    });
    logOldCompatibleMetric("load point mutation through derived schema", deltaMutation.durationMs);
    snapshot = (await db.getSnapshot()).snapshot;
    expect((await collectRows(snapshot, "groupedByTeamReadModel", "delta")).some(row => row.rowIdentifier === "seed-100000")).toBe(true);
    expect(await collectRows(snapshot, "expandedByTeamReadModel", "delta")).toHaveLength(2);
    expect(await collectRows(snapshot, "leftJoinedByTeam", "delta")).toHaveLength(1);
  }, 120_000);
});

describe("Bulldozer table performance", () => {
  for (const scenario of scenarios) {
    it(`${scenario.table}: ${scenario.operation}`, async () => {
      const small = await scenario.measure(smallSize);
      const large = await scenario.measure(largeSize);
      if (scenario.expectation === "polylog") {
        expectPolylogScaling(small, large);
      } else {
        expectKnownLinearScaling(small, large);
      }
    });
  }
});

describe("Bulldozer complex schema performance", () => {
  it("times a large stored-table setRow through a schema using every table helper", async () => {
    const rowCount = 384;
    let compactCalls = 0;
    let snapshot = await initializedSnapshot([[
      { type: "initTable", tableId: "events", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "prices", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "identityEvents", table: defineIdentityTable(), inputTables: { input: "events" } },
      { type: "initTable", tableId: "activeEvents", table: defineFilterTable(row => (row.rowData as { active: boolean }).active), inputTables: { input: "identityEvents" } },
      { type: "initTable", tableId: "normalizedEvents", table: defineMapTable(row => {
        const event = row.rowData as { account: string, asset: string, amount: number, active: boolean, bucket: number };
        return {
          account: event.account,
          asset: event.asset,
          amount: event.amount,
          active: event.active,
          bucket: event.bucket,
          weightedAmount: event.amount * 2,
        };
      }), inputTables: { input: "activeEvents" } },
      { type: "initTable", tableId: "expandedEvents", table: defineFlatMapTable(row => {
        const event = row.rowData as { account: string, asset: string, amount: number, weightedAmount: number };
        return [
          { account: event.account, asset: event.asset, kind: "debit", amount: -event.amount },
          { account: event.account, asset: event.asset, kind: "credit", amount: event.weightedAmount },
        ];
      }), inputTables: { input: "normalizedEvents" } },
      { type: "initTable", tableId: "sortedExpandedEvents", table: defineSortTable({
        sortKeyExtractor: row => {
          const event = row.rowData as { account: string, asset: string, amount: number, kind: string };
          return [event.account, event.asset, event.amount, event.kind, row.rowIdentifier];
        },
        sortKeyComparator: (a, b) => stringCompare(JSON.stringify(a), JSON.stringify(b)),
      }), inputTables: { input: "expandedEvents" } },
      { type: "initTable", tableId: "runningFoldInput", table: defineSortTable({
        sortKeyExtractor: row => {
          const [eventId, outputIndex] = JSON.parse(row.rowIdentifier) as [string, number];
          return [Number(eventId.slice("event-".length)), outputIndex];
        },
        sortKeyComparator: (a, b) => {
          const [eventA, outputA] = a as [number, number];
          const [eventB, outputB] = b as [number, number];
          return eventA - eventB || outputA - outputB;
        },
      }), inputTables: { input: "expandedEvents" } },
      { type: "initTable", tableId: "materializedExpandedEvents", table: defineMaterializeTable(), inputTables: { input: "sortedExpandedEvents" } },
      { type: "initTable", tableId: "expandedTotal", table: defineReduceTable({
        valueExtractor: async row => (row.rowData as { amount: number }).amount,
        valueReducer: async (...values) => values.reduce((sum, value) => Number(sum) + Number(value), 0),
      }), inputTables: { input: "sortedExpandedEvents" } },
      { type: "initTable", tableId: "accountSequence", table: defineTransduceTable({
        valueExtractor: async row => ConcatTreeList.fromEntries([[row.rowIdentifier, (row.rowData as { account: string }).account]]),
        valueReducer: async (...lists) => ConcatTreeList.concat(lists),
      }), inputTables: { input: "normalizedEvents" } },
      { type: "initTable", tableId: "compactedExpandedEvents", table: defineCompactTable({
        compactor: () => {
          compactCalls++;
          return [];
        },
      }), inputTables: { input: "sortedExpandedEvents" } },
      { type: "initTable", tableId: "eventsByAccount", table: declareGroupByTable({
        groupKeyExtractor: async row => (row.rowData as { account: string }).account,
        groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
      }), inputTables: { input: "normalizedEvents" } },
      { type: "initTable", tableId: "enrichedEvents", table: declareLeftJoinTable({
        leftJoinKeyExtractor: async row => (row.rowData as { asset: string }).asset,
        rightJoinKeyExtractor: async row => (row.rowData as { asset: string }).asset,
        joinKeyComparator: (a, b) => stringCompare(String(a), String(b)),
        joiner: async (event, price) => ({
          event: event.rowData,
          price: price?.rowData ?? null,
        }),
      }), inputTables: { left: "normalizedEvents", right: "prices" } },
      { type: "initTable", tableId: "runningExpandedTotal", table: declareLeftFoldTable({
        initialState: 0,
        reducer: async (state, row) => {
          const next = Number(state) + (row.rowData as { amount: number }).amount;
          return { newState: next, newRowData: next };
        },
      }), inputTables: { input: "runningFoldInput" } },
      { type: "initTable", tableId: "eventReminders", table: declareTimeFoldTable({
        initialState: 0,
        reducer: async (state, row, triggerTimeIfRepeated) => ({
          newState: Number(state) + 1,
          newRowData: { event: row.rowIdentifier, repeated: triggerTimeIfRepeated !== null, state: Number(state) + 1 },
          nextTriggerTime: triggerTimeIfRepeated === null ? new Date("2100-01-01T00:00:00.000Z") : null,
        }),
      }), inputTables: { input: "normalizedEvents" } },
      { type: "initTable", tableId: "everything", table: defineConcatTable(), inputTables: {
        accountSequence: "accountSequence",
        compacted: "compactedExpandedEvents",
        enriched: "enrichedEvents",
        expanded: "materializedExpandedEvents",
        grouped: "eventsByAccount",
        reduced: "expandedTotal",
        reminders: "eventReminders",
        running: "runningExpandedTotal",
      } },
      { type: "initTable", tableId: "everythingMaterialized", table: defineMaterializeTable(), inputTables: { input: "everything" } },
    ]]);

    for (let i = 0; i < 8; i++) {
      snapshot = await set(snapshot, "prices", `asset-${i}`, { asset: `asset-${i}`, usd: 100 + i });
    }
    for (let i = 0; i < rowCount; i++) {
      snapshot = await set(snapshot, "events", `event-${i}`, complexEventRow(i));
    }

    compactCalls = 0;
    const targetIndex = rowCount - 1;
    const { value: nextSnapshot, durationMs } = await timed(() => set(snapshot, "events", `event-${targetIndex}`, complexEventRow(targetIndex, rowCount * 10)));
    snapshot = nextSnapshot;

    const finalRows = await collect(snapshot.listRowsInGroup({
      tableId: "everythingMaterialized",
      groupKey: null,
      range: { limit: 5 },
    }));
    process.stdout.write(`\ncomplex schema setRow: ${durationMs.toFixed(2)}ms for ${rowCount} source rows; compact calls=${compactCalls}; sample final rows=${finalRows.length}\n`);

    expect(finalRows.length).toBeGreaterThan(0);
    expect(durationMs).toBeLessThan(5_000);
  });
});

describe("Bulldozer LFold performance", () => {
  it("makes suffix recomputation explicit for first, middle, and last row updates", async () => {
    const rowCount = 256;
    let reducerCalls = 0;
    const measureUpdateAt = async (index: number) => {
      let snapshot = await initializedSnapshot([[
        { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
        { type: "initTable", tableId: "sorted", table: defineSortTable({
          sortKeyExtractor: row => (row.rowData as { order: number }).order,
          sortKeyComparator: (a, b) => Number(a) - Number(b),
        }), inputTables: { input: "store" } },
        { type: "initTable", tableId: "fold", table: declareLeftFoldTable({
          initialState: 0,
          reducer: async (state, row) => {
            reducerCalls++;
            const next = Number(state) + (row.rowData as { value: number }).value;
            return { newState: next, newRowData: next };
          },
        }), inputTables: { input: "sorted" } },
      ]]);
      for (let i = 0; i < rowCount; i++) {
        snapshot = await set(snapshot, "store", `r${i}`, { order: i, value: i + 1 });
      }

      reducerCalls = 0;
      const { durationMs } = await timed(() => set(snapshot, "store", `r${index}`, { order: index, value: rowCount * 10 + index }));
      return { reducerCalls, durationMs };
    };

    const first = await measureUpdateAt(0);
    const middle = await measureUpdateAt(Math.floor(rowCount / 2));
    const last = await measureUpdateAt(rowCount - 1);

    process.stdout.write(`\nlfold suffix scaling: first=${first.reducerCalls} calls/${first.durationMs.toFixed(2)}ms; middle=${middle.reducerCalls} calls/${middle.durationMs.toFixed(2)}ms; last=${last.reducerCalls} calls/${last.durationMs.toFixed(2)}ms\n`);

    expect(first.reducerCalls).toBe(rowCount);
    expect(middle.reducerCalls).toBe(rowCount - Math.floor(rowCount / 2));
    expect(last.reducerCalls).toBe(1);
  });
});

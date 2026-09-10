import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declareInMemoryLowLevelDatabase } from "../low-level/implementations/in-memory.js";
import { declareInstantAvailabilityLowLevelDatabase } from "../low-level/implementations/instant-availability.js";
import { declareLmdbLowLevelDatabase } from "../low-level/implementations/lmdb.js";
import type { DatabaseSeq } from "../index.js";
import { declareBasePiledriverDatabase } from "../piledriver/implementations/base.js";
import { declareInMemoryPiledriverDatabase } from "../piledriver/implementations/in-memory.js";
import type { PiledriverObject } from "../piledriver/index.js";
import { ConcatTreeList } from "../piledriver/data-structures/concat-tree-list.js";
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

type Row = {
  groupKey: PiledriverObject,
  rowIdentifier: string,
  rowSortKey: PiledriverObject,
  rowData: PiledriverObject,
};

const byId = (a: Row, b: Row) => stringCompare(a.rowIdentifier, b.rowIdentifier);
const asRows = async (iterable: AsyncIterable<Row>) => [...await collect(iterable)].sort(byId);
const collect = async <T>(iterable: AsyncIterable<T>) => {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
};
const newDb = (backend: "base" | "in-memory", migrations: Parameters<typeof declareBulldozerDatabase>[1]["migrations"]) =>
  declareBulldozerDatabase(
    backend === "base"
      ? declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(crypto.randomUUID()))
      : declareInMemoryPiledriverDatabase(crypto.randomUUID()),
    { migrations },
  );
const initializedSnapshot = async (backend: "base" | "in-memory", migrations: Parameters<typeof declareBulldozerDatabase>[1]["migrations"]) => {
  const db = newDb(backend, migrations);
  await db.applyRemainingMigrations();
  return (await db.getSnapshot()).snapshot;
};
const rows = (snapshot: Awaited<ReturnType<typeof initializedSnapshot>>, tableId: string, range: Record<string, PiledriverObject> = {}, groupKey: PiledriverObject = null) =>
  asRows(snapshot.listRowsInGroup({ tableId, groupKey, range }));
const set = async (snapshot: Awaited<ReturnType<typeof initializedSnapshot>>, tableId: string, rowIdentifier: string, newRowData: PiledriverObject | undefined) =>
  (await snapshot.setOrDeleteRow({ tableId, rowIdentifier, newRowData })).newSnapshot;

describe.each(["base", "in-memory"] as const)("Bulldozer (%s)", backend => {
  it("persists an empty snapshot for zero migrations", async () => {
    const db = newDb(backend, []);
    await db.applyRemainingMigrations();

    await expect(db.getSnapshot()).resolves.toMatchObject({ snapshot: expect.anything() });
  });

  it("serializes overlapping withSnapshot operations", async () => {
    const db = newDb(backend, [[{ type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} }]]);
    await db.applyRemainingMigrations();

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    const releaseFirstPromise = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = db.withSnapshot(async snapshot => {
      markFirstStarted();
      await releaseFirstPromise;
      return await set(snapshot, "store", "a", 1);
    });
    await firstStarted;

    const second = db.withSnapshot(async snapshot => await set(snapshot, "store", "b", 2));
    releaseFirst();
    await Promise.all([first, second]);

    const snapshot = (await db.getSnapshot()).snapshot;
    expect(await rows(snapshot, "store")).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: null, rowData: 1 },
      { groupKey: null, rowIdentifier: "b", rowSortKey: null, rowData: 2 },
    ]);
  });

  it("rejects Piledriver garbage collection once shutdown starts", async () => {
    const db = newDb(backend, []);
    const closing = db.close();

    await expect(db.collectPiledriverGarbage(0)).rejects.toThrow("closing");
    await closing;
  });

  it("does not expose stored rows through non-null groups", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "mapped", table: defineMapTable(row => row.rowData), inputTables: { input: "store" } },
    ]]);
    snapshot = await set(snapshot, "store", "a", 1);

    expect(await rows(snapshot, "store", {}, { fake: "group" })).toEqual([]);
    expect(await rows(snapshot, "mapped", {}, { fake: "group" })).toEqual([]);
  });

  it("lists tables with dependency links, capabilities, and debug metadata", async () => {
    const db = newDb(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {}, debugMetadata: { name: "Store", operator: "stored" } },
      { type: "initTable", tableId: "mapped", table: defineMapTable(row => row.rowData), inputTables: { input: "store" }, debugMetadata: { name: "Mapped", operator: "map" } },
    ]]);

    const tables = db.listTables();
    expect(tables).toEqual([
      {
        tableId: "store",
        inputTableIds: {},
        outputTables: [{ tableId: "mapped", inputTableKey: "input" }],
        supportsSetRow: true,
        supportsDeleteRow: true,
        supportsTick: false,
        debugMetadata: { name: "Store", operator: "stored" },
      },
      {
        tableId: "mapped",
        inputTableIds: { input: "store" },
        outputTables: [],
        supportsSetRow: false,
        supportsDeleteRow: false,
        supportsTick: false,
        debugMetadata: { name: "Mapped", operator: "map" },
      },
    ]);

    tables[0].debugMetadata!.name = "Mutated copy";
    expect(db.listTables()[0].debugMetadata).toEqual({ name: "Store", operator: "stored" });
  });

  it("stores, modifies, deletes, and ignores missing deletes", async () => {
    let snapshot = await initializedSnapshot(backend, [[{ type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} }]]);

    snapshot = await set(snapshot, "store", "a", { value: 1 });
    snapshot = await set(snapshot, "store", "b", { value: 2 });
    expect(await rows(snapshot, "store")).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: null, rowData: { value: 1 } },
      { groupKey: null, rowIdentifier: "b", rowSortKey: null, rowData: { value: 2 } },
    ]);

    snapshot = await set(snapshot, "store", "a", { value: 3 });
    snapshot = await set(snapshot, "store", "missing", undefined);
    snapshot = await set(snapshot, "store", "b", undefined);
    expect(await rows(snapshot, "store")).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: null, rowData: { value: 3 } },
    ]);
  });

  it("asserts stored row changes before applying them", async () => {
    const assertedChanges: unknown[] = [];
    let snapshot = await initializedSnapshot(backend, [[
      {
        type: "initTable",
        tableId: "store",
        table: defineStoredTable({
          async assertRowChange(change) {
            assertedChanges.push(structuredClone(change));
            if (change.newRowData !== undefined) {
              const row = change.newRowData as { value?: unknown, locked?: unknown };
              if (typeof row.value !== "number") throw new Error("stored row value must be a number");
              if ((change.oldRowData as { locked?: unknown } | undefined)?.locked !== undefined && row.locked !== true) {
                throw new Error("locked rows must stay locked");
              }
            }
          },
        }),
        inputTables: {},
      },
    ]]);

    snapshot = await set(snapshot, "store", "a", { value: 1, locked: true });
    snapshot = await set(snapshot, "store", "a", { value: 2, locked: true });
    snapshot = await set(snapshot, "store", "missing", undefined);
    await expect(set(snapshot, "store", "bad", { value: "not-a-number" })).rejects.toThrow("stored row value must be a number");
    await expect(set(snapshot, "store", "a", { value: 3 })).rejects.toThrow("locked rows must stay locked");

    expect(assertedChanges).toEqual([
      { rowIdentifier: "a", oldRowData: undefined, newRowData: { value: 1, locked: true } },
      { rowIdentifier: "a", oldRowData: { value: 1, locked: true }, newRowData: { value: 2, locked: true } },
      { rowIdentifier: "missing", oldRowData: undefined, newRowData: undefined },
      { rowIdentifier: "bad", oldRowData: undefined, newRowData: { value: "not-a-number" } },
      { rowIdentifier: "a", oldRowData: { value: 2, locked: true }, newRowData: { value: 3 } },
    ]);
    expect(await rows(snapshot, "store")).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: null, rowData: { value: 2, locked: true } },
    ]);
  });

  it("propagates through identity, map, filter, flatMap, sort, and materialize", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "identity", table: defineIdentityTable(), inputTables: { input: "store" } },
      { type: "initTable", tableId: "mapped", table: defineMapTable(row => ({ doubled: Number(row.rowData) * 2 })), inputTables: { input: "identity" } },
      { type: "initTable", tableId: "filtered", table: defineFilterTable(row => Number(row.rowData) % 2 === 0), inputTables: { input: "store" } },
      { type: "initTable", tableId: "flat", table: defineFlatMapTable(row => [row.rowData, Number(row.rowData) + 10]), inputTables: { input: "filtered" } },
      { type: "initTable", tableId: "sorted", table: defineSortTable({ sortKeyExtractor: row => Number(row.rowData), sortKeyComparator: (a, b) => Number(a) - Number(b) }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "sorted" } },
    ]]);

    snapshot = await set(snapshot, "store", "one", 1);
    snapshot = await set(snapshot, "store", "two", 2);
    snapshot = await set(snapshot, "store", "three", 3);

    expect(await rows(snapshot, "mapped")).toEqual([
      { groupKey: null, rowIdentifier: "one", rowSortKey: null, rowData: { doubled: 2 } },
      { groupKey: null, rowIdentifier: "three", rowSortKey: null, rowData: { doubled: 6 } },
      { groupKey: null, rowIdentifier: "two", rowSortKey: null, rowData: { doubled: 4 } },
    ]);
    expect(await rows(snapshot, "filtered")).toEqual([
      { groupKey: null, rowIdentifier: "two", rowSortKey: null, rowData: 2 },
    ]);
    expect(await rows(snapshot, "flat")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["two", 0]), rowSortKey: [null, 0], rowData: 2 },
      { groupKey: null, rowIdentifier: JSON.stringify(["two", 1]), rowSortKey: [null, 1], rowData: 12 },
    ]);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "mat", groupKey: null, range: {} }))).toEqual([
      { groupKey: null, rowIdentifier: "one", rowSortKey: 1, rowData: 1 },
      { groupKey: null, rowIdentifier: "two", rowSortKey: 2, rowData: 2 },
      { groupKey: null, rowIdentifier: "three", rowSortKey: 3, rowData: 3 },
    ]);

    snapshot = await set(snapshot, "store", "one", 4);
    expect(await rows(snapshot, "filtered")).toEqual([
      { groupKey: null, rowIdentifier: "one", rowSortKey: null, rowData: 4 },
      { groupKey: null, rowIdentifier: "two", rowSortKey: null, rowData: 2 },
    ]);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "mat", groupKey: null, range: { gte: 2, lt: 4 } }))).toEqual([
      { groupKey: null, rowIdentifier: "two", rowSortKey: 2, rowData: 2 },
      { groupKey: null, rowIdentifier: "three", rowSortKey: 3, rowData: 3 },
    ]);
  });

  it("concatenates multiple inputs without conflating input keys", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "left", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "right", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "concat", table: defineConcatTable(), inputTables: { z: "right", a: "left" } },
    ]]);

    snapshot = await set(snapshot, "left", "l", "L");
    snapshot = await set(snapshot, "right", "r", "R");

    expect(await rows(snapshot, "concat")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", "l"]), rowSortKey: [0, null], rowData: "L" },
      { groupKey: null, rowIdentifier: JSON.stringify(["z", "r"]), rowSortKey: [1, null], rowData: "R" },
    ]);
  });

  it("orders and paginates concat groups using the shared input ordering", async () => {
    const compareGroupKeys = (a: PiledriverObject, b: PiledriverObject) => stringCompare(JSON.stringify(a), JSON.stringify(b));
    const groupBy = declareGroupByTable({
      groupKeyExtractor: async row => Number(row.rowData),
      groupKeyComparator: compareGroupKeys,
    });
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "storeA", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "storeB", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "groupsA", table: groupBy, inputTables: { input: "storeA" } },
      { type: "initTable", tableId: "groupsB", table: groupBy, inputTables: { input: "storeB" } },
      { type: "initTable", tableId: "concat", table: defineConcatTable(), inputTables: { a: "groupsA", b: "groupsB" } },
    ]]);

    snapshot = await set(snapshot, "storeA", "a1", 1);
    snapshot = await set(snapshot, "storeA", "a3", 3);
    snapshot = await set(snapshot, "storeA", "a4", 4);
    snapshot = await set(snapshot, "storeB", "b2", 2);
    snapshot = await set(snapshot, "storeB", "b4", 4);

    const listGroups = async (range: Record<string, PiledriverObject> = {}) =>
      await collect(snapshot.listGroups({ tableId: "concat", range }));
    const lastGroupKey = (groups: { groupKey: PiledriverObject }[]) => {
      const group = groups.at(-1);
      if (group === undefined) throw new Error("Expected a non-empty group page");
      return group.groupKey;
    };
    const full = await listGroups();
    expect(full).toEqual([{ groupKey: 1 }, { groupKey: 2 }, { groupKey: 3 }, { groupKey: 4 }]);
    expect(full.filter(group => group.groupKey === 4)).toHaveLength(1);
    expect(await listGroups({ limit: 3 })).toEqual(full.slice(0, 3));

    const firstPage = await listGroups({ limit: 2 });
    const secondPage = await listGroups({ gt: lastGroupKey(firstPage), limit: 2 });
    expect([...firstPage, ...secondPage]).toEqual(full);

    const reverseFull = await listGroups({ reverse: true });
    expect(reverseFull).toEqual([...full].reverse());
    const reverseFirstPage = await listGroups({ reverse: true, limit: 2 });
    const reverseSecondPage = await listGroups({ reverse: true, lt: lastGroupKey(reverseFirstPage), limit: 2 });
    expect([...reverseFirstPage, ...reverseSecondPage]).toEqual(reverseFull);
  });

  it("closes concat input group iterators when iteration ends early", async () => {
    let closed = false;
    const stored = defineStoredTable();
    const tracked = {
      ...stored,
      async * listGroups(options: Parameters<typeof stored.listGroups>[0]) {
        try {
          for await (const group of stored.listGroups(options)) yield group;
        } finally {
          closed = true;
        }
      },
    };
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "tracked", table: tracked, inputTables: {} },
      { type: "initTable", tableId: "other", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "concat", table: defineConcatTable(), inputTables: { a: "tracked", b: "other" } },
    ]]);
    snapshot = await set(snapshot, "tracked", "row", "value");

    closed = false;
    expect(await collect(snapshot.listGroups({ tableId: "concat", range: { limit: 1 } }))).toEqual([{ groupKey: null }]);
    expect(closed).toBe(true);

    closed = false;
    for await (const group of snapshot.listGroups({ tableId: "concat", range: {} })) {
      expect(group).toEqual({ groupKey: null });
      break;
    }
    expect(closed).toBe(true);
  });

  it("closes acquired concat iterators when a later input fails during acquisition", async () => {
    let closed = false;
    const stored = defineStoredTable();
    const tracked = {
      ...stored,
      listGroups(options: Parameters<typeof stored.listGroups>[0]) {
        const inner = stored.listGroups(options)[Symbol.asyncIterator]();
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => inner.next(),
              async return() {
                closed = true;
                const result = await inner.return?.();
                return result ?? { done: true, value: undefined };
              },
            };
          },
        };
      },
    };
    let shouldThrow = false;
    const throwingStored = defineStoredTable();
    const throwing = {
      ...throwingStored,
      listGroups(options: Parameters<typeof throwingStored.listGroups>[0]) {
        if (shouldThrow) throw new Error("concat input acquisition failed");
        return throwingStored.listGroups(options);
      },
    };
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "tracked", table: tracked, inputTables: {} },
      { type: "initTable", tableId: "throwing", table: throwing, inputTables: {} },
      { type: "initTable", tableId: "concat", table: defineConcatTable(), inputTables: { a: "tracked", z: "throwing" } },
    ]]);
    snapshot = await set(snapshot, "tracked", "row", "value");
    shouldThrow = true;
    closed = false;

    await expect(collect(snapshot.listGroups({ tableId: "concat", range: {} }))).rejects.toThrow("concat input acquisition failed");
    expect(closed).toBe(true);
  });

  it("left joins rows by derived keys and updates when either side changes", async () => {
    const join = declareLeftJoinTable({
      leftJoinKeyExtractor: async row => (row.rowData as { key: string }).key,
      rightJoinKeyExtractor: async row => (row.rowData as { key: string }).key,
      joinKeyComparator: (a, b) => stringCompare(String(a), String(b)),
      joiner: async (left, right) => ({
        left: (left.rowData as { value: string }).value,
        right: right ? (right.rowData as { label: string }).label : null,
      }),
    });
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "left", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "right", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "join", table: join, inputTables: { left: "left", right: "right" } },
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "join" } },
    ]]);

    snapshot = await set(snapshot, "left", "l1", { key: "a", value: "A" });
    expect(await rows(snapshot, "join")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["l1", null]), rowSortKey: [null, null], rowData: { left: "A", right: null } },
    ]);

    snapshot = await set(snapshot, "right", "r1", { key: "a", label: "R1" });
    expect(await rows(snapshot, "join")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["l1", "r1"]), rowSortKey: [null, null], rowData: { left: "A", right: "R1" } },
    ]);

    snapshot = await set(snapshot, "right", "r1", { key: "a", label: "R1b" });
    expect(await rows(snapshot, "mat")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["l1", "r1"]), rowSortKey: [null, null], rowData: { left: "A", right: "R1b" } },
    ]);

    snapshot = await set(snapshot, "right", "r2", { key: "a", label: "R2" });
    expect(await rows(snapshot, "join")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["l1", "r1"]), rowSortKey: [null, null], rowData: { left: "A", right: "R1b" } },
      { groupKey: null, rowIdentifier: JSON.stringify(["l1", "r2"]), rowSortKey: [null, null], rowData: { left: "A", right: "R2" } },
    ]);

    snapshot = await set(snapshot, "left", "l1", { key: "b", value: "B" });
    expect(await rows(snapshot, "join")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["l1", null]), rowSortKey: [null, null], rowData: { left: "B", right: null } },
    ]);

    snapshot = await set(snapshot, "right", "r3", { key: "b", label: "R3" });
    snapshot = await set(snapshot, "right", "r3", undefined);
    expect(await rows(snapshot, "join")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["l1", null]), rowSortKey: [null, null], rowData: { left: "B", right: null } },
    ]);
  });

  it("left folds rows in sort order and recomputes touched suffixes", async () => {
    const captured: any[] = [];
    const spyTable = {
      init: () => ({ serializedTable: null }),
      async * listGroups() {},
      async * listRowsInGroup() {},
      async emitInputChanges({ serializedTable, changes }: { serializedTable: PiledriverObject, changes: unknown }) {
        captured.push(structuredClone(changes));
        return { newSerializedTable: serializedTable, outputChanges: { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] } };
      },
      compareGroupKeys: () => 0,
      compareSortKeys: () => 0,
    };
    const reducerCalls: string[] = [];
    const fold = declareLeftFoldTable({
      initialState: 0,
      reducer: async (state, row) => {
        reducerCalls.push(row.rowIdentifier);
        const sum = Number(state) + Number(row.rowData);
        return { newState: sum, newRowData: sum };
      },
    });
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "sorted", table: defineSortTable({ sortKeyExtractor: row => Number(row.rowData), sortKeyComparator: (a, b) => Number(a) - Number(b) }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "fold", table: fold, inputTables: { input: "sorted" } },
      { type: "initTable", tableId: "spy", table: spyTable, inputTables: { input: "fold" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 1);
    snapshot = await set(snapshot, "store", "b", 2);
    snapshot = await set(snapshot, "store", "c", 3);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "fold", groupKey: null, range: {} }))).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: 1, rowData: 1 },
      { groupKey: null, rowIdentifier: "b", rowSortKey: 2, rowData: 3 },
      { groupKey: null, rowIdentifier: "c", rowSortKey: 3, rowData: 6 },
    ]);

    captured.length = 0;
    reducerCalls.length = 0;
    snapshot = await set(snapshot, "store", "c", 4);
    expect(reducerCalls).toEqual(["c"]);
    expect(captured[0].input.modifiedRows).toEqual([
      { groupKey: null, rowIdentifier: "c", oldRowSortKey: 3, newRowSortKey: 4, oldRowData: 6, newRowData: 7 },
    ]);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "fold", groupKey: null, range: {} }))).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: 1, rowData: 1 },
      { groupKey: null, rowIdentifier: "b", rowSortKey: 2, rowData: 3 },
      { groupKey: null, rowIdentifier: "c", rowSortKey: 4, rowData: 7 },
    ]);

    captured.length = 0;
    reducerCalls.length = 0;
    snapshot = await set(snapshot, "store", "a", 10);
    expect(reducerCalls).toEqual(["b", "c", "a"]);
    expect(captured[0].input.modifiedRows).toEqual([
      { groupKey: null, rowIdentifier: "a", oldRowSortKey: 1, newRowSortKey: 10, oldRowData: 1, newRowData: 16 },
      { groupKey: null, rowIdentifier: "b", oldRowSortKey: 2, newRowSortKey: 2, oldRowData: 3, newRowData: 2 },
      { groupKey: null, rowIdentifier: "c", oldRowSortKey: 4, newRowSortKey: 4, oldRowData: 7, newRowData: 6 },
    ]);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "fold", groupKey: null, range: {} }))).toEqual([
      { groupKey: null, rowIdentifier: "b", rowSortKey: 2, rowData: 2 },
      { groupKey: null, rowIdentifier: "c", rowSortKey: 4, rowData: 6 },
      { groupKey: null, rowIdentifier: "a", rowSortKey: 10, rowData: 16 },
    ]);
  });

  it("time folds rows and appends due repeated outputs", async () => {
    const firstTrigger = Date.UTC(2026, 0, 1, 0, 0, 1);
    const secondTrigger = Date.UTC(2026, 0, 1, 0, 0, 2);
    const reducerCalls: Array<{ rowIdentifier: string, trigger: number | null, state: PiledriverObject }> = [];
    const fold = declareTimeFoldTable({
      initialState: 0,
      reducer: async (state, row, trigger) => {
        reducerCalls.push({ rowIdentifier: row.rowIdentifier, trigger: trigger?.getTime() ?? null, state });
        const count = Number(state) + 1;
        return {
          newState: count,
          newRowData: `${row.rowData}:${trigger ? count : "initial"}`,
          nextTriggerTime: count < 3 ? new Date(trigger ? secondTrigger : firstTrigger) : null,
        };
      },
    });
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "time", table: fold, inputTables: { input: "store" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", "A");
    expect(await rows(snapshot, "time")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: null, rowData: "A:initial" },
    ]);
    expect(reducerCalls).toEqual([{ rowIdentifier: "a", trigger: null, state: 0 }]);

    snapshot = (await snapshot.tick(new Date(firstTrigger))).newSnapshot;
    expect(await rows(snapshot, "time")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: null, rowData: "A:initial" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 1]), rowSortKey: null, rowData: "A:2" },
    ]);

    snapshot = (await snapshot.tick(new Date(secondTrigger))).newSnapshot;
    expect(await rows(snapshot, "time")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: null, rowData: "A:initial" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 1]), rowSortKey: null, rowData: "A:2" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 2]), rowSortKey: null, rowData: "A:3" },
    ]);

    snapshot = await set(snapshot, "store", "a", "B");
    expect(await rows(snapshot, "time")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: null, rowData: "B:initial" },
    ]);

    snapshot = await set(snapshot, "store", "a", undefined);
    expect(await rows(snapshot, "time")).toEqual([]);
  });

  it("keeps emitted outputs and fold state across source updates with onSourceRowChanged", async () => {
    const firstTrigger = Date.UTC(2026, 0, 1, 0, 0, 1);
    const secondTrigger = Date.UTC(2026, 0, 1, 0, 0, 2);
    const changedCalls: Array<{ state: PiledriverObject, rowData: PiledriverObject, oldRowData: PiledriverObject, previousTrigger: number | null }> = [];
    const fold = declareTimeFoldTable({
      initialState: 0,
      reducer: async (state, row, trigger) => {
        const count = Number(state) + 1;
        return {
          newState: count,
          newRowData: `${row.rowData}:${trigger ? count : "initial"}`,
          nextTriggerTime: trigger ? null : new Date(firstTrigger),
        };
      },
      onSourceRowChanged: async (state, row, previous) => {
        changedCalls.push({ state, rowData: row.rowData, oldRowData: previous.rowData, previousTrigger: previous.nextTriggerTime?.getTime() ?? null });
        if (row.rowData === "C") {
          return { newState: Number(state) + 1000, nextTriggerTime: null, appendRowData: `${row.rowData}:changed` };
        }
        return { newState: Number(state) + 100, nextTriggerTime: new Date(secondTrigger) };
      },
    });
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "time", table: fold, inputTables: { input: "store" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", "A");
    snapshot = (await snapshot.tick(new Date(firstTrigger))).newSnapshot;
    expect(await rows(snapshot, "time")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: null, rowData: "A:initial" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 1]), rowSortKey: null, rowData: "A:2" },
    ]);

    // The update keeps all previously emitted outputs verbatim (no deletions, no re-derivation)
    // and hands the fold state + old row to the hook instead of re-running from initialState.
    snapshot = await set(snapshot, "store", "a", "B");
    expect(await rows(snapshot, "time")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: null, rowData: "A:initial" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 1]), rowSortKey: null, rowData: "A:2" },
    ]);
    expect(changedCalls).toEqual([{ state: 2, rowData: "B", oldRowData: "A", previousTrigger: null }]);

    // The hook's returned state and trigger drive subsequent timed steps: the next tick appends
    // (using the carried-over state) instead of replaying history.
    snapshot = (await snapshot.tick(new Date(secondTrigger))).newSnapshot;
    expect(await rows(snapshot, "time")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: null, rowData: "A:initial" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 1]), rowSortKey: null, rowData: "A:2" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 2]), rowSortKey: null, rowData: "B:103" },
    ]);

    // The hook can append one output row synchronously in the same write (appendRowData),
    // while everything previously emitted still survives verbatim.
    snapshot = await set(snapshot, "store", "a", "C");
    expect(await rows(snapshot, "time")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: null, rowData: "A:initial" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 1]), rowSortKey: null, rowData: "A:2" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 2]), rowSortKey: null, rowData: "B:103" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 3]), rowSortKey: null, rowData: "C:changed" },
    ]);
    expect(changedCalls).toEqual([
      { state: 2, rowData: "B", oldRowData: "A", previousTrigger: null },
      { state: 103, rowData: "C", oldRowData: "B", previousTrigger: null },
    ]);

    // Deleting the source row still removes everything.
    snapshot = await set(snapshot, "store", "a", undefined);
    expect(await rows(snapshot, "time")).toEqual([]);
  });

  it("ticks all tickable tables from the snapshot object", async () => {
    const trigger = Date.UTC(2026, 0, 1, 0, 0, 1);
    const db = newDb(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "time", table: declareTimeFoldTable({
        initialState: 0,
        reducer: async (state, row, triggerTime) => ({
          newState: Number(state) + 1,
          newRowData: triggerTime ? "tick" : "initial",
          nextTriggerTime: triggerTime ? null : new Date(trigger),
        }),
      }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "time2", table: declareTimeFoldTable({
        initialState: 0,
        reducer: async (state, row, triggerTime) => ({
          newState: Number(state) + 1,
          newRowData: triggerTime ? "tick2" : "initial2",
          nextTriggerTime: triggerTime ? null : new Date(trigger),
        }),
      }), inputTables: { input: "store" } },
    ]]);
    await db.applyRemainingMigrations();
    await db.withSnapshotConsistent(async snapshot => await set(snapshot, "store", "a", "A"));

    const { snapshot } = await db.withSnapshotConsistent(async snapshot => await snapshot.tick(new Date(trigger)));
    expect(await rows(snapshot, "time")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: null, rowData: "initial" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 1]), rowSortKey: null, rowData: "tick" },
    ]);
    expect(await rows(snapshot, "time2")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: null, rowData: "initial2" },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 1]), rowSortKey: null, rowData: "tick2" },
    ]);
  });

  it("groups rows by a derived key and moves rows between groups", async () => {
    const groupByParity = declareGroupByTable({
      groupKeyExtractor: async row => Number(row.rowData) % 2 === 0 ? "even" : "odd",
      groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
    });
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "grouped", table: groupByParity, inputTables: { input: "store" } },
      { type: "initTable", tableId: "groupedMaterialized", table: defineMaterializeTable(), inputTables: { input: "grouped" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 1);
    snapshot = await set(snapshot, "store", "b", 2);
    expect(await collect(snapshot.listGroups({ tableId: "grouped", range: {} }))).toEqual([
      { groupKey: "even" },
      { groupKey: "odd" },
    ]);
    await expect(collect(snapshot.listRowsInGroup({ tableId: "grouped", groupKey: "odd", range: {} }))).rejects.toThrow("does not support listing rows");
    expect(await rows(snapshot, "groupedMaterialized", {}, "odd")).toEqual([
      { groupKey: "odd", rowIdentifier: "a", rowSortKey: null, rowData: 1 },
    ]);
    expect(await rows(snapshot, "groupedMaterialized", {}, "even")).toEqual([
      { groupKey: "even", rowIdentifier: "b", rowSortKey: null, rowData: 2 },
    ]);

    snapshot = await set(snapshot, "store", "a", 4);
    expect(await collect(snapshot.listGroups({ tableId: "grouped", range: {} }))).toEqual([
      { groupKey: "even" },
    ]);
    expect(await rows(snapshot, "groupedMaterialized", {}, "even")).toEqual([
      { groupKey: "even", rowIdentifier: "a", rowSortKey: null, rowData: 4 },
      { groupKey: "even", rowIdentifier: "b", rowSortKey: null, rowData: 2 },
    ]);

    snapshot = await set(snapshot, "store", "b", undefined);
    snapshot = await set(snapshot, "store", "a", undefined);
    expect(await collect(snapshot.listGroups({ tableId: "grouped", range: {} }))).toEqual([]);
  });

  it("reduces incrementally and suppresses unchanged aggregate outputs", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "reduce", table: defineReduceTable({
        valueExtractor: async row => Number(row.rowData),
        valueReducer: async (...values) => values.reduce((sum, value) => Number(sum) + Number(value), 0),
      }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "downstream", table: defineMaterializeTable(), inputTables: { input: "reduce" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 1);
    snapshot = await set(snapshot, "store", "b", 2);
    expect(await rows(snapshot, "reduce")).toEqual([
      { groupKey: null, rowIdentifier: expect.any(String), rowSortKey: null, rowData: 3 },
    ]);
    expect(await rows(snapshot, "downstream")).toEqual([
      { groupKey: null, rowIdentifier: expect.any(String), rowSortKey: null, rowData: 3 },
    ]);

    snapshot = await set(snapshot, "store", "a", 0);
    snapshot = await set(snapshot, "store", "b", 3);
    expect(await rows(snapshot, "downstream")).toEqual([
      { groupKey: null, rowIdentifier: expect.any(String), rowSortKey: null, rowData: 3 },
    ]);
  });

  it("does not propagate reduce changes when the aggregate is unchanged", async () => {
    const downstreamChanges: unknown[] = [];
    const spyTable = {
      init: () => ({ serializedTable: null }),
      async * listGroups() {},
      async * listRowsInGroup() {},
      async emitInputChanges({ serializedTable, changes }: { serializedTable: PiledriverObject, changes: unknown }) {
        downstreamChanges.push(changes);
        return { newSerializedTable: serializedTable, outputChanges: { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] } };
      },
      compareGroupKeys: () => 0,
      compareSortKeys: () => 0,
    };
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "reduce", table: defineReduceTable({
        valueExtractor: async row => Number(row.rowData) % 2 === 0,
        valueReducer: async (...values) => values.some(Boolean),
      }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "spy", table: spyTable, inputTables: { input: "reduce" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 2);
    downstreamChanges.length = 0;
    snapshot = await set(snapshot, "store", "a", 4);

    expect(await rows(snapshot, "reduce")).toEqual([
      { groupKey: null, rowIdentifier: expect.any(String), rowSortKey: null, rowData: true },
    ]);
    expect(downstreamChanges).toEqual([]);
  });

  it("transduces to stable ConcatTreeList entries and propagates diffs", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "transduce", table: defineTransduceTable({
        valueExtractor: async row => ConcatTreeList.fromEntries([[`${row.rowIdentifier}:base`, row.rowData], [`${row.rowIdentifier}:plus`, Number(row.rowData) + 10]]),
        valueReducer: async (...lists) => ConcatTreeList.concat(lists),
      }), inputTables: { input: "store" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 1);
    snapshot = await set(snapshot, "store", "b", 2);
    expect(await rows(snapshot, "transduce")).toEqual([
      { groupKey: null, rowIdentifier: "a:base", rowSortKey: null, rowData: 1 },
      { groupKey: null, rowIdentifier: "a:plus", rowSortKey: null, rowData: 11 },
      { groupKey: null, rowIdentifier: "b:base", rowSortKey: null, rowData: 2 },
      { groupKey: null, rowIdentifier: "b:plus", rowSortKey: null, rowData: 12 },
    ]);

    snapshot = await set(snapshot, "store", "a", 3);
    expect(await rows(snapshot, "transduce")).toEqual([
      { groupKey: null, rowIdentifier: "a:base", rowSortKey: null, rowData: 3 },
      { groupKey: null, rowIdentifier: "a:plus", rowSortKey: null, rowData: 13 },
      { groupKey: null, rowIdentifier: "b:base", rowSortKey: null, rowData: 2 },
      { groupKey: null, rowIdentifier: "b:plus", rowSortKey: null, rowData: 12 },
    ]);
  });

  it("supports async reduce and transduce extractors and reducers", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "reduce", table: defineReduceTable({
        valueExtractor: async row => Number(row.rowData),
        valueReducer: async (...values) => values.reduce((sum, value) => Number(sum) + Number(value), 0),
      }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "transduce", table: defineTransduceTable({
        valueExtractor: async row => ConcatTreeList.fromEntries([[`async:${row.rowIdentifier}`, row.rowData]]),
        valueReducer: async (...lists) => ConcatTreeList.concat(lists),
      }), inputTables: { input: "store" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 2);
    snapshot = await set(snapshot, "store", "b", 5);

    expect(await rows(snapshot, "reduce")).toEqual([
      { groupKey: null, rowIdentifier: expect.any(String), rowSortKey: null, rowData: 7 },
    ]);
    expect(await rows(snapshot, "transduce")).toEqual([
      { groupKey: null, rowIdentifier: "async:a", rowSortKey: null, rowData: 2 },
      { groupKey: null, rowIdentifier: "async:b", rowSortKey: null, rowData: 5 },
    ]);
  });

  it("applies row ranges, limits, and reverse consistently across table helpers", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "mapped", table: defineMapTable(row => Number(row.rowData) * 10), inputTables: { input: "store" } },
      { type: "initTable", tableId: "flat", table: defineFlatMapTable(row => [row.rowData, Number(row.rowData) + 100]), inputTables: { input: "store" } },
      { type: "initTable", tableId: "sorted", table: defineSortTable({ sortKeyExtractor: row => Number(row.rowData), sortKeyComparator: (a, b) => Number(a) - Number(b) }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "sortedMaterialized", table: defineMaterializeTable(), inputTables: { input: "sorted" } },
      { type: "initTable", tableId: "concat", table: defineConcatTable(), inputTables: { a: "sorted", b: "flat" } },
      { type: "initTable", tableId: "concatMaterialized", table: defineMaterializeTable(), inputTables: { input: "concat" } },
    ]]);
    await expect(collect(snapshot.listRowsInGroup({ tableId: "sorted", groupKey: null, range: {} }))).rejects.toThrow("does not support listing rows");
    snapshot = await set(snapshot, "store", "a", 1);
    snapshot = await set(snapshot, "store", "b", 2);
    snapshot = await set(snapshot, "store", "c", 3);

    expect(await collect(snapshot.listRowsInGroup({ tableId: "store", groupKey: null, range: { limit: 1 } }))).toHaveLength(1);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "mapped", groupKey: null, range: { limit: 2 } }))).toHaveLength(2);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "flat", groupKey: null, range: { limit: 3 } }))).toHaveLength(3);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "flat", groupKey: null, range: { reverse: true, limit: 2 } }))).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["c", 1]), rowSortKey: [null, 1], rowData: 103 },
      { groupKey: null, rowIdentifier: JSON.stringify(["c", 0]), rowSortKey: [null, 0], rowData: 3 },
    ]);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "sortedMaterialized", groupKey: null, range: { gte: 2, reverse: true } }))).toEqual([
      { groupKey: null, rowIdentifier: "c", rowSortKey: 3, rowData: 3 },
      { groupKey: null, rowIdentifier: "b", rowSortKey: 2, rowData: 2 },
    ]);
    // Reading concat directly still works here even though its input `a` (sorted) rejects row
    // listing: with `reverse`, concat drains input `b` first and reaches the limit before ever
    // touching `a`. Note the intentional asymmetry with the materialized copy below: lazy operators
    // stream outputs in input-major order, which only coincides with global sort-key order when sort
    // keys are distinct. All store rows share the sort key `null`, so flatMap's outputs tie on their
    // input-key component and the lazy read yields each input row's elements together ([103, 3])
    // instead of the true top-2 by sort key ([103, 102]) that the materialized table returns.
    expect(await collect(snapshot.listRowsInGroup({ tableId: "concat", groupKey: null, range: { reverse: true, limit: 2 } }))).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["b", JSON.stringify(["c", 1])]), rowSortKey: [1, [null, 1]], rowData: 103 },
      { groupKey: null, rowIdentifier: JSON.stringify(["b", JSON.stringify(["c", 0])]), rowSortKey: [1, [null, 0]], rowData: 3 },
    ]);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "concatMaterialized", groupKey: null, range: { reverse: true, limit: 2 } }))).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["b", JSON.stringify(["c", 1])]), rowSortKey: [1, [null, 1]], rowData: 103 },
      { groupKey: null, rowIdentifier: JSON.stringify(["b", JSON.stringify(["b", 1])]), rowSortKey: [1, [null, 1]], rowData: 102 },
    ]);
  });

  it("keeps null sort-key range semantics on stored tables", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
    ]]);
    snapshot = await set(snapshot, "store", "txn-a", { txnId: "txn-a" });
    snapshot = await set(snapshot, "store", "txn-b", { txnId: "txn-b" });

    // Inclusive null bounds (flatMap/identity pushdown of [null, i]) still list rows.
    expect((await collect(snapshot.listRowsInGroup({
      tableId: "store",
      groupKey: null,
      range: { gte: null, lte: null },
    }))).map((row) => row.rowIdentifier)).toEqual(["txn-a", "txn-b"]);

    // Exclusive gt on the null sort key cannot match any row.
    expect(await collect(snapshot.listRowsInGroup({
      tableId: "store",
      groupKey: null,
      range: { gt: null },
    }))).toEqual([]);
  });

  it("pages identifier-ordered rows via a materialized sort table over a stored table", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "sorted", table: defineSortTable({
        sortKeyExtractor: (row) => row.rowIdentifier,
        sortKeyComparator: (a, b) => stringCompare(String(a), String(b)),
      }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "sortedMaterialized", table: defineMaterializeTable(), inputTables: { input: "sorted" } },
    ]]);
    snapshot = await set(snapshot, "store", "txn-a", { txnId: "txn-a" });
    snapshot = await set(snapshot, "store", "txn-b", { txnId: "txn-b" });
    snapshot = await set(snapshot, "store", "txn-c", { txnId: "txn-c" });

    const page1 = await collect(snapshot.listRowsInGroup({
      tableId: "sortedMaterialized",
      groupKey: null,
      range: { limit: 2 },
    }));
    expect(page1.map((row) => row.rowIdentifier)).toEqual(["txn-a", "txn-b"]);
    expect(page1.map((row) => row.rowSortKey)).toEqual(["txn-a", "txn-b"]);

    const page2 = await collect(snapshot.listRowsInGroup({
      tableId: "sortedMaterialized",
      groupKey: null,
      range: { gt: "txn-b", limit: 2 },
    }));
    expect(page2.map((row) => row.rowIdentifier)).toEqual(["txn-c"]);
  });

  it("does not eagerly evaluate rows beyond requested limits", async () => {
    let mapCalls = 0;
    let flatMapCalls = 0;
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "mapped", table: defineMapTable(row => {
        mapCalls++;
        return row.rowData;
      }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "flat", table: defineFlatMapTable(row => {
        flatMapCalls++;
        return [row.rowData, Number(row.rowData) + 10];
      }), inputTables: { input: "store" } },
    ]]);
    snapshot = await set(snapshot, "store", "a", 1);
    snapshot = await set(snapshot, "store", "b", 2);
    snapshot = await set(snapshot, "store", "c", 3);

    mapCalls = 0;
    flatMapCalls = 0;
    expect(await collect(snapshot.listRowsInGroup({ tableId: "mapped", groupKey: null, range: { limit: 1 } }))).toHaveLength(1);
    expect(mapCalls).toBe(1);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "flat", groupKey: null, range: { limit: 1 } }))).toHaveLength(1);
    expect(flatMapCalls).toBe(1);
  });

  it("does not read later concat inputs after satisfying a limit", async () => {
    let rightWasRead = false;
    const source = (value: string) => ({
      init: () => ({ serializedTable: null }),
      async * listGroups() {
        yield { groupKey: null };
      },
      async * listRowsInGroup() {
        yield { groupKey: null, rowIdentifier: value, rowSortKey: null, rowData: value };
      },
      async emitInputChanges({ serializedTable }: { serializedTable: PiledriverObject }) {
        return { newSerializedTable: serializedTable, outputChanges: { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] } };
      },
      compareGroupKeys: () => 0,
      compareSortKeys: () => 0,
    });
    const right = source("right");
    right.listRowsInGroup = async function* () {
      rightWasRead = true;
      yield { groupKey: null, rowIdentifier: "right", rowSortKey: null, rowData: "right" };
    };
    const snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "left", table: source("left"), inputTables: {} },
      { type: "initTable", tableId: "right", table: right, inputTables: {} },
      { type: "initTable", tableId: "concat", table: defineConcatTable(), inputTables: { a: "left", b: "right" } },
    ]]);
    // the migration backfill legitimately scans all inputs once; laziness is about reads after that
    rightWasRead = false;

    expect(await collect(snapshot.listRowsInGroup({ tableId: "concat", groupKey: null, range: { limit: 1 } }))).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", "left"]), rowSortKey: [0, null], rowData: "left" },
    ]);
    expect(rightWasRead).toBe(false);
  });

  it("applies later migrations and table deletions", async () => {
    const db = newDb(backend, [
      [{ type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} }],
      [{ type: "initTable", tableId: "mapped", table: defineMapTable(row => row.rowData), inputTables: { input: "store" } }],
      [{ type: "deleteTable", tableId: "mapped" }],
    ]);

    await db.applyRemainingMigrations();
    const snapshot = (await db.getSnapshot()).snapshot;

    expect(() => snapshot.listRowsInGroup({ tableId: "mapped", groupKey: null, range: {} })).toThrow();
  });

  it("propagates group creations and deletions even when only groups change", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "evens", table: defineFilterTable(row => Number(row.rowData) % 2 === 0), inputTables: { input: "store" } },
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "evens" } },
    ]]);

    // the first row is odd, so the filter emits a group creation without any rows
    snapshot = await set(snapshot, "store", "a", 1);
    snapshot = await set(snapshot, "store", "b", 2);
    expect(await rows(snapshot, "mat")).toEqual([
      { groupKey: null, rowIdentifier: "b", rowSortKey: null, rowData: 2 },
    ]);

    // deleting the remaining odd row emits a group deletion without any rows
    snapshot = await set(snapshot, "store", "b", undefined);
    snapshot = await set(snapshot, "store", "a", undefined);
    expect(await collect(snapshot.listGroups({ tableId: "mat", range: {} }))).toEqual([]);
  });

  it("propagates group changes through map tables", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "mapped", table: defineMapTable(row => Number(row.rowData) * 10), inputTables: { input: "store" } },
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "mapped" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 1);
    expect(await rows(snapshot, "mat")).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: null, rowData: 10 },
    ]);

    snapshot = await set(snapshot, "store", "a", undefined);
    expect(await collect(snapshot.listGroups({ tableId: "mat", range: {} }))).toEqual([]);
  });

  it("emits unwrapped group keys and aggregate row lifecycle events from reduce", async () => {
    const captured: any[] = [];
    const spyTable = {
      init: () => ({ serializedTable: null }),
      async * listGroups() {},
      async * listRowsInGroup() {},
      async emitInputChanges({ serializedTable, changes }: { serializedTable: PiledriverObject, changes: unknown }) {
        captured.push(structuredClone(changes));
        return { newSerializedTable: serializedTable, outputChanges: { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] } };
      },
      compareGroupKeys: () => 0,
      compareSortKeys: () => 0,
    };
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "reduce", table: defineReduceTable({
        valueExtractor: async row => Number(row.rowData),
        valueReducer: async (...values) => values.reduce((sum, value) => Number(sum) + Number(value), 0),
      }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "spy", table: spyTable, inputTables: { input: "reduce" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 1);
    expect(captured).toEqual([{
      input: {
        addedRows: [{ groupKey: null, rowIdentifier: expect.any(String), rowSortKey: null, rowData: 0 }],
        modifiedRows: [{ groupKey: null, rowIdentifier: expect.any(String), oldRowSortKey: null, newRowSortKey: null, oldRowData: 0, newRowData: 1 }],
        deletedRows: [],
        addedGroups: [{ groupKey: null }],
        deletedGroups: [],
      },
    }]);
    expect(captured[0].input.addedRows[0].rowIdentifier).toBe(captured[0].input.modifiedRows[0].rowIdentifier);

    captured.length = 0;
    snapshot = await set(snapshot, "store", "a", undefined);
    expect(captured).toEqual([{
      input: {
        addedRows: [],
        modifiedRows: [{ groupKey: null, rowIdentifier: expect.any(String), oldRowSortKey: null, newRowSortKey: null, oldRowData: 1, newRowData: 0 }],
        deletedRows: [{ groupKey: null, rowIdentifier: expect.any(String), oldRowSortKey: null, oldRowData: 0 }],
        addedGroups: [],
        deletedGroups: [{ groupKey: null }],
      },
    }]);
  });

  it("applies flatMap modifications to downstream materialized tables", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "flat", table: defineFlatMapTable(row => [row.rowData, Number(row.rowData) + 10]), inputTables: { input: "store" } },
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "flat" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 1);
    snapshot = await set(snapshot, "store", "a", 2);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "mat", groupKey: null, range: {} }))).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: [null, 0], rowData: 2 },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 1]), rowSortKey: [null, 1], rowData: 12 },
    ]);

    snapshot = await set(snapshot, "store", "a", undefined);
    expect(await collect(snapshot.listGroups({ tableId: "mat", range: {} }))).toEqual([]);
  });

  it("propagates transduce value changes when entry ids are reused", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "transduce", table: defineTransduceTable({
        valueExtractor: async row => ConcatTreeList.fromEntries([[row.rowIdentifier, row.rowData]]),
        valueReducer: async (...lists) => ConcatTreeList.concat(lists),
      }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "transduce" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 1);
    expect(await rows(snapshot, "mat")).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: null, rowData: 1 },
    ]);

    snapshot = await set(snapshot, "store", "a", 3);
    expect(await rows(snapshot, "mat")).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: null, rowData: 3 },
    ]);
  });

  it("lists transduce rows in reverse", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "transduce", table: defineTransduceTable({
        valueExtractor: async row => ConcatTreeList.fromEntries([[row.rowIdentifier, row.rowData]]),
        valueReducer: async (...lists) => ConcatTreeList.concat(lists),
      }), inputTables: { input: "store" } },
    ]]);
    snapshot = await set(snapshot, "store", "a", 1);
    snapshot = await set(snapshot, "store", "b", 2);

    expect(await collect(snapshot.listRowsInGroup({ tableId: "transduce", groupKey: null, range: { reverse: true } }))).toEqual([
      { groupKey: null, rowIdentifier: "b", rowSortKey: null, rowData: 2 },
      { groupKey: null, rowIdentifier: "a", rowSortKey: null, rowData: 1 },
    ]);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "transduce", groupKey: null, range: { reverse: true, limit: 1 } }))).toEqual([
      { groupKey: null, rowIdentifier: "b", rowSortKey: null, rowData: 2 },
    ]);
  });

  it("returns nothing for limit 0 ranges", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "filtered", table: defineFilterTable(() => true), inputTables: { input: "store" } },
      { type: "initTable", tableId: "flat", table: defineFlatMapTable(row => [row.rowData]), inputTables: { input: "store" } },
      { type: "initTable", tableId: "concat", table: defineConcatTable(), inputTables: { a: "store" } },
    ]]);
    snapshot = await set(snapshot, "store", "a", 1);

    expect(await collect(snapshot.listRowsInGroup({ tableId: "filtered", groupKey: null, range: { limit: 0 } }))).toEqual([]);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "flat", groupKey: null, range: { limit: 0 } }))).toEqual([]);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "concat", groupKey: null, range: { limit: 0 } }))).toEqual([]);
    expect(await collect(snapshot.listGroups({ tableId: "concat", range: { limit: 0 } }))).toEqual([]);
  });

  it("rejects snapshots whose completed migrations do not match the schema", async () => {
    const piledriver = declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(crypto.randomUUID()));
    const migrations = [[{ type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} }]] satisfies Parameters<typeof declareBulldozerDatabase>[1]["migrations"];

    const behind = declareBulldozerDatabase(piledriver, { migrations: [] });
    await behind.applyRemainingMigrations();

    const ahead = declareBulldozerDatabase(piledriver, { migrations });
    await expect(ahead.getSnapshot()).rejects.toThrow(/applyRemainingMigrations/);

    await ahead.applyRemainingMigrations();
    await expect(ahead.getSnapshot()).resolves.toMatchObject({ snapshot: expect.anything() });
    await expect(behind.getSnapshot()).rejects.toThrow(/more completed migrations/);
  });

  it("backfills stateful tables added by later migrations from existing input data", async () => {
    const piledriver = declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(crypto.randomUUID()));
    const migration1 = [{ type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} }] satisfies Parameters<typeof declareBulldozerDatabase>[1]["migrations"][number];

    const dbV1 = declareBulldozerDatabase(piledriver, { migrations: [migration1] });
    await dbV1.applyRemainingMigrations();
    await dbV1.withSnapshotConsistent(async snapshot => {
      snapshot = await set(snapshot, "store", "a", 1);
      snapshot = await set(snapshot, "store", "b", 2);
      return snapshot;
    });

    const dbV2 = declareBulldozerDatabase(piledriver, { migrations: [migration1, [
      { type: "initTable", tableId: "sorted", table: defineSortTable({ sortKeyExtractor: row => Number(row.rowData), sortKeyComparator: (a, b) => Number(a) - Number(b) }), inputTables: { input: "store" } },
      // also backfills a table that depends on another table created in the same migration
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "sorted" } },
      { type: "initTable", tableId: "reduce", table: defineReduceTable({
        valueExtractor: async row => Number(row.rowData),
        valueReducer: async (...values) => values.reduce((sum, value) => Number(sum) + Number(value), 0),
      }), inputTables: { input: "store" } },
    ]] });
    await dbV2.applyRemainingMigrations();
    let snapshot2 = (await dbV2.getSnapshot()).snapshot;

    expect(await collect(snapshot2.listRowsInGroup({ tableId: "mat", groupKey: null, range: {} }))).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: 1, rowData: 1 },
      { groupKey: null, rowIdentifier: "b", rowSortKey: 2, rowData: 2 },
    ]);
    expect(await rows(snapshot2, "reduce")).toEqual([
      { groupKey: null, rowIdentifier: expect.any(String), rowSortKey: null, rowData: 3 },
    ]);

    // subsequent writes propagate into the backfilled tables
    snapshot2 = await set(snapshot2, "store", "c", 3);
    expect(await collect(snapshot2.listRowsInGroup({ tableId: "mat", groupKey: null, range: {} }))).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: 1, rowData: 1 },
      { groupKey: null, rowIdentifier: "b", rowSortKey: 2, rowData: 2 },
      { groupKey: null, rowIdentifier: "c", rowSortKey: 3, rowData: 3 },
    ]);
    expect(await rows(snapshot2, "reduce")).toEqual([
      { groupKey: null, rowIdentifier: expect.any(String), rowSortKey: null, rowData: 6 },
    ]);
  });

  it("treats concat groups as the union of its inputs' groups", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "left", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "right", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "concat", table: defineConcatTable(), inputTables: { a: "left", b: "right" } },
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "concat" } },
    ]]);

    // second input joining an existing group must not re-create it downstream
    snapshot = await set(snapshot, "left", "l", 1);
    snapshot = await set(snapshot, "right", "r", 2);
    expect(await rows(snapshot, "mat")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", "l"]), rowSortKey: [0, null], rowData: 1 },
      { groupKey: null, rowIdentifier: JSON.stringify(["b", "r"]), rowSortKey: [1, null], rowData: 2 },
    ]);

    // one input leaving the group must not delete it while the other still has rows
    snapshot = await set(snapshot, "left", "l", undefined);
    expect(await collect(snapshot.listGroups({ tableId: "mat", range: {} }))).toEqual([{ groupKey: null }]);
    expect(await rows(snapshot, "mat")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["b", "r"]), rowSortKey: [1, null], rowData: 2 },
    ]);

    // the group is deleted once the last input leaves it, and can be re-created afterwards
    snapshot = await set(snapshot, "right", "r", undefined);
    expect(await collect(snapshot.listGroups({ tableId: "mat", range: {} }))).toEqual([]);
    snapshot = await set(snapshot, "right", "r2", 3);
    expect(await rows(snapshot, "mat")).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["b", "r2"]), rowSortKey: [1, null], rowData: 3 },
    ]);
  });

  it("keeps piledriverObjectEquals-distinct groups separate even when compareGroupKeys returns 0", async () => {
    // a source where every row lives in its own group, but all group keys compare as order-equivalent
    const groupPerRowStore = () => ({
      init: () => ({ serializedTable: {} as PiledriverObject }),
      async * listGroups({ serializedTable }: { serializedTable: PiledriverObject }) {
        for (const groupKey of Object.keys(serializedTable as Record<string, PiledriverObject>)) yield { groupKey };
      },
      async * listRowsInGroup({ serializedTable, groupKey }: { serializedTable: PiledriverObject, groupKey: PiledriverObject }) {
        const record = serializedTable as Record<string, PiledriverObject>;
        if (typeof groupKey === "string" && groupKey in record) {
          yield { groupKey, rowIdentifier: groupKey, rowSortKey: null as PiledriverObject, rowData: record[groupKey] };
        }
      },
      async setOrDeleteRow({ serializedTable, rowIdentifier, newRowData }: { serializedTable: PiledriverObject, rowIdentifier: string, newRowData: PiledriverObject | undefined }) {
        const record = { ...serializedTable as Record<string, PiledriverObject> };
        const outputChanges = { addedRows: [] as any[], modifiedRows: [] as any[], deletedRows: [] as any[], addedGroups: [] as any[], deletedGroups: [] as any[] };
        if (newRowData === undefined) {
          if (rowIdentifier in record) {
            outputChanges.deletedRows.push({ groupKey: rowIdentifier, rowIdentifier, oldRowSortKey: null, oldRowData: record[rowIdentifier] });
            outputChanges.deletedGroups.push({ groupKey: rowIdentifier });
            delete record[rowIdentifier];
          }
        } else if (rowIdentifier in record) {
          outputChanges.modifiedRows.push({ groupKey: rowIdentifier, rowIdentifier, oldRowSortKey: null, newRowSortKey: null, oldRowData: record[rowIdentifier], newRowData });
          record[rowIdentifier] = newRowData;
        } else {
          outputChanges.addedGroups.push({ groupKey: rowIdentifier });
          outputChanges.addedRows.push({ groupKey: rowIdentifier, rowIdentifier, rowSortKey: null, rowData: newRowData });
          record[rowIdentifier] = newRowData;
        }
        return { newSerializedTable: record as PiledriverObject, outputChanges };
      },
      async emitInputChanges(): Promise<never> {
        throw new Error("Called emitInputChanges on table without inputs");
      },
      compareGroupKeys: () => 0,
      compareSortKeys: () => 0,
    });
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "source", table: groupPerRowStore(), inputTables: {} },
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "source" } },
    ]]);

    snapshot = await set(snapshot, "source", "g1", 1);
    snapshot = await set(snapshot, "source", "g2", 2);

    expect(await collect(snapshot.listGroups({ tableId: "mat", range: {} }))).toHaveLength(2);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "mat", groupKey: "g1", range: {} }))).toEqual([
      { groupKey: "g1", rowIdentifier: "g1", rowSortKey: null, rowData: 1 },
    ]);
    expect(await collect(snapshot.listRowsInGroup({ tableId: "mat", groupKey: "g2", range: {} }))).toEqual([
      { groupKey: "g2", rowIdentifier: "g2", rowSortKey: null, rowData: 2 },
    ]);

    snapshot = await set(snapshot, "source", "g1", undefined);
    expect(await collect(snapshot.listGroups({ tableId: "mat", range: {} }))).toEqual([{ groupKey: "g2" }]);
  });

  it("supports creating and deleting a table within the same migration", async () => {
    const db = newDb(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "temp", table: defineMapTable(row => row.rowData), inputTables: { input: "store" } },
      { type: "deleteTable", tableId: "temp" },
    ]]);
    await db.applyRemainingMigrations();
    const snapshot = (await db.getSnapshot()).snapshot;

    expect(() => snapshot.listRowsInGroup({ tableId: "temp", groupKey: null, range: {} })).toThrow();
    expect(await rows(snapshot, "store")).toEqual([]);
  });

  it("pushes concat row ranges down and skips inputs outside the bounds", async () => {
    let leftRowsRead = 0;
    let rightRowsRead = 0;
    const source = (values: number[], onRead: () => void) => ({
      init: () => ({ serializedTable: null }),
      async * listGroups() {
        yield { groupKey: null };
      },
      async * listRowsInGroup({ range }: { range: { gte?: PiledriverObject, lte?: PiledriverObject } }) {
        for (const value of values) {
          if (range.gte !== undefined && value < Number(range.gte)) continue;
          if (range.lte !== undefined && value > Number(range.lte)) break;
          onRead();
          yield { groupKey: null, rowIdentifier: `r${value}`, rowSortKey: value, rowData: value };
        }
      },
      async emitInputChanges({ serializedTable }: { serializedTable: PiledriverObject }) {
        return { newSerializedTable: serializedTable, outputChanges: { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] } };
      },
      compareGroupKeys: () => 0,
      compareSortKeys: ({ a, b }: { a: PiledriverObject, b: PiledriverObject }) => Number(a) - Number(b),
    });
    const snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "left", table: source([1, 2, 3], () => leftRowsRead++), inputTables: {} },
      { type: "initTable", tableId: "right", table: source([4, 5, 6], () => rightRowsRead++), inputTables: {} },
      { type: "initTable", tableId: "concat", table: defineConcatTable(), inputTables: { a: "left", b: "right" } },
    ]]);
    leftRowsRead = 0;
    rightRowsRead = 0;

    // bound entirely within input b: input a must not be read at all
    expect(await collect(snapshot.listRowsInGroup({ tableId: "concat", groupKey: null, range: { gte: [1, 5] } }))).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["b", "r5"]), rowSortKey: [1, 5], rowData: 5 },
      { groupKey: null, rowIdentifier: JSON.stringify(["b", "r6"]), rowSortKey: [1, 6], rowData: 6 },
    ]);
    expect(leftRowsRead).toBe(0);
    expect(rightRowsRead).toBe(2);

    // upper bound within input a: input b must not be read, and a's scan is bounded
    leftRowsRead = 0;
    rightRowsRead = 0;
    expect(await collect(snapshot.listRowsInGroup({ tableId: "concat", groupKey: null, range: { lte: [0, 2] } }))).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", "r1"]), rowSortKey: [0, 1], rowData: 1 },
      { groupKey: null, rowIdentifier: JSON.stringify(["a", "r2"]), rowSortKey: [0, 2], rowData: 2 },
    ]);
    expect(leftRowsRead).toBe(2);
    expect(rightRowsRead).toBe(0);

    // bounds spanning both inputs
    expect(await collect(snapshot.listRowsInGroup({ tableId: "concat", groupKey: null, range: { gt: [0, 2], lt: [1, 6] } }))).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", "r3"]), rowSortKey: [0, 3], rowData: 3 },
      { groupKey: null, rowIdentifier: JSON.stringify(["b", "r4"]), rowSortKey: [1, 4], rowData: 4 },
      { groupKey: null, rowIdentifier: JSON.stringify(["b", "r5"]), rowSortKey: [1, 5], rowData: 5 },
    ]);
  });

  it("pushes flatMap row ranges down to the input", async () => {
    let mapperCalls = 0;
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "sorted", table: defineSortTable({ sortKeyExtractor: row => Number(row.rowData), sortKeyComparator: (a, b) => Number(a) - Number(b) }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "sortedMaterialized", table: defineMaterializeTable(), inputTables: { input: "sorted" } },
      { type: "initTable", tableId: "flat", table: defineFlatMapTable(row => {
        mapperCalls++;
        return [row.rowData, Number(row.rowData) + 10];
      }), inputTables: { input: "sortedMaterialized" } },
    ]]);
    for (const value of [1, 2, 3, 4]) snapshot = await set(snapshot, "store", `r${value}`, value);

    mapperCalls = 0;
    expect(await collect(snapshot.listRowsInGroup({ tableId: "flat", groupKey: null, range: { gte: [2, 1], lt: [4, 0] } }))).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["r2", 1]), rowSortKey: [2, 1], rowData: 12 },
      { groupKey: null, rowIdentifier: JSON.stringify(["r3", 0]), rowSortKey: [3, 0], rowData: 3 },
      { groupKey: null, rowIdentifier: JSON.stringify(["r3", 1]), rowSortKey: [3, 1], rowData: 13 },
    ]);
    // only input rows 2..4 are pulled (4 is the inclusive pushdown of the lt boundary)
    expect(mapperCalls).toBe(3);

    mapperCalls = 0;
    expect(await collect(snapshot.listRowsInGroup({ tableId: "flat", groupKey: null, range: { gt: [3, 0], reverse: true } }))).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["r4", 1]), rowSortKey: [4, 1], rowData: 14 },
      { groupKey: null, rowIdentifier: JSON.stringify(["r4", 0]), rowSortKey: [4, 0], rowData: 4 },
      { groupKey: null, rowIdentifier: JSON.stringify(["r3", 1]), rowSortKey: [3, 1], rowData: 13 },
    ]);
    expect(mapperCalls).toBe(2);
  });

  it("emits flatMap modifications as element-level diffs", async () => {
    const captured: any[] = [];
    const spyTable = {
      init: () => ({ serializedTable: null }),
      async * listGroups() {},
      async * listRowsInGroup() {},
      async emitInputChanges({ serializedTable, changes }: { serializedTable: PiledriverObject, changes: unknown }) {
        captured.push(structuredClone(changes));
        return { newSerializedTable: serializedTable, outputChanges: { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] } };
      },
      compareGroupKeys: () => 0,
      compareSortKeys: () => 0,
    };
    // element 0 varies with the value, element 1 is constant, elements 2+ exist only for large values
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "flat", table: defineFlatMapTable(row => Number(row.rowData) >= 10 ? [row.rowData, "constant", "extra"] : [row.rowData, "constant"]), inputTables: { input: "store" } },
      { type: "initTable", tableId: "spy", table: spyTable, inputTables: { input: "flat" } },
    ]]);
    snapshot = await set(snapshot, "store", "a", 1);

    // unchanged element suppressed, changed element emitted as a modification
    captured.length = 0;
    snapshot = await set(snapshot, "store", "a", 2);
    expect(captured[0].input.modifiedRows).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), oldRowSortKey: [null, 0], newRowSortKey: [null, 0], oldRowData: 1, newRowData: 2 },
    ]);
    expect(captured[0].input.addedRows).toEqual([]);
    expect(captured[0].input.deletedRows).toEqual([]);

    // growing the output adds only the new elements
    captured.length = 0;
    snapshot = await set(snapshot, "store", "a", 10);
    expect(captured[0].input.modifiedRows).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 0]), oldRowSortKey: [null, 0], newRowSortKey: [null, 0], oldRowData: 2, newRowData: 10 },
    ]);
    expect(captured[0].input.addedRows).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 2]), rowSortKey: [null, 2], rowData: "extra" },
    ]);
    expect(captured[0].input.deletedRows).toEqual([]);

    // shrinking the output deletes only the removed elements
    captured.length = 0;
    snapshot = await set(snapshot, "store", "a", 3);
    expect(captured[0].input.deletedRows).toEqual([
      { groupKey: null, rowIdentifier: JSON.stringify(["a", 2]), oldRowSortKey: [null, 2], oldRowData: "extra" },
    ]);
    expect(captured[0].input.addedRows).toEqual([]);
  });

  it("normalizes same-batch group delete and re-add from groupBy before downstream consumers", async () => {
    const captured: any[] = [];
    const spyTable = {
      init: () => ({ serializedTable: null }),
      async * listGroups() {},
      async * listRowsInGroup() {},
      async emitInputChanges({ serializedTable, changes }: { serializedTable: PiledriverObject, changes: unknown }) {
        captured.push(structuredClone(changes));
        return { newSerializedTable: serializedTable, outputChanges: { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] } };
      },
      compareGroupKeys: () => 0,
      compareSortKeys: () => 0,
    };
    const parity = declareGroupByTable({
      groupKeyExtractor: async row => Number(row.rowData) % 2 === 0 ? "even" : "odd",
      groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
    });
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "flat", table: defineFlatMapTable(row => [Number(row.rowData), Number(row.rowData) + 1]), inputTables: { input: "store" } },
      { type: "initTable", tableId: "grouped", table: parity, inputTables: { input: "flat" } },
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "grouped" } },
      { type: "initTable", tableId: "spy", table: spyTable, inputTables: { input: "grouped" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 1);
    captured.length = 0;
    snapshot = await set(snapshot, "store", "a", 2);

    expect(captured[0].input.addedGroups).toEqual([]);
    expect(captured[0].input.deletedGroups).toEqual([]);
    expect(await rows(snapshot, "mat", {}, "odd")).toEqual([
      { groupKey: "odd", rowIdentifier: JSON.stringify(["a", 1]), rowSortKey: [null, 1], rowData: 3 },
    ]);
    expect(await rows(snapshot, "mat", {}, "even")).toEqual([
      { groupKey: "even", rowIdentifier: JSON.stringify(["a", 0]), rowSortKey: [null, 0], rowData: 2 },
    ]);
  });

  it("normalizes same-batch group membership handoffs from concat", async () => {
    const groupByA = declareGroupByTable({
      groupKeyExtractor: async row => Number(row.rowData) % 2 === 0 ? "even" : "odd",
      groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
    });
    const groupByB = declareGroupByTable({
      groupKeyExtractor: async row => (Number(row.rowData) + 1) % 2 === 0 ? "even" : "odd",
      groupKeyComparator: (a, b) => stringCompare(String(a), String(b)),
    });
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "ga", table: groupByA, inputTables: { input: "store" } },
      { type: "initTable", tableId: "gb", table: groupByB, inputTables: { input: "store" } },
      { type: "initTable", tableId: "concat", table: defineConcatTable(), inputTables: { x: "ga", y: "gb" } },
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "concat" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 1);
    snapshot = await set(snapshot, "store", "a", 2);

    expect(await rows(snapshot, "mat", {}, "odd")).toEqual([
      { groupKey: "odd", rowIdentifier: JSON.stringify(["y", "a"]), rowSortKey: [1, null], rowData: 2 },
    ]);
    expect(await rows(snapshot, "mat", {}, "even")).toEqual([
      { groupKey: "even", rowIdentifier: JSON.stringify(["x", "a"]), rowSortKey: [0, null], rowData: 2 },
    ]);
  });

  it("rejects table outputs that delete and add the same group in one batch", async () => {
    const invalidTable = {
      init: () => ({ serializedTable: null }),
      async * listGroups() {},
      async * listRowsInGroup() {},
      async setOrDeleteRow({ serializedTable }: { serializedTable: PiledriverObject }) {
        return {
          newSerializedTable: serializedTable,
          outputChanges: {
            addedRows: [],
            modifiedRows: [],
            deletedRows: [],
            addedGroups: [{ groupKey: { value: "same" } }],
            deletedGroups: [{ groupKey: { value: "same" } }],
          },
        };
      },
      async emitInputChanges({ serializedTable }: { serializedTable: PiledriverObject }) {
        return { newSerializedTable: serializedTable, outputChanges: { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] } };
      },
      compareGroupKeys: () => 0,
      compareSortKeys: () => 0,
    };

    const snapshot = await initializedSnapshot(backend, [[{ type: "initTable", tableId: "invalid", table: invalidTable, inputTables: {} }]]);
    await expect(set(snapshot, "invalid", "trigger", 1)).rejects.toThrow(/group .* was both deleted and added/);
  });

  it("compacts rows left-to-right with stable identifiers and output data", async () => {
    let snapshot = await initializedSnapshot(backend, [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "sorted", table: defineSortTable({ sortKeyExtractor: row => Number(row.rowData), sortKeyComparator: (a, b) => Number(a) - Number(b) }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "compact", table: defineCompactTable({
        compactor: (a, b) => [{ newRowData: Number(a) + Number(b) }],
      }), inputTables: { input: "sorted" } },
      { type: "initTable", tableId: "mat", table: defineMaterializeTable(), inputTables: { input: "compact" } },
    ]]);

    snapshot = await set(snapshot, "store", "a", 1);
    expect(await rows(snapshot, "compact")).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: null, rowData: 1 },
    ]);

    snapshot = await set(snapshot, "store", "b", 2);
    expect(await rows(snapshot, "compact")).toEqual([
      { groupKey: null, rowIdentifier: "a", rowSortKey: null, rowData: 3 },
    ]);

    const stableId = "a";
    snapshot = await set(snapshot, "store", "c", 3);
    expect(await rows(snapshot, "mat")).toEqual([
      { groupKey: null, rowIdentifier: stableId, rowSortKey: null, rowData: 6 },
    ]);

    snapshot = await set(snapshot, "store", "c", 4);
    expect(await rows(snapshot, "mat")).toEqual([
      { groupKey: null, rowIdentifier: stableId, rowSortKey: null, rowData: 7 },
    ]);
  });

  it("compacts object-keyed groups after a persistence round trip", async () => {
    const lowLevelId = crypto.randomUUID();
    const migrations: Parameters<typeof declareBulldozerDatabase>[1]["migrations"] = [[
      { type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} },
      { type: "initTable", tableId: "grouped", table: declareGroupByTable({
        groupKeyExtractor: async () => ({ team: "g" }),
        groupKeyComparator: () => 0,
      }), inputTables: { input: "store" } },
      { type: "initTable", tableId: "compact", table: defineCompactTable({
        compactor: (a, b) => [{ newRowData: Number(a) + Number(b) }],
      }), inputTables: { input: "grouped" } },
    ]];
    const db1 = declareBulldozerDatabase(declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(lowLevelId)), { migrations });
    await db1.applyRemainingMigrations();
    await db1.withSnapshotConsistent(async snapshot => {
      for (const value of [1, 2, 3]) snapshot = await set(snapshot, "store", `r${value}`, value);
      return snapshot;
    });

    const db2 = declareBulldozerDatabase(declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(lowLevelId)), { migrations });
    let snapshot = (await db2.getSnapshot()).snapshot;
    snapshot = await set(snapshot, "store", "r4", 4);

    expect(await rows(snapshot, "compact", {}, { team: "g" })).toEqual([
      { groupKey: { team: "g" }, rowIdentifier: "r1", rowSortKey: null, rowData: 10 },
    ]);
  });

  it("provides functional input tables to init during migrations", async () => {
    let observed: number | undefined;
    const probeTable = {
      init({ inputTables }: { inputTables: Record<string, { compareGroupKeys(options: { a: PiledriverObject, b: PiledriverObject }): number }> }) {
        observed = inputTables.input.compareGroupKeys({ a: null, b: null });
        return { serializedTable: null };
      },
      async * listGroups() {},
      async * listRowsInGroup() {},
      async emitInputChanges({ serializedTable }: { serializedTable: PiledriverObject }) {
        return { newSerializedTable: serializedTable, outputChanges: { addedRows: [], modifiedRows: [], deletedRows: [], addedGroups: [], deletedGroups: [] } };
      },
      compareGroupKeys: () => 0,
      compareSortKeys: () => 0,
    };
    const db = newDb(backend, [
      [{ type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} }],
      [{ type: "initTable", tableId: "identity", table: defineIdentityTable(), inputTables: { input: "store" } }],
      [{ type: "initTable", tableId: "probe", table: probeTable, inputTables: { input: "identity" } }],
    ]);

    await db.applyRemainingMigrations();
    expect(observed).toBe(0);
  });
});

describe("Bulldozer (base Piledriver only)", () => {
  it("keeps shutdown behind an in-flight Piledriver garbage collection", async () => {
    const underlying = declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(crypto.randomUUID()));
    let markCollectionStarted: (() => void) | undefined;
    const collectionStarted = new Promise<void>(resolve => {
      markCollectionStarted = resolve;
    });
    let releaseCollection: (() => void) | undefined;
    const collectionGate = new Promise<void>(resolve => {
      releaseCollection = resolve;
    });
    let closeCalls = 0;
    const piledriver = {
      ...underlying,
      async collectGarbage(cutoffTimestampMillis: number, maxObjects?: number) {
        if (markCollectionStarted === undefined) throw new Error("Collection-start signal was not initialized");
        markCollectionStarted();
        await collectionGate;
        return await underlying.collectGarbage(cutoffTimestampMillis, maxObjects);
      },
      async close() {
        closeCalls++;
        await underlying.close();
      },
    };
    const db = declareBulldozerDatabase(piledriver, { migrations: [] });

    const collection = db.collectPiledriverGarbage(0);
    await collectionStarted;
    const closing = db.close();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closeCalls).toBe(0);

    if (releaseCollection === undefined) throw new Error("Collection gate was not initialized");
    releaseCollection();
    await Promise.all([collection, closing]);
    expect(closeCalls).toBe(1);
  });

  it("retains the latest write sequence after instant-availability cache eviction", async () => {
    const path = await mkdtemp(join(tmpdir(), "bulldozer-durability-barrier-"));
    const lmdb = declareLmdbLowLevelDatabase({ path, dbId: "durability-barrier" });
    const instant = declareInstantAvailabilityLowLevelDatabase(lmdb, { dbId: "instant-durability-barrier" });
    const db = declareBulldozerDatabase(declareBasePiledriverDatabase(instant), {
      migrations: [[{ type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} }]],
    });
    let releaseDurability: (() => void) | undefined;
    const durabilityGate = new Promise<void>((resolve) => {
      releaseDurability = resolve;
    });
    try {
      await db.applyRemainingMigrations();

      const originalWaitUntilDurable = lmdb.waitUntilDurable.bind(lmdb);
      lmdb.waitUntilDurable = async (seq) => {
        if (seq !== lmdb.initialSeq) await durabilityGate;
        await originalWaitUntilDurable(seq);
      };

      const write = await db.withSnapshot(async snapshot => await set(snapshot, "store", "a", 1));
      await instant.waitUntilUnderlyingAvailable(write.seq);

      const barrier = db.waitUntilCurrentStateDurable();
      expect(await Promise.race([
        barrier.then(() => "resolved"),
        Promise.resolve("pending"),
      ])).toBe("pending");

      if (releaseDurability === undefined) throw new Error("Durability gate was not initialized");
      releaseDurability();
      await barrier;
    } finally {
      if (releaseDurability !== undefined) releaseDurability();
      await db.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("waits for the current root write to become consistent", async () => {
    const piledriver = declareInMemoryPiledriverDatabase(crypto.randomUUID());
    const waitUntilConsistent = piledriver.waitUntilConsistent.bind(piledriver);
    let waitedSeq: DatabaseSeq | undefined;
    piledriver.waitUntilConsistent = async (seq) => {
      waitedSeq = seq;
      await waitUntilConsistent(seq);
    };
    const db = declareBulldozerDatabase(piledriver, {
      migrations: [[{ type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} }]],
    });
    try {
      await db.applyRemainingMigrations();
      waitedSeq = undefined;

      const write = await db.withSnapshot(async snapshot => await set(snapshot, "store", "a", 1));
      await db.waitUntilCurrentStateConsistent();

      expect(waitedSeq).toBe(write.seq);
    } finally {
      await db.close();
    }
  });

  it("exposes Piledriver and low-level debug snapshots when available", async () => {
    const db = newDb("base", [[{ type: "initTable", tableId: "store", table: defineStoredTable(), inputTables: {} }]]);
    await db.applyRemainingMigrations();
    await db.withSnapshotConsistent(async snapshot => await set(snapshot, "store", "a", { value: 1 }));

    const piledriver = await db.debugPiledriverSnapshot!();
    expect(piledriver.roots).toHaveLength(1);
    expect(piledriver.roots[0].serializedJson).toMatchObject({
      snapshot: {
        mostRecentlyCompletedMigrationIndex: 1,
      },
    });

    const lowLevel = await db.debugLowLevelSnapshot!();
    expect(Object.keys(lowLevel.stores)).toEqual(expect.arrayContaining(["root"]));
    expect(Object.keys(lowLevel.dumps)).toEqual(expect.arrayContaining(["heap"]));
  });
});

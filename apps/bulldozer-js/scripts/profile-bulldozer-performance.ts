import { declareInMemoryLowLevelDatabase } from "../src/databases/low-level/implementations/in-memory.js";
import { ConcatTreeList } from "../src/databases/piledriver/data-structures/concat-tree-list.js";
import { declareBasePiledriverDatabase } from "../src/databases/piledriver/implementations/base.js";
import type { PiledriverObject } from "../src/databases/piledriver/index.js";
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
} from "../src/databases/bulldozer/index.js";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

type AnyTable = ReturnType<typeof defineStoredTable>;
type Metric = { calls: number, ms: number };
type Metrics = Record<string, Metric>;
type ChangeMetric = { calls: number, inputRows: number, outputRows: number, inputGroups: number, outputGroups: number };

const rowCount = 384;
const measuredIterations = 10;

const metrics: Metrics = {};
const changeMetrics: Record<string, ChangeMetric> = {};
function record(name: string, durationMs: number) {
  const metric = metrics[name] ??= { calls: 0, ms: 0 };
  metric.calls++;
  metric.ms += durationMs;
}

function resetMetrics() {
  for (const key of Object.keys(metrics)) delete metrics[key];
  for (const key of Object.keys(changeMetrics)) delete changeMetrics[key];
}

function rowChangeCount(changes: { addedRows: unknown[], modifiedRows: unknown[], deletedRows: unknown[] }) {
  return changes.addedRows.length + changes.modifiedRows.length + changes.deletedRows.length;
}

function groupChangeCount(changes: { addedGroups: unknown[], deletedGroups: unknown[] }) {
  return changes.addedGroups.length + changes.deletedGroups.length;
}

function recordChanges(tableId: string, inputChanges: Record<string, any>, outputChanges: any) {
  const metric = changeMetrics[tableId] ??= { calls: 0, inputRows: 0, outputRows: 0, inputGroups: 0, outputGroups: 0 };
  metric.calls++;
  metric.inputRows += Object.values(inputChanges).reduce((sum, changes) => sum + rowChangeCount(changes), 0);
  metric.inputGroups += Object.values(inputChanges).reduce((sum, changes) => sum + groupChangeCount(changes), 0);
  metric.outputRows += rowChangeCount(outputChanges);
  metric.outputGroups += groupChangeCount(outputChanges);
}

function timeSync<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    record(name, performance.now() - start);
  }
}

async function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    record(name, performance.now() - start);
  }
}

async function collect<T>(iterable: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

function profileTable(tableId: string, table: AnyTable): AnyTable {
  return {
    ...table,
    setOrDeleteRow: table.setOrDeleteRow && (async options => await timeAsync(`table:${tableId}:setOrDeleteRow`, () => table.setOrDeleteRow!(options))),
    tick: table.tick && (async options => await timeAsync(`table:${tableId}:tick`, () => table.tick!(options))),
    emitInputChanges: async options => {
      const result = await timeAsync(`table:${tableId}:emitInputChanges`, () => table.emitInputChanges(options));
      recordChanges(tableId, options.changes, result.outputChanges);
      return result;
    },
    async * listGroups(options) {
      const start = performance.now();
      try {
        yield* table.listGroups(options);
      } finally {
        record(`table:${tableId}:listGroups`, performance.now() - start);
      }
    },
    async * listRowsInGroup(options) {
      const start = performance.now();
      try {
        yield* table.listRowsInGroup(options);
      } finally {
        record(`table:${tableId}:listRowsInGroup`, performance.now() - start);
      }
    },
  };
}

function eventRow(index: number, amount = index + 1) {
  return {
    account: `acct-${index % 32}`,
    asset: `asset-${index % 8}`,
    amount,
    active: index % 5 !== 0,
    bucket: index % 16,
  };
}

function createProfiledDatabase() {
  const table = (tableId: string, table: AnyTable) => profileTable(tableId, table);
  const db = declareBulldozerDatabase(declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(crypto.randomUUID())), { migrations: [[
    { type: "initTable", tableId: "events", table: table("events", defineStoredTable()), inputTables: {} },
    { type: "initTable", tableId: "prices", table: table("prices", defineStoredTable()), inputTables: {} },
    { type: "initTable", tableId: "identityEvents", table: table("identityEvents", defineIdentityTable()), inputTables: { input: "events" } },
    { type: "initTable", tableId: "activeEvents", table: table("activeEvents", defineFilterTable(row => timeSync("callback:filter:activeEvents", () => (row.rowData as { active: boolean }).active))), inputTables: { input: "identityEvents" } },
    { type: "initTable", tableId: "normalizedEvents", table: table("normalizedEvents", defineMapTable(row => timeSync("callback:map:normalizedEvents", () => {
      const event = row.rowData as { account: string, asset: string, amount: number, active: boolean, bucket: number };
      return {
        account: event.account,
        asset: event.asset,
        amount: event.amount,
        active: event.active,
        bucket: event.bucket,
        weightedAmount: event.amount * 2,
      };
    }))), inputTables: { input: "activeEvents" } },
    { type: "initTable", tableId: "expandedEvents", table: table("expandedEvents", defineFlatMapTable(row => timeSync("callback:flatMap:expandedEvents", () => {
      const event = row.rowData as { account: string, asset: string, amount: number, weightedAmount: number };
      return [
        { account: event.account, asset: event.asset, kind: "debit", amount: -event.amount },
        { account: event.account, asset: event.asset, kind: "credit", amount: event.weightedAmount },
      ];
    }))), inputTables: { input: "normalizedEvents" } },
    { type: "initTable", tableId: "sortedExpandedEvents", table: table("sortedExpandedEvents", defineSortTable({
      sortKeyExtractor: row => timeSync("callback:sortKey:sortedExpandedEvents", () => {
        const event = row.rowData as { account: string, asset: string, amount: number, kind: string };
        return [event.account, event.asset, event.amount, event.kind, row.rowIdentifier];
      }),
      sortKeyComparator: (a, b) => timeSync("callback:sortComparator:sortedExpandedEvents", () => stringCompare(JSON.stringify(a), JSON.stringify(b))),
    })), inputTables: { input: "expandedEvents" } },
    { type: "initTable", tableId: "runningFoldInput", table: table("runningFoldInput", defineSortTable({
      sortKeyExtractor: row => timeSync("callback:sortKey:runningFoldInput", () => {
        const [eventId, outputIndex] = JSON.parse(row.rowIdentifier) as [string, number];
        return [Number(eventId.slice("event-".length)), outputIndex];
      }),
      sortKeyComparator: (a, b) => timeSync("callback:sortComparator:runningFoldInput", () => {
        const [eventA, outputA] = a as [number, number];
        const [eventB, outputB] = b as [number, number];
        return eventA - eventB || outputA - outputB;
      }),
    })), inputTables: { input: "expandedEvents" } },
    { type: "initTable", tableId: "materializedExpandedEvents", table: table("materializedExpandedEvents", defineMaterializeTable()), inputTables: { input: "sortedExpandedEvents" } },
    { type: "initTable", tableId: "expandedTotal", table: table("expandedTotal", defineReduceTable({
      valueExtractor: async row => await timeAsync("callback:reduceExtractor:expandedTotal", async () => (row.rowData as { amount: number }).amount),
      valueReducer: async (...values) => await timeAsync("callback:reduceReducer:expandedTotal", async () => values.reduce((sum, value) => Number(sum) + Number(value), 0)),
    })), inputTables: { input: "sortedExpandedEvents" } },
    { type: "initTable", tableId: "accountSequence", table: table("accountSequence", defineTransduceTable({
      valueExtractor: async row => await timeAsync("callback:transduceExtractor:accountSequence", async () => ConcatTreeList.fromEntries([[row.rowIdentifier, (row.rowData as { account: string }).account]])),
      valueReducer: async (...lists) => await timeAsync("callback:transduceReducer:accountSequence", async () => ConcatTreeList.concat(lists)),
    })), inputTables: { input: "normalizedEvents" } },
    { type: "initTable", tableId: "compactedExpandedEvents", table: table("compactedExpandedEvents", defineCompactTable({
      compactor: (a, b) => timeSync("callback:compact:compactedExpandedEvents", () => []),
    })), inputTables: { input: "sortedExpandedEvents" } },
    { type: "initTable", tableId: "eventsByAccount", table: table("eventsByAccount", declareGroupByTable({
      groupKeyExtractor: async row => await timeAsync("callback:groupByExtractor:eventsByAccount", async () => (row.rowData as { account: string }).account),
      groupKeyComparator: (a, b) => timeSync("callback:groupComparator:eventsByAccount", () => stringCompare(String(a), String(b))),
    })), inputTables: { input: "normalizedEvents" } },
    { type: "initTable", tableId: "enrichedEvents", table: table("enrichedEvents", declareLeftJoinTable({
      leftJoinKeyExtractor: async row => await timeAsync("callback:leftJoinKey:enrichedEvents", async () => (row.rowData as { asset: string }).asset),
      rightJoinKeyExtractor: async row => await timeAsync("callback:rightJoinKey:enrichedEvents", async () => (row.rowData as { asset: string }).asset),
      joinKeyComparator: (a, b) => timeSync("callback:joinComparator:enrichedEvents", () => stringCompare(String(a), String(b))),
      joiner: async (event, price) => await timeAsync("callback:joiner:enrichedEvents", async () => ({
        event: event.rowData,
        price: price?.rowData ?? null,
      })),
    })), inputTables: { left: "normalizedEvents", right: "prices" } },
    { type: "initTable", tableId: "runningExpandedTotal", table: table("runningExpandedTotal", declareLeftFoldTable({
      initialState: 0,
      reducer: async (state, row) => await timeAsync("callback:leftFoldReducer:runningExpandedTotal", async () => {
        const next = Number(state) + (row.rowData as { amount: number }).amount;
        return { newState: next, newRowData: next };
      }),
    })), inputTables: { input: "runningFoldInput" } },
    { type: "initTable", tableId: "eventReminders", table: table("eventReminders", declareTimeFoldTable({
      initialState: 0,
      reducer: async (state, row, triggerTimeIfRepeated) => await timeAsync("callback:timeFoldReducer:eventReminders", async () => ({
        newState: Number(state) + 1,
        newRowData: { event: row.rowIdentifier, repeated: triggerTimeIfRepeated !== null, state: Number(state) + 1 },
        nextTriggerTime: triggerTimeIfRepeated === null ? new Date("2100-01-01T00:00:00.000Z") : null,
      })),
    })), inputTables: { input: "normalizedEvents" } },
    { type: "initTable", tableId: "everything", table: table("everything", defineConcatTable()), inputTables: {
      accountSequence: "accountSequence",
      compacted: "compactedExpandedEvents",
      enriched: "enrichedEvents",
      expanded: "materializedExpandedEvents",
      grouped: "eventsByAccount",
      reduced: "expandedTotal",
      reminders: "eventReminders",
      running: "runningExpandedTotal",
    } },
    { type: "initTable", tableId: "everythingMaterialized", table: table("everythingMaterialized", defineMaterializeTable()), inputTables: { input: "everything" } },
  ]] });
  return db;
}

async function main() {
  const db = createProfiledDatabase();
  await db.applyRemainingMigrations();
  let snapshot = (await db.getSnapshot()).snapshot;
  for (let i = 0; i < 8; i++) {
    snapshot = (await snapshot.setOrDeleteRow({ tableId: "prices", rowIdentifier: `asset-${i}`, newRowData: { asset: `asset-${i}`, usd: 100 + i } })).newSnapshot;
  }
  for (let i = 0; i < rowCount; i++) {
    snapshot = (await snapshot.setOrDeleteRow({ tableId: "events", rowIdentifier: `event-${i}`, newRowData: eventRow(i) })).newSnapshot;
  }

  resetMetrics();
  const durations: number[] = [];
  const targetIndex = rowCount - 1;
  for (let iteration = 0; iteration < measuredIterations; iteration++) {
    const start = performance.now();
    snapshot = (await snapshot.setOrDeleteRow({
      tableId: "events",
      rowIdentifier: `event-${targetIndex}`,
      newRowData: eventRow(targetIndex, rowCount * 10 + iteration),
    })).newSnapshot;
    durations.push(performance.now() - start);
  }

  const tableMetrics = Object.entries(metrics)
    .filter(([name]) => name.startsWith("table:"))
    .map(([name, metric]) => {
      const [, tableId, method] = name.split(":");
      return { tableId, method, ...metric };
    })
    .sort((a, b) => b.ms - a.ms);
  const callbackMetrics = Object.entries(metrics)
    .filter(([name]) => name.startsWith("callback:"))
    .map(([name, metric]) => ({ name: name.slice("callback:".length), ...metric }))
    .sort((a, b) => b.ms - a.ms);
  const tableChangeMetrics = Object.entries(changeMetrics)
    .map(([tableId, metric]) => ({ tableId, ...metric }))
    .sort((a, b) => b.inputRows + b.outputRows - (a.inputRows + a.outputRows));
  console.log(JSON.stringify({
    rowCount,
    measuredIterations,
    durations,
    totalSetRowMs: durations.reduce((sum, value) => sum + value, 0),
    meanSetRowMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    tableMetrics,
    tableChangeMetrics,
    callbackMetrics,
  }, null, 2));
}

await main();

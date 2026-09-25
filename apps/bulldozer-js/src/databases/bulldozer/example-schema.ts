import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { declareInMemoryLowLevelDatabase } from "../low-level/implementations/in-memory.js";
import { declareBasePiledriverDatabase } from "../piledriver/implementations/base.js";
import type { PiledriverObject } from "../piledriver/index.js";
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
  defineMapTable,
  defineReduceTable,
  defineSortTable,
  defineStoredTable,
} from "./index.js";

type LedgerEntry = {
  accountId: string,
  asset: string,
  amount: string,
  side: "credit" | "debit",
  txHash: string,
  blockNumber: number,
  timestamp: string,
  counterparty: string | null,
  memo: string | null,
};

type Migration = Parameters<typeof declareBulldozerDatabase>[1]["migrations"][number];
const asObject = (value: PiledriverObject) => value as Record<string, PiledriverObject>;
const asLedgerEntry = (value: PiledriverObject) => asObject(value) as unknown as LedgerEntry;
const signedAmount = (entry: LedgerEntry) => Number(entry.amount) * (entry.side === "credit" ? 1 : -1);
const compareStrings = (a: PiledriverObject, b: PiledriverObject) => stringCompare(String(a), String(b));
const compareNumbers = (a: PiledriverObject, b: PiledriverObject) => Number(a) - Number(b);
const joinKey = (entry: LedgerEntry) => ({ counterparty: entry.counterparty, asset: entry.asset });
const storedTableId = "ledgerEntries";
const isRecord = (value: PiledriverObject): value is Record<string, PiledriverObject> => typeof value === "object" && value !== null && !Array.isArray(value);
const requireString = (entry: Record<string, PiledriverObject>, field: keyof LedgerEntry) => {
  if (typeof entry[field] !== "string" || entry[field].length === 0) throw new Error(`Ledger entry ${String(field)} must be a non-empty string`);
};
const requireNullableString = (entry: Record<string, PiledriverObject>, field: keyof LedgerEntry) => {
  if (entry[field] !== null && typeof entry[field] !== "string") throw new Error(`Ledger entry ${String(field)} must be null or a string`);
};
const assertLedgerEntry = (value: PiledriverObject | undefined) => {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("Ledger entry must be an object");
  requireString(value, "accountId");
  requireString(value, "asset");
  requireString(value, "amount");
  requireString(value, "txHash");
  requireString(value, "timestamp");
  requireNullableString(value, "counterparty");
  requireNullableString(value, "memo");
  if (value.side !== "credit" && value.side !== "debit") throw new Error("Ledger entry side must be credit or debit");
  if (typeof value.blockNumber !== "number" || !Number.isInteger(value.blockNumber) || value.blockNumber < 0) throw new Error("Ledger entry blockNumber must be a non-negative integer");
  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Ledger entry amount must be a non-negative finite decimal string");
  const timestamp = Date.parse(String(value.timestamp));
  if (!Number.isFinite(timestamp)) throw new Error("Ledger entry timestamp must be an ISO timestamp");
};
const assertLedgerEntryChange = async (change: { rowIdentifier: string, oldRowData: PiledriverObject | undefined, newRowData: PiledriverObject | undefined }) => {
  if (!change.rowIdentifier) throw new Error("Ledger entry rowIdentifier is required");
  assertLedgerEntry(change.oldRowData);
  assertLedgerEntry(change.newRowData);
};

const exampleLedgerRows: Record<string, LedgerEntry> = {
  "entry-001": { accountId: "acct-alice", asset: "USD", amount: "1200", side: "credit", txHash: "0xaaa001", blockNumber: 100, timestamp: "2026-01-01T00:00:00.000Z", counterparty: "acct-bob", memo: "invoice payment" },
  "entry-002": { accountId: "acct-alice", asset: "USD", amount: "250", side: "debit", txHash: "0xaaa002", blockNumber: 104, timestamp: "2026-01-01T00:02:00.000Z", counterparty: "acct-carol", memo: "vendor payout" },
  "entry-003": { accountId: "acct-bob", asset: "ETH", amount: "2.5", side: "credit", txHash: "0xbbb001", blockNumber: 108, timestamp: "2026-01-01T00:04:00.000Z", counterparty: "acct-alice", memo: "bridge settlement" },
  "entry-004": { accountId: "acct-carol", asset: "USD", amount: "1800", side: "debit", txHash: "0xccc001", blockNumber: 111, timestamp: "2026-01-01T00:06:00.000Z", counterparty: "acct-alice", memo: "treasury move" },
  "entry-005": { accountId: "acct-bob", asset: "USD", amount: "90", side: "debit", txHash: "0xbbb002", blockNumber: 115, timestamp: "2026-01-01T00:08:00.000Z", counterparty: null, memo: "fee" },
};

export const exampleFungibleLedgerMigrations: readonly Migration[] = [
  [
    {
      type: "initTable",
      tableId: "ledgerEntries",
      table: defineStoredTable({ assertRowChange: assertLedgerEntryChange }),
      inputTables: {},
      debugMetadata: {
        name: "Ledger entries",
        operator: "stored",
        description: "Raw append/update table for ledger entries.",
        category: "base",
        sampleRow: exampleLedgerRows["entry-001"],
      },
    },
    {
      type: "initTable",
      tableId: "entriesByAccount",
      table: declareGroupByTable({
        groupKeyExtractor: async row => asLedgerEntry(row.rowData).accountId,
        groupKeyComparator: compareStrings,
      }),
      inputTables: { input: "ledgerEntries" },
      debugMetadata: { name: "Entries by account", operator: "groupBy", description: "Groups ledger entries by accountId.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "entriesByAsset",
      table: declareGroupByTable({
        groupKeyExtractor: async row => asLedgerEntry(row.rowData).asset,
        groupKeyComparator: compareStrings,
      }),
      inputTables: { input: "ledgerEntries" },
      debugMetadata: { name: "Entries by asset", operator: "groupBy", description: "Groups ledger entries by asset symbol.", category: "asset views" },
    },
    {
      type: "initTable",
      tableId: "accountEntriesNormalized",
      table: defineMapTable(row => {
        const entry = asLedgerEntry(row.rowData);
        return {
          accountId: entry.accountId,
          asset: entry.asset,
          amountNumeric: Number(entry.amount),
          flowDirection: entry.side === "credit" ? "inflow" : "outflow",
          signedAmount: signedAmount(entry),
          txHash: entry.txHash,
          timestamp: entry.timestamp,
        };
      }),
      inputTables: { input: "entriesByAccount" },
      debugMetadata: { name: "Account entries normalized", operator: "map", description: "Adds numeric amount, signed amount, and flow direction.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "accountEntryLegs",
      table: defineFlatMapTable(row => {
        const entry = asLedgerEntry(row.rowData);
        const amount = signedAmount(entry);
        return [
          { accountId: entry.accountId, asset: entry.asset, legType: "entry", signedAmount: amount, txHash: entry.txHash },
          { accountId: entry.counterparty ?? "external", asset: entry.asset, legType: "counterparty", signedAmount: -amount, txHash: entry.txHash },
        ];
      }),
      inputTables: { input: "entriesByAccount" },
      debugMetadata: { name: "Account entry legs", operator: "flatMap", description: "Fans each entry into entry and counterparty legs.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "accountAssetPartitions",
      table: declareGroupByTable({
        groupKeyExtractor: async row => {
          const entry = asObject(row.rowData);
          return { accountId: entry.accountId, asset: entry.asset };
        },
        groupKeyComparator: (a, b) => stringCompare(JSON.stringify(a), JSON.stringify(b)),
      }),
      inputTables: { input: "accountEntriesNormalized" },
      debugMetadata: { name: "Account asset partitions", operator: "groupBy", description: "Partitions normalized rows by account and asset.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "accountEntriesWithCounterparty",
      table: defineFilterTable(row => asLedgerEntry(row.rowData).counterparty !== null),
      inputTables: { input: "entriesByAccount" },
      debugMetadata: { name: "Entries with counterparty", operator: "filter", description: "Keeps only entries that mention a counterparty.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "accountEntriesSortedByAmount",
      table: defineSortTable({
        sortKeyExtractor: row => Number(asLedgerEntry(row.rowData).amount),
        sortKeyComparator: compareNumbers,
      }),
      inputTables: { input: "entriesByAccount" },
      debugMetadata: { name: "Entries sorted by amount", operator: "sort", description: "Sorts account-local entries by numeric amount.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "accountCounterpartyJoinedSample",
      table: declareLeftJoinTable({
        leftJoinKeyExtractor: async row => joinKey(asLedgerEntry(row.rowData)),
        rightJoinKeyExtractor: async row => joinKey(asLedgerEntry(row.rowData)),
        joinKeyComparator: (a, b) => stringCompare(JSON.stringify(a), JSON.stringify(b)),
        joiner: async (left, right) => ({
          entry: asLedgerEntry(left.rowData),
          matchedReference: right ? asLedgerEntry(right.rowData) : null,
        }),
      }),
      inputTables: { left: "accountEntriesWithCounterparty", right: "accountEntriesWithCounterparty" },
      debugMetadata: { name: "Counterparty self-join", operator: "leftJoin", description: "Joins counterparty rows to reference rows with the same counterparty+asset key.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "accountEntriesRunningExposure",
      table: declareLeftFoldTable({
        initialState: 0,
        reducer: async (state, row) => {
          const entry = asLedgerEntry(row.rowData);
          const runningExposure = Number(state) + signedAmount(entry);
          return {
            newState: runningExposure,
            newRowData: { accountId: entry.accountId, asset: entry.asset, txHash: entry.txHash, delta: signedAmount(entry), runningExposure },
          };
        },
      }),
      inputTables: { input: "accountEntriesSortedByAmount" },
      debugMetadata: { name: "Running exposure", operator: "leftFold", description: "Computes account-local running exposure over amount-sorted rows.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "accountEntriesTimedExposure",
      table: declareTimeFoldTable({
        initialState: 0,
        reducer: async (state, row, triggerTime) => {
          const entry = asLedgerEntry(row.rowData);
          const timedExposure = Number(state) + signedAmount(entry);
          return {
            newState: timedExposure,
            newRowData: { accountId: entry.accountId, asset: entry.asset, txHash: entry.txHash, timedExposure, tickTimestamp: triggerTime?.toISOString() ?? null },
            nextTriggerTime: triggerTime === null ? new Date(Date.parse(entry.timestamp) + 5 * 60 * 1000) : null,
          };
        },
      }),
      inputTables: { input: "entriesByAccount" },
      debugMetadata: { name: "Timed exposure", operator: "timeFold", description: "Schedules one follow-up exposure checkpoint five minutes after each row timestamp.", category: "timed folds" },
    },
    {
      type: "initTable",
      tableId: "accountEntriesTimedReprice",
      table: declareTimeFoldTable({
        initialState: 0,
        reducer: async (state, row, triggerTime) => {
          const entry = asLedgerEntry(row.rowData);
          const step = Number(state) + 1;
          return {
            newState: step,
            newRowData: { accountId: entry.accountId, asset: entry.asset, txHash: entry.txHash, amount: Number(entry.amount), step, mode: triggerTime === null ? "initial" : "follow-up", tickTimestamp: triggerTime?.toISOString() ?? null },
            nextTriggerTime: step < 3 ? new Date((triggerTime?.getTime() ?? Date.parse(entry.timestamp)) + 60 * 1000) : null,
          };
        },
      }),
      inputTables: { input: "entriesByAccount" },
      debugMetadata: { name: "Timed reprice", operator: "timeFold", description: "Schedules repeated repricing checkpoints until step three.", category: "timed folds" },
    },
    {
      type: "initTable",
      tableId: "highValueEntriesByAsset",
      table: defineFilterTable(row => Number(asLedgerEntry(row.rowData).amount) >= 1000),
      inputTables: { input: "entriesByAsset" },
      debugMetadata: { name: "High-value entries by asset", operator: "filter", description: "Keeps entries whose amount is at least 1000.", category: "asset views" },
    },
    {
      type: "initTable",
      tableId: "highValueEntriesByAssetAccount",
      table: declareGroupByTable({
        groupKeyExtractor: async row => asLedgerEntry(row.rowData).accountId,
        groupKeyComparator: compareStrings,
      }),
      inputTables: { input: "highValueEntriesByAsset" },
      debugMetadata: { name: "High-value by account", operator: "groupBy", description: "Regroups high-value asset rows by account.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "accountPriorityEntries",
      table: defineConcatTable(),
      inputTables: { counterparty: "accountEntriesWithCounterparty", highValue: "highValueEntriesByAssetAccount" },
      debugMetadata: { name: "Priority entries", operator: "concat", description: "Unions counterparty rows and high-value account rows.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "assetEntriesNormalized",
      table: defineMapTable(row => {
        const entry = asLedgerEntry(row.rowData);
        return { asset: entry.asset, accountId: entry.accountId, amountNumeric: Number(entry.amount), signedDirection: entry.side === "credit" ? 1 : -1, blockNumber: entry.blockNumber, txHash: entry.txHash };
      }),
      inputTables: { input: "entriesByAsset" },
      debugMetadata: { name: "Asset entries normalized", operator: "map", description: "Enriches asset-grouped rows for analytics.", category: "asset views" },
    },
    {
      type: "initTable",
      tableId: "accountDebits",
      table: defineFilterTable(row => asLedgerEntry(row.rowData).side === "debit"),
      inputTables: { input: "entriesByAccount" },
      debugMetadata: { name: "Account debits", operator: "filter", description: "Keeps debit entries.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "accountDebitsSorted",
      table: defineSortTable({
        sortKeyExtractor: row => asLedgerEntry(row.rowData).blockNumber,
        sortKeyComparator: compareNumbers,
      }),
      inputTables: { input: "accountDebits" },
      debugMetadata: { name: "Debits sorted", operator: "sort", description: "Sorts debit rows by block number.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "compactedDebits",
      table: defineCompactTable({
        compactor: (a, b) => {
          const left = asLedgerEntry(a);
          const right = asLedgerEntry(b);
          if (left.asset !== right.asset) return [a, b].map(row => ({ newRowData: row }));
          return [{
            newRowData: {
              accountId: left.accountId,
              asset: left.asset,
              amount: String(Number(left.amount) + Number(right.amount)),
              side: "debit",
              txHash: `${left.txHash}+${right.txHash}`,
              blockNumber: right.blockNumber,
              timestamp: right.timestamp,
              counterparty: right.counterparty,
              memo: "compacted adjacent debits",
            },
          }];
        },
      }),
      inputTables: { input: "accountDebitsSorted" },
      debugMetadata: { name: "Compacted debits", operator: "compact", description: "Merges adjacent debit rows with the same asset.", category: "account views" },
    },
    {
      type: "initTable",
      tableId: "accountSummary",
      table: defineReduceTable({
        valueExtractor: async row => {
          const entry = asLedgerEntry(row.rowData);
          return { totalCredits: entry.side === "credit" ? Number(entry.amount) : 0, totalDebits: entry.side === "debit" ? Number(entry.amount) : 0, netBalance: signedAmount(entry) };
        },
        valueReducer: async (...values) => values.reduce<{ totalCredits: number, totalDebits: number, netBalance: number }>((summary, value) => {
          const item = asObject(value);
          return {
            totalCredits: Number(summary.totalCredits) + Number(item.totalCredits),
            totalDebits: Number(summary.totalDebits) + Number(item.totalDebits),
            netBalance: Number(summary.netBalance) + Number(item.netBalance),
          };
        }, { totalCredits: 0, totalDebits: 0, netBalance: 0 }),
      }),
      inputTables: { input: "entriesByAccount" },
      debugMetadata: { name: "Account summary", operator: "reduce", description: "Collapses each account into credit/debit/net totals.", category: "account views" },
    },
  ],
];

export async function createExampleFungibleLedgerDatabase() {
  const db = declareBulldozerDatabase(
    declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(`bulldozer-example-${crypto.randomUUID()}`)),
    { migrations: exampleFungibleLedgerMigrations },
  );
  await db.applyRemainingMigrations();
  await db.withSnapshotConsistent(async snapshot => {
    for (const [rowIdentifier, rowData] of Object.entries(exampleLedgerRows)) {
      snapshot = (await snapshot.setOrDeleteRow({ tableId: storedTableId, rowIdentifier, newRowData: rowData as unknown as PiledriverObject })).newSnapshot;
    }
    return snapshot;
  });
  return db;
}

import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { declareInMemoryLowLevelDatabase } from "../../databases/low-level/implementations/in-memory.js";
import { declareBulldozerDatabase } from "../../databases/bulldozer/index.js";
import { declareBasePiledriverDatabase } from "../../databases/piledriver/implementations/base.js";
import type { PiledriverObject } from "../../databases/piledriver/index.js";
import { createPaymentsSchema } from "./index.js";
import type { CustomerType, ProductSnapshot, SubscriptionRow } from "./types.js";

// Shared helpers for the payments-schema test suites (index.test.ts + item-quantities.test.ts).
// Kept in one place so the two files can't drift apart. This is plain test plumbing: it builds an
// in-memory bulldozer database from the payments schema and reads rows back out.

export const MONTH_MS = 2_592_000_000;

export type Snapshot = Awaited<ReturnType<typeof initializedSnapshot>>;
export type Row = { groupKey: PiledriverObject, rowIdentifier: string, rowSortKey: PiledriverObject, rowData: PiledriverObject };

export const byId = (a: Row, b: Row) => stringCompare(a.rowIdentifier, b.rowIdentifier);

export const collect = async <T>(iterable: AsyncIterable<T>) => {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
};

export const initializedSnapshot = async () => {
  const schema = createPaymentsSchema();
  const db = declareBulldozerDatabase(declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(crypto.randomUUID())), { migrations: schema.migrations });
  await db.applyRemainingMigrations();
  return (await db.getSnapshot()).snapshot;
};

export const rows = async (snapshot: Snapshot, tableId: string, groupKey: PiledriverObject = null) =>
  (await collect(snapshot.listRowsInGroup({ tableId, groupKey, range: {} }))).sort(byId);

export const rowDatas = async (snapshot: Snapshot, tableId: string, groupKey: PiledriverObject = null) =>
  (await rows(snapshot, tableId, groupKey)).map(row => row.rowData);

// `listRowsInGroup` already yields rows in stored sort-key order (the table's own comparator), so we
// return them as-is. Re-sorting here by `Number(rowSortKey)` would be wrong for tables whose sort key
// is a composite object (e.g. the item-quantities ledger), which stringifies/coerces to NaN.
export const rowsBySortKey = async (snapshot: Snapshot, tableId: string, groupKey: PiledriverObject = null) =>
  await collect(snapshot.listRowsInGroup({ tableId, groupKey, range: {} }));

export const set = async (snapshot: Snapshot, tableId: string, rowIdentifier: string, newRowData: PiledriverObject | undefined) =>
  (await snapshot.setOrDeleteRow({ tableId, rowIdentifier, newRowData })).newSnapshot;

export const customerGroup = (customerId: string, customerType: CustomerType = "user"): PiledriverObject => ({ tenancyId: "t1", customerType, customerId });

export const asRecord = (value: PiledriverObject) => value as Record<string, PiledriverObject>;

export const product = (includedItems: ProductSnapshot["includedItems"] = {}): ProductSnapshot => ({
  displayName: "Test Plan",
  customerType: "user",
  productLineId: "line-main",
  prices: { p1: { USD: "10.00" } },
  includedItems,
});

export const subscription = (id: string, overrides: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  id,
  tenancyId: "t1",
  customerId: `customer-${id}`,
  customerType: "user",
  productId: `prod-${id}`,
  priceId: "p1",
  product: product(),
  quantity: 1,
  stripeSubscriptionId: null,
  status: "active",
  currentPeriodStartMillis: 0,
  currentPeriodEndMillis: MONTH_MS,
  cancelAtPeriodEnd: false,
  canceledAtMillis: null,
  endedAtMillis: null,
  refundedAtMillis: null,
  productRevokedAtMillis: null,
  creationSource: "TEST_MODE",
  createdAtMillis: 0,
  ...overrides,
});

// Net balance of `itemId` for `group` as of `atMillis`: the last item-quantities fold row whose
// txnEffectiveAtMillis <= atMillis, or 0 if none exists yet. The item-quantities fold materializes a
// row per change (including future-dated expiry rows), so reading the final row would report the
// fully-expired balance rather than the balance "as of" a point in time — hence this helper.
export const balanceAt = async (snapshot: Snapshot, group: PiledriverObject, itemId: string, atMillis: number): Promise<number> => {
  const itemQuantitiesTableId = createPaymentsSchema().itemQuantities;
  const eligible = (await rowsBySortKey(snapshot, itemQuantitiesTableId, group))
    .filter(row => Number(asRecord(row.rowData).txnEffectiveAtMillis) <= atMillis);
  const latest = eligible.at(-1);
  if (latest === undefined) return 0;
  return Number(asRecord(asRecord(latest.rowData).itemQuantities)[itemId] ?? 0);
};

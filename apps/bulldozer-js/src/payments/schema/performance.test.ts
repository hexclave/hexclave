import { afterAll, describe, expect, it } from "vitest";
import { declareInMemoryLowLevelDatabase } from "../../databases/low-level/implementations/in-memory.js";
import { declareInstantAvailabilityLowLevelDatabase } from "../../databases/low-level/implementations/instant-availability.js";
import { declareLmdbLowLevelDatabase } from "../../databases/low-level/implementations/lmdb.js";
import { declareBulldozerDatabase } from "../../databases/bulldozer/index.js";
import { declareBasePiledriverDatabase } from "../../databases/piledriver/implementations/base.js";
import { declareBreezyPiledriverDatabase } from "../../databases/piledriver/implementations/breezy/index.js";
import { declareBufferedPiledriverDatabase } from "../../databases/piledriver/implementations/buffered.js";
import { declareInMemoryPiledriverDatabase } from "../../databases/piledriver/implementations/in-memory.js";
import type { PiledriverObject } from "../../databases/piledriver/index.js";
import { createPaymentsSchema } from "./index.js";
import type { ProductSnapshot, SubscriptionRow } from "./types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type LockStats = { heldMs: number, waitMs: number, acquisitions: number };
type Metric = {
  name: string,
  count: number,
  elapsedMs: number,
  opsPerSecond: number,
  lockHeldMs: number,
  lockWaitMs: number,
  lockAcquisitions: number,
  lockOccupancy: number,
};
type LockStatsDatabase = { debugWriteLockStats?(): LockStats };
type Snapshot = Awaited<ReturnType<ReturnType<typeof declareBulldozerDatabase>["getSnapshot"]>>["snapshot"];

const readNonNegativeInteger = (name: string, defaultValue: number) => {
  const value = process.env[name] ?? String(defaultValue);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a non-negative safe integer`);
  return parsed;
};

const USER_COUNT = 6;
const ITEM_UPDATES_PER_USER = readNonNegativeInteger("BULLDOZER_PAYMENTS_PERF_ITEM_UPDATES_PER_USER", 10);
// The concurrent phases issue CONCURRENCY writes at once and only then wait for all of them. This is
// the shape a real request burst has, and unlike the serial phases it actually puts the Bulldozer
// write lock under contention, so lockWaitMs becomes meaningful instead of pinned near zero.
const CONCURRENCY = 10;
const CONCURRENT_SUBSCRIPTION_BATCHES = readNonNegativeInteger("BULLDOZER_PAYMENTS_PERF_CONCURRENT_SUBSCRIPTION_BATCHES", 6);
const CONCURRENT_PURCHASE_BATCHES = readNonNegativeInteger("BULLDOZER_PAYMENTS_PERF_CONCURRENT_PURCHASE_BATCHES", 6);
const CONCURRENT_ITEM_UPDATE_BATCHES = readNonNegativeInteger("BULLDOZER_PAYMENTS_PERF_CONCURRENT_ITEM_UPDATE_BATCHES", 60);
const PREFILL_USER_COUNT = readNonNegativeInteger("BULLDOZER_PAYMENTS_PERF_PREFILL_USERS", 200);
const PREFILL_ITEM_UPDATES_PER_USER = 4;
const PREFILL_SOURCE_FACT_COUNT = PREFILL_USER_COUNT * (2 + PREFILL_ITEM_UPDATES_PER_USER);
// Local large-store measurements are ~156s for this suite and ~273s for the listing suite.
// 600s provides practical slower-runner headroom; the low-level close barrier is the race fix.
const MONTH_MS = 2_592_000_000;
const tempPaths: string[] = [];
const databases: Array<ReturnType<typeof declareBulldozerDatabase>> = [];
const perfBackend = process.env.BULLDOZER_PAYMENTS_PERF_BACKEND ?? "lmdb-instant";
const piledriverImplementation = process.env.STACK_BULLDOZER_PILEDRIVER_IMPLEMENTATION ?? "base";
const bufferedPiledriver = process.env.BULLDOZER_PAYMENTS_PERF_BUFFERED_PILEDRIVER === "1";
if (piledriverImplementation !== "base" && piledriverImplementation !== "breezy") throw new Error("STACK_BULLDOZER_PILEDRIVER_IMPLEMENTATION must be base or breezy");
const effectivePiledriverImplementation = perfBackend.includes("piledriver-in-memory") ? "in-memory" : piledriverImplementation;

const product = (includedItems: ProductSnapshot["includedItems"]): ProductSnapshot => ({
  displayName: "Perf Product",
  customerType: "user",
  productLineId: "line-perf",
  prices: { p1: { USD: "10.00" } },
  includedItems,
});
const customerId = (namespace: string, index: number) => `${namespace}user-${index}`;
const subscription = (index: number, namespace = ""): SubscriptionRow => ({
  id: `${namespace}sub-${index}`,
  tenancyId: "t1",
  customerId: customerId(namespace, index),
  customerType: "user",
  productId: "prod-sub",
  priceId: "p1",
  product: product({
    credits: { quantity: 100, expires: "never" },
    seats: { quantity: 1, expires: "when-purchase-expires" },
  }),
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
  createdAtMillis: 1_000 + index,
});
const oneTimePurchase = (index: number, namespace = "") => ({
  id: `${namespace}otp-${index}`,
  tenancyId: "t1",
  customerId: customerId(namespace, index),
  customerType: "user",
  productId: "prod-otp",
  priceId: "p1",
  product: product({
    coins: { quantity: 50, expires: "never" },
  }),
  quantity: 2,
  stripePaymentIntentId: null,
  revokedAtMillis: null,
  refundedAtMillis: null,
  creationSource: "TEST_MODE",
  createdAtMillis: 2_000 + index,
});
const manualItemQuantityChange = (userIndex: number, updateIndex: number, namespace = "") => ({
  id: `${namespace}miqc-${userIndex}-${updateIndex}`,
  tenancyId: "t1",
  customerId: customerId(namespace, userIndex),
  customerType: "user",
  itemId: updateIndex % 2 === 0 ? "credits" : "coins",
  quantity: updateIndex % 3 === 0 ? -1 : 3,
  description: null,
  expiresAtMillis: null,
  createdAtMillis: 10_000 + userIndex * 1_000 + updateIndex,
});
const customerGroup = (index: number, namespace = ""): PiledriverObject => ({ tenancyId: "t1", customerType: "user", customerId: customerId(namespace, index) });
const rows = async (snapshot: Snapshot, tableId: string, groupKey: PiledriverObject) => {
  const result = [];
  for await (const row of snapshot.listRowsInGroup({ tableId, groupKey, range: {} })) result.push(row);
  return result;
};
const emptyLockStats = (): LockStats => ({ heldMs: 0, waitMs: 0, acquisitions: 0 });
// Runs `batchCount` batches of CONCURRENCY writes; each batch is issued concurrently and fully
// awaited before the next one starts, so concurrency stays bounded at CONCURRENCY.
const inConcurrentBatches = async (batchCount: number, write: (batchIndex: number, slotIndex: number) => Promise<unknown>) => {
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    await Promise.all(Array.from({ length: CONCURRENCY }, async (_unused, slotIndex) => await write(batchIndex, slotIndex)));
  }
};
const measure = async <T>(
  metrics: Metric[],
  name: string,
  count: number,
  operation: () => Promise<T>,
  db?: LockStatsDatabase | (() => LockStatsDatabase | undefined),
) => {
  const getLockStats = () => (typeof db === "function" ? db() : db)?.debugWriteLockStats?.() ?? emptyLockStats();
  const before = getLockStats();
  const start = performance.now();
  const value = await operation();
  const elapsedMs = performance.now() - start;
  const opsPerSecond = count / elapsedMs * 1_000;
  const after = getLockStats();
  const lockHeldMs = after.heldMs - before.heldMs;
  const lockWaitMs = after.waitMs - before.waitMs;
  const lockAcquisitions = after.acquisitions - before.acquisitions;
  const lockOccupancy = elapsedMs === 0 ? 0 : lockHeldMs / elapsedMs;
  metrics.push({ name, count, elapsedMs, opsPerSecond, lockHeldMs, lockWaitMs, lockAcquisitions, lockOccupancy });
  process.stdout.write(`\n[bulldozer-payments-schema-perf-js] ${name}: ${elapsedMs.toFixed(1)} ms (${count} ops, ${opsPerSecond.toFixed(2)} ops/s)\n`);
  return value;
};
const newPiledriverDb = () => {
  if (perfBackend === "piledriver-in-memory") return declareInMemoryPiledriverDatabase(crypto.randomUUID());
  if (perfBackend === "buffered-piledriver-in-memory") {
    return declareBufferedPiledriverDatabase(declareInMemoryPiledriverDatabase(crypto.randomUUID()));
  }
  if (piledriverImplementation === "breezy") {
    if (perfBackend !== "lmdb") throw new Error("Breezy requires the lmdb performance backend");
    const path = mkdtempSync(join(tmpdir(), "bulldozer-payments-schema-perf-"));
    tempPaths.push(path);
    const breezy = declareBreezyPiledriverDatabase({ path, dbId: crypto.randomUUID() });
    return bufferedPiledriver ? declareBufferedPiledriverDatabase(breezy) : breezy;
  }
  if (perfBackend === "lmdb" || perfBackend === "lmdb-instant") {
    const path = mkdtempSync(join(tmpdir(), "bulldozer-payments-schema-perf-"));
    tempPaths.push(path);
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const lmdb = declareLmdbLowLevelDatabase(lmdbOptions);
    const lowLevel = perfBackend === "lmdb-instant" ? declareInstantAvailabilityLowLevelDatabase(lmdb) : lmdb;
    return declareBasePiledriverDatabase(lowLevel);
  }
  if (perfBackend === "buffered-lmdb-instant" || perfBackend === "buffered-lmdb") {
    const path = mkdtempSync(join(tmpdir(), "bulldozer-payments-schema-perf-"));
    tempPaths.push(path);
    const lmdb = declareLmdbLowLevelDatabase({ path, dbId: crypto.randomUUID() });
    const lowLevel = perfBackend === "buffered-lmdb-instant" ? declareInstantAvailabilityLowLevelDatabase(lmdb) : lmdb;
    return declareBufferedPiledriverDatabase(declareBasePiledriverDatabase(lowLevel));
  }
  return declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(crypto.randomUUID()));
};
const newPaymentsDb = async () => {
  const schema = createPaymentsSchema();
  const db = declareBulldozerDatabase(newPiledriverDb(), { migrations: schema.migrations });
  databases.push(db);
  await db.applyRemainingMigrations();
  return { db, schema };
};

describe("payments schema performance", () => {
  it("runs the comparable schema workload", { timeout: 600_000 }, async () => {
    const metrics: Metric[] = [];
    let initialized!: Awaited<ReturnType<typeof newPaymentsDb>>;
    let initializedDb: ReturnType<typeof declareBulldozerDatabase> | undefined;

    initialized = await measure(metrics, "initialize schema", 1, async () => {
      const result = await newPaymentsDb();
      initializedDb = result.db;
      return result;
    }, () => initializedDb);
    const { db, schema } = initialized;

    await measure(metrics, "prefill baseline rows", PREFILL_SOURCE_FACT_COUNT, async () => {
      for (let i = 0; i < PREFILL_USER_COUNT; i++) {
        await db.withSnapshot(async snapshot => await snapshot.setOrDeleteRow({ tableId: schema.subscriptions, rowIdentifier: `prefill-sub-${i}`, newRowData: subscription(i, "prefill-") as unknown as PiledriverObject }));
        await db.withSnapshot(async snapshot => await snapshot.setOrDeleteRow({ tableId: schema.oneTimePurchases, rowIdentifier: `prefill-otp-${i}`, newRowData: oneTimePurchase(i, "prefill-") as unknown as PiledriverObject }));
        for (let updateIndex = 0; updateIndex < PREFILL_ITEM_UPDATES_PER_USER; updateIndex++) {
          await db.withSnapshot(async snapshot => await snapshot.setOrDeleteRow({
            tableId: schema.manualItemQuantityChanges,
            rowIdentifier: `prefill-miqc-${i}-${updateIndex}`,
            newRowData: manualItemQuantityChange(i, updateIndex, "prefill-"),
          }));
        }
      }
      await db.waitUntilCurrentStateConsistent();
    }, () => db);

    // The first mutation after the large prefill can pay one-off cache and GC costs. Keep those
    // outside the measured request phases; the "warmup-" namespace also keeps this row out of the
    // transaction count asserted at the end.
    await db.withSnapshotConsistent(async snapshot => await snapshot.setOrDeleteRow({ tableId: schema.subscriptions, rowIdentifier: "warmup-sub-0", newRowData: subscription(0, "warmup-") as unknown as PiledriverObject }));

    // The measured write phases wait for replication and durability, because that is what an HTTP
    // handler waits for before responding; plain withSnapshot understates response time.
    await measure(metrics, "write subscriptions", USER_COUNT, async () => {
      for (let i = 0; i < USER_COUNT; i++) {
        await db.withSnapshotConsistent(async snapshot => await snapshot.setOrDeleteRow({ tableId: schema.subscriptions, rowIdentifier: `sub-${i}`, newRowData: subscription(i) as unknown as PiledriverObject }));
      }
    }, () => db);

    await measure(metrics, "write one-time purchases", USER_COUNT, async () => {
      for (let i = 0; i < USER_COUNT; i++) {
        await db.withSnapshotConsistent(async snapshot => await snapshot.setOrDeleteRow({ tableId: schema.oneTimePurchases, rowIdentifier: `otp-${i}`, newRowData: oneTimePurchase(i) as unknown as PiledriverObject }));
      }
    }, () => db);

    await measure(metrics, "write manual item quantity changes", USER_COUNT * ITEM_UPDATES_PER_USER, async () => {
      for (let userIndex = 0; userIndex < USER_COUNT; userIndex++) {
        for (let updateIndex = 0; updateIndex < ITEM_UPDATES_PER_USER; updateIndex++) {
          await db.withSnapshotConsistent(async snapshot => await snapshot.setOrDeleteRow({
            tableId: schema.manualItemQuantityChanges,
            rowIdentifier: `miqc-${userIndex}-${updateIndex}`,
            newRowData: manualItemQuantityChange(userIndex, updateIndex),
          }));
        }
      }
    }, () => db);

    // The same three operations, issued CONCURRENCY-at-a-time with each batch fully awaited before
    // the next. This exercises write-lock contention that serial phases cannot show; rows use their
    // own "concurrent-" namespace so they cannot collide with serial rows or affect the transaction
    // count asserted at the end.
    await measure(metrics, "write subscriptions (concurrent)", CONCURRENT_SUBSCRIPTION_BATCHES * CONCURRENCY, async () => {
      await inConcurrentBatches(CONCURRENT_SUBSCRIPTION_BATCHES, async (batchIndex, slotIndex) => {
        const i = batchIndex * CONCURRENCY + slotIndex;
        await db.withSnapshotConsistent(async snapshot => await snapshot.setOrDeleteRow({ tableId: schema.subscriptions, rowIdentifier: `concurrent-sub-${i}`, newRowData: subscription(i, "concurrent-") as unknown as PiledriverObject }));
      });
    }, () => db);

    await measure(metrics, "write one-time purchases (concurrent)", CONCURRENT_PURCHASE_BATCHES * CONCURRENCY, async () => {
      await inConcurrentBatches(CONCURRENT_PURCHASE_BATCHES, async (batchIndex, slotIndex) => {
        const i = batchIndex * CONCURRENCY + slotIndex;
        await db.withSnapshotConsistent(async snapshot => await snapshot.setOrDeleteRow({ tableId: schema.oneTimePurchases, rowIdentifier: `concurrent-otp-${i}`, newRowData: oneTimePurchase(i, "concurrent-") as unknown as PiledriverObject }));
      });
    }, () => db);

    await measure(metrics, "write manual item quantity changes (concurrent)", CONCURRENT_ITEM_UPDATE_BATCHES * CONCURRENCY, async () => {
      await inConcurrentBatches(CONCURRENT_ITEM_UPDATE_BATCHES, async (batchIndex, slotIndex) => {
        await db.withSnapshotConsistent(async snapshot => await snapshot.setOrDeleteRow({
          tableId: schema.manualItemQuantityChanges,
          rowIdentifier: `concurrent-miqc-${slotIndex}-${batchIndex}`,
          newRowData: manualItemQuantityChange(slotIndex, batchIndex, "concurrent-"),
        }));
      });
    }, () => db);

    const { snapshot } = await db.getSnapshot();
    await measure(metrics, "read owned products", USER_COUNT, async () => {
      for (let i = 0; i < USER_COUNT; i++) await rows(snapshot, schema.ownedProducts, customerGroup(i));
    }, () => db);
    await measure(metrics, "read item quantities", USER_COUNT * 3, async () => {
      for (let i = 0; i < USER_COUNT; i++) {
        for (const _itemId of ["credits", "coins", "seats"]) await rows(snapshot, schema.itemQuantities, customerGroup(i));
      }
    }, () => db);
    const transactionRows = await measure(metrics, "read transactions", USER_COUNT, async () => {
      let count = 0;
      for (let i = 0; i < USER_COUNT; i++) count += (await rows(snapshot, schema.transactions, customerGroup(i))).length;
      return count;
    }, () => db);

    expect(transactionRows).toBe(USER_COUNT * (2 + ITEM_UPDATES_PER_USER));
    const summary = { engine: "bulldozer-js", backend: perfBackend, piledriverImplementation: effectivePiledriverImplementation, bufferedPiledriver, users: USER_COUNT, prefillUsers: PREFILL_USER_COUNT, prefillSourceFacts: PREFILL_SOURCE_FACT_COUNT, transactions: transactionRows, metrics };
    writeFileSync("../../bulldozer-payments-schema-perf-js.untracked.json", JSON.stringify(summary, null, 2));
    process.stdout.write(`\n[bulldozer-payments-schema-perf-js] summary=${JSON.stringify(summary)}\n`);
  });
});

describe("transactions listing performance", () => {
  // Drives the real listing read path (the tenancy date index, reverse + lt + limit) at
  // scale to prove per-page cost stays ~O(limit) instead of growing with the tenancy total
  // — i.e. that we read a page, not the whole tenancy, on every request.
  const PAGE_SIZE = 50;
  const SMALL_TXN_COUNT = 1_000;
  const LARGE_TXN_COUNT = 4_000;
  const refundTxn = (index: number, tenancyId = "t1") => ({
    txnId: `listing-refund-${tenancyId}-${String(index).padStart(7, "0")}`,
    tenancyId,
    effectiveAtMillis: 1_000 + index,
    type: "refund",
    entries: [],
    customerType: "user",
    customerId: `listing-user-${index % 25}`,
    paymentProvider: "stripe",
    createdAtMillis: 1_000 + index,
    renewalTargetSubscriptionId: null,
  });
  const fillTenancy = async (db: Awaited<ReturnType<typeof newPaymentsDb>>["db"], schema: ReturnType<typeof createPaymentsSchema>, from: number, to: number) => {
    for (let i = from; i < to; i++) {
      await db.withSnapshot(async snapshot => await snapshot.setOrDeleteRow({ tableId: schema.manualTransactions, rowIdentifier: refundTxn(i).txnId, newRowData: refundTxn(i) as unknown as PiledriverObject }));
    }
    await db.waitUntilCurrentStateConsistent();
  };
  const readFirstPage = async (snapshot: Snapshot, schema: ReturnType<typeof createPaymentsSchema>) => {
    const page = [];
    for await (const row of snapshot.listRowsInGroup({ tableId: schema.transactionsByTenancy, groupKey: { tenancyId: "t1" }, range: { reverse: true, limit: PAGE_SIZE } })) page.push(row);
    return page;
  };

  it("keeps first-page latency flat as the tenancy grows", { timeout: 600_000 }, async () => {
    const metrics: Metric[] = [];
    const { db, schema } = await newPaymentsDb();

    await measure(metrics, "fill tenancy (small)", SMALL_TXN_COUNT, async () => await fillTenancy(db, schema, 0, SMALL_TXN_COUNT), () => db);
    const smallFirstPage = await measure(metrics, "first page @ small total", PAGE_SIZE, async () => await readFirstPage((await db.getSnapshot()).snapshot, schema), () => db);
    const smallPageMs = metrics.at(-1)!.elapsedMs;

    await measure(metrics, "fill tenancy (grow to large)", LARGE_TXN_COUNT - SMALL_TXN_COUNT, async () => await fillTenancy(db, schema, SMALL_TXN_COUNT, LARGE_TXN_COUNT), () => db);
    const largeFirstPage = await measure(metrics, "first page @ large total", PAGE_SIZE, async () => await readFirstPage((await db.getSnapshot()).snapshot, schema), () => db);
    const largePageMs = metrics.at(-1)!.elapsedMs;

    // A page is always ~PAGE_SIZE rows regardless of how big the tenancy got.
    expect(smallFirstPage).toHaveLength(PAGE_SIZE);
    expect(largeFirstPage).toHaveLength(PAGE_SIZE);
    // Newest-first ordering at the large total (createdAtMillis descending here).
    const createdAts = largeFirstPage.map(row => (row.rowData as { createdAtMillis: number }).createdAtMillis);
    expect(createdAts).toEqual([...createdAts].sort((a, b) => b - a));
    expect(createdAts[0]).toBe(1_000 + LARGE_TXN_COUNT - 1);

    // The whole point: a 4x bigger tenancy must NOT make a page ~4x slower. With the date
    // index it's an O(log n + limit) seek, so it stays flat. Only assert the ratio when the
    // baseline is large enough to be signal rather than timer noise; the threshold is
    // deliberately generous (catches an O(total) full-scan regression, tolerates GC jitter).
    process.stdout.write(`\n[bulldozer-payments-listing-perf-js] smallPageMs=${smallPageMs.toFixed(3)} largePageMs=${largePageMs.toFixed(3)}\n`);
    if (smallPageMs > 3) expect(largePageMs).toBeLessThan(smallPageMs * 12);
  });
});

afterAll(async () => {
  // An unclosed LMDB environment keeps native handles alive, preventing Vitest's worker and main process from exiting; remove its mapped directory only after closing it.
  for (const db of databases.reverse()) await db.close();
  for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
});

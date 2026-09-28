import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { declareBulldozerDatabase } from "../../databases/bulldozer/index.js";
import { declareInstantAvailabilityLowLevelDatabase } from "../../databases/low-level/implementations/instant-availability.js";
import { declareLmdbLowLevelDatabase } from "../../databases/low-level/implementations/lmdb.js";
import { declareBasePiledriverDatabase } from "../../databases/piledriver/implementations/base.js";
import type { PiledriverObject } from "../../databases/piledriver/index.js";
import { createPaymentsSchema } from "./index.js";
import type { ProductSnapshot, SubscriptionRow } from "./types.js";

const MONTH_MS = 2_592_000_000;
const tempPaths: string[] = [];

const product = (includedItems: ProductSnapshot["includedItems"]): ProductSnapshot => ({
  displayName: "Compression Product",
  customerType: "user",
  productLineId: "line-compress",
  prices: { p1: { USD: "10.00" } },
  includedItems,
});

const subscription = (tenancyId: string, customerId: string, id: string): SubscriptionRow => ({
  id,
  tenancyId,
  customerId,
  customerType: "user",
  productId: `prod-${id}`,
  priceId: "p1",
  product: product({
    credits: { quantity: 100, expires: "never" },
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
  createdAtMillis: 1_000,
});

const otp = (tenancyId: string, customerId: string, id: string) => ({
  id,
  tenancyId,
  customerId,
  customerType: "user" as const,
  productId: `prod-${id}`,
  priceId: "p1",
  product: product({ coins: { quantity: 50, expires: "never" } }),
  quantity: 1,
  stripePaymentIntentId: null,
  revokedAtMillis: null,
  refundedAtMillis: null,
  creationSource: "TEST_MODE",
  createdAtMillis: 2_000,
});

const miqc = (tenancyId: string, customerId: string, id: string) => ({
  id,
  tenancyId,
  customerId,
  customerType: "user" as const,
  itemId: "credits",
  quantity: 7,
  description: null,
  expiresAtMillis: null,
  createdAtMillis: 3_000,
});

async function newPaymentsLmdb(compression: boolean) {
  const path = await mkdtemp(join(tmpdir(), `bulldozer-payments-lmdb-${compression ? "c" : "u"}-`));
  tempPaths.push(path);
  const schema = createPaymentsSchema();
  const low = declareInstantAvailabilityLowLevelDatabase(declareLmdbLowLevelDatabase({ path, compression }));
  const db = declareBulldozerDatabase(declareBasePiledriverDatabase(low), { migrations: schema.migrations });
  await db.applyRemainingMigrations();
  return { path, schema, low, db };
}

async function collectOwned(db: Awaited<ReturnType<typeof newPaymentsLmdb>>["db"], schema: ReturnType<typeof createPaymentsSchema>, group: PiledriverObject) {
  const { snapshot } = await db.getSnapshot();
  const rows = [];
  for await (const row of snapshot.listRowsInGroup({ tableId: schema.ownedProducts, groupKey: group, range: {} })) {
    rows.push(row.rowData);
  }
  return rows;
}

async function collectQuantities(db: Awaited<ReturnType<typeof newPaymentsLmdb>>["db"], schema: ReturnType<typeof createPaymentsSchema>, group: PiledriverObject) {
  const { snapshot } = await db.getSnapshot();
  const rows = [];
  for await (const row of snapshot.listRowsInGroup({ tableId: schema.itemQuantities, groupKey: group, range: {} })) {
    rows.push(row.rowData);
  }
  return rows;
}

describe("payments schema on compressed LMDB", () => {
  it("writes sub/otp/miqc and derives owned products + item quantities", { timeout: 60_000 }, async () => {
    const { schema, low, db } = await newPaymentsLmdb(true);
    try {
      const tenancyId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const customerId = "user-1";
      const group = { tenancyId, customerType: "user", customerId };

      await db.withSnapshot(async (snapshot) => await snapshot.setOrDeleteRow({
        tableId: schema.subscriptions,
        rowIdentifier: "sub-1",
        newRowData: subscription(tenancyId, customerId, "sub-1") as unknown as PiledriverObject,
      }));
      await db.withSnapshot(async (snapshot) => await snapshot.setOrDeleteRow({
        tableId: schema.oneTimePurchases,
        rowIdentifier: "otp-1",
        newRowData: otp(tenancyId, customerId, "otp-1") as unknown as PiledriverObject,
      }));
      await db.withSnapshot(async (snapshot) => await snapshot.setOrDeleteRow({
        tableId: schema.manualItemQuantityChanges,
        rowIdentifier: "miqc-1",
        newRowData: miqc(tenancyId, customerId, "miqc-1") as unknown as PiledriverObject,
      }));
      await db.waitUntilCurrentStateDurable();

      const owned = await collectOwned(db, schema, group);
      const quantities = await collectQuantities(db, schema, group);
      expect(owned.length).toBeGreaterThan(0);
      expect(quantities.length).toBeGreaterThan(0);

      const latestQuantities = quantities.at(-1) as { itemQuantities: Record<string, number> };
      expect(latestQuantities.itemQuantities.credits).toBe(107);
      expect(latestQuantities.itemQuantities.coins).toBe(50);
    } finally {
      await low.close();
    }
  });

  it("can reopen an uncompressed store with compression=true and keep reading/writing", { timeout: 60_000 }, async () => {
    const path = await mkdtemp(join(tmpdir(), "bulldozer-payments-reopen-"));
    tempPaths.push(path);
    const schema = createPaymentsSchema();
    const tenancyId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const customerId = "user-reopen";
    const group = { tenancyId, customerType: "user", customerId };

    {
      const low = declareInstantAvailabilityLowLevelDatabase(declareLmdbLowLevelDatabase({ path, compression: false }));
      const db = declareBulldozerDatabase(declareBasePiledriverDatabase(low), { migrations: schema.migrations });
      await db.applyRemainingMigrations();
      await db.withSnapshot(async (snapshot) => await snapshot.setOrDeleteRow({
        tableId: schema.subscriptions,
        rowIdentifier: "sub-old",
        newRowData: subscription(tenancyId, customerId, "sub-old") as unknown as PiledriverObject,
      }));
      await db.waitUntilCurrentStateDurable();
      await low.close();
    }

    const low2 = declareInstantAvailabilityLowLevelDatabase(declareLmdbLowLevelDatabase({ path, compression: true }));
    try {
      const db2 = declareBulldozerDatabase(declareBasePiledriverDatabase(low2), { migrations: schema.migrations });
      await db2.applyRemainingMigrations();
      const ownedBefore = await collectOwned(db2, schema, group);
      expect(ownedBefore.length).toBe(1);

      await db2.withSnapshot(async (snapshot) => await snapshot.setOrDeleteRow({
        tableId: schema.oneTimePurchases,
        rowIdentifier: "otp-new",
        newRowData: otp(tenancyId, customerId, "otp-new") as unknown as PiledriverObject,
      }));
      await db2.waitUntilCurrentStateDurable();

      const ownedAfter = await collectOwned(db2, schema, group);
      const quantities = await collectQuantities(db2, schema, group);
      expect(ownedAfter.length).toBe(2);
      expect(quantities.length).toBeGreaterThan(0);
    } finally {
      await low2.close();
    }
  });
});

afterAll(async () => {
  for (const path of tempPaths) await rm(path, { recursive: true, force: true });
});

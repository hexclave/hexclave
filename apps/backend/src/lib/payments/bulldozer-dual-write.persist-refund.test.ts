import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ManualTransactionRow } from "@/lib/payments/schema/types";

const { fetchBulldozerServerJsonMock } = vi.hoisted(() => ({
  fetchBulldozerServerJsonMock: vi.fn(),
}));

vi.mock("@/lib/bulldozer-server-client", () => ({
  fetchBulldozerServerJson: fetchBulldozerServerJsonMock,
  bulldozerCustomerPath: () => {
    throw new Error("unused in persistRefundManualTransaction tests");
  },
}));

import { persistRefundManualTransaction } from "./bulldozer-dual-write";

type StoredPrismaRow = {
  tenancyId: string,
  txnId: string,
  type: string,
  customerId: string,
  customerType: string,
  paymentProvider: string | null,
  effectiveAt: Date,
  createdAt: Date,
  entries: unknown,
};

/**
 * In-memory stand-in for Prisma's ManualTransaction upsert. Models the
 * Prisma-ok / Bulldozer-fail retry: the first create sticks, and a later
 * conflict with `update: {}` must leave that row untouched.
 */
function createInMemoryManualTransactionStore() {
  const rows = new Map<string, StoredPrismaRow>();
  const upsertCalls: Array<{ create: StoredPrismaRow, update: Record<string, unknown> }> = [];

  return {
    upsertCalls,
    rows,
    client: {
      manualTransaction: {
        upsert: async (args: {
          where: { tenancyId_txnId: { tenancyId: string, txnId: string } },
          create: StoredPrismaRow,
          update: Record<string, unknown>,
        }) => {
          upsertCalls.push({ create: args.create, update: args.update });
          const key = `${args.where.tenancyId_txnId.tenancyId}\0${args.where.tenancyId_txnId.txnId}`;
          const existing = rows.get(key);
          if (existing == null) {
            rows.set(key, { ...args.create });
            return { ...args.create };
          }
          // Mirror Prisma: apply only keys present on `update`. Empty update
          // leaves the canonical first row intact.
          const next = { ...existing, ...args.update };
          rows.set(key, next);
          return { ...next };
        },
      },
    },
  };
}

function refundRow(overrides: Partial<ManualTransactionRow> = {}): ManualTransactionRow {
  return {
    txnId: "refund:otp:purchase-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tenancyId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    effectiveAtMillis: 1_000,
    createdAtMillis: 1_000,
    type: "refund",
    customerType: "user",
    customerId: "user-1",
    paymentProvider: "stripe",
    entries: [{
      type: "money-transfer",
      customerType: "user",
      customerId: "user-1",
      chargedAmount: { USD: "2.39" },
    }],
    ...overrides,
  };
}

describe("persistRefundManualTransaction", () => {
  beforeEach(() => {
    fetchBulldozerServerJsonMock.mockReset();
    fetchBulldozerServerJsonMock.mockResolvedValue({ success: true });
  });

  test("first write creates the Prisma row and posts that same payload to Bulldozer", async () => {
    const store = createInMemoryManualTransactionStore();
    const first = refundRow();

    await persistRefundManualTransaction(store.client, first);

    expect(store.upsertCalls).toHaveLength(1);
    expect(store.upsertCalls[0].update).toEqual({});
    expect(fetchBulldozerServerJsonMock).toHaveBeenCalledTimes(1);
    const body = fetchBulldozerServerJsonMock.mock.calls[0][0].body as { rowData: ManualTransactionRow };
    expect(body.rowData.txnId).toBe(first.txnId);
    expect(body.rowData.effectiveAtMillis).toBe(1_000);
    expect(body.rowData.entries).toEqual(first.entries);
  });

  test("same-txnId retry keeps the first Prisma row and dual-writes that canonical row (not retry-time values)", async () => {
    // Reproduces the Prisma-ok / Bulldozer-fail → retry path: first attempt
    // landed in Postgres; second attempt recomputes nowMillis / entries.
    const store = createInMemoryManualTransactionStore();
    const first = refundRow({
      effectiveAtMillis: 1_000,
      createdAtMillis: 1_000,
      entries: [{
        type: "money-transfer",
        customerType: "user",
        customerId: "user-1",
        chargedAmount: { USD: "2.39" },
      }],
    });
    const retry = refundRow({
      effectiveAtMillis: 9_999,
      createdAtMillis: 9_999,
      entries: [{
        type: "money-transfer",
        customerType: "user",
        customerId: "user-1",
        chargedAmount: { USD: "2.39" },
      }, {
        // Retry-time recomputation could add expiry entries if grants moved;
        // those must not replace the first ledger snapshot under the same id.
        type: "item-quantity-expire",
        customerType: "user",
        customerId: "user-1",
        adjustedTransactionId: "otp:purchase-1",
        adjustedEntryIndex: 1,
        itemId: "credits",
        quantity: 10,
      }],
    });

    await persistRefundManualTransaction(store.client, first);
    fetchBulldozerServerJsonMock.mockClear();

    await persistRefundManualTransaction(store.client, retry);

    expect(store.upsertCalls).toHaveLength(2);
    expect(store.upsertCalls[1].update).toEqual({});

    const key = `${first.tenancyId}\0${first.txnId}`;
    const persisted = store.rows.get(key);
    expect(persisted).toBeDefined();
    expect(persisted?.effectiveAt.getTime()).toBe(1_000);
    expect(persisted?.createdAt.getTime()).toBe(1_000);
    expect(persisted?.entries).toEqual(first.entries);

    expect(fetchBulldozerServerJsonMock).toHaveBeenCalledTimes(1);
    const body = fetchBulldozerServerJsonMock.mock.calls[0][0].body as { rowData: ManualTransactionRow };
    // Critically: Bulldozer receives the canonical first row, not `retry`.
    expect(body.rowData.effectiveAtMillis).toBe(1_000);
    expect(body.rowData.createdAtMillis).toBe(1_000);
    expect(body.rowData.entries).toEqual(first.entries);
    expect(body.rowData.entries).not.toEqual(retry.entries);
  });

  test("Bulldozer failure after Prisma create leaves the canonical row for a later retry", async () => {
    const store = createInMemoryManualTransactionStore();
    const first = refundRow({ effectiveAtMillis: 1_000, createdAtMillis: 1_000 });
    const retry = refundRow({ effectiveAtMillis: 5_000, createdAtMillis: 5_000 });

    fetchBulldozerServerJsonMock.mockRejectedValueOnce(new Error("bulldozer unavailable"));
    await expect(persistRefundManualTransaction(store.client, first)).rejects.toThrow("bulldozer unavailable");

    fetchBulldozerServerJsonMock.mockResolvedValueOnce({ success: true });
    await persistRefundManualTransaction(store.client, retry);

    const key = `${first.tenancyId}\0${first.txnId}`;
    expect(store.rows.get(key)?.effectiveAt.getTime()).toBe(1_000);
    const body = fetchBulldozerServerJsonMock.mock.calls[1][0].body as { rowData: ManualTransactionRow };
    expect(body.rowData.effectiveAtMillis).toBe(1_000);
  });
});

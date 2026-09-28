import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ManualTransactionRow } from "@/lib/payments/schema/types";

const { fetchPageMock, upsertMock } = vi.hoisted(() => ({
  fetchPageMock: vi.fn(),
  upsertMock: vi.fn(),
}));

vi.mock("@/lib/bulldozer-server-client", () => ({
  fetchBulldozerManualTransactionsPage: fetchPageMock,
}));

vi.mock("@/lib/payments/bulldozer-dual-write", () => ({
  manualTransactionToPrismaRow: (row: ManualTransactionRow) => ({
    tenancyId: row.tenancyId,
    txnId: row.txnId,
    type: row.type,
    customerId: row.customerId,
    customerType: "USER",
    paymentProvider: row.paymentProvider,
    effectiveAt: new Date(row.effectiveAtMillis),
    createdAt: new Date(row.createdAtMillis),
    entries: row.entries,
  }),
}));

vi.mock("@/prisma-client", () => ({
  globalPrismaClient: {
    manualTransaction: { upsert: upsertMock },
  },
}));

import { runExportBulldozerManualTransactionsToPrisma } from "./export-bulldozer-manual-transactions-to-prisma";

function row(txnId: string, tenancyId: string): ManualTransactionRow {
  return {
    txnId,
    tenancyId,
    effectiveAtMillis: 1,
    createdAtMillis: 1,
    type: "refund",
    customerType: "user",
    customerId: "u1",
    paymentProvider: "stripe",
    entries: [],
  };
}

describe("runExportBulldozerManualTransactionsToPrisma", () => {
  beforeEach(() => {
    fetchPageMock.mockReset();
    upsertMock.mockReset();
    upsertMock.mockResolvedValue(undefined);
  });

  test("pages until next_cursor is null and upserts each row", async () => {
    const tenA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const tenB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    fetchPageMock
      .mockResolvedValueOnce({ rows: [row("t1", tenA)], next_cursor: "t1" })
      .mockResolvedValueOnce({ rows: [row("t2", tenB)], next_cursor: null });

    const result = await runExportBulldozerManualTransactionsToPrisma({ batchSize: 10 });

    expect(result).toEqual({ upserted: 2, skipped: 0, failed: 0 });
    expect(fetchPageMock).toHaveBeenCalledTimes(2);
    expect(fetchPageMock).toHaveBeenNthCalledWith(1, { limit: 10, cursor: null });
    expect(fetchPageMock).toHaveBeenNthCalledWith(2, { limit: 10, cursor: "t1" });
    expect(upsertMock).toHaveBeenCalledTimes(2);
  });

  test("clamps batch size to GET max 200 and still pages", async () => {
    const tenA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    fetchPageMock.mockResolvedValue({ rows: [row("t1", tenA)], next_cursor: null });

    await runExportBulldozerManualTransactionsToPrisma({ batchSize: 500 });

    expect(fetchPageMock).toHaveBeenCalledWith({ limit: 200, cursor: null });
  });

  test("fails loud when next_cursor does not advance", async () => {
    const tenA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    fetchPageMock
      .mockResolvedValueOnce({ rows: [row("t1", tenA)], next_cursor: "t1" })
      .mockResolvedValueOnce({ rows: [row("t1", tenA)], next_cursor: "t1" });

    await expect(runExportBulldozerManualTransactionsToPrisma({ batchSize: 10 })).rejects.toThrow(
      "Export cursor failed to advance at t1",
    );
    expect(fetchPageMock).toHaveBeenCalledTimes(2);
  });

  test("re-run upserts again (idempotent at Prisma)", async () => {
    const tenA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    fetchPageMock.mockResolvedValue({ rows: [row("t1", tenA)], next_cursor: null });

    await runExportBulldozerManualTransactionsToPrisma();
    await runExportBulldozerManualTransactionsToPrisma();

    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock.mock.calls[0][0].create.txnId).toBe("t1");
    expect(upsertMock.mock.calls[1][0].create.txnId).toBe("t1");
  });

  test("skips excluded tenancies without upserting", async () => {
    const tenA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const tenB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    fetchPageMock.mockResolvedValue({
      rows: [row("t1", tenA), row("t2", tenB)],
      next_cursor: null,
    });

    const result = await runExportBulldozerManualTransactionsToPrisma({
      excludeTenancyIds: [tenA],
    });

    expect(result).toEqual({ upserted: 1, skipped: 1, failed: 0 });
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(upsertMock.mock.calls[0][0].create.txnId).toBe("t2");
  });

  test("skips every tenancy in a multi-id exclude list", async () => {
    const tenA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const tenB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const tenC = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    fetchPageMock.mockResolvedValue({
      rows: [row("t1", tenA), row("t2", tenB), row("t3", tenC)],
      next_cursor: null,
    });

    const result = await runExportBulldozerManualTransactionsToPrisma({
      excludeTenancyIds: [tenA, tenB],
    });

    expect(result).toEqual({ upserted: 1, skipped: 2, failed: 0 });
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(upsertMock.mock.calls[0][0].create).toMatchObject({ tenancyId: tenC, txnId: "t3" });
  });
});

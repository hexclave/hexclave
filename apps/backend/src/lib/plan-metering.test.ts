import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bulldozerWriteItemQuantityChanges: vi.fn(),
  getItemQuantitiesForCustomer: vi.fn(),
  createMany: vi.fn(),
  deleteMany: vi.fn(),
  findMany: vi.fn(),
  ensureCustomerExists: vi.fn(),
  getPrismaClientForTenancy: vi.fn(),
  executeRaw: vi.fn(),
  retryTransaction: vi.fn(),
}));

vi.mock("@/lib/payments", () => ({
  ensureCustomerExists: mocks.ensureCustomerExists,
}));

vi.mock("@/lib/payments/bulldozer-dual-write", () => ({
  bulldozerWriteItemQuantityChanges: mocks.bulldozerWriteItemQuantityChanges,
}));

vi.mock("@/lib/payments/customer-data", () => ({
  getItemQuantitiesForCustomer: mocks.getItemQuantitiesForCustomer,
}));

vi.mock("@/prisma-client", () => ({
  getPrismaClientForTenancy: mocks.getPrismaClientForTenancy,
  retryTransaction: mocks.retryTransaction,
}));

vi.mock("./tenancies", () => ({
  DEFAULT_BRANCH_ID: "main",
  getSoleTenancyFromProjectBranch: vi.fn(async () => ({
    id: "internal-tenancy",
    config: {
      payments: {
        items: {
          analytics_events: { customerType: "team" },
          analytics_spans: { customerType: "team" },
          session_replays: { customerType: "team" },
          analytics_timeout_seconds: { customerType: "team" },
        },
      },
    },
  })),
}));

import { rollbackPlanItemDebits, tryDecreasePlanItemQuantities } from "./plan-metering";

describe("plan metering persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPrismaClientForTenancy.mockResolvedValue({});
    mocks.bulldozerWriteItemQuantityChanges.mockResolvedValue(undefined);
    mocks.getItemQuantitiesForCustomer.mockResolvedValue({
      [ITEM_IDS.analyticsEvents]: 1_000_000,
      [ITEM_IDS.analyticsSpans]: 1_000_000,
      [ITEM_IDS.sessionReplays]: 1_000_000,
    });
    mocks.createMany.mockResolvedValue({ count: 1 });
    mocks.deleteMany.mockResolvedValue({ count: 1 });
    mocks.findMany.mockResolvedValue([]);
    mocks.executeRaw.mockResolvedValue(0);
    mocks.retryTransaction.mockImplementation(async (_prisma, callback) => await callback({
      $executeRaw: mocks.executeRaw,
      itemQuantityChange: {
        createMany: mocks.createMany,
        deleteMany: mocks.deleteMany,
        findMany: mocks.findMany,
      },
    }));
  });

  it("rolls back the original retry-stable debit without exposing a temporary credit", async () => {
    const debit = {
      itemId: ITEM_IDS.analyticsEvents,
      quantity: 3,
      idempotency: { key: "analytics-events:tenancy:batch", createdAt: new Date("2026-08-04T12:00:00.123Z") },
    };
    const debitResult = await tryDecreasePlanItemQuantities("billing-team", [debit]);
    const originalChange = mocks.bulldozerWriteItemQuantityChanges.mock.calls[0][0][0];

    await rollbackPlanItemDebits("billing-team", [debit], new Set(debitResult.createdChangeIds));

    expect(mocks.bulldozerWriteItemQuantityChanges).toHaveBeenNthCalledWith(2, [{
      ...originalChange,
      quantity: 0,
    }]);
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { tenancyId: "internal-tenancy", id: { in: [originalChange.id] } },
    });
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
  });

  it("holds the customer lock while persisting a debit and does not write if Postgres fails", async () => {
    const persistenceError = new Error("Postgres unavailable");
    mocks.createMany.mockRejectedValueOnce(persistenceError);

    await expect(tryDecreasePlanItemQuantities("billing-team", [{
      itemId: ITEM_IDS.analyticsEvents,
      quantity: 1,
      idempotency: { key: "batch", createdAt: new Date("2026-08-04T12:00:00.123Z") },
    }])).rejects.toBe(persistenceError);

    const lockOrder = mocks.executeRaw.mock.invocationCallOrder.at(0);
    const createOrder = mocks.createMany.mock.invocationCallOrder.at(0);
    if (lockOrder === undefined || createOrder === undefined) throw new Error("Expected lock and persist calls");
    expect(lockOrder).toBeLessThan(createOrder);
    expect(mocks.bulldozerWriteItemQuantityChanges).not.toHaveBeenCalled();
  });

  it("uses the same valid UUID row and timestamp for an idempotent telemetry debit retry", async () => {
    const createdAt = new Date("2026-08-04T12:00:00.123Z");
    const idempotency = {
      key: "otlp-span:0123456789abcdef0123456789abcdef:0123456789abcdef",
      createdAt,
    };

    await tryDecreasePlanItemQuantities("billing-team", [{ itemId: ITEM_IDS.analyticsSpans, quantity: 1, idempotency }]);
    const firstChange = mocks.bulldozerWriteItemQuantityChanges.mock.calls[0][0][0];
    mocks.findMany.mockResolvedValueOnce([firstChange]);
    await tryDecreasePlanItemQuantities("billing-team", [{ itemId: ITEM_IDS.analyticsSpans, quantity: 1, idempotency }]);

    const retryChange = mocks.bulldozerWriteItemQuantityChanges.mock.calls[1][0][0];
    expect(firstChange.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(retryChange).toEqual(firstChange);
    expect(firstChange.createdAt).toEqual(createdAt);
  });

  it("does not let an idempotent retry claim or roll back another invocation's debit", async () => {
    const debit = {
      itemId: ITEM_IDS.sessionReplays,
      quantity: 1,
      idempotency: { key: "session-replay:tenancy:batch", createdAt: new Date("2026-08-04T12:00:00.123Z") },
    };
    const first = await tryDecreasePlanItemQuantities("billing-team", [debit]);
    const createdChangeId = first.createdChangeIds.at(0);
    if (createdChangeId === undefined) throw new Error("Expected the first debit to own a plan change");

    mocks.findMany.mockResolvedValueOnce([{ id: createdChangeId }]);
    const retry = await tryDecreasePlanItemQuantities("billing-team", [debit]);
    expect(retry.createdChangeIds).toEqual([]);
    expect(mocks.bulldozerWriteItemQuantityChanges).toHaveBeenCalledTimes(2);

    await rollbackPlanItemDebits("billing-team", [debit], new Set(retry.createdChangeIds));
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("zeroes posted Bulldozer rows when the Postgres transaction fails to commit", async () => {
    const commitError = new Error("Transaction timed out");
    const committedFindMany = vi.fn().mockResolvedValue([]);
    mocks.getPrismaClientForTenancy.mockResolvedValue({ itemQuantityChange: { findMany: committedFindMany } });
    mocks.retryTransaction.mockImplementationOnce(async (_prisma, callback) => {
      await callback({
        $executeRaw: mocks.executeRaw,
        itemQuantityChange: {
          createMany: mocks.createMany,
          deleteMany: mocks.deleteMany,
          findMany: mocks.findMany,
        },
      });
      throw commitError;
    });

    await expect(tryDecreasePlanItemQuantities("billing-team", [{
      itemId: ITEM_IDS.analyticsEvents,
      quantity: 2,
    }])).rejects.toBe(commitError);

    const postedChange = mocks.bulldozerWriteItemQuantityChanges.mock.calls[0][0][0];
    expect(committedFindMany).toHaveBeenCalledWith({
      where: { tenancyId: "internal-tenancy", id: { in: [postedChange.id] } },
      select: { id: true },
    });
    expect(mocks.bulldozerWriteItemQuantityChanges).toHaveBeenNthCalledWith(2, [{ ...postedChange, quantity: 0 }]);
  });

  it("refuses a debit that would take a plan item below zero", async () => {
    mocks.getItemQuantitiesForCustomer.mockResolvedValueOnce({
      [ITEM_IDS.analyticsEvents]: 1,
    });

    const result = await tryDecreasePlanItemQuantities("billing-team", [{
      itemId: ITEM_IDS.analyticsEvents,
      quantity: 2,
    }]);

    expect(result).toEqual({ insufficientItemId: ITEM_IDS.analyticsEvents, createdChangeIds: [] });
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(mocks.bulldozerWriteItemQuantityChanges).not.toHaveBeenCalled();
  });

  it("coalesces concurrent debits for one customer into a single locked transaction", async () => {
    const debit = { itemId: ITEM_IDS.analyticsEvents, quantity: 1 } as const;
    const results = await Promise.all([
      tryDecreasePlanItemQuantities("billing-team", [debit]),
      tryDecreasePlanItemQuantities("billing-team", [debit]),
      tryDecreasePlanItemQuantities("billing-team", [debit]),
    ]);

    expect(results.every((result) => result.insufficientItemId === null && result.createdChangeIds.length === 1)).toBe(true);
    expect(new Set(results.flatMap((result) => result.createdChangeIds)).size).toBe(3);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.bulldozerWriteItemQuantityChanges).toHaveBeenCalledTimes(1);
    expect(mocks.bulldozerWriteItemQuantityChanges.mock.calls[0][0]).toHaveLength(3);
  });

  it("rejects only the coalesced debit that exceeds the remaining balance", async () => {
    mocks.getItemQuantitiesForCustomer.mockResolvedValue({ [ITEM_IDS.analyticsEvents]: 2 });
    const results = await Promise.all([
      tryDecreasePlanItemQuantities("billing-team", [{ itemId: ITEM_IDS.analyticsEvents, quantity: 1 }]),
      tryDecreasePlanItemQuantities("billing-team", [{ itemId: ITEM_IDS.analyticsEvents, quantity: 5 }]),
      tryDecreasePlanItemQuantities("billing-team", [{ itemId: ITEM_IDS.analyticsEvents, quantity: 1 }]),
    ]);

    expect(results.map((result) => result.insufficientItemId)).toEqual([null, ITEM_IDS.analyticsEvents, null]);
    expect(results[1].createdChangeIds).toEqual([]);
    expect(mocks.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it("isolates a failing coalesced batch by retrying each debit on its own", async () => {
    const persistenceError = new Error("batch failed");
    mocks.createMany.mockRejectedValueOnce(persistenceError);
    const results = await Promise.all([
      tryDecreasePlanItemQuantities("billing-team", [{ itemId: ITEM_IDS.analyticsEvents, quantity: 1 }]),
      tryDecreasePlanItemQuantities("billing-team", [{ itemId: ITEM_IDS.analyticsEvents, quantity: 1 }]),
    ]);

    expect(results.every((result) => result.createdChangeIds.length === 1)).toBe(true);
    expect(mocks.createMany).toHaveBeenCalledTimes(3);
    expect(mocks.bulldozerWriteItemQuantityChanges).toHaveBeenCalledTimes(2);
  });

  it("reverts a rolled-back attempt's Bulldozer rows before the retry reads the balance", async () => {
    let bulldozerBalance = 1;
    const bulldozerRows = new Map<string, number>();
    mocks.bulldozerWriteItemQuantityChanges.mockImplementation(async (changes: { id: string, quantity: number }[]) => {
      for (const change of changes) {
        bulldozerBalance += change.quantity - (bulldozerRows.get(change.id) ?? 0);
        bulldozerRows.set(change.id, change.quantity);
      }
    });
    mocks.getItemQuantitiesForCustomer.mockImplementation(async () => ({ [ITEM_IDS.analyticsEvents]: bulldozerBalance }));
    mocks.retryTransaction.mockImplementationOnce(async (_prisma, callback) => {
      const tx = {
        $executeRaw: mocks.executeRaw,
        itemQuantityChange: { createMany: mocks.createMany, deleteMany: mocks.deleteMany, findMany: mocks.findMany },
      };
      await callback(tx);
      return await callback(tx);
    });

    const result = await tryDecreasePlanItemQuantities("billing-team", [{ itemId: ITEM_IDS.analyticsEvents, quantity: 1 }]);

    expect(result.insufficientItemId).toBeNull();
    expect(result.createdChangeIds).toHaveLength(1);
    expect(bulldozerBalance).toBe(0);
  });

  it("zeroes Bulldozer rows posted by a retried attempt that the committed attempt rejected", async () => {
    mocks.getItemQuantitiesForCustomer
      .mockResolvedValueOnce({ [ITEM_IDS.analyticsEvents]: 10 })
      .mockResolvedValueOnce({ [ITEM_IDS.analyticsEvents]: 0 });
    mocks.retryTransaction.mockImplementationOnce(async (_prisma, callback) => {
      const tx = {
        $executeRaw: mocks.executeRaw,
        itemQuantityChange: { createMany: mocks.createMany, deleteMany: mocks.deleteMany, findMany: mocks.findMany },
      };
      await callback(tx);
      return await callback(tx);
    });

    const result = await tryDecreasePlanItemQuantities("billing-team", [{ itemId: ITEM_IDS.analyticsEvents, quantity: 1 }]);

    expect(result.insufficientItemId).toBe(ITEM_IDS.analyticsEvents);
    const posted = mocks.bulldozerWriteItemQuantityChanges.mock.calls[0][0][0];
    expect(mocks.bulldozerWriteItemQuantityChanges).toHaveBeenLastCalledWith([{ ...posted, quantity: 0 }]);
  });
});

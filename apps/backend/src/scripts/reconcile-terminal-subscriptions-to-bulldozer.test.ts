import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  parseReconcileTerminalSubscriptionsArgs,
  runReconcileTerminalSubscriptionsToBulldozer,
  type ReconcileTerminalSubscriptionsDependencies,
} from "../../scripts/reconcile-terminal-subscriptions-to-bulldozer";

type SubscriptionRow = Parameters<ReconcileTerminalSubscriptionsDependencies["writeSubscriptions"]>[0][number];

function subscription(id: string, tenancyId: string): SubscriptionRow {
  const endedAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    id,
    tenancyId,
    customerId: `customer-${id}`,
    customerType: "TEAM",
    productId: "team",
    priceId: "monthly",
    product: {
      displayName: "Team",
      customerType: "team",
      productLineId: "plans",
      prices: { monthly: { USD: "10.00" } },
      includedItems: {},
    },
    quantity: 1,
    stripeSubscriptionId: null,
    status: "canceled",
    currentPeriodStart: new Date("2025-12-01T00:00:00.000Z"),
    currentPeriodEnd: endedAt,
    cancelAtPeriodEnd: true,
    canceledAt: endedAt,
    endedAt,
    refundedAt: null,
    productRevokedAt: null,
    creationSource: "PURCHASE_PAGE",
    createdAt: new Date("2025-12-01T00:00:00.000Z"),
  };
}

function dependencies(
  overrides: Partial<ReconcileTerminalSubscriptionsDependencies> = {},
): ReconcileTerminalSubscriptionsDependencies {
  return {
    countTerminalSubscriptionsWithoutEndedAt: vi.fn(async () => 0),
    fetchTerminalSubscriptionBatch: vi.fn(async () => []),
    writeSubscriptions: vi.fn(async () => undefined),
    settleBulldozerTimeFolds: vi.fn(async () => undefined),
    getInternalBillingTenancyId: vi.fn(async () => "internal-tenancy"),
    fetchExpiredInternalSubscriptionBatch: vi.fn(async () => []),
    filterExistingBillingTeamIds: vi.fn(async (_internalTenancyId, billingTeamIds) => billingTeamIds),
    ensureFreePlan: vi.fn(async () => false),
    now: () => new Date("2026-02-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("parseReconcileTerminalSubscriptionsArgs", () => {
  it("parses batch size and a normalized composite resume cursor", () => {
    const tenancyId = randomUUID().toUpperCase();
    const subscriptionId = randomUUID().toUpperCase();

    expect(parseReconcileTerminalSubscriptionsArgs([
      "reconcile-terminal-subscriptions-to-bulldozer",
      "--batch-size=100",
      `--resume-cursor=${tenancyId},${subscriptionId}`,
    ])).toEqual({
      batchSize: 100,
      resumeCursor: {
        tenancyId: tenancyId.toLowerCase(),
        id: subscriptionId.toLowerCase(),
      },
    });
  });

  it("rejects invalid batch sizes and cursors", () => {
    expect(() => parseReconcileTerminalSubscriptionsArgs(["--batch-size=0"]))
      .toThrow("positive integer");
    expect(() => parseReconcileTerminalSubscriptionsArgs(["--resume-cursor=not-a-cursor"]))
      .toThrow("two UUIDs");
  });
});

describe("runReconcileTerminalSubscriptionsToBulldozer", () => {
  it("fails before touching Bulldozer when the SQL migration is incomplete", async () => {
    const deps = dependencies({
      countTerminalSubscriptionsWithoutEndedAt: vi.fn(async () => 3),
    });

    await expect(runReconcileTerminalSubscriptionsToBulldozer({}, deps))
      .rejects.toThrow("3 terminal Subscription row(s) still have endedAt=NULL");
    expect(deps.fetchTerminalSubscriptionBatch).not.toHaveBeenCalled();
    expect(deps.writeSubscriptions).not.toHaveBeenCalled();
    expect(deps.settleBulldozerTimeFolds).not.toHaveBeenCalled();
  });

  it("re-emits every page before repairing expired internal teams", async () => {
    const tenancyA = randomUUID();
    const tenancyB = randomUUID();
    const first = subscription(randomUUID(), tenancyA);
    const second = subscription(randomUUID(), tenancyA);
    const third = subscription(randomUUID(), tenancyB);
    const events: string[] = [];

    const fetchTerminalSubscriptionBatch = vi.fn(async (cursor: { tenancyId: string, id: string } | null) => {
      if (cursor === null) return [first, second];
      if (cursor.tenancyId === second.tenancyId && cursor.id === second.id) return [third];
      return [];
    });
    const fetchExpiredInternalSubscriptionBatch = vi.fn(async (
      _internalTenancyId: string,
      _endedAtOrBefore: Date,
      cursorId: string | null,
    ) => {
      if (cursorId === null) {
        return [
          { id: "expired-1", customerId: "team-a" },
          { id: "expired-2", customerId: "team-a" },
        ];
      }
      if (cursorId === "expired-2") return [{ id: "expired-3", customerId: "team-b" }];
      return [];
    });
    const deps = dependencies({
      fetchTerminalSubscriptionBatch,
      writeSubscriptions: vi.fn(async (rows) => {
        events.push(`write:${rows.map((row) => row.id).join(",")}`);
      }),
      settleBulldozerTimeFolds: vi.fn(async () => {
        events.push("settle");
      }),
      fetchExpiredInternalSubscriptionBatch,
      ensureFreePlan: vi.fn(async (billingTeamId) => {
        events.push(`ensure:${billingTeamId}`);
        return billingTeamId === "team-a";
      }),
    });

    await expect(runReconcileTerminalSubscriptionsToBulldozer({ batchSize: 2 }, deps))
      .resolves.toEqual({
        subscriptionsReconciled: 3,
        freePlanCandidates: 2,
        freePlansGranted: 1,
      });

    expect(events).toEqual([
      `write:${first.id},${second.id}`,
      `write:${third.id}`,
      "settle",
      "ensure:team-a",
      "ensure:team-b",
    ]);
    expect(fetchTerminalSubscriptionBatch).toHaveBeenNthCalledWith(1, null, 2);
    expect(fetchTerminalSubscriptionBatch).toHaveBeenNthCalledWith(
      2,
      { tenancyId: second.tenancyId, id: second.id },
      2,
    );
  });

  it("is safe to run repeatedly and honors a resume cursor", async () => {
    const resumeCursor = { tenancyId: randomUUID(), id: randomUUID() };
    const corrected = subscription(randomUUID(), resumeCursor.tenancyId);
    const writes: string[] = [];
    const makeDeps = () => dependencies({
      fetchTerminalSubscriptionBatch: vi.fn(async (cursor) => {
        expect(cursor).toEqual(resumeCursor);
        return [corrected];
      }),
      writeSubscriptions: vi.fn(async (rows) => {
        writes.push(...rows.map((row) => row.id));
      }),
    });

    await runReconcileTerminalSubscriptionsToBulldozer({ batchSize: 2, resumeCursor }, makeDeps());
    await runReconcileTerminalSubscriptionsToBulldozer({ batchSize: 2, resumeCursor }, makeDeps());

    expect(writes).toEqual([corrected.id, corrected.id]);
  });

  it("fails immediately when a Bulldozer batch write fails", async () => {
    const row = subscription(randomUUID(), randomUUID());
    const deps = dependencies({
      fetchTerminalSubscriptionBatch: vi.fn(async () => [row]),
      writeSubscriptions: vi.fn(async () => {
        throw new Error("Bulldozer unavailable");
      }),
    });

    await expect(runReconcileTerminalSubscriptionsToBulldozer({ batchSize: 2 }, deps))
      .rejects.toThrow("Bulldozer unavailable");
    expect(deps.settleBulldozerTimeFolds).not.toHaveBeenCalled();
    expect(deps.ensureFreePlan).not.toHaveBeenCalled();
  });

  it("does not create a free subscription for a deleted billing team", async () => {
    const deps = dependencies({
      fetchExpiredInternalSubscriptionBatch: vi.fn(async (_tenancyId, _endedAt, cursorId) => {
        return cursorId === null ? [{ id: "expired-1", customerId: "deleted-team" }] : [];
      }),
      filterExistingBillingTeamIds: vi.fn(async () => []),
    });

    await expect(runReconcileTerminalSubscriptionsToBulldozer({ batchSize: 2 }, deps))
      .resolves.toEqual({
        subscriptionsReconciled: 0,
        freePlanCandidates: 0,
        freePlansGranted: 0,
      });
    expect(deps.ensureFreePlan).not.toHaveBeenCalled();
  });
});

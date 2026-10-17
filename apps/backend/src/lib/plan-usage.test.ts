import { ITEM_IDS, UNLIMITED } from "@hexclave/shared/dist/plans";
import { describe, expect, it } from "vitest";
import type { SubscriptionRow } from "./payments/schema/types";
import { buildUsageRow, getNextPlanId, getPlanUsagePeriod, readBillingSubscriptionMapOrSkip, resolveInEffectPlanSubscription } from "./plan-usage";

function createSubscriptionPeriod(startMillis: number, endMillis: number): SubscriptionRow {
  return {
    id: "sub_1",
    tenancyId: "tenancy_1",
    customerId: "team_1",
    customerType: "team",
    productId: "team",
    priceId: "monthly",
    product: {
      displayName: "Team",
      customerType: "team",
      prices: {},
      includedItems: {},
    },
    quantity: 1,
    stripeSubscriptionId: null,
    status: "active",
    currentPeriodStartMillis: startMillis,
    currentPeriodEndMillis: endMillis,
    cancelAtPeriodEnd: false,
    canceledAtMillis: null,
    endedAtMillis: null,
    refundedAtMillis: null,
    productRevokedAtMillis: null,
    creationSource: "TEST_MODE",
    createdAtMillis: startMillis,
  };
}

describe("buildUsageRow", () => {
  it("calculates remaining usage under the limit", () => {
    expect(buildUsageRow({
      itemId: ITEM_IDS.emailsPerMonth,
      displayName: "Emails per month",
      kind: "metered",
      used: 25,
      limit: 100,
    })).toMatchInlineSnapshot(`
      {
        "display_name": "Emails per month",
        "is_unlimited": false,
        "item_id": "emails_per_month",
        "kind": "metered",
        "limit": 100,
        "overage": 0,
        "remaining": 75,
        "used": 25,
      }
    `);
  });

  it("treats exact limit as no overage", () => {
    expect(buildUsageRow({
      itemId: ITEM_IDS.analyticsEvents,
      displayName: "Analytics events",
      kind: "metered",
      used: 100,
      limit: 100,
    })).toMatchInlineSnapshot(`
      {
        "display_name": "Analytics events",
        "is_unlimited": false,
        "item_id": "analytics_events",
        "kind": "metered",
        "limit": 100,
        "overage": 0,
        "remaining": 0,
        "used": 100,
      }
    `);
  });

  it("calculates overage when usage exceeds the limit", () => {
    expect(buildUsageRow({
      itemId: ITEM_IDS.sessionReplays,
      displayName: "Session replays",
      kind: "metered",
      used: 125,
      limit: 100,
    })).toMatchInlineSnapshot(`
      {
        "display_name": "Session replays",
        "is_unlimited": false,
        "item_id": "session_replays",
        "kind": "metered",
        "limit": 100,
        "overage": 25,
        "remaining": 0,
        "used": 125,
      }
    `);
  });

  it("represents unlimited auth users without remaining or overage", () => {
    expect(buildUsageRow({
      itemId: ITEM_IDS.authUsers,
      displayName: "Auth users",
      kind: "current",
      used: 250_000,
      limit: UNLIMITED,
    })).toMatchInlineSnapshot(`
      {
        "display_name": "Auth users",
        "is_unlimited": true,
        "item_id": "auth_users",
        "kind": "current",
        "limit": null,
        "overage": 0,
        "remaining": null,
        "used": 250000,
      }
    `);
  });
});

describe("plan upgrade targets", () => {
  it("selects the next paid tier", () => {
    expect({
      free: getNextPlanId("free"),
      team: getNextPlanId("team"),
      growth: getNextPlanId("growth"),
    }).toMatchInlineSnapshot(`
      {
        "free": "team",
        "growth": null,
        "team": "growth",
      }
    `);
  });
});

describe("readBillingSubscriptionMapOrSkip", () => {
  it("returns the subscription map when the bulldozer read succeeds", async () => {
    const start = Date.UTC(2026, 4, 15);
    const end = Date.UTC(2026, 5, 15);
    const subMap = { sub_1: createSubscriptionPeriod(start, end) };
    const result = await readBillingSubscriptionMapOrSkip(() => Promise.resolve(subMap));
    expect(result).toBe(subMap);
  });

  it("falls back to an empty map (free plan) instead of throwing when bulldozer is down", async () => {
    // Regression: plan usage is read on the dashboard's own pages (overview
    // limit banners, usage page). A bulldozer outage here used to bubble a 500
    // and take the whole dashboard down. It must now degrade to "no
    // subscription" (free plan) rather than failing the page.
    const result = await readBillingSubscriptionMapOrSkip(() => {
      throw new Error("Mock Bulldozer unreachable — this is not an error, instead an intentional test condition we create to test the fallback logic");
    });
    expect(result).toEqual({});
  });

  it("also swallows async rejections from the bulldozer read", async () => {
    const result = await readBillingSubscriptionMapOrSkip(async () => {
      throw new Error("Mock Bulldozer timed out — this is not an error, instead an intentional test condition we create to test the fallback logic");
    });
    expect(result).toEqual({});
  });
});

describe("billing period selection", () => {
  it("uses the subscription period when available", () => {
    const start = Date.UTC(2026, 4, 15);
    const end = Date.UTC(2026, 5, 15);
    const period = getPlanUsagePeriod(createSubscriptionPeriod(start, end), new Date(Date.UTC(2026, 5, 11)));
    expect({
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    }).toMatchInlineSnapshot(`
      {
        "end": "2026-06-15T00:00:00.000Z",
        "start": "2026-05-15T00:00:00.000Z",
      }
    `);
  });

  it("falls back to the current calendar month", () => {
    const period = getPlanUsagePeriod(null, new Date(Date.UTC(2026, 5, 11, 12)));
    expect({
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    }).toMatchInlineSnapshot(`
      {
        "end": "2026-07-01T00:00:00.000Z",
        "start": "2026-06-01T00:00:00.000Z",
      }
    `);
  });
});

describe("resolveInEffectPlanSubscription", () => {
  // Fully deterministic now that the resolver takes the clock as a parameter
  const nowMillis = 1_800_000_000_000;
  const futureMillis = nowMillis + 30 * 86400000;
  const pastMillis = nowMillis - 86400000;

  it("keeps resolving a canceled-at-period-end plan sub until its endedAt passes", () => {
    const windingDownTeam: SubscriptionRow = {
      ...createSubscriptionPeriod(pastMillis, futureMillis),
      id: "sub_team",
      productId: "team",
      status: "canceled",
      cancelAtPeriodEnd: true,
      canceledAtMillis: pastMillis,
      endedAtMillis: futureMillis,
    };
    const activeFree: SubscriptionRow = {
      ...createSubscriptionPeriod(pastMillis, futureMillis),
      id: "sub_free",
      productId: "free",
    };
    expect(resolveInEffectPlanSubscription({ sub_team: windingDownTeam, sub_free: activeFree }, nowMillis)?.id).toBe("sub_team");
  });

  it("falls back to the free plan sub once the canceled sub has ended", () => {
    const endedTeam: SubscriptionRow = {
      ...createSubscriptionPeriod(pastMillis - 86400000, pastMillis),
      id: "sub_team",
      productId: "team",
      status: "canceled",
      cancelAtPeriodEnd: true,
      canceledAtMillis: pastMillis - 86400000,
      endedAtMillis: pastMillis,
    };
    const activeFree: SubscriptionRow = {
      ...createSubscriptionPeriod(pastMillis, futureMillis),
      id: "sub_free",
      productId: "free",
    };
    expect(resolveInEffectPlanSubscription({ sub_team: endedTeam, sub_free: activeFree }, nowMillis)?.id).toBe("sub_free");
  });
});

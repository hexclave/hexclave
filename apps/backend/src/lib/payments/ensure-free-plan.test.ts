import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXTRA_SEAT_PRODUCT_ID } from "@hexclave/shared/dist/plans";
import { getOrUndefined } from "@hexclave/shared/dist/utils/objects";
import { bulldozerWriteSubscription } from "@/lib/payments/bulldozer-dual-write";
import { getSubscriptionMapForCustomer } from "@/lib/payments/customer-data";
// eslint-disable-next-line @typescript-eslint/no-deprecated -- idiomatic way to get the internal tenancy today (see plan-entitlements.ts)
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { ensureFreePlanForBillingTeam } from "./ensure-free-plan";

// Uses the real internal tenancy (relies on its seeded free/team/growth/
// extra-seats product config) and random UUIDs as billing team IDs.
// Subscription rows aren't FK-checked against the Team table, so inserting
// a sub for a non-existent team works and keeps tests side-effect-free on
// real teams.
describe.sequential("ensureFreePlanForBillingTeam (real DB)", () => {
  async function getInternal() {
    const tenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID, true);
    if (tenancy == null) throw new Error("Internal billing tenancy not found");
    const prisma = await getPrismaClientForTenancy(tenancy);
    return { tenancy, prisma };
  }

  // Returns subs that haven't ended yet — matches the "occupies the product
  // line" semantics of `ensureFreePlanForBillingTeam`'s predicate, which is
  // endedAt-based (not status-based) to mirror the Subscription TimeFold.
  async function getUnendedSubsForTeam(tenancyId: string, billingTeamId: string, prisma: unknown) {
    const subMap = await getSubscriptionMapForCustomer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors `payments.test.tsx`: PrismaClient is structurally compatible with PrismaClientTransaction here
      prisma: prisma as any,
      tenancyId,
      customerType: "team",
      customerId: billingTeamId,
    });
    const nowMillis = Date.now();
    return Object.values(subMap).filter((s) => s.endedAtMillis == null || s.endedAtMillis > nowMillis);
  }

  async function seedSub(options: {
    tenancyId: string,
    billingTeamId: string,
    productId: string,
    productSnapshot: unknown,
    status?: "active" | "trialing" | "incomplete" | "past_due",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see `getUnendedSubsForTeam`
    prisma: any,
  }) {
    const now = new Date();
    await bulldozerWriteSubscription({
      id: randomUUID(),
      tenancyId: options.tenancyId,
      customerId: options.billingTeamId,
      customerType: "TEAM",
      productId: options.productId,
      priceId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProductSnapshot is a structural JSON type; bulldozerWriteSubscription will stamp it into the stored row as-is.
      product: options.productSnapshot as any,
      quantity: 1,
      stripeSubscriptionId: `stripe-${randomUUID()}`,
      status: options.status ?? "active",
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      endedAt: null,
      refundedAt: null,
      productRevokedAt: null,
      creationSource: "PURCHASE_PAGE",
      createdAt: now,
    });
  }

  it("fast path: no-op when team already owns an active base plan in the line", async () => {
    const { tenancy, prisma } = await getInternal();
    const billingTeamId = randomUUID();

    const teamProduct = getOrUndefined(tenancy.config.payments.products, "team");
    if (teamProduct == null) throw new Error("Internal tenancy missing `team` product");

    await seedSub({
      tenancyId: tenancy.id,
      billingTeamId,
      productId: "team",
      productSnapshot: teamProduct,
      prisma,
    });

    expect(await ensureFreePlanForBillingTeam(billingTeamId)).toBe(false);

    const subs = await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma);
    expect(subs).toHaveLength(1);
    expect(subs[0].productId).toBe("team");
  });

  it("regression: an `incomplete` paid sub still occupies the line — no free regrant", async () => {
    // Reproduces the Stripe webhook race the endedAt-based predicate
    // defends against: `subscription.created` lands first with
    // `status=incomplete` and no `endedAt`; the subsequent `invoice.paid`
    // flips it to `active`. Between those two webhooks, `ensureFree...`
    // must treat the incomplete sub as occupying the line — gating on
    // `status` alone would regrant free on top and leave the customer
    // with both subs active (exactly the chauncey-team dashboard bug).
    const { tenancy, prisma } = await getInternal();
    const billingTeamId = randomUUID();

    const teamProduct = getOrUndefined(tenancy.config.payments.products, "team");
    if (teamProduct == null) throw new Error("Internal tenancy missing `team` product");

    await seedSub({
      tenancyId: tenancy.id,
      billingTeamId,
      productId: "team",
      productSnapshot: teamProduct,
      status: "incomplete",
      prisma,
    });

    expect(await ensureFreePlanForBillingTeam(billingTeamId)).toBe(false);

    const subs = await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma);
    expect(subs).toHaveLength(1);
    expect(subs[0].productId).toBe("team");
  });

  it("slow path: creates a free sub when team has no prior sub in the line", async () => {
    const { tenancy, prisma } = await getInternal();
    const billingTeamId = randomUUID();

    expect(await ensureFreePlanForBillingTeam(billingTeamId)).toBe(true);

    const subs = await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma);
    expect(subs).toHaveLength(1);
    expect(subs[0].productId).toBe("free");
  });

  it("idempotent: sequential double-call creates exactly one free sub (second call returns false)", async () => {
    const { tenancy, prisma } = await getInternal();
    const billingTeamId = randomUUID();

    expect(await ensureFreePlanForBillingTeam(billingTeamId)).toBe(true);
    expect(await ensureFreePlanForBillingTeam(billingTeamId)).toBe(false);

    const subs = await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma);
    expect(subs).toHaveLength(1);
    expect(subs[0].productId).toBe("free");
  });

  it("regression: a team whose only sub has ENDED is treated as orphaned and gets a fresh free grant", async () => {
    // The "occupies the line" predicate gates on endedAt (not status), so a
    // team whose only sub is canceled+ended in the past should be seen as
    // orphaned and re-granted free. Pins this against the old "team has any
    // sub" predicate that earlier scripts relied on.
    const { tenancy, prisma } = await getInternal();
    const billingTeamId = randomUUID();

    const teamProduct = getOrUndefined(tenancy.config.payments.products, "team");
    if (teamProduct == null) throw new Error("Internal tenancy missing `team` product");

    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    const endedSubId = randomUUID();
    await bulldozerWriteSubscription({
      id: endedSubId,
      tenancyId: tenancy.id,
      customerId: billingTeamId,
      customerType: "TEAM",
      productId: "team",
      priceId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProductSnapshot is a structural JSON type
      product: teamProduct as any,
      quantity: 1,
      stripeSubscriptionId: null,
      status: "canceled",
      currentPeriodStart: yesterday,
      currentPeriodEnd: yesterday,
      cancelAtPeriodEnd: false,
      canceledAt: yesterday,
      endedAt: yesterday,
      refundedAt: null,
      productRevokedAt: null,
      creationSource: "PURCHASE_PAGE",
      createdAt: yesterday,
    });

    // Precondition: the team has exactly one sub on record, and it is the
    // ended one (no unended subs exist). This is what makes the test
    // meaningful — without it, a regression that ignored `endedAt` could
    // still pass by virtue of some other unrelated sub being present.
    const subMapBefore = await getSubscriptionMapForCustomer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see `getUnendedSubsForTeam`
      prisma: prisma as any,
      tenancyId: tenancy.id,
      customerType: "team",
      customerId: billingTeamId,
    });
    expect(Object.keys(subMapBefore)).toEqual([endedSubId]);
    expect(await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma)).toHaveLength(0);

    expect(await ensureFreePlanForBillingTeam(billingTeamId)).toBe(true);

    const subs = await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma);
    expect(subs).toHaveLength(1);
    expect(subs[0].productId).toBe("free");
  });

  it("slow path race: concurrent Promise.all calls create exactly one free sub", async () => {
    // Exercises the SERIALIZABLE slow path's retry-on-conflict behaviour —
    // both invocations enter the tx concurrently, one commits, the other
    // retries under a fresh snapshot, sees the committed row, and skips.
    const { tenancy, prisma } = await getInternal();
    const billingTeamId = randomUUID();

    await Promise.all([
      ensureFreePlanForBillingTeam(billingTeamId),
      ensureFreePlanForBillingTeam(billingTeamId),
    ]);

    const subs = await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma);
    expect(subs).toHaveLength(1);
    expect(subs[0].productId).toBe("free");
  });

  it("add-on does not count as a base plan — free is still regranted", async () => {
    const { tenancy, prisma } = await getInternal();
    const billingTeamId = randomUUID();

    // The extra seat is an add-on (isAddOnTo: { team, growth }) but lives in
    // the same product line as the free plan. It must NOT short-circuit the
    // fast path; the team should still get a free sub on top.
    const extraSeatsProduct = getOrUndefined(tenancy.config.payments.products, EXTRA_SEAT_PRODUCT_ID);
    if (extraSeatsProduct == null) throw new Error(`Internal tenancy missing \`${EXTRA_SEAT_PRODUCT_ID}\` product`);

    await seedSub({
      tenancyId: tenancy.id,
      billingTeamId,
      productId: EXTRA_SEAT_PRODUCT_ID,
      productSnapshot: extraSeatsProduct,
      prisma,
    });

    await ensureFreePlanForBillingTeam(billingTeamId);

    const subs = await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma);
    const productIds = new Set(subs.map((s) => s.productId));
    expect(subs).toHaveLength(2);
    expect(productIds.has("free")).toBe(true);
    expect(productIds.has(EXTRA_SEAT_PRODUCT_ID)).toBe(true);
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getOrUndefined } from "@hexclave/shared/dist/utils/objects";
import { bulldozerWriteSubscription } from "@/lib/payments/bulldozer-dual-write";
import { getSubscriptionMapForCustomer } from "@/lib/payments/customer-data";
// eslint-disable-next-line @typescript-eslint/no-deprecated -- idiomatic way to get the internal tenancy today (see plan-entitlements.ts)
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { runFreePlanRegrantSweep } from "./free-plan-regrant-sweep";

// Same conventions as `ensure-free-plan.test.ts`: real internal tenancy, random
// UUIDs as billing team IDs (Subscription rows aren't FK-checked against Team,
// so this stays side-effect-free on real teams).
//
// Unlike that suite, these tests must write through PRISMA and not just
// Bulldozer: the sweep's candidate query reads the Subscription table directly,
// so a bulldozer-only seed would be invisible to it.
describe.sequential("runFreePlanRegrantSweep (real DB)", () => {
  async function getInternal() {
    const tenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID, true);
    if (tenancy == null) throw new Error("Internal billing tenancy not found");
    const prisma = await getPrismaClientForTenancy(tenancy);
    return { tenancy, prisma };
  }

  async function getUnendedSubsForTeam(tenancyId: string, billingTeamId: string, prisma: unknown) {
    const subMap = await getSubscriptionMapForCustomer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors `ensure-free-plan.test.ts`: PrismaClient is structurally compatible with PrismaClientTransaction here
      prisma: prisma as any,
      tenancyId,
      customerType: "team",
      customerId: billingTeamId,
    });
    const nowMillis = Date.now();
    return Object.values(subMap).filter((s) => s.endedAtMillis == null || s.endedAtMillis > nowMillis);
  }

  /**
   * Seeds an ended, non-Stripe plan subscription — i.e. exactly what the cancel
   * route leaves behind for a test-mode / API-granted sub once its paid-through
   * window has elapsed, which is the state the sweep exists to repair.
   */
  async function seedEndedLocalSub(options: {
    tenancyId: string,
    billingTeamId: string,
    productId: string,
    productSnapshot: unknown,
    endedAt: Date,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see `getUnendedSubsForTeam`
    prisma: any,
  }) {
    const created = await options.prisma.subscription.create({
      data: {
        tenancyId: options.tenancyId,
        customerId: options.billingTeamId,
        customerType: "TEAM",
        status: "canceled",
        productId: options.productId,
        priceId: null,
        product: options.productSnapshot,
        quantity: 1,
        // No stripeSubscriptionId: this is the local-sub path, the one with no
        // webhook to fire at the period boundary.
        stripeSubscriptionId: null,
        currentPeriodStart: new Date(options.endedAt.getTime() - 30 * 24 * 3600 * 1000),
        currentPeriodEnd: options.endedAt,
        cancelAtPeriodEnd: true,
        canceledAt: options.endedAt,
        endedAt: options.endedAt,
        creationSource: "PURCHASE_PAGE",
      },
    });
    await bulldozerWriteSubscription(created);
    return created;
  }

  it("regrants free to a team whose local sub just ended", async () => {
    const { tenancy, prisma } = await getInternal();
    const billingTeamId = randomUUID();

    const teamProduct = getOrUndefined(tenancy.config.payments.products, "team");
    if (teamProduct == null) throw new Error("Internal tenancy missing `team` product");

    await seedEndedLocalSub({
      tenancyId: tenancy.id,
      billingTeamId,
      productId: "team",
      productSnapshot: teamProduct,
      // Inside the lookback window, and already past — the exact moment the
      // team becomes orphaned with nothing scheduled to notice.
      endedAt: new Date(Date.now() - 60 * 1000),
      prisma,
    });

    // Precondition: the team really is orphaned, so a pass would otherwise be
    // meaningless.
    expect(await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma)).toHaveLength(0);

    const result = await runFreePlanRegrantSweep();
    expect(result.failed).toBe(0);
    expect(result.granted).toBeGreaterThanOrEqual(1);

    const subs = await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma);
    expect(subs).toHaveLength(1);
    expect(subs[0].productId).toBe("free");
  });

  it("is idempotent — a second run does not stack another free sub", async () => {
    const { tenancy, prisma } = await getInternal();
    const billingTeamId = randomUUID();

    const teamProduct = getOrUndefined(tenancy.config.payments.products, "team");
    if (teamProduct == null) throw new Error("Internal tenancy missing `team` product");

    await seedEndedLocalSub({
      tenancyId: tenancy.id,
      billingTeamId,
      productId: "team",
      productSnapshot: teamProduct,
      endedAt: new Date(Date.now() - 60 * 1000),
      prisma,
    });

    await runFreePlanRegrantSweep();
    // The ended sub stays inside the lookback window, so the second run
    // re-considers the same team. This is the overlap that lets the lookback be
    // 2x the interval without any watermark state.
    await runFreePlanRegrantSweep();

    const subs = await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma);
    expect(subs).toHaveLength(1);
    expect(subs[0].productId).toBe("free");
  });

  it("ignores a sub that ended before the lookback window", async () => {
    const { tenancy, prisma } = await getInternal();
    const billingTeamId = randomUUID();

    const teamProduct = getOrUndefined(tenancy.config.payments.products, "team");
    if (teamProduct == null) throw new Error("Internal tenancy missing `team` product");

    await seedEndedLocalSub({
      tenancyId: tenancy.id,
      billingTeamId,
      productId: "team",
      productSnapshot: teamProduct,
      // Well outside 2x the 10-minute interval. Teams this stale are the
      // deploy-time backfill's job, not the sweep's — bounding the window is
      // what keeps a run cheap.
      endedAt: new Date(Date.now() - 24 * 3600 * 1000),
      prisma,
    });

    await runFreePlanRegrantSweep();

    expect(await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma)).toHaveLength(0);
  });

  it("does not regrant on top of a sub that is still winding down", async () => {
    const { tenancy, prisma } = await getInternal();
    const billingTeamId = randomUUID();

    const teamProduct = getOrUndefined(tenancy.config.payments.products, "team");
    if (teamProduct == null) throw new Error("Internal tenancy missing `team` product");

    // Canceled but still paid through: `endedAt` is in the future, so the
    // customer keeps the plan they paid for and must NOT be handed free on top
    // of it. Two independent guards have to hold for that — the candidate
    // query's `lte: now` bound, and `ensureFreePlanForBillingTeam`'s
    // still-in-effect check — and this pins the observable result of both.
    await seedEndedLocalSub({
      tenancyId: tenancy.id,
      billingTeamId,
      productId: "team",
      productSnapshot: teamProduct,
      endedAt: new Date(Date.now() + 60 * 60 * 1000),
      prisma,
    });

    await runFreePlanRegrantSweep();

    const subs = await getUnendedSubsForTeam(tenancy.id, billingTeamId, prisma);
    expect(subs.map((s) => s.productId)).toEqual(["team"]);
  });
});

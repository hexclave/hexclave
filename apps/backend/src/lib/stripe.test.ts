import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { BooleanTrue, CustomerType, PurchaseCreationSource, SubscriptionStatus } from "@/generated/prisma/client";
import { getTenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyStripeInvoiceOutcome,
  getCanceledAtForSync,
  getEndedAtForSync,
  type StripeInvoiceOutcomeTimestamps,
} from "./stripe";

// Minimal cast: the helpers only read status / cancel_at_period_end /
// ended_at / canceled_at, and a newly-relied-on field would surface as a
// failing assertion here rather than a silent wrong value.
function stripeSub(fields: {
  status: Stripe.Subscription.Status,
  cancelAtPeriodEnd?: boolean,
  endedAtSeconds?: number | null,
  canceledAtSeconds?: number | null,
}): Stripe.Subscription {
  return {
    status: fields.status,
    cancel_at_period_end: fields.cancelAtPeriodEnd ?? false,
    ended_at: fields.endedAtSeconds ?? null,
    canceled_at: fields.canceledAtSeconds ?? null,
  } as unknown as Stripe.Subscription;
}

describe("getEndedAtForSync", () => {
  const periodEnd = new Date("2026-08-16T00:00:00Z");

  it("clears endedAt for a non-terminal sub without a pending cancel (reactivation path)", () => {
    expect(getEndedAtForSync(stripeSub({ status: "active" }), periodEnd)).toEqual({ endedAt: null });
  });

  it("schedules endedAt at Stripe's period end while a cancel is pending", () => {
    expect(getEndedAtForSync(stripeSub({ status: "active", cancelAtPeriodEnd: true }), periodEnd)).toEqual({ endedAt: periodEnd });
  });

  it("uses Stripe's ended_at for terminal subs", () => {
    const endedAtSeconds = 1_800_000_000;
    expect(getEndedAtForSync(stripeSub({ status: "canceled", endedAtSeconds }), periodEnd)).toEqual({ endedAt: new Date(endedAtSeconds * 1000) });
  });

  it("falls back to the past period boundary for terminal subs without ended_at", () => {
    const pastEnd = new Date(Date.now() - 86400000);
    expect(getEndedAtForSync(stripeSub({ status: "incomplete_expired" }), pastEnd)).toEqual({ endedAt: pastEnd });
  });

  it("falls back to now for terminal subs whose period end is still in the future", () => {
    const futureEnd = new Date(Date.now() + 86400000);
    const before = Date.now();
    const result = getEndedAtForSync(stripeSub({ status: "unpaid" }), futureEnd);
    expect(result.endedAt).not.toBeNull();
    expect(result.endedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.endedAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("getCanceledAtForSync", () => {
  it("mirrors Stripe's canceled_at", () => {
    const canceledAtSeconds = 1_800_000_000;
    expect(getCanceledAtForSync(stripeSub({ status: "active", canceledAtSeconds }))).toEqual({ canceledAt: new Date(canceledAtSeconds * 1000) });
  });

  it("clears canceledAt when Stripe's is null (reactivation path)", () => {
    expect(getCanceledAtForSync(stripeSub({ status: "active" }))).toEqual({ canceledAt: null });
  });
});

describe.sequential("Stripe invoice outcome ordering (real DB)", () => {
  const projectIds: string[] = [];
  const tenancyIds: string[] = [];

  async function createInvoice() {
    const projectId = `stripe-outcome-${randomUUID()}`;
    const tenancyId = randomUUID();
    const stripeSubscriptionId = `sub_${randomUUID()}`;
    projectIds.push(projectId);
    tenancyIds.push(tenancyId);

    await globalPrismaClient.project.create({
      data: {
        id: projectId,
        displayName: "Stripe outcome ordering test",
        description: "",
        isProductionMode: false,
      },
    });
    await globalPrismaClient.tenancy.create({
      data: {
        id: tenancyId,
        projectId,
        branchId: "main",
        hasNoOrganization: BooleanTrue.TRUE,
      },
    });
    await globalPrismaClient.subscription.create({
      data: {
        tenancyId,
        customerId: randomUUID(),
        customerType: CustomerType.CUSTOM,
        product: {},
        stripeSubscriptionId,
        status: SubscriptionStatus.active,
        currentPeriodStart: new Date("2026-08-20T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-09-20T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        creationSource: PurchaseCreationSource.TEST_MODE,
      },
    });
    await globalPrismaClient.subscriptionInvoice.create({
      data: {
        tenancyId,
        stripeSubscriptionId,
        stripeInvoiceId: `in_${randomUUID()}`,
        isSubscriptionCreationInvoice: false,
        status: "open",
      },
    });
    const tenancy = await getTenancy(tenancyId);
    if (tenancy == null) throw new Error("Stripe outcome test tenancy was not created");
    const invoice = await globalPrismaClient.subscriptionInvoice.findFirstOrThrow({
      where: { tenancyId, stripeSubscriptionId },
    });
    return { invoice, tenancy };
  }

  function exactPaidOutcome(eventAt: Date, paidAt: Date): StripeInvoiceOutcomeTimestamps {
    return {
      paymentOutcomeEventAt: eventAt,
      paidAt,
      paidAtIsExact: true,
      markedUncollectibleAt: null,
      markedUncollectibleAtIsExact: false,
      voidedAt: null,
      voidedAtIsExact: false,
    };
  }

  function noOutcome(): StripeInvoiceOutcomeTimestamps {
    return {
      paymentOutcomeEventAt: null,
      paidAt: null,
      paidAtIsExact: false,
      markedUncollectibleAt: null,
      markedUncollectibleAtIsExact: false,
      voidedAt: null,
      voidedAtIsExact: false,
    };
  }

  function inferredPaidOutcome(eventAt: Date): StripeInvoiceOutcomeTimestamps {
    return {
      paymentOutcomeEventAt: null,
      paidAt: eventAt,
      paidAtIsExact: false,
      markedUncollectibleAt: null,
      markedUncollectibleAtIsExact: false,
      voidedAt: null,
      voidedAtIsExact: false,
    };
  }

  function exactMarkedUncollectibleOutcome(eventAt: Date, markedAt: Date): StripeInvoiceOutcomeTimestamps {
    return {
      paymentOutcomeEventAt: eventAt,
      paidAt: null,
      paidAtIsExact: false,
      markedUncollectibleAt: markedAt,
      markedUncollectibleAtIsExact: true,
      voidedAt: null,
      voidedAtIsExact: false,
    };
  }

  afterEach(async () => {
    const tenancyIdsToDelete = [...tenancyIds];
    const projectIdsToDelete = [...projectIds];
    await globalPrismaClient.subscriptionInvoice.deleteMany({ where: { tenancyId: { in: tenancyIdsToDelete } } });
    await globalPrismaClient.subscription.deleteMany({ where: { tenancyId: { in: tenancyIdsToDelete } } });
    await globalPrismaClient.project.deleteMany({ where: { id: { in: projectIdsToDelete } } });
    tenancyIds.splice(0);
    projectIds.splice(0);
  });

  it("keeps the newer exact-paid outcome when an older event arrives later", async () => {
    const { invoice, tenancy } = await createInvoice();
    const newerEventAt = new Date("2026-08-20T12:00:00.000Z");
    const newerPaidAt = new Date("2026-08-20T11:59:00.000Z");
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "usd",
      amountPaid: 10_000,
      outcome: exactPaidOutcome(newerEventAt, newerPaidAt),
    });
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "eur",
      amountPaid: 1_000,
      outcome: exactPaidOutcome(
        new Date("2026-08-20T11:00:00.000Z"),
        new Date("2026-08-20T10:59:00.000Z"),
      ),
    });
    await expect(globalPrismaClient.subscriptionInvoice.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: invoice.id } },
      select: { paymentOutcomeEventAt: true, paidAt: true, amountPaid: true, currency: true },
    })).resolves.toEqual({
      paymentOutcomeEventAt: newerEventAt,
      paidAt: newerPaidAt,
      amountPaid: 10_000,
      currency: "USD",
    });
  });

  it("applies a newer exact-paid outcome after an older event", async () => {
    const { invoice, tenancy } = await createInvoice();
    const newerEventAt = new Date("2026-08-20T12:00:00.000Z");
    const newerPaidAt = new Date("2026-08-20T11:59:00.000Z");
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "eur",
      amountPaid: 1_000,
      outcome: exactPaidOutcome(
        new Date("2026-08-20T11:00:00.000Z"),
        new Date("2026-08-20T10:59:00.000Z"),
      ),
    });
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "usd",
      amountPaid: 10_000,
      outcome: exactPaidOutcome(newerEventAt, newerPaidAt),
    });
    await expect(globalPrismaClient.subscriptionInvoice.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: invoice.id } },
      select: { paymentOutcomeEventAt: true, paidAt: true, amountPaid: true, currency: true },
    })).resolves.toEqual({
      paymentOutcomeEventAt: newerEventAt,
      paidAt: newerPaidAt,
      amountPaid: 10_000,
      currency: "USD",
    });
  });

  it("does not let a no-outcome event hide an older genuine payment", async () => {
    const { invoice, tenancy } = await createInvoice();
    const paidEventAt = new Date("2026-08-20T11:00:00.000Z");
    const paidAt = new Date("2026-08-20T10:59:00.000Z");
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "eur",
      amountPaid: null,
      outcome: noOutcome(),
    });
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "usd",
      amountPaid: 10_000,
      outcome: exactPaidOutcome(paidEventAt, paidAt),
    });
    await expect(globalPrismaClient.subscriptionInvoice.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: invoice.id } },
      select: { paymentOutcomeEventAt: true, paidAt: true, amountPaid: true, currency: true },
    })).resolves.toEqual({
      paymentOutcomeEventAt: paidEventAt,
      paidAt,
      amountPaid: 10_000,
      currency: "USD",
    });
  });

  it("lets an older exact payment correct a newer inferred payment", async () => {
    const { invoice, tenancy } = await createInvoice();
    const inferredEventAt = new Date("2026-08-20T12:00:00.000Z");
    const exactEventAt = new Date("2026-08-20T11:00:00.000Z");
    const exactPaidAt = new Date("2026-08-20T10:59:00.000Z");
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "usd",
      amountPaid: 1_000,
      outcome: inferredPaidOutcome(inferredEventAt),
    });
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "eur",
      amountPaid: 10_000,
      outcome: exactPaidOutcome(exactEventAt, exactPaidAt),
    });
    await expect(globalPrismaClient.subscriptionInvoice.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: invoice.id } },
      select: { paymentOutcomeEventAt: true, paidAt: true, amountPaid: true, currency: true },
    })).resolves.toEqual({
      paymentOutcomeEventAt: exactEventAt,
      paidAt: exactPaidAt,
      amountPaid: 10_000,
      currency: "EUR",
    });
  });

  it("lets an older exact outcome fill a still-null terminal field", async () => {
    const { invoice, tenancy } = await createInvoice();
    const newerPaidEventAt = new Date("2026-08-20T12:00:00.000Z");
    const newerPaidAt = new Date("2026-08-20T11:59:00.000Z");
    const olderMarkedEventAt = new Date("2026-08-20T11:00:00.000Z");
    const olderMarkedAt = new Date("2026-08-20T10:59:00.000Z");
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "usd",
      amountPaid: 10_000,
      outcome: exactPaidOutcome(newerPaidEventAt, newerPaidAt),
    });
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "eur",
      amountPaid: null,
      outcome: exactMarkedUncollectibleOutcome(olderMarkedEventAt, olderMarkedAt),
    });
    await expect(globalPrismaClient.subscriptionInvoice.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: invoice.id } },
      select: {
        paymentOutcomeEventAt: true,
        paidAt: true,
        amountPaid: true,
        currency: true,
        markedUncollectibleAt: true,
      },
    })).resolves.toEqual({
      paymentOutcomeEventAt: newerPaidEventAt,
      paidAt: newerPaidAt,
      amountPaid: 10_000,
      currency: "USD",
      markedUncollectibleAt: olderMarkedAt,
    });
  });

  it("fills amountPaid when an older exact payment fills a NULL paidAt", async () => {
    const { invoice, tenancy } = await createInvoice();
    const newerMarkedEventAt = new Date("2026-08-20T12:00:00.000Z");
    const newerMarkedAt = new Date("2026-08-20T11:59:00.000Z");
    const olderPaidEventAt = new Date("2026-08-20T11:00:00.000Z");
    const olderPaidAt = new Date("2026-08-20T10:59:00.000Z");
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "usd",
      amountPaid: null,
      outcome: exactMarkedUncollectibleOutcome(newerMarkedEventAt, newerMarkedAt),
    });
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "eur",
      amountPaid: 10_000,
      outcome: exactPaidOutcome(olderPaidEventAt, olderPaidAt),
    });
    await expect(globalPrismaClient.subscriptionInvoice.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: tenancy.id, id: invoice.id } },
      select: {
        paymentOutcomeEventAt: true,
        paidAt: true,
        amountPaid: true,
        currency: true,
        markedUncollectibleAt: true,
      },
    })).resolves.toEqual({
      paymentOutcomeEventAt: newerMarkedEventAt,
      paidAt: olderPaidAt,
      amountPaid: 10_000,
      currency: "USD",
      markedUncollectibleAt: newerMarkedAt,
    });
  });

  it("stores exact outcome timestamps as UTC wall-clock values", async () => {
    const { invoice, tenancy } = await createInvoice();
    const paidAt = new Date("2026-08-20T15:00:00.000Z");
    await applyStripeInvoiceOutcome(globalPrismaClient, {
      tenancyId: tenancy.id,
      invoiceId: invoice.id,
      currency: "usd",
      amountPaid: 10_000,
      outcome: exactPaidOutcome(paidAt, paidAt),
    });
    const rows = await globalPrismaClient.$queryRaw<Array<{ paidAt: string | null }>>`
      SELECT "paidAt"::TEXT AS "paidAt"
      FROM "SubscriptionInvoice"
      WHERE "tenancyId" = ${tenancy.id}::UUID AND "id" = ${invoice.id}::UUID
    `;
    expect(rows[0]?.paidAt).toBe("2026-08-20 15:00:00");
  });
});

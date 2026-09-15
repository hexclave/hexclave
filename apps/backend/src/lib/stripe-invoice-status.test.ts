import { randomUUID } from "node:crypto";
import { BooleanTrue, CustomerType, PurchaseCreationSource, SubscriptionStatus } from "@/generated/prisma/client";
import { bulldozerWriteSubscriptionInvoice } from "@/lib/payments/bulldozer-dual-write";
import { getTenancy } from "@/lib/tenancies";
import { loadTvSubscriptionCollectionOutcomes } from "@/lib/tv-mode/events";
import { globalPrismaClient } from "@/prisma-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHexclaveStripe, upsertStripeInvoice, useStripeMock } from "./stripe";

vi.mock("@/lib/payments/bulldozer-dual-write", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/payments/bulldozer-dual-write")>(),
  bulldozerWriteSubscriptionInvoice: vi.fn(),
}));

describe.sequential("Stripe invoice status and independent outcome facts (real DB)", () => {
  const projectIds: string[] = [];
  const tenancyIds: string[] = [];
  const paidAtSeconds = 1_787_222_340;
  const paidEventSeconds = paidAtSeconds + 60;

  async function createFixture() {
    // Never issue requests to a real Stripe account from this regression suite.
    if (!useStripeMock) throw new Error("Invoice status tests require the local Stripe mock.");
    const projectId = `stripe-status-${randomUUID()}`;
    const tenancyId = randomUUID();
    const subscriptionId = `sub_${randomUUID()}`;
    const invoiceId = `in_${randomUUID()}`;
    projectIds.push(projectId);
    tenancyIds.push(tenancyId);
    await globalPrismaClient.project.create({
      data: { id: projectId, displayName: "Invoice status test", description: "", isProductionMode: false },
    });
    await globalPrismaClient.tenancy.create({
      data: { id: tenancyId, projectId, branchId: "main", hasNoOrganization: BooleanTrue.TRUE },
    });
    await globalPrismaClient.subscription.create({
      data: {
        tenancyId, stripeSubscriptionId: subscriptionId, customerId: randomUUID(),
        customerType: CustomerType.CUSTOM, product: {}, status: SubscriptionStatus.active,
        currentPeriodStart: new Date((paidAtSeconds - 86_400) * 1000),
        currentPeriodEnd: new Date((paidAtSeconds + 86_400) * 1000),
        cancelAtPeriodEnd: false, creationSource: PurchaseCreationSource.TEST_MODE,
      },
    });
    const tenancy = await getTenancy(tenancyId);
    if (tenancy == null) throw new Error("Invoice status test tenancy was not created.");
    const stripe = getHexclaveStripe({
      "accounts.retrieve": { metadata: { tenancyId } },
      "invoices.retrieve": {
        id: invoiceId, status: "paid", amount_paid: 900, total: 1_000, currency: "usd",
        billing_reason: "subscription_cycle", hosted_invoice_url: null,
        status_transitions: { paid_at: paidAtSeconds, marked_uncollectible_at: null, voided_at: null, finalized_at: null },
        lines: { data: [{ parent: { subscription_item_details: { subscription: subscriptionId } } }] },
      },
    });
    const invoice = await stripe.invoices.retrieve(invoiceId);
    const readInvoice = () => globalPrismaClient.subscriptionInvoice.findUniqueOrThrow({
      where: { tenancyId_stripeInvoiceId: { tenancyId, stripeInvoiceId: invoiceId } },
    });
    return { stripe, invoice, tenancy, readInvoice };
  }

  afterEach(async () => {
    // Payment rows are not project-cascaded; remove only this suite's fixtures.
    await globalPrismaClient.subscriptionInvoice.deleteMany({ where: { tenancyId: { in: tenancyIds } } });
    await globalPrismaClient.subscription.deleteMany({ where: { tenancyId: { in: tenancyIds } } });
    await globalPrismaClient.project.deleteMany({ where: { id: { in: projectIds } } });
    tenancyIds.splice(0);
    projectIds.splice(0);
    vi.clearAllMocks();
  });

  it.each(["draft", "open", "paid", "uncollectible", "void", null] as const)(
    "preserves provider status %s on create and update even with independent paid evidence",
    async (status) => {
      const { stripe, invoice, readInvoice } = await createFixture();
      // Deliberately disagreeing evidence guards against deriving a shared
      // Payments status from TV's independently ordered observation fields.
      const observation = { ...invoice, status };
      await upsertStripeInvoice(stripe, "acct_status_test", observation, { type: "invoice.updated", created: paidEventSeconds });
      const created = await readInvoice();
      expect(created).toMatchObject({
        status, amountTotal: 1_000, amountPaid: 900, currency: "USD",
        paidAt: new Date(paidAtSeconds * 1000), paymentOutcomeEventAt: new Date(paidEventSeconds * 1000),
      });
      await globalPrismaClient.subscriptionInvoice.update({
        where: { tenancyId_id: { tenancyId: created.tenancyId, id: created.id } },
        data: { status: status === "open" ? "paid" : "open" },
      });
      await upsertStripeInvoice(stripe, "acct_status_test", observation, { type: "invoice.updated", created: paidEventSeconds + 1 });
      const stored = await readInvoice();
      expect(stored.status).toBe(status);
      expect(bulldozerWriteSubscriptionInvoice).toHaveBeenLastCalledWith(expect.objectContaining({
        status, amountPaid: 900, paidAt: new Date(paidAtSeconds * 1000), currency: "USD",
      }));
    },
  );

  it("keeps ordered collection evidence when delayed payloads change the ordinary invoice status", async () => {
    const { stripe, invoice, tenancy, readInvoice } = await createFixture();
    const windowStart = new Date((paidAtSeconds - 3_600) * 1000);
    const windowEnd = new Date((paidAtSeconds + 3_600) * 1000);
    await upsertStripeInvoice(stripe, "acct_status_test", invoice, { type: "invoice.paid", created: paidEventSeconds });
    await upsertStripeInvoice(stripe, "acct_status_test", {
      ...invoice, status: "open", amount_paid: 0,
      status_transitions: { ...invoice.status_transitions, paid_at: null },
    }, { type: "invoice.updated", created: paidAtSeconds - 60 });
    expect(await readInvoice()).toMatchObject({
      status: "open", amountPaid: 900, paidAt: new Date(paidAtSeconds * 1000),
      paymentOutcomeEventAt: new Date(paidEventSeconds * 1000),
    });
    await expect(loadTvSubscriptionCollectionOutcomes(tenancy, windowStart, windowEnd)).resolves.toEqual([
      { outcomeAt: new Date(paidAtSeconds * 1000), success: true },
    ]);

    const failureSeconds = paidAtSeconds + 600;
    await upsertStripeInvoice(stripe, "acct_status_test", {
      ...invoice, status: "uncollectible", amount_paid: 0,
      status_transitions: { ...invoice.status_transitions, paid_at: null, marked_uncollectible_at: failureSeconds },
    }, { type: "invoice.marked_uncollectible", created: failureSeconds + 60 });
    await upsertStripeInvoice(stripe, "acct_status_test", invoice, { type: "invoice.paid", created: paidEventSeconds });
    expect(await readInvoice()).toMatchObject({
      status: "paid", amountPaid: 900, markedUncollectibleAt: new Date(failureSeconds * 1000),
      paymentOutcomeEventAt: new Date((failureSeconds + 60) * 1000),
    });
    await expect(loadTvSubscriptionCollectionOutcomes(tenancy, windowStart, windowEnd)).resolves.toEqual([
      { outcomeAt: new Date(failureSeconds * 1000), success: false },
    ]);

    const voidSeconds = failureSeconds + 600;
    await upsertStripeInvoice(stripe, "acct_status_test", {
      ...invoice, status: "void",
      status_transitions: { ...invoice.status_transitions, voided_at: voidSeconds },
    }, { type: "invoice.voided", created: voidSeconds + 60 });
    await upsertStripeInvoice(stripe, "acct_status_test", invoice, { type: "invoice.paid", created: paidEventSeconds });
    expect((await readInvoice()).status).toBe("paid");
    await expect(loadTvSubscriptionCollectionOutcomes(tenancy, windowStart, windowEnd)).resolves.toEqual([]);
    expect(bulldozerWriteSubscriptionInvoice).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "paid", voidedAt: new Date(voidSeconds * 1000), amountPaid: 900,
    }));
  });

  it("reconciles the mirror if another status observation arrives during the first mirror write", async () => {
    const { stripe, invoice, readInvoice } = await createFixture();
    vi.mocked(bulldozerWriteSubscriptionInvoice).mockImplementationOnce(async (mirrored) => {
      // Simulate an overlapping webhook after the normalized row was read but
      // before the mirror completed. The final reread must still converge.
      await globalPrismaClient.subscriptionInvoice.update({
        where: { tenancyId_id: { tenancyId: mirrored.tenancyId, id: mirrored.id } },
        data: { status: "open" },
      });
    });
    await upsertStripeInvoice(stripe, "acct_status_test", invoice, { type: "invoice.updated", created: paidEventSeconds });
    expect(bulldozerWriteSubscriptionInvoice).toHaveBeenCalledTimes(2);
    expect(bulldozerWriteSubscriptionInvoice).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "open", amountPaid: 900, paidAt: new Date(paidAtSeconds * 1000), currency: "USD",
    }));
    expect((await readInvoice()).status).toBe("open");
  });
});

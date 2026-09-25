import { randomUUID } from "node:crypto";
import { getTvBuiltInProfile, TvSavedProfileResourceSchema, TvSnapshotSchema } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { vi } from "vitest";
import { it } from "../../../../helpers";
import { Auth, Payments, Project, niceBackendFetch } from "../../../backend-helpers";
import { createPurchaseCode, setupProjectWithPaymentsConfig } from "../../../helpers/payments";

it("keeps provider invoice status independent from ordered TV revenue and collection facts", async ({ expect }) => {
  await setupProjectWithPaymentsConfig({ testMode: false });
  const product = {
    displayName: "Invoice outcome test",
    customerType: "user",
    serverOnly: false,
    stackable: false,
    prices: { monthly: { USD: "10.00", interval: [1, "month"] } },
    includedItems: {},
  };
  await Project.updateConfig({ "payments.products.subscription": product });
  const { userId } = await Auth.fastSignUp();
  const code = await createPurchaseCode({ userId, productId: "subscription" });
  const tenancyId = code.split("_")[0];
  const accountInfo = await niceBackendFetch("/api/latest/internal/payments/stripe/account-info", { accessType: "admin" });
  expect(accountInfo.status).toBe(200);
  const suffix = randomUUID();
  const nowSeconds = Math.floor(new Date().getTime() / 1000);
  const paidSeconds = nowSeconds - 600;
  const subscription = {
    id: `sub_status_${suffix}`,
    status: "active",
    items: { data: [{ quantity: 1, current_period_start: paidSeconds - 60, current_period_end: nowSeconds + 3_600 }] },
    metadata: { productId: "subscription", product: JSON.stringify(product), priceId: "monthly" },
    cancel_at_period_end: false,
  };
  const paidInvoice = {
    id: `in_status_${suffix}`,
    customer: `cus_status_${suffix}`,
    status: "paid",
    total: 1_000,
    amount_paid: 900,
    currency: "usd",
    billing_reason: "subscription_cycle",
    hosted_invoice_url: null,
    status_transitions: {
      paid_at: paidSeconds,
      marked_uncollectible_at: null,
      voided_at: null,
      finalized_at: paidSeconds - 60,
    },
    lines: { data: [{ parent: { subscription_item_details: { subscription: subscription.id } } }] },
    stack_stripe_mock_data: {
      "accounts.retrieve": { metadata: { tenancyId } },
      "customers.retrieve": { metadata: { customerId: userId, customerType: "USER" } },
      "subscriptions.list": { data: [subscription] },
    },
  };
  const template = getTvBuiltInProfile("company-pulse");
  if (template == null) throw new Error("The Company Pulse TV template must exist.");
  const profileResponse = await niceBackendFetch("/api/v1/internal/tv-mode/profiles", {
    accessType: "admin",
    method: "POST",
    body: { configuration: { ...template.configuration, displayName: "Payment facts", financialVisibility: "exact" } },
  });
  expect(profileResponse.status).toBe(200);
  const profile = await TvSavedProfileResourceSchema.validate(profileResponse.body.profile, { strict: true });

  async function observeInvoice(invoice: unknown, created: number) {
    const response = await Payments.sendStripeWebhook({
      id: `evt_status_${randomUUID()}`,
      type: "invoice.updated",
      created,
      account: accountInfo.body.account_id,
      data: { object: invoice },
    }, { secret: getEnvVariable("STACK_STRIPE_WEBHOOK_SECRET", "mock_stripe_webhook_secret") });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
  }

  async function assertInvoiceStatus(status: string) {
    await vi.waitFor(async () => {
      const response = await niceBackendFetch(`/api/latest/payments/invoices/user/${userId}`, { accessType: "client" });
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([
        expect.objectContaining({ status, amount_total: 1_000, hosted_invoice_url: null }),
      ]);
    }, { timeout: 10_000, interval: 250 });
  }

  async function assertTvRevenue(paidRevenueCents: number, applicableAttempts: number) {
    await vi.waitFor(async () => {
      const response = await niceBackendFetch(`/api/v1/internal/tv-mode/profiles/${profile.id}/snapshot`, { accessType: "admin" });
      expect(response.status).toBe(200);
      const snapshot = await TvSnapshotSchema.validate(response.body, { strict: true });
      const revenue = snapshot.screens.find((screen) => screen.id === "revenue-payments");
      if (revenue?.id !== "revenue-payments" || revenue.data == null) {
        throw new Error("The active subscription fixture must produce a TV revenue screen.");
      }
      expect(revenue.data).toMatchObject({
        financials: { visibility: "exact", paidRevenueCents },
        paymentSuccess: { applicableAttempts },
      });
    }, { timeout: 10_000, interval: 250 });
  }

  await observeInvoice(paidInvoice, paidSeconds + 60);
  await assertInvoiceStatus("paid");
  await assertTvRevenue(900, 1);

  // Preserve the pre-TV last-observed status behavior without erasing actual
  // collection evidence or replacing the collected amount with invoice total.
  await observeInvoice({
    ...paidInvoice,
    status: "open",
    amount_paid: 0,
    status_transitions: { ...paidInvoice.status_transitions, paid_at: null },
  }, paidSeconds - 60);
  await assertInvoiceStatus("open");
  await assertTvRevenue(900, 1);

  await observeInvoice({
    ...paidInvoice,
    status: "void",
    status_transitions: { ...paidInvoice.status_transitions, voided_at: paidSeconds + 120 },
  }, paidSeconds + 180);
  await assertInvoiceStatus("void");
  await assertTvRevenue(0, 0);

  // A delayed paid payload can restore the ordinary status, but must not make
  // TV count revenue or collection success for a later-voided invoice.
  await observeInvoice(paidInvoice, paidSeconds + 60);
  await assertInvoiceStatus("paid");
  await assertTvRevenue(0, 0);
}, 60_000);

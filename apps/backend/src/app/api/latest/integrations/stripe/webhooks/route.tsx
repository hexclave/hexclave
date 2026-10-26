import { sendEmailToMany, type EmailOutboxRecipient } from "@/lib/emails";
import { bulldozerWriteOneTimePurchase } from "@/lib/payments/bulldozer-dual-write";
import { claimStripeEvent, markStripeEventFailed, markStripeEventProcessed } from "@/lib/stripe-webhook-events";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { listPermissions } from "@/lib/permissions";
import { getHexclaveStripe, getStripeForAccount, resolveProductFromStripeMetadata, syncStripeSubscriptions, upsertStripeInvoice } from "@/lib/stripe";
import type { StripeOverridesMap } from "@/lib/stripe-proxy";
import { getTelegramConfig, sendTelegramMessage } from "@/lib/telegram";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { DEFAULT_TEMPLATE_IDS } from "@hexclave/shared/dist/helpers/emails";
import { yupMixed, yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { typedIncludes } from '@hexclave/shared/dist/utils/arrays';
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError, captureError } from "@hexclave/shared/dist/utils/errors";
import { getOrUndefined } from "@hexclave/shared/dist/utils/objects";
import { typedToUppercase } from "@hexclave/shared/dist/utils/strings";
import Stripe from "stripe";

const subscriptionChangedEvents = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "customer.subscription.trial_will_end",
  "invoice.created",
  "invoice.finalized",
  "invoice.updated",
  "invoice.voided",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.upcoming",
  "invoice.marked_uncollectible",
  "invoice.payment_succeeded",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
] as const satisfies Stripe.Event.Type[];

const ignoredEvents = [
  "account.updated",
  "account.application.authorized",
  "capability.updated",
  "charge.failed",
  "balance.available",
  "customer.updated",
  "customer.created",
  "invoice_payment.paid",
  "payout.created",
  "payout.paid",
  "payout.reconciliation_completed",
  "refund.updated",
] as const satisfies Stripe.Event.Type[];

const isSubscriptionChangedEvent = (event: Stripe.Event): event is Stripe.Event & { type: (typeof subscriptionChangedEvents)[number] } => {
  return subscriptionChangedEvents.includes(event.type as any);
};

const paymentCustomerTypes = ["user", "team", "custom"] as const;

const formatAmount = (amountCents: number | null | undefined, currency: string | null | undefined) => {
  if (typeof amountCents !== "number" || Number.isNaN(amountCents)) {
    return "Amount unavailable";
  }
  const amount = (amountCents / 100).toFixed(2);
  const normalizedCurrency = typeof currency === "string" && currency.length > 0 ? currency.toUpperCase() : "";
  return normalizedCurrency ? `${normalizedCurrency} ${amount}` : amount;
};

const normalizeCustomerType = (value: string | null | undefined) => {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  return typedIncludes(paymentCustomerTypes, normalized) ? normalized : null;
};

const formatStripeTimestamp = (timestampSeconds: number | null | undefined) => {
  if (typeof timestampSeconds !== "number" || Number.isNaN(timestampSeconds)) {
    return "Timestamp unavailable";
  }
  return new Date(timestampSeconds * 1000).toISOString();
};

const buildChargebackMessage = (options: {
  accountId: string,
  eventId: string,
  tenancy: Tenancy,
  dispute: Stripe.Dispute,
}) => {
  const chargeId = typeof options.dispute.charge === "string" ? options.dispute.charge : null;
  const paymentIntentId = typeof options.dispute.payment_intent === "string" ? options.dispute.payment_intent : null;
  const lines = [
    "Stripe chargeback received",
    `Project: ${options.tenancy.project.display_name} (${options.tenancy.project.id})`,
    `Tenancy: ${options.tenancy.id}`,
    `StripeAccount: ${options.accountId}`,
    `Event: ${options.eventId}`,
    `Dispute: ${options.dispute.id}`,
    `Amount: ${formatAmount(options.dispute.amount, options.dispute.currency)}`,
    `Reason: ${options.dispute.reason}`,
    `Status: ${options.dispute.status}`,
    chargeId ? `Charge: ${chargeId}` : null,
    paymentIntentId ? `PaymentIntent: ${paymentIntentId}` : null,
    `Created: ${formatStripeTimestamp(options.dispute.created)}`,
    `LiveMode: ${options.dispute.livemode ? "true" : "false"}`,
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
};

async function getTenancyForStripeAccountId(accountId: string, mockData?: StripeOverridesMap) {
  const stripe = getHexclaveStripe(mockData);
  const account = await stripe.accounts.retrieve(accountId);
  const tenancyId = account.metadata?.tenancyId;
  if (!tenancyId) {
    throw new HexclaveAssertionError("Stripe account metadata missing tenancyId", { accountId });
  }
  const tenancy = await getTenancy(tenancyId);
  if (!tenancy) {
    throw new HexclaveAssertionError("Tenancy not found", { accountId, tenancyId });
  }
  return tenancy;
}

async function getPaymentRecipients(options: {
  tenancy: Tenancy,
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  customerType: (typeof paymentCustomerTypes)[number],
  customerId: string,
}): Promise<EmailOutboxRecipient[]> {
  if (options.customerType === "user") {
    return [{ type: "user-primary-email", userId: options.customerId }];
  }
  if (options.customerType === "team") {
    const permissions = await listPermissions(options.prisma, {
      scope: "team",
      tenancy: options.tenancy,
      teamId: options.customerId,
      permissionId: "team_admin",
      recursive: true,
    });
    const userIds = [...new Set(permissions.map((permission) => permission.user_id))];
    return userIds.map((userId) => ({ type: "user-primary-email", userId }));
  }
  return [];
}

async function sendDefaultTemplateEmail(options: {
  tenancy: Tenancy,
  recipients: EmailOutboxRecipient[],
  templateType: keyof typeof DEFAULT_TEMPLATE_IDS,
  extraVariables: Record<string, string | number>,
}) {
  if (options.recipients.length === 0) {
    return;
  }
  const templateId = DEFAULT_TEMPLATE_IDS[options.templateType];
  const template = getOrUndefined(options.tenancy.config.emails.templates, templateId);
  if (!template) {
    throw new HexclaveAssertionError(`Default email template not found: ${options.templateType}`, { templateId });
  }
  await sendEmailToMany({
    tenancy: options.tenancy,
    recipients: options.recipients,
    tsxSource: template.tsxSource,
    extraVariables: options.extraVariables,
    themeId: template.themeId === false ? null : (template.themeId ?? options.tenancy.config.emails.selectedThemeId),
    createdWith: { type: "programmatic-call", templateId },
    isHighPriority: true,
    shouldSkipDeliverabilityCheck: false,
    scheduledAt: new Date(),
  });
}

async function processStripeWebhookEvent(event: Stripe.Event): Promise<void> {
  const mockData = (event.data.object as { stack_stripe_mock_data?: StripeOverridesMap }).stack_stripe_mock_data;
  if (event.type === "payment_intent.succeeded" && event.data.object.metadata.purchaseKind === "ONE_TIME") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent & {
      charges?: { data?: Array<{ receipt_url?: string | null }> },
    };
    const metadata = paymentIntent.metadata;
    const accountId = event.account;
    if (!accountId) {
      throw new HexclaveAssertionError("Stripe webhook account id missing", { event });
    }
    const tenancy = await getTenancyForStripeAccountId(accountId, mockData);
    const prisma = await getPrismaClientForTenancy(tenancy);

    const product = await resolveProductFromStripeMetadata({
      prisma,
      tenancyId: tenancy.id,
      metadata: metadata as Record<string, string | undefined>,
      context: { paymentIntentId: paymentIntent.id },
    });

    const qty = Math.max(1, Number(metadata.purchaseQuantity || 1));
    const stripePaymentIntentId = paymentIntent.id;
    if (!metadata.customerId || !metadata.customerType) {
      throw new HexclaveAssertionError("Missing customer metadata for one-time purchase", { event });
    }
    const customerType = normalizeCustomerType(metadata.customerType);
    if (!customerType) {
      throw new HexclaveAssertionError("Invalid customer type for one-time purchase", { event });
    }
    // dual write - prisma and bulldozer
    const upsertedPurchase = await prisma.oneTimePurchase.upsert({
      where: {
        tenancyId_stripePaymentIntentId: {
          tenancyId: tenancy.id,
          stripePaymentIntentId,
        },
      },
      create: {
        tenancyId: tenancy.id,
        customerId: metadata.customerId,
        customerType: typedToUppercase(customerType),
        productId: metadata.productId || null,
        priceId: metadata.priceId || null,
        stripePaymentIntentId,
        product,
        quantity: qty,
        creationSource: "PURCHASE_PAGE",
      },
      update: {
        productId: metadata.productId || null,
        priceId: metadata.priceId || null,
        product,
        quantity: qty,
      }
    });
    const paidAt = new Date(event.created * 1000);
    // PaymentIntent webhooks can be replayed or delivered out of order. Only a
    // success event may stamp collection truth, and an older success must not
    // replace a newer authoritative observation for the same logical purchase.
    await prisma.$executeRaw`
      UPDATE "OneTimePurchase"
      SET
        "amountReceived" = CASE
          WHEN "paidAt" IS NULL OR ${paidAt} >= "paidAt" THEN ${paymentIntent.amount_received}
          ELSE "amountReceived"
        END,
        "currency" = CASE
          WHEN "paidAt" IS NULL OR ${paidAt} >= "paidAt" THEN UPPER(${paymentIntent.currency})
          ELSE "currency"
        END,
        "paidAt" = GREATEST("paidAt", ${paidAt})
      WHERE "tenancyId" = ${tenancy.id}::UUID
        AND "id" = ${upsertedPurchase.id}::UUID
    `;
    const normalizedPurchase = (await prisma.$queryRaw<Array<typeof upsertedPurchase & {
      amountReceived: number | null,
      currency: string | null,
      paidAt: Date | null,
    }>>`
      SELECT * FROM "OneTimePurchase"
      WHERE "tenancyId" = ${tenancy.id}::UUID AND "id" = ${upsertedPurchase.id}::UUID
    `).at(0);
    if (normalizedPurchase == null) {
      throw new HexclaveAssertionError("Normalized one-time purchase disappeared after update", { tenancyId: tenancy.id, purchaseId: upsertedPurchase.id });
    }
    await bulldozerWriteOneTimePurchase(normalizedPurchase);
    const latestPurchase = (await prisma.$queryRaw<Array<typeof normalizedPurchase>>`
      SELECT * FROM "OneTimePurchase"
      WHERE "tenancyId" = ${tenancy.id}::UUID AND "id" = ${upsertedPurchase.id}::UUID
    `).at(0);
    if (latestPurchase == null) {
      throw new HexclaveAssertionError("One-time purchase disappeared during Bulldozer convergence", { tenancyId: tenancy.id, purchaseId: upsertedPurchase.id });
    }
    if (
      latestPurchase.paidAt?.getTime() !== normalizedPurchase.paidAt?.getTime()
      || latestPurchase.amountReceived !== normalizedPurchase.amountReceived
      || latestPurchase.currency !== normalizedPurchase.currency
    ) {
      await bulldozerWriteOneTimePurchase(latestPurchase);
    }

    const recipients = await getPaymentRecipients({
      tenancy,
      prisma,
      customerType,
      customerId: metadata.customerId,
    });
    const receiptLink = paymentIntent.charges?.data?.[0]?.receipt_url ?? null;
    const productName = product.displayName ?? "Purchase";
    const extraVariables: Record<string, string | number> = {
      productName,
      quantity: qty,
      amount: formatAmount(paymentIntent.amount_received, paymentIntent.currency),
    };
    if (receiptLink) {
      extraVariables.receiptLink = receiptLink;
    }
    await sendDefaultTemplateEmail({
      tenancy,
      recipients,
      templateType: "payment_receipt",
      extraVariables,
    });
  }
  else if (event.type === "payment_intent.payment_failed" && event.data.object.metadata.purchaseKind === "ONE_TIME") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const metadata = paymentIntent.metadata;
    const accountId = event.account;
    if (!accountId) {
      throw new HexclaveAssertionError("Stripe webhook account id missing", { event });
    }
    const tenancy = await getTenancyForStripeAccountId(accountId, mockData);
    const prisma = await getPrismaClientForTenancy(tenancy);
    if (!metadata.customerId || !metadata.customerType) {
      throw new HexclaveAssertionError("Missing customer metadata for one-time purchase failure", { event });
    }
    const customerType = normalizeCustomerType(metadata.customerType);
    if (!customerType) {
      throw new HexclaveAssertionError("Invalid customer type for one-time purchase failure", { event });
    }
    const recipients = await getPaymentRecipients({
      tenancy,
      prisma,
      customerType,
      customerId: metadata.customerId,
    });
    const product = await resolveProductFromStripeMetadata({
      prisma,
      tenancyId: tenancy.id,
      metadata: metadata as Record<string, string | undefined>,
      context: { paymentIntentId: paymentIntent.id },
    });
    const productName = product.displayName ?? "Purchase";
    const failureReason = paymentIntent.last_payment_error?.message;
    const extraVariables: Record<string, string | number> = {
      productName,
      amount: formatAmount(paymentIntent.amount, paymentIntent.currency),
    };
    if (failureReason) {
      extraVariables.failureReason = failureReason;
    }
    await sendDefaultTemplateEmail({
      tenancy,
      recipients,
      templateType: "payment_failed",
      extraVariables,
    });
  }
  else if (event.type === "charge.dispute.created") {
    const telegramConfig = getTelegramConfig("chargebacks");
    if (!telegramConfig) {
      return;
    }
    const accountId = event.account;
    if (!accountId) {
      throw new HexclaveAssertionError("Stripe webhook account id missing", { event });
    }
    const dispute = event.data.object as Stripe.Dispute;
    const tenancy = await getTenancyForStripeAccountId(accountId, mockData);
    const message = buildChargebackMessage({
      accountId,
      eventId: event.id,
      tenancy,
      dispute,
    });
    await sendTelegramMessage({
      ...telegramConfig,
      message,
    });
  }
  else if (isSubscriptionChangedEvent(event)) {
    const accountId = event.account;
    const customerId = event.data.object.customer;
    if (!accountId) {
      throw new HexclaveAssertionError("Stripe webhook account id missing", { event });
    }
    if (typeof customerId !== 'string') {
      throw new HexclaveAssertionError("Stripe webhook bad customer id", { event });
    }
    const stripe = await getStripeForAccount({ accountId }, mockData);
    await syncStripeSubscriptions(stripe, accountId, customerId);

    if (event.type.startsWith("invoice.")) {
      const invoice = event.data.object as Stripe.Invoice;
      await upsertStripeInvoice(stripe, accountId, invoice, event);
    }

    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object as Stripe.Invoice;

      // Skip $0 invoices (e.g. free-trial creation invoices) so customers don't
      // get a "payment receipt" that looks like they were charged at checkout.
      if (invoice.amount_paid === 0) {
        return;
      }

      const tenancy = await getTenancyForStripeAccountId(accountId, mockData);
      const prisma = await getPrismaClientForTenancy(tenancy);
      const stripeCustomerId = invoice.customer;
      if (typeof stripeCustomerId !== "string") {
        throw new HexclaveAssertionError("Stripe invoice customer id missing", { event });
      }
      const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId);
      if (stripeCustomer.deleted) {
        throw new HexclaveAssertionError("Stripe invoice customer deleted", { event });
      }
      const customerType = normalizeCustomerType(stripeCustomer.metadata.customerType);
      if (!stripeCustomer.metadata.customerId || !customerType) {
        throw new HexclaveAssertionError("Stripe invoice customer metadata missing customerId or customerType", { event });
      }
      const recipients = await getPaymentRecipients({
        tenancy,
        prisma,
        customerType,
        customerId: stripeCustomer.metadata.customerId,
      });
      const invoiceLines = (invoice as { lines?: { data?: Stripe.InvoiceLineItem[] } }).lines?.data ?? [];
      const lineItem = invoiceLines.length > 0 ? invoiceLines[0] : null;
      const productName = lineItem?.description ?? "Subscription";
      const quantity = lineItem?.quantity ?? 1;
      const receiptLink = invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? null;
      const extraVariables: Record<string, string | number> = {
        productName,
        quantity,
        amount: formatAmount(invoice.amount_paid, invoice.currency),
      };
      if (receiptLink) {
        extraVariables.receiptLink = receiptLink;
      }
      await sendDefaultTemplateEmail({
        tenancy,
        recipients,
        templateType: "payment_receipt",
        extraVariables,
      });
    }

    if (event.type === "customer.subscription.trial_will_end") {
      const subscription = event.data.object as Stripe.Subscription;
      const tenancy = await getTenancyForStripeAccountId(accountId, mockData);
      const prisma = await getPrismaClientForTenancy(tenancy);
      const stripeCustomerId = subscription.customer;
      if (typeof stripeCustomerId !== "string") {
        throw new HexclaveAssertionError("Stripe subscription customer id missing", { event });
      }
      const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId);
      if (stripeCustomer.deleted) {
        throw new HexclaveAssertionError("Stripe subscription customer deleted", { event });
      }
      const customerType = normalizeCustomerType(stripeCustomer.metadata.customerType);
      if (!stripeCustomer.metadata.customerId || !customerType) {
        throw new HexclaveAssertionError("Stripe subscription customer metadata missing customerId or customerType", { event });
      }
      const recipients = await getPaymentRecipients({
        tenancy,
        prisma,
        customerType,
        customerId: stripeCustomer.metadata.customerId,
      });
      const product = await resolveProductFromStripeMetadata({
        prisma,
        tenancyId: tenancy.id,
        metadata: subscription.metadata as Record<string, string | undefined>,
        context: { subscriptionId: subscription.id },
      });
      const productName = product.displayName ?? "Subscription";
      const trialEndDate = formatStripeTimestamp(subscription.trial_end);
      await sendDefaultTemplateEmail({
        tenancy,
        recipients,
        templateType: "trial_will_end",
        extraVariables: {
          productName,
          trialEndDate,
        },
      });
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.status !== "uncollectible") {
        return;
      }
      const tenancy = await getTenancyForStripeAccountId(accountId, mockData);
      const prisma = await getPrismaClientForTenancy(tenancy);
      const stripeCustomerId = invoice.customer;
      if (typeof stripeCustomerId !== "string") {
        throw new HexclaveAssertionError("Stripe invoice customer id missing", { event });
      }
      const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId);
      if (stripeCustomer.deleted) {
        throw new HexclaveAssertionError("Stripe invoice customer deleted", { event });
      }
      const customerType = normalizeCustomerType(stripeCustomer.metadata.customerType);
      if (!stripeCustomer.metadata.customerId || !customerType) {
        throw new HexclaveAssertionError("Stripe invoice customer metadata missing customerId or customerType", { event });
      }
      const recipients = await getPaymentRecipients({
        tenancy,
        prisma,
        customerType,
        customerId: stripeCustomer.metadata.customerId,
      });
      const invoiceLines = (invoice as { lines?: { data?: Stripe.InvoiceLineItem[] } }).lines?.data ?? [];
      const lineItem = invoiceLines.length > 0 ? invoiceLines[0] : null;
      const productName = lineItem?.description ?? "Subscription";
      const invoiceUrl = invoice.hosted_invoice_url ?? null;
      const extraVariables: Record<string, string | number> = {
        productName,
        amount: formatAmount(invoice.amount_due, invoice.currency),
      };
      if (invoiceUrl) {
        extraVariables.invoiceUrl = invoiceUrl;
      }
      await sendDefaultTemplateEmail({
        tenancy,
        recipients,
        templateType: "payment_failed",
        extraVariables,
      });
    }
  }
  else if (typedIncludes(ignoredEvents, event.type)) {
    // These events are received but don't require processing
    return;
  }
  else {
    throw new HexclaveAssertionError("Unknown stripe webhook type received: " + event.type, { event });
  }
}

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    headers: yupObject({
      "stripe-signature": yupTuple([yupString().defined()]).defined(),
    }).defined(),
    body: yupMixed().optional(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
  }),
  handler: async (req, fullReq) => {
    const stripe = getHexclaveStripe();
    let event: Stripe.Event;
    try {
      const signature = req.headers["stripe-signature"][0];
      const textBody = new TextDecoder().decode(fullReq.bodyBuffer);
      event = stripe.webhooks.constructEvent(
        textBody,
        signature,
        getEnvVariable("STACK_STRIPE_WEBHOOK_SECRET"),
      );
    } catch {
      throw new StatusError(400, "Invalid stripe-signature header");
    }

    // Persist the event for idempotency + recovery BEFORE acking. Stripe
    // delivers at-least-once
    const { shouldProcess } = await claimStripeEvent(event);
    if (!shouldProcess) {
      return {
        statusCode: 200,
        bodyType: "json",
        body: { received: true, deduplicated: true },
      };
    }

    // Ack Stripe immediately and process in the background.
    // Stripe recommends ACKing ASAP to avoid timeouts and redeliveries
    runAsynchronouslyAndWaitUntil(async () => {
      try {
        await processStripeWebhookEvent(event);
        await markStripeEventProcessed(event.id);
      } catch (error) {
        captureError("stripe-webhook-receiver", error);
        await markStripeEventFailed(event.id, error);
      }
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: { received: true }
    };
  },
});

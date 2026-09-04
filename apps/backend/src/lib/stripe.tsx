import { CustomerType, Prisma } from "@/generated/prisma/client";
import { bulldozerWriteSubscription, bulldozerWriteSubscriptionInvoice } from "@/lib/payments/bulldozer-dual-write";
import { ensureFreePlanForBillingTeam } from "@/lib/payments/ensure-free-plan";
import { getProductVersion } from "@/lib/product-versions";
import { getTenancy, Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, globalPrismaClient, type PrismaClientTransaction } from "@/prisma-client";
import type { productSchema } from "@hexclave/shared/dist/schema-fields";
import { typedIncludes } from "@hexclave/shared/dist/utils/arrays";
import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import Stripe from "stripe";
import type * as yup from "yup";
import { createStripeProxy, type StripeOverridesMap } from "./stripe-proxy";

const stripeSecretKey = getEnvVariable("STACK_STRIPE_SECRET_KEY", "");
export const useStripeMock = stripeSecretKey === "sk_test_mockstripekey" && ["development", "test"].includes(getNodeEnvironment());
const hexclavePortPrefix = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81");
const stripeMockPort = Number(getEnvVariable("STACK_STRIPE_MOCK_PORT", "") || `${hexclavePortPrefix}23`);
const stripeConfig: Stripe.StripeConfig = useStripeMock ? {
  protocol: "http",
  host: "localhost",
  port: stripeMockPort,
} : {};

/** Product type as stored in Stripe metadata (same as config product schema) */
export type StripeMetadataProduct = yup.InferType<typeof productSchema>;

/**
 * Sanitizes subscription period dates from Stripe.
 *
 * The Stripe mock returns hardcoded fixture dates that are invalid (e.g., start in 2030, end in 2000).
 * This function detects when end <= start and replaces with sensible defaults.
 *
 * We only check the ordering constraint to avoid interfering with legitimate Stripe dates
 * (e.g., long trials, future billing anchors).
 *
 * @param startTimestamp - Unix timestamp in seconds for period start
 * @param endTimestamp - Unix timestamp in seconds for period end
 * @param context - Optional context for error reporting (subscriptionId, tenancyId)
 * @returns Sanitized Date objects for start and end
 */
export function sanitizeStripePeriodDates(
  startTimestamp: number,
  endTimestamp: number,
  context?: { subscriptionId?: string, tenancyId?: string },
): { start: Date, end: Date } {
  const startDate = new Date(startTimestamp * 1000);
  const endDate = new Date(endTimestamp * 1000);

  if (startDate < endDate) {
    return { start: startDate, end: endDate };
  }

  // Dates are invalid (likely from Stripe mock where end <= start), use sensible defaults
  captureError("sanitize-stripe-period-dates", new HexclaveAssertionError(
    "Invalid Stripe period dates detected (end <= start), using fallback dates",
    { startTimestamp, endTimestamp, startDate, endDate, useStripeMock, ...context }
  ));

  const now = new Date();
  const defaultEnd = new Date(now);
  defaultEnd.setMonth(defaultEnd.getMonth() + 1);

  return { start: now, end: defaultEnd };
}

/**
 * Resolves product JSON from Stripe metadata with backward compatibility.
 *
 * Resolution order:
 * 1. productVersionId - new approach, looks up ProductVersion table
 * 2. product - older approach, JSON string in metadata
 * 3. offer - oldest approach, JSON string in metadata (legacy naming)
 *
 * @throws HexclaveAssertionError if none of the above are found
 */
export async function resolveProductFromStripeMetadata(options: {
  prisma: Parameters<typeof getProductVersion>[0]['prisma'],
  tenancyId: string,
  metadata: Record<string, string | undefined>,
  context?: { subscriptionId?: string, paymentIntentId?: string },
}): Promise<StripeMetadataProduct> {
  const productVersionId = options.metadata.productVersionId;
  if (productVersionId) {
    const version = await getProductVersion({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      productVersionId,
    });
    return version.productJson as StripeMetadataProduct;
  }

  const productString = options.metadata.product ?? options.metadata.offer;
  if (productString) {
    try {
      return JSON.parse(productString) as StripeMetadataProduct;
    } catch (error) {
      throw new HexclaveAssertionError(
        "Failed to parse product JSON from Stripe metadata. The 'product' or 'offer' field contains invalid JSON.",
        {
          ...options.context,
          tenancyId: options.tenancyId,
          productString,
          metadata: options.metadata,
          cause: error,
        }
      );
    }
  }

  throw new HexclaveAssertionError(
    "Stripe metadata is missing product information. Expected one of: 'productVersionId' (current), 'product' (legacy), or 'offer' (oldest). This may indicate the purchase was created before product tracking was implemented, or the metadata was corrupted.",
    {
      ...options.context,
      tenancyId: options.tenancyId,
      metadata: options.metadata,
    }
  );
}

import.meta.vitest?.describe("resolveProductFromStripeMetadata", (test) => {
  const mockProduct = { displayName: "Test Product", customerType: "team" as const };

  // Note: productVersionId path is tested via E2E tests since it requires database mocking

  test("falls back to 'product' metadata (legacy format)", async ({ expect }) => {
    const result = await resolveProductFromStripeMetadata({
      prisma: {} as any,
      tenancyId: "tenant-1",
      metadata: { product: JSON.stringify(mockProduct) },
    });

    expect(result).toEqual(mockProduct);
  });

  test("falls back to 'offer' metadata (oldest format)", async ({ expect }) => {
    const result = await resolveProductFromStripeMetadata({
      prisma: {} as any,
      tenancyId: "tenant-1",
      metadata: { offer: JSON.stringify(mockProduct) },
    });

    expect(result).toEqual(mockProduct);
  });

  test("prefers 'product' over 'offer' when both present", async ({ expect }) => {
    const offerProduct = { displayName: "Offer Product", customerType: "user" as const };

    const result = await resolveProductFromStripeMetadata({
      prisma: {} as any,
      tenancyId: "tenant-1",
      metadata: {
        product: JSON.stringify(mockProduct),
        offer: JSON.stringify(offerProduct),
      },
    });

    expect(result).toEqual(mockProduct);
  });

  test("throws on invalid JSON in product field", async ({ expect }) => {
    await expect(resolveProductFromStripeMetadata({
      prisma: {} as any,
      tenancyId: "tenant-1",
      metadata: { product: "not valid json" },
    })).rejects.toThrow("Failed to parse product JSON");
  });

  test("throws when no product info in metadata", async ({ expect }) => {
    await expect(resolveProductFromStripeMetadata({
      prisma: {} as any,
      tenancyId: "tenant-1",
      metadata: {},
    })).rejects.toThrow("Stripe metadata is missing product information");
  });

  test("includes context in error when provided", async ({ expect }) => {
    await expect(resolveProductFromStripeMetadata({
      prisma: {} as any,
      tenancyId: "tenant-1",
      metadata: {},
      context: { subscriptionId: "sub-123" },
    })).rejects.toMatchObject({
      message: expect.stringContaining("missing product information"),
    });
  });
});
export const getHexclaveStripe = (overrides?: StripeOverridesMap) => {
  if (!stripeSecretKey) {
    throw new HexclaveAssertionError("STACK_STRIPE_SECRET_KEY environment variable is not set");
  }
  if (overrides && !useStripeMock) {
    throw new HexclaveAssertionError("Stripe overrides are not supported in production");
  }
  return createStripeProxy(new Stripe(stripeSecretKey, stripeConfig), overrides);
};

export const getStripeForAccount = async (options: { tenancy?: Tenancy, accountId?: string }, overrides?: StripeOverridesMap) => {
  if (!stripeSecretKey) {
    throw new HexclaveAssertionError("STACK_STRIPE_SECRET_KEY environment variable is not set");
  }
  if (overrides && !useStripeMock) {
    throw new HexclaveAssertionError("Stripe overrides are not supported in production");
  }
  if (!options.tenancy && !options.accountId) {
    throwErr(400, "Either tenancy or stripeAccountId must be provided");
  }

  let accountId = options.accountId;

  if (!accountId && options.tenancy) {
    const project = await globalPrismaClient.project.findUnique({
      where: { id: options.tenancy.project.id },
      select: { stripeAccountId: true },
    });
    accountId = project?.stripeAccountId || undefined;
  }

  if (!accountId) {
    throwErr(400, "Payments are not set up in this Hexclave project. Please go to the Hexclave dashboard and complete the Payments onboarding.");
  }
  return createStripeProxy(new Stripe(stripeSecretKey, { stripeAccount: accountId, ...stripeConfig }), overrides);
};

const getTenancyFromStripeAccountIdOrThrow = async (stripe: Stripe, stripeAccountId: string) => {
  const account = await stripe.accounts.retrieve(stripeAccountId);
  if (!account.metadata?.tenancyId || typeof account.metadata.tenancyId !== "string") {
    throw new HexclaveAssertionError("Stripe account metadata missing tenancyId", { accountId: stripeAccountId });
  }
  const tenancy = await getTenancy(account.metadata.tenancyId);
  if (!tenancy) {
    throw new HexclaveAssertionError("Tenancy not found", { accountId: stripeAccountId });
  }
  return tenancy;
};

const TERMINAL_STRIPE_STATUSES = ["canceled", "incomplete_expired", "unpaid"] as const;

function getEndedAtForSync(subscription: Stripe.Subscription, sanitizedEnd: Date): { endedAt: Date } | {} {
  if (!TERMINAL_STRIPE_STATUSES.includes(subscription.status as typeof TERMINAL_STRIPE_STATUSES[number])) {
    return {};
  }
  // Prefer Stripe's `ended_at` — real Stripe always sets it on transitions into
  // a terminal status. If the webhook payload omits it (mocks, older API
  // versions), fall back to the already-past period boundary so the timefold
  // can fire sub-end inline; absolute last resort is `now`.
  if (subscription.ended_at) {
    return { endedAt: new Date(subscription.ended_at * 1000) };
  }
  //fallback for if stripe didnt set ended_at but sub definitely ended i.e current_period_end <= now
  if (sanitizedEnd <= new Date()) {
    return { endedAt: sanitizedEnd };
  }
  return { endedAt: new Date() };
}

function getCanceledAtForSync(subscription: Stripe.Subscription): { canceledAt: Date } | {} {
  if (subscription.canceled_at) {
    return { canceledAt: new Date(subscription.canceled_at * 1000) };
  }
  return {};
}

export async function syncStripeSubscriptions(stripe: Stripe, stripeAccountId: string, stripeCustomerId: string) {
  const tenancy = await getTenancyFromStripeAccountIdOrThrow(stripe, stripeAccountId);
  const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId);
  if (stripeCustomer.deleted) {
    return;
  }
  const customerId = stripeCustomer.metadata.customerId;
  const customerType = stripeCustomer.metadata.customerType;
  if (!customerId || !customerType) {
    throw new HexclaveAssertionError("Stripe customer metadata missing customerId or customerType");
  }
  if (!typedIncludes(Object.values(CustomerType), customerType)) {
    throw new HexclaveAssertionError("Stripe customer metadata has invalid customerType");
  }
  const prisma = await getPrismaClientForTenancy(tenancy);
  const subscriptions = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
  });

  // TODO: handle in parallel, store payment method?
  for (const subscription of subscriptions.data) {
    if (subscription.items.data.length === 0) {
      continue;
    }
    const item = subscription.items.data[0];
    const sanitizedDates = sanitizeStripePeriodDates(
      item.current_period_start,
      item.current_period_end,
      { subscriptionId: subscription.id, tenancyId: tenancy.id }
    );
    const priceId = subscription.metadata.priceId as string | undefined;

    const product = await resolveProductFromStripeMetadata({
      prisma,
      tenancyId: tenancy.id,
      metadata: subscription.metadata as Record<string, string | undefined>,
      context: { subscriptionId: subscription.id },
    });

    // dual write - prisma and bulldozer
    const upsertedSub = await prisma.subscription.upsert({
      where: {
        tenancyId_stripeSubscriptionId: {
          tenancyId: tenancy.id,
          stripeSubscriptionId: subscription.id,
        },
      },
      update: {
        status: subscription.status,
        product,
        quantity: item.quantity ?? 1,
        currentPeriodEnd: sanitizedDates.end,
        currentPeriodStart: sanitizedDates.start,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        priceId: priceId ?? null,
        ...getEndedAtForSync(subscription, sanitizedDates.end),
        ...getCanceledAtForSync(subscription),
      },
      create: {
        tenancyId: tenancy.id,
        customerId,
        customerType,
        productId: subscription.metadata.productId as string | undefined ?? subscription.metadata.offerId,
        priceId: priceId ?? null,
        product,
        quantity: item.quantity ?? 1,
        stripeSubscriptionId: subscription.id,
        status: subscription.status,
        currentPeriodEnd: sanitizedDates.end,
        currentPeriodStart: sanitizedDates.start,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        creationSource: "PURCHASE_PAGE"
      },
    });
    await bulldozerWriteSubscription(upsertedSub);
  }

  // If this was a cancellation on our own billing (internal tenancy hosts the
  // free/team/growth plans), regrant free so the team doesn't end up at zero
  // entitlements. No-op if the team still owns another plan in the line, or
  // for customer projects' own Stripe webhooks.
  if (tenancy.project.id === "internal" && customerType === CustomerType.TEAM) {
    await ensureFreePlanForBillingTeam(customerId);
  }
}

type StripeInvoiceTransitionSource = {
  status?: string | null,
  status_transitions?: {
    paid_at?: number | null,
    marked_uncollectible_at?: number | null,
    voided_at?: number | null,
  },
};

function getStripeInvoiceStatusTransitions(invoice: StripeInvoiceTransitionSource) {
  return invoice.status_transitions;
}

function getStripeInvoiceOutcomeTimestamps(
  invoice: StripeInvoiceTransitionSource,
  event: Pick<Stripe.Event, "created" | "type">,
): {
  paymentOutcomeEventAt: Date | null,
  paidAt: Date | null,
  paidAtIsExact: boolean,
  markedUncollectibleAt: Date | null,
  markedUncollectibleAtIsExact: boolean,
  voidedAt: Date | null,
  voidedAtIsExact: boolean,
} {
  const transitionTimestamp = (timestamp: number | null | undefined) => timestamp == null ? null : new Date(timestamp * 1000);
  const statusTransitions = getStripeInvoiceStatusTransitions(invoice);
  const eventTimestamp = new Date(event.created * 1000);
  const exactPaidAt = transitionTimestamp(statusTransitions?.paid_at);
  const exactMarkedUncollectibleAt = transitionTimestamp(statusTransitions?.marked_uncollectible_at);
  const exactVoidedAt = transitionTimestamp(statusTransitions?.voided_at);
  const paidAt = exactPaidAt
    ?? (
      event.type === "invoice.paid" || event.type === "invoice.payment_succeeded"
        ? eventTimestamp
        : null
    );
  const markedUncollectibleAt = exactMarkedUncollectibleAt
    ?? (event.type === "invoice.marked_uncollectible" ? eventTimestamp : null);
  const voidedAt = exactVoidedAt
    ?? (event.type === "invoice.voided" ? eventTimestamp : null);
  return {
    // The watermark only records exact outcomes. Inferred outcomes remain
    // COALESCE-only so a later-delivered exact event can correct them.
    paymentOutcomeEventAt: exactPaidAt != null
      || exactMarkedUncollectibleAt != null
      || exactVoidedAt != null
      ? eventTimestamp
      : null,
    // The transition object is the most precise source. Some webhook payloads
    // omit it, but an exact outcome event's own Stripe timestamp is still
    // authoritative evidence of the successful or terminal transition.
    paidAt,
    paidAtIsExact: exactPaidAt != null,
    markedUncollectibleAt,
    markedUncollectibleAtIsExact: exactMarkedUncollectibleAt != null,
    voidedAt,
    voidedAtIsExact: exactVoidedAt != null,
  };
}

import.meta.vitest?.describe("getStripeInvoiceOutcomeTimestamps", (test) => {
  test("uses terminal webhook timestamps without advancing the exact-outcome watermark", ({ expect }) => {
    const occurredAtSeconds = 1_787_098_400;
    const occurredAt = new Date(occurredAtSeconds * 1000);
    expect(getStripeInvoiceOutcomeTimestamps({}, {
      type: "invoice.paid",
      created: occurredAtSeconds,
    })).toEqual({
      paymentOutcomeEventAt: null,
      paidAt: occurredAt,
      paidAtIsExact: false,
      markedUncollectibleAt: null,
      markedUncollectibleAtIsExact: false,
      voidedAt: null,
      voidedAtIsExact: false,
    });
    expect(getStripeInvoiceOutcomeTimestamps({}, {
      type: "invoice.payment_succeeded",
      created: occurredAtSeconds,
    })).toEqual({
      paymentOutcomeEventAt: null,
      paidAt: occurredAt,
      paidAtIsExact: false,
      markedUncollectibleAt: null,
      markedUncollectibleAtIsExact: false,
      voidedAt: null,
      voidedAtIsExact: false,
    });
    expect(getStripeInvoiceOutcomeTimestamps({}, {
      type: "invoice.marked_uncollectible",
      created: occurredAtSeconds,
    })).toEqual({
      paymentOutcomeEventAt: null,
      paidAt: null,
      paidAtIsExact: false,
      markedUncollectibleAt: occurredAt,
      markedUncollectibleAtIsExact: false,
      voidedAt: null,
      voidedAtIsExact: false,
    });
    expect(getStripeInvoiceOutcomeTimestamps({}, {
      type: "invoice.voided",
      created: occurredAtSeconds,
    })).toEqual({
      paymentOutcomeEventAt: null,
      paidAt: null,
      paidAtIsExact: false,
      markedUncollectibleAt: null,
      markedUncollectibleAtIsExact: false,
      voidedAt: occurredAt,
      voidedAtIsExact: false,
    });
  });

  test("prefers Stripe's precise transition timestamp and does not infer from non-terminal events", ({ expect }) => {
    const paidAtSeconds = 1_787_098_100;
    expect(getStripeInvoiceOutcomeTimestamps({
      status_transitions: { paid_at: paidAtSeconds },
    }, {
      type: "invoice.updated",
      created: 1_787_098_400,
    })).toEqual({
      paymentOutcomeEventAt: new Date(1_787_098_400 * 1000),
      paidAt: new Date(paidAtSeconds * 1000),
      paidAtIsExact: true,
      markedUncollectibleAt: null,
      markedUncollectibleAtIsExact: false,
      voidedAt: null,
      voidedAtIsExact: false,
    });
    expect(getStripeInvoiceOutcomeTimestamps({}, {
      type: "invoice.updated",
      created: 1_787_098_400,
    })).toEqual({
      paymentOutcomeEventAt: null,
      paidAt: null,
      paidAtIsExact: false,
      markedUncollectibleAt: null,
      markedUncollectibleAtIsExact: false,
      voidedAt: null,
      voidedAtIsExact: false,
    });
  });

  test("does not infer terminal outcomes from status-only snapshots", ({ expect }) => {
    const occurredAtSeconds = 1_787_098_400;
    const occurredAt = new Date(occurredAtSeconds * 1000);
    expect(getStripeInvoiceOutcomeTimestamps({ status: "uncollectible" }, {
      type: "invoice.payment_failed",
      created: occurredAtSeconds,
    })).toMatchObject({
      paymentOutcomeEventAt: null,
      markedUncollectibleAt: null,
      voidedAt: null,
    });
    expect(getStripeInvoiceOutcomeTimestamps({ status: "void" }, {
      type: "invoice.updated",
      created: occurredAtSeconds,
    })).toMatchObject({
      paymentOutcomeEventAt: null,
      markedUncollectibleAt: null,
      voidedAt: null,
    });
    expect(getStripeInvoiceOutcomeTimestamps({ status: "uncollectible" }, {
      type: "invoice.marked_uncollectible",
      created: occurredAtSeconds,
    })).toMatchObject({
      paymentOutcomeEventAt: null,
      markedUncollectibleAt: occurredAt,
      markedUncollectibleAtIsExact: false,
    });
    expect(getStripeInvoiceOutcomeTimestamps({ status: "void" }, {
      type: "invoice.voided",
      created: occurredAtSeconds,
    })).toMatchObject({
      paymentOutcomeEventAt: null,
      voidedAt: occurredAt,
      voidedAtIsExact: false,
    });
  });

  test("prefers exact terminal transitions over event timestamps", ({ expect }) => {
    const eventAtSeconds = 1_787_098_400;
    const exactAtSeconds = 1_787_098_100;
    expect(getStripeInvoiceOutcomeTimestamps({
      status: "uncollectible",
      status_transitions: { marked_uncollectible_at: exactAtSeconds },
    }, {
      type: "invoice.marked_uncollectible",
      created: eventAtSeconds,
    })).toMatchObject({
      paymentOutcomeEventAt: new Date(eventAtSeconds * 1000),
      markedUncollectibleAt: new Date(exactAtSeconds * 1000),
      markedUncollectibleAtIsExact: true,
    });
    expect(getStripeInvoiceOutcomeTimestamps({
      status: "void",
      status_transitions: { voided_at: exactAtSeconds },
    }, {
      type: "invoice.voided",
      created: eventAtSeconds,
    })).toMatchObject({
      paymentOutcomeEventAt: new Date(eventAtSeconds * 1000),
      voidedAt: new Date(exactAtSeconds * 1000),
      voidedAtIsExact: true,
    });
  });

});

export type StripeInvoiceOutcomeTimestamps = ReturnType<typeof getStripeInvoiceOutcomeTimestamps>;

export async function applyStripeInvoiceOutcome(
  prisma: PrismaClientTransaction,
  options: {
    tenancyId: string,
    invoiceId: string,
    currency: string | null,
    amountPaid: number | null,
    outcome: StripeInvoiceOutcomeTimestamps,
  },
) {
  const {
    paidAt,
    paidAtIsExact,
    markedUncollectibleAt,
    markedUncollectibleAtIsExact,
    voidedAt,
    voidedAtIsExact,
    paymentOutcomeEventAt,
  } = options.outcome;
  // Stripe does not guarantee webhook ordering. The watermark records only the
  // newest exact outcome event applied; inferred fields must remain repairable
  // by an exact event even when that exact event was created earlier.
  const shouldApply = Prisma.sql`
    ${paymentOutcomeEventAt}::TIMESTAMP IS NOT NULL
    AND (
      "paymentOutcomeEventAt" IS NULL
      OR ${paymentOutcomeEventAt}::TIMESTAMP >= "paymentOutcomeEventAt"
    )
  `;
  await prisma.$executeRaw`
    UPDATE "SubscriptionInvoice"
    SET
      "paymentOutcomeEventAt" = CASE
        WHEN ${shouldApply} THEN ${paymentOutcomeEventAt}::TIMESTAMP
        ELSE "paymentOutcomeEventAt"
      END,
      "paidAt" = CASE
        WHEN ${paidAt}::TIMESTAMP IS NULL THEN "paidAt"
        WHEN ${paidAtIsExact} AND (${shouldApply} OR "paidAt" IS NULL)
          THEN ${paidAt}::TIMESTAMP
        WHEN NOT ${paidAtIsExact} THEN COALESCE("paidAt", ${paidAt}::TIMESTAMP)
        ELSE "paidAt"
      END,
      "markedUncollectibleAt" = CASE
        WHEN ${markedUncollectibleAt}::TIMESTAMP IS NULL THEN "markedUncollectibleAt"
        WHEN ${markedUncollectibleAtIsExact}
          AND (${shouldApply} OR "markedUncollectibleAt" IS NULL)
          THEN ${markedUncollectibleAt}::TIMESTAMP
        WHEN NOT ${markedUncollectibleAtIsExact}
          THEN COALESCE("markedUncollectibleAt", ${markedUncollectibleAt}::TIMESTAMP)
        ELSE "markedUncollectibleAt"
      END,
      "voidedAt" = CASE
        WHEN ${voidedAt}::TIMESTAMP IS NULL THEN "voidedAt"
        WHEN ${voidedAtIsExact}
          AND (${shouldApply} OR "voidedAt" IS NULL)
          THEN ${voidedAt}::TIMESTAMP
        WHEN NOT ${voidedAtIsExact} THEN COALESCE("voidedAt", ${voidedAt}::TIMESTAMP)
        ELSE "voidedAt"
      END,
      "currency" = CASE
        WHEN ${shouldApply} OR "paymentOutcomeEventAt" IS NULL
          THEN COALESCE(UPPER(${options.currency}), "currency")
        ELSE "currency"
      END,
      "amountPaid" = CASE
        WHEN ${paidAt}::TIMESTAMP IS NOT NULL
          AND (
            (${paidAtIsExact} AND (${shouldApply} OR "paidAt" IS NULL))
            OR (NOT ${paidAtIsExact} AND "paidAt" IS NULL)
          )
          THEN ${options.amountPaid}
        ELSE "amountPaid"
      END
    WHERE "tenancyId" = ${options.tenancyId}::UUID
      AND "id" = ${options.invoiceId}::UUID
  `;
}

export async function upsertStripeInvoice(
  stripe: Stripe,
  stripeAccountId: string,
  invoice: Stripe.Invoice,
  event: Pick<Stripe.Event, "created" | "type">,
) {
  const invoiceLines = (invoice as { lines?: { data?: Stripe.InvoiceLineItem[] } }).lines?.data ?? [];
  const invoiceSubscriptionIds = invoiceLines
    .map((line) => line.parent?.subscription_item_details?.subscription)
    .filter((subscription): subscription is string => !!subscription);
  if (invoiceSubscriptionIds.length === 0 || !invoice.id) {
    return;
  }
  if (invoiceSubscriptionIds.length > 1) {
    throw new HexclaveAssertionError(
      "Multiple subscription line items found in single invoice",
      { stripeAccountId, invoiceId: invoice.id }
    );
  }

  const stripeSubscriptionId = invoiceSubscriptionIds[0];
  const isSubscriptionCreationInvoice = invoice.billing_reason === "subscription_create";
  const tenancy = await getTenancyFromStripeAccountIdOrThrow(stripe, stripeAccountId);
  const prisma = await getPrismaClientForTenancy(tenancy);
  // Stripe's wire payload may omit this expansion even though the installed
  // SDK types currently mark it required. Keep webhook normalization tolerant
  // without weakening the rest of the invoice contract.
  const outcome = getStripeInvoiceOutcomeTimestamps(invoice, event);

  // dual write - prisma and bulldozer
  const upsertedInvoice = await prisma.subscriptionInvoice.upsert({
    where: {
      tenancyId_stripeInvoiceId: {
        tenancyId: tenancy.id,
        stripeInvoiceId: invoice.id,
      },
    },
    update: {
      stripeSubscriptionId,
      isSubscriptionCreationInvoice,
      status: invoice.status,
      amountTotal: invoice.total,
      hostedInvoiceUrl: invoice.hosted_invoice_url,
    },
    create: {
      tenancyId: tenancy.id,
      stripeSubscriptionId,
      stripeInvoiceId: invoice.id,
      isSubscriptionCreationInvoice,
      status: invoice.status,
      amountTotal: invoice.total,
      hostedInvoiceUrl: invoice.hosted_invoice_url,
    },
  });
  await applyStripeInvoiceOutcome(prisma, {
    tenancyId: tenancy.id,
    invoiceId: upsertedInvoice.id,
    currency: invoice.currency,
    amountPaid: invoice.amount_paid,
    outcome,
  });
  await prisma.$executeRaw`
    UPDATE "SubscriptionInvoice"
    SET "status" = CASE
      WHEN "paidAt" IS NOT NULL AND "paidAt" = GREATEST("paidAt", "markedUncollectibleAt", "voidedAt") THEN 'paid'
      -- Match the evaluator's deterministic tie order: paid, then void, then failure.
      WHEN "voidedAt" IS NOT NULL AND "voidedAt" = GREATEST("paidAt", "markedUncollectibleAt", "voidedAt") THEN 'void'
      WHEN "markedUncollectibleAt" IS NOT NULL AND "markedUncollectibleAt" = GREATEST("paidAt", "markedUncollectibleAt", "voidedAt") THEN 'uncollectible'
      ELSE "status"
    END
    WHERE "tenancyId" = ${tenancy.id}::UUID
      AND "id" = ${upsertedInvoice.id}::UUID
  `;
  const normalizedInvoice = (await prisma.$queryRaw<Array<typeof upsertedInvoice & {
    paidAt: Date | null,
    markedUncollectibleAt: Date | null,
    voidedAt: Date | null,
    currency: string | null,
    amountPaid: number | null,
  }>>`
    SELECT * FROM "SubscriptionInvoice"
    WHERE "tenancyId" = ${tenancy.id}::UUID AND "id" = ${upsertedInvoice.id}::UUID
  `).at(0) ?? throwErr("Normalized subscription invoice disappeared after update");
  await bulldozerWriteSubscriptionInvoice(normalizedInvoice);
  const latestInvoice = (await prisma.$queryRaw<Array<typeof normalizedInvoice>>`
    SELECT * FROM "SubscriptionInvoice"
    WHERE "tenancyId" = ${tenancy.id}::UUID AND "id" = ${upsertedInvoice.id}::UUID
  `).at(0) ?? throwErr("Subscription invoice disappeared during Bulldozer convergence");
  if (
    latestInvoice.status !== normalizedInvoice.status
    || latestInvoice.paidAt?.getTime() !== normalizedInvoice.paidAt?.getTime()
    || latestInvoice.markedUncollectibleAt?.getTime() !== normalizedInvoice.markedUncollectibleAt?.getTime()
    || latestInvoice.voidedAt?.getTime() !== normalizedInvoice.voidedAt?.getTime()
    || latestInvoice.amountPaid !== normalizedInvoice.amountPaid
    || latestInvoice.currency !== normalizedInvoice.currency
  ) {
    await bulldozerWriteSubscriptionInvoice(latestInvoice);
  }
}

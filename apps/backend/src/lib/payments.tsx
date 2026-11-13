import { CustomerType, PurchaseCreationSource, SubscriptionStatus } from "@/generated/prisma/client";
import { bulldozerWriteOneTimePurchase, bulldozerWriteSubscription } from "@/lib/payments/bulldozer-dual-write";
import { getOwnedProductsForCustomer } from "@/lib/payments/customer-data";
import type { OwnedProductsRow } from "@/lib/payments/schema/types";
import { ensureUserTeamPermissionExists } from "@/lib/request-checks";
import { getPrismaClientForTenancy, PrismaClientTransaction } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import type { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import type { inlineProductSchema, productSchema, productSchemaWithMetadata } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES } from "@hexclave/shared/dist/utils/currency-constants";
import { addInterval, getIntervalsElapsed, type DayInterval } from "@hexclave/shared/dist/utils/dates";
import { captureError, HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { filterUndefined, getOrUndefined, has, typedEntries, typedFromEntries, typedKeys, typedValues } from "@hexclave/shared/dist/utils/objects";
import { typedToUppercase } from "@hexclave/shared/dist/utils/strings";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";
import Stripe from "stripe";
import * as yup from "yup";
import { getStripeForAccount, useStripeMock } from "./stripe";
import { Tenancy } from "./tenancies";


type Product = yup.InferType<typeof productSchema>;
type ProductWithMetadata = yup.InferType<typeof productSchemaWithMetadata>;
type SelectedPrice = Product["prices"][string];

export async function ensureClientCanAccessCustomer(options: {
  customerType: "user" | "team" | "custom",
  customerId: string,
  user: UsersCrud["Admin"]["Read"] | undefined,
  tenancy: Tenancy,
  forbiddenMessage: string,
}): Promise<void> {
  const currentUser = options.user;
  if (!currentUser) {
    throw new KnownErrors.UserAuthenticationRequired();
  }
  if (options.customerType === "custom") {
    throw new StatusError(StatusError.Forbidden, options.forbiddenMessage);
  }
  if (options.customerType === "user") {
    if (options.customerId !== currentUser.id) {
      throw new StatusError(StatusError.Forbidden, options.forbiddenMessage);
    }
    return;
  }

  const prisma = await getPrismaClientForTenancy(options.tenancy);
  await ensureUserTeamPermissionExists(prisma, {
    tenancy: options.tenancy,
    teamId: options.customerId,
    userId: currentUser.id,
    permissionId: "team_admin",
    errorType: "required",
    recursive: true,
  });
}

export async function ensureProductIdOrInlineProduct(
  tenancy: Tenancy,
  accessType: "client" | "server" | "admin",
  productId: string | undefined,
  inlineProduct: yup.InferType<typeof inlineProductSchema> | undefined
): Promise<ProductWithMetadata> {
  if (productId && inlineProduct) {
    throw new StatusError(400, "Cannot specify both product_id and product_inline!");
  }
  if (inlineProduct && accessType === "client") {
    throw new StatusError(400, "Cannot specify product_inline when calling from client! Please call with a server API key, or use the product_id parameter.");
  }
  if (!productId && !inlineProduct) {
    throw new StatusError(400, "Must specify either product_id or product_inline!");
  }
  if (productId) {
    const product = getOrUndefined(tenancy.config.payments.products, productId);
    if (!product) {
      const itemExists = has(tenancy.config.payments.items, productId);
      throw new KnownErrors.ProductDoesNotExist(productId, itemExists ? "item_exists" : null);
    }
    if (product.serverOnly && accessType === "client") {
      throw new KnownErrors.ProductDoesNotExist(productId, "server_only");
    }
    return product;
  } else {
    if (!inlineProduct) {
      throw new HexclaveAssertionError("Inline product does not exist, this should never happen", { inlineProduct, productId });
    }
    return {
      productLineId: undefined,
      isAddOnTo: false,
      displayName: inlineProduct.display_name,
      customerType: inlineProduct.customer_type,
      freeTrial: inlineProduct.free_trial,
      serverOnly: inlineProduct.server_only,
      stackable: false,
      prices: Object.fromEntries(Object.entries(inlineProduct.prices).map(([key, value]) => [key, {
        ...typedFromEntries(SUPPORTED_CURRENCIES.map(c => [c.code, getOrUndefined(value, c.code)])),
        interval: value.interval,
        freeTrial: value.free_trial,
        serverOnly: true,
      }])),
      clientMetadata: inlineProduct.client_metadata ?? undefined,
      clientReadOnlyMetadata: inlineProduct.client_read_only_metadata ?? undefined,
      serverMetadata: inlineProduct.server_metadata ?? undefined,
      includedItems: typedFromEntries(Object.entries(inlineProduct.included_items).map(([key, value]) => [key, {
        repeat: value.repeat ?? "never",
        quantity: value.quantity ?? 0,
        expires: value.expires ?? "never",
      }])),
    };
  }
}

// ── Legacy functions deleted ──
// computeLedgerBalanceAtNow, addWhenRepeatedItemWindowTransactions,
// getItemQuantityForCustomerLegacy, Subscription type, getSubscriptions,
// getCustomerPurchaseContext, OwnedProduct type, getOwnedProductsForCustomerLegacy
// were removed. All reads now go through customer-data.ts backed by Bulldozer.

export function isActiveSubscription(subscription: { status: string }): boolean {
  const s = subscription.status;
  return s === "active" || s === SubscriptionStatus.active || s === "trialing" || s === SubscriptionStatus.trialing;
}

/**
 * True when the given product config / snapshot declares itself as an add-on
 * to one or more other products. Add-ons share a product line with their base
 * plan but don't satisfy "base plan owned" invariants on their own.
 *
 * The predicate normalises the three ways a product can signal "not an
 * add-on" (absent, explicitly `false`, or an empty record) so callers don't
 * have to reimplement the check.
 */
export function isAddOnProduct(product: { isAddOnTo?: false | Record<string, true> | null }): boolean {
  return product.isAddOnTo != null && product.isAddOnTo !== false && Object.keys(product.isAddOnTo).length > 0;
}

type OwnedProducts = OwnedProductsRow["ownedProducts"];

/**
 * Returns true if the customer currently owns the given product (quantity > 0).
 */
export function customerOwnsProduct(ownedProducts: OwnedProducts, productId: string): boolean {
  return productId in ownedProducts && ownedProducts[productId].quantity > 0;
}

export async function ensureCustomerExists(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  customerType: "user" | "team" | "custom",
  customerId: string,
}) {
  if (options.customerType === "user") {
    if (!isUuid(options.customerId)) {
      throw new KnownErrors.UserNotFound();
    }
    const user = await options.prisma.projectUser.findUnique({
      where: {
        tenancyId_projectUserId: {
          tenancyId: options.tenancyId,
          projectUserId: options.customerId,
        },
      },
    });
    if (!user) {
      throw new KnownErrors.UserNotFound();
    }
  } else if (options.customerType === "team") {
    if (!isUuid(options.customerId)) {
      throw new KnownErrors.TeamNotFound(options.customerId);
    }
    const team = await options.prisma.team.findUnique({
      where: {
        tenancyId_teamId: {
          tenancyId: options.tenancyId,
          teamId: options.customerId,
        },
      },
    });
    if (!team) {
      throw new KnownErrors.TeamNotFound(options.customerId);
    }
  }
}

function customerTypeToStripeCustomerType(customerType: "user" | "team") {
  return customerType === "user" ? CustomerType.USER : CustomerType.TEAM;
}

export function stripeCustomerIdempotencyKey(tenancyId: string, customerType: "user" | "team" | "custom", customerId: string): string {
  return `hexclave-stripe-customer:${tenancyId}:${customerType}:${customerId}`;
}

/**
 * Stripe Search query used to find a Customer by Hexclave `customerId` metadata.
 * Values are interpolated raw (Search QL, not SQL). A custom id containing `'`
 * can split the quoted token and change which rows match.
 */
export function stripeCustomerMetadataSearchQuery(customerId: string): string {
  return `metadata['customerId']:'${customerId}'`;
}

/**
 * Custom-customer checkout still takes Search's first hit (`data[0]`), with no
 * `customerType` filter and no "newest / has-card" picker. User/team lookups
 * go through `selectStripeCustomersMatchingType` instead. Keep this function
 * so tests can pin the first-hit behavior that attaches the wrong `cus_…`.
 */
export function pickFirstStripeCustomerFromSearch<T>(customers: readonly T[]): T | undefined {
  return customers[0];
}

/**
 * Checkout (`create-purchase-url`) and setup-intent (save card) both call
 * `ensureStripeCustomerForCustomer`. Stripe Search is eventually consistent
 * (https://docs.stripe.com/search#data-freshness — "Don't use search for
 * read-after-write flows"; searchable in under ~1 minute). Two in-flight
 * ensures can both miss Search, both `customers.create`, and leave two
 * Stripe Customers with the same `metadata.customerId` (Stripe does not
 * unique-index metadata). The old lookup then threw on `matches.length > 1`.
 * Idempotency keys collapse retries of the *same* create; this picker is
 * for duplicates that already exist. Treat missing `customerType` as a
 * legacy row that matches only when no typed row exists.
 */
type StripeCustomerLookup = Pick<Stripe.Customer, "id" | "created" | "metadata">;

export function selectStripeCustomersMatchingType<T extends StripeCustomerLookup>(options: {
  customers: T[],
  expectedType: CustomerType,
}): T[] {
  const typed = options.customers.filter((customer) => customer.metadata.customerType === options.expectedType);
  if (typed.length > 0) {
    return typed;
  }
  return options.customers.filter((customer) => !("customerType" in customer.metadata) || customer.metadata.customerType === "");
}

export function pickNewestStripeCustomer<T extends StripeCustomerLookup>(customers: T[]): T | null {
  if (customers.length === 0) {
    return null;
  }
  return [...customers].sort((a, b) => b.created - a.created)[0];
}

async function pickStripeCustomerAmongDuplicates(options: {
  stripe: Stripe,
  customers: Stripe.Customer[],
  customerId: string,
  customerType: "user" | "team",
}): Promise<Stripe.Customer> {
  captureError("payments:duplicate-stripe-customers", new HexclaveAssertionError(
    "Multiple Stripe customers found for customerId; using the one with a card, else newest",
    {
      customerId: options.customerId,
      customerType: options.customerType,
      stripeCustomerIds: options.customers.map((customer) => customer.id),
    },
  ));

  const scored = await Promise.all(options.customers.map(async (customer) => {
    const paymentMethods = await options.stripe.customers.listPaymentMethods(customer.id, { type: "card", limit: 1 });
    return {
      customer,
      hasCard: paymentMethods.data.length > 0,
    };
  }));
  const withCard = scored.filter((entry) => entry.hasCard);
  const pool = withCard.length > 0 ? withCard : scored;
  return pickNewestStripeCustomer(pool.map((entry) => entry.customer))
    ?? throwErr("duplicate Stripe customer pool was empty after scoring");
}

export async function getStripeCustomerForCustomerOrNull(options: {
  stripe: Stripe,
  prisma: PrismaClientTransaction,
  tenancyId: string,
  customerType: "user" | "team",
  customerId: string,
}): Promise<Stripe.Customer | null> {
  await ensureCustomerExists({
    prisma: options.prisma,
    tenancyId: options.tenancyId,
    customerType: options.customerType,
    customerId: options.customerId,
  });

  const stripeCustomerType = customerTypeToStripeCustomerType(options.customerType);
  const matchesCustomerId = (customer: Stripe.Customer) => customer.metadata.customerId === options.customerId;

  const stripeCustomerSearch = await options.stripe.customers.search({
    query: `metadata['customerId']:'${options.customerId}'`,
  });
  let candidates = stripeCustomerSearch.data.filter(matchesCustomerId);

  if (candidates.length === 0) {
    // Stripe's search is eventually consistent; fall back to listing to ensure we can find a newly created customer.
    let startingAfter: string | undefined = undefined;
    for (let i = 0; i < 10; i++) {
      const page: Stripe.ApiList<Stripe.Customer> = await options.stripe.customers.list({
        limit: 100,
        ...startingAfter ? { starting_after: startingAfter } : {},
      });
      const exactMatches = page.data.filter(matchesCustomerId);
      if (exactMatches.length > 0) {
        candidates = exactMatches;
        break;
      }
      if (useStripeMock && page.data.length > 0) {
        candidates = [page.data[0]];
        break;
      }
      if (!page.has_more || page.data.length === 0) {
        break;
      }
      startingAfter = page.data[page.data.length - 1].id;
    }
  }

  const matches = selectStripeCustomersMatchingType({
    customers: candidates,
    expectedType: stripeCustomerType,
  });
  if (matches.length <= 1) {
    return matches[0] ?? null;
  }
  return await pickStripeCustomerAmongDuplicates({
    stripe: options.stripe,
    customers: matches,
    customerId: options.customerId,
    customerType: options.customerType,
  });
}

export async function ensureStripeCustomerForCustomer(options: {
  stripe: Stripe,
  prisma: PrismaClientTransaction,
  tenancyId: string,
  customerType: "user" | "team",
  customerId: string,
}): Promise<Stripe.Customer> {
  const existing = await getStripeCustomerForCustomerOrNull(options);
  if (existing) {
    return existing;
  }
  const stripeCustomerType = customerTypeToStripeCustomerType(options.customerType);
  return await options.stripe.customers.create({
    metadata: {
      customerId: options.customerId,
      customerType: stripeCustomerType,
    },
  }, {
    idempotencyKey: stripeCustomerIdempotencyKey(options.tenancyId, options.customerType, options.customerId),
  });
}

export type StripeCardPaymentMethodSummary = {
  id: string,
  brand: string | null,
  last4: string | null,
  exp_month: number | null,
  exp_year: number | null,
};

export async function getDefaultCardPaymentMethodSummary(options: {
  stripe: Stripe,
  stripeCustomer: Stripe.Customer,
}): Promise<StripeCardPaymentMethodSummary | null> {
  const paymentMethods = await options.stripe.customers.listPaymentMethods(
    options.stripeCustomer.id,
    { type: "card", limit: 1 }
  );
  if (paymentMethods.data.length === 0) {
    return null;
  }
  return {
    id: paymentMethods.data[0].id,
    brand: paymentMethods.data[0].card?.brand ?? null,
    last4: paymentMethods.data[0].card?.last4 ?? null,
    exp_month: paymentMethods.data[0].card?.exp_month ?? null,
    exp_year: paymentMethods.data[0].card?.exp_year ?? null,
  };
}

/** Identifies which customer/product a snapshot belongs to, for diagnostics. */
export type ProductSnapshotContext = {
  productId: string | null,
  customerType: string,
  customerId: string,
};

function isPriceRecord(value: unknown): value is ProductWithMetadata["prices"] {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Legacy free-plan snapshots stored `prices` as the string "include-by-default"
// instead of a record. Live config was migrated to `{}`, but frozen snapshots
// (subscriptions + Bulldozer materialized tables) weren't, so `typedEntries` on
// that string explodes into currency-less price entries that fail response
// validation and 500 the whole payments view. Normalize the sentinel to `{}`
// (free plans need no prices); for any other non-object, capture it and degrade
// to `{}` so one bad row can't block a customer.
// TODO: remove this once no snapshot/Bulldozer data contains "include-by-default".
function normalizeProductSnapshotPrices(product: ProductWithMetadata, context: ProductSnapshotContext): ProductWithMetadata["prices"] {
  const prices: unknown = product.prices;
  if (isPriceRecord(prices)) {
    return prices;
  }
  if (prices !== "include-by-default") {
    captureError("product-to-inline-product-invalid-prices", new HexclaveAssertionError(
      "Product snapshot has an unexpected non-object `prices`; degrading to empty prices to avoid blocking the customer's payments view. The underlying snapshot should be investigated and repaired.",
      { productId: context.productId, customerType: context.customerType, customerId: context.customerId, product },
    ));
  }
  return {};
}

export function productToInlineProduct(product: ProductWithMetadata, context: ProductSnapshotContext): yup.InferType<typeof inlineProductSchema> {
  return {
    display_name: product.displayName ?? "Product",
    customer_type: product.customerType,
    // Product-level free_trial is transitional; price-level free_trial is preferred.
    free_trial: product.freeTrial,
    stackable: product.stackable === true,
    server_only: product.serverOnly === true,
    included_items: product.includedItems,
    client_metadata: product.clientMetadata ?? null,
    client_read_only_metadata: product.clientReadOnlyMetadata ?? null,
    server_metadata: product.serverMetadata ?? null,
    prices: typedFromEntries(typedEntries(normalizeProductSnapshotPrices(product, context)).map(([key, value]) => [key, filterUndefined({
      ...typedFromEntries(SUPPORTED_CURRENCIES.map(c => [c.code, getOrUndefined(value, c.code)])),
      interval: value.interval,
      free_trial: value.freeTrial,
    })])),
  };
}

import.meta.vitest?.describe("productToInlineProduct prices normalization", (test) => {
  const context = { productId: "free", customerType: "team", customerId: "team_1" };
  // Snapshots are untrusted JSON, so tests deliberately feed `prices` values that
  // violate the type. Centralize that single boundary cast here.
  const snapshotWithPrices = (prices: unknown): ProductWithMetadata => ({
    displayName: "Free Plan",
    customerType: "team",
    serverOnly: false,
    stackable: false,
    includedItems: {},
    prices,
  }) as ProductWithMetadata;

  test("normal case: a valid prices record passes through unchanged", ({ expect }) => {
    const inline = productToInlineProduct(
      snapshotWithPrices({ monthly: { USD: "0", interval: [1, "month"] } }),
      context,
    );
    expect(inline.prices).toEqual({ monthly: { USD: "0", interval: [1, "month"] } });
  });

  test('legacy "include-by-default" sentinel is normalized to {} (no explosion, schema-valid)', ({ expect }) => {
    const inline = productToInlineProduct(snapshotWithPrices("include-by-default"), context);
    expect(inline.prices).toEqual({});
  });
});

export async function validatePurchaseSession(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  customerType: "user" | "team" | "custom",
  customerId: string,
  product: Product,
  productId: string | undefined,
  priceId: string | undefined,
  quantity: number,
}): Promise<{
  selectedPrice: SelectedPrice | undefined,
  conflictingSubscriptions: Array<{ id: string, stripeSubscriptionId: string | null }>,
}> {
  const { prisma, tenancyId, customerType, customerId, product, productId, priceId, quantity } = options;

  // Step 1: Resolve the selected price from the product config
  let selectedPrice: SelectedPrice | undefined = undefined;
  if (!priceId) {
    selectedPrice = typedValues(product.prices)[0];
  } else {
    const pricesMap = new Map(typedEntries(product.prices));
    selectedPrice = pricesMap.get(priceId);
    if (!selectedPrice) {
      throw new StatusError(400, "Price not found on product associated with this purchase code");
    }
  }

  // Step 2: Reject non-stackable products with quantity > 1
  if (quantity !== 1 && product.stackable !== true) {
    throw new StatusError(400, "This product is not stackable; quantity must be 1");
  }

  // Step 3: Fetch owned products once for all subsequent checks
  const ownedProducts = await getOwnedProductsForCustomer({ prisma, tenancyId, customerType, customerId });

  // Step 4: Check the customer doesn't already own this product
  if (productId && product.stackable !== true && customerOwnsProduct(ownedProducts, productId)) {
    throw new KnownErrors.ProductAlreadyGranted(productId, customerId);
  }

  // Step 5: Verify add-on prerequisites (customer must own the base product)
  if (product.isAddOnTo) {
    const baseProductIds = typedKeys(product.isAddOnTo);
    if (!baseProductIds.some(id => customerOwnsProduct(ownedProducts, id))) {
      throw new StatusError(400, "This product is an add-on to a product that the customer does not have");
    }
  }

  // Step 6: Block purchase if customer already owns a product in the same product line.
  // If they do, find active subscriptions to cancel so the caller can replace them.
  // Two exceptions:
  //   - Add-on products: allowed even if their base product is in the same line.
  //   - Stackable same-product: a second purchase of a stackable product is
  //     additive, not a replacement — don't treat the existing holding as a
  //     conflict.
  // TODO: swap this for bulldozer read when it's consistent
  // Read subs from Prisma (not the bulldozer view) — the view can lag, so a duplicate request would otherwise miss the just-granted sub.
  let conflictingSubscriptions: Array<{ id: string, stripeSubscriptionId: string | null }> = [];
  const productLineId = product.productLineId;
  const addOnBaseProductIds = product.isAddOnTo ? typedKeys(product.isAddOnTo) : [];
  const isStackableSelfMatch = (pid: string) =>
    productId != null && pid === productId && product.stackable === true;

  // Same-product duplicate guards. Step 4 reads bulldozer's lagged ownedProducts;
  // a duplicate request during lag would slip past it and silently re-grant.
  // We query Prisma directly so the sub guard is symmetric with the OTP guard
  // and works for products with no productLineId.
  const activeSubs = await prisma.subscription.findMany({
    where: {
      tenancyId,
      customerType: typedToUppercase(customerType),
      customerId,
      status: { in: [SubscriptionStatus.active, SubscriptionStatus.trialing] },
    },
    select: { id: true, stripeSubscriptionId: true, productId: true, product: true },
  });
  if (productId != null && product.stackable !== true) {
    const activeOtp = await prisma.oneTimePurchase.findFirst({
      where: {
        tenancyId,
        customerType: typedToUppercase(customerType),
        customerId,
        productId,
        revokedAt: null,
        refundedAt: null,
      },
      select: { id: true },
    });
    if (activeOtp || activeSubs.some(s => s.productId === productId)) {
      throw new KnownErrors.ProductAlreadyGranted(productId, customerId);
    }
  }

  if (productLineId) {
    conflictingSubscriptions = activeSubs
      .filter(s =>
        (s.product as Product).productLineId === productLineId
        && !addOnBaseProductIds.includes(s.productId ?? "")
        && !isStackableSelfMatch(s.productId ?? ""),
      )
      .map(s => ({ id: s.id, stripeSubscriptionId: s.stripeSubscriptionId }));

    // If ownedProducts shows a same-line holding but there's no active subscription
    // backing it, the customer owns via OTP — which can't be replaced by a switch.
    // (We still rely on bulldozer here because OTPs aren't part of the duplicate-
    // request race we're guarding above and OTP propagation lag is low-stakes.)
    const activeSubProductIds = new Set(activeSubs.map(s => s.productId ?? "__null__"));
    const otpInProductLine = Object.entries(ownedProducts).some(
      ([pid, p]) =>
        p.productLineId === productLineId
        && p.quantity > 0
        && !addOnBaseProductIds.includes(pid)
        && !isStackableSelfMatch(pid)
        && !activeSubProductIds.has(pid),
    );
    if (otpInProductLine && conflictingSubscriptions.length === 0) {
      // TODO: reconsider the coupling here between products and purchases. OTPs can
      // be refunded, so this check conflates product ownership with purchase type.
      throw new StatusError(400, "Customer already has a one-time purchase in this product line");
    }
  }

  return { selectedPrice, conflictingSubscriptions };
}

export type StripeSubscriptionClientSecret = {
  type: "payment" | "setup",
  clientSecret: string,
};

/** Stripe rejects trial periods longer than 730 days (2 years). */
export const STRIPE_MAX_TRIAL_PERIOD_DAYS = 730;

/**
 * Resolves the effective free-trial interval for a purchase.
 * Price-level wins when set; product-level is a transitional fallback while
 * product-level freeTrial is being deprecated in favor of price-only config.
 *
 * Uses `??`, so an explicit `null` on the price is treated like "absent" and
 * falls through to the product — same as config path-updates where null means
 * "reset to default", not "opt out of a product-level trial".
 */
export function getEffectiveFreeTrial(
  product: { freeTrial?: DayInterval | null },
  price: { freeTrial?: DayInterval | null } | null | undefined,
): DayInterval | undefined {
  return price?.freeTrial ?? product.freeTrial ?? undefined;
}

/**
 * Rejects free-trial combos that cannot work with Stripe checkout:
 * - one-time prices (no billing interval)
 * - $0 recurring prices (nothing to charge after the trial)
 *
 * `freeTrial` is the already-resolved effective trial (see getEffectiveFreeTrial).
 */
export function assertFreeTrialAllowedForPurchase(
  price: { USD?: string, interval?: DayInterval },
  freeTrial: DayInterval | undefined,
): void {
  if (freeTrial == null) {
    return;
  }
  if (price.interval == null) {
    throw new StatusError(400, "Free trials are only supported on recurring prices");
  }
  const priceAmount = Number(price.USD);
  if (Number.isFinite(priceAmount) && priceAmount === 0) {
    throw new StatusError(400, "Free trials cannot be combined with a $0 price");
  }
}

/**
 * Stripe `trial_period_days` from a DayInterval. Day/week are exact; month/year
 * use addInterval + getIntervalsElapsed from the shared date helpers so we
 * don't hand-roll calendar math here. Caps at Stripe's 730-day maximum.
 */
export function getStripeTrialPeriodDays(freeTrial: DayInterval, from: Date = new Date()): number {
  const [amount, unit] = freeTrial;
  const days = unit === "day"
    ? amount
    : unit === "week"
      ? amount * 7
      : getIntervalsElapsed(from, addInterval(from, freeTrial), [1, "day"]);
  if (!Number.isFinite(days) || days < 1) {
    throw new StatusError(400, `Free trial duration must resolve to at least 1 day (got ${days})`);
  }
  if (days > STRIPE_MAX_TRIAL_PERIOD_DAYS) {
    throw new StatusError(400, `Free trial duration cannot exceed ${STRIPE_MAX_TRIAL_PERIOD_DAYS} days`);
  }
  return days;
}

/**
 * Extracts the Stripe Elements client secret for a just-created/updated
 * subscription. When `shouldExpectSetupIntent` is true (free trial), we must
 * get a SetupIntent secret — a missing one means Stripe did not start a trial
 * as configured. Otherwise we require a PaymentIntent / invoice confirmation
 * secret for an immediate charge.
 *
 * Callers must pass `expand: ['pending_setup_intent', 'latest_invoice.confirmation_secret']`
 * (or equivalent) on create/update so these fields are objects, not id strings.
 */
export function getClientSecretFromStripeSubscription(
  subscription: Stripe.Subscription,
  shouldExpectSetupIntent: boolean,
): StripeSubscriptionClientSecret {
  if (shouldExpectSetupIntent) {
    const pendingSetupIntent = subscription.pending_setup_intent;
    // Without expand, Stripe returns an id string. treat that as missing.
    if (pendingSetupIntent == null || typeof pendingSetupIntent === "string") {
      // Internal Stripe invariant — don't leak details via StatusError(500) to public callers.
      throw new HexclaveAssertionError("Expected a Stripe SetupIntent client secret for free-trial subscription, but none was returned");
    }
    const setupSecret = pendingSetupIntent.client_secret;
    if (typeof setupSecret !== "string") {
      throw new HexclaveAssertionError("Expected a Stripe SetupIntent client secret for free-trial subscription, but none was returned");
    }
    return { type: "setup", clientSecret: setupSecret };
  }

  const latestInvoice = subscription.latest_invoice;
  if (latestInvoice && typeof latestInvoice !== "string") {
    type InvoiceWithExtras = Stripe.Invoice & {
      confirmation_secret?: { client_secret?: string },
      payment_intent?: string | (Stripe.PaymentIntent & { client_secret?: string }) | null,
    };
    const invoice = latestInvoice as InvoiceWithExtras;
    const confirmationSecret = invoice.confirmation_secret?.client_secret;
    const piSecret = typeof invoice.payment_intent !== "string" ? invoice.payment_intent?.client_secret : undefined;
    if (typeof confirmationSecret === "string") {
      return { type: "payment", clientSecret: confirmationSecret };
    }
    if (typeof piSecret === "string") {
      return { type: "payment", clientSecret: piSecret };
    }
  }
  throw new HexclaveAssertionError("No PaymentIntent client secret returned from Stripe for subscription");
}

export function setupIntentClientSecretFromSubscription(subscription: Stripe.Subscription): string | null {
  const pendingSetupIntent = subscription.pending_setup_intent;
  if (pendingSetupIntent == null || typeof pendingSetupIntent === "string") {
    return null;
  }
  return typeof pendingSetupIntent.client_secret === "string" ? pendingSetupIntent.client_secret : null;
}

/**
 * Paid catalog + promo-net $0 first invoice (no trial) auto-activates in
 * Stripe with no PaymentIntent. Collect a card the same way free trials do,
 * via SetupIntent, so later invoices have a payment method.
 */
export async function resolveSetupClientSecretForZeroFirstInvoice(options: {
  stripe: Stripe,
  subscription: Stripe.Subscription,
  customerId: string,
  tenancyId: string,
}): Promise<string> {
  const existing = setupIntentClientSecretFromSubscription(options.subscription);
  if (existing != null) {
    return existing;
  }
  const setupIntent = await options.stripe.setupIntents.create({
    customer: options.customerId,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: {
      stripeSubscriptionId: options.subscription.id,
      tenancyId: options.tenancyId,
    },
  });
  if (typeof setupIntent.client_secret !== "string") {
    throw new HexclaveAssertionError("No client secret returned from Stripe for subscription card SetupIntent");
  }
  return setupIntent.client_secret;
}

export async function attachSetupIntentPaymentMethodToSubscription(options: {
  stripe: Stripe,
  setupIntent: Stripe.SetupIntent,
}): Promise<void> {
  const metadata = options.setupIntent.metadata;
  if (metadata == null || !Object.hasOwn(metadata, "stripeSubscriptionId")) {
    return;
  }
  const stripeSubscriptionId = metadata.stripeSubscriptionId;
  if (stripeSubscriptionId.length === 0) {
    return;
  }
  const paymentMethodId = options.setupIntent.payment_method;
  if (typeof paymentMethodId !== "string") {
    throw new HexclaveAssertionError("Succeeded SetupIntent for a subscription is missing a payment method");
  }
  const customerId = typeof options.setupIntent.customer === "string"
    ? options.setupIntent.customer
    : options.setupIntent.customer?.id;
  if (typeof customerId !== "string") {
    throw new HexclaveAssertionError("Succeeded SetupIntent for a subscription is missing a customer");
  }
  await options.stripe.subscriptions.update(stripeSubscriptionId, {
    default_payment_method: paymentMethodId,
  });
  await options.stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
    metadata: {
      defaultPaymentMethodId: paymentMethodId,
      default_payment_method_id: paymentMethodId,
      hasPaymentMethod: "true",
    },
  });
}

type GrantProductResult =
  | {
    type: "one_time",
    purchaseId: string | null,
  }
  | {
    type: "subscription",
    subscriptionId: string,
  };

export async function grantProductToCustomer(options: {
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  customerType: "user" | "team" | "custom",
  customerId: string,
  product: ProductWithMetadata,
  quantity: number,
  productId: string | undefined,
  priceId: string | undefined,
  creationSource: PurchaseCreationSource,
}): Promise<GrantProductResult> {
  const { prisma, tenancy, customerId, customerType, product, productId, priceId, quantity, creationSource } = options;
  const { selectedPrice, conflictingSubscriptions } = await validatePurchaseSession({
    prisma,
    tenancyId: tenancy.id,
    customerType,
    customerId,
    product,
    productId,
    priceId,
    quantity,
  });

  const now = new Date();

  if (conflictingSubscriptions.length > 0) {
    const conflicting = conflictingSubscriptions[0];
    if (conflicting.stripeSubscriptionId) {
      const stripe = await getStripeForAccount({ tenancy });
      await stripe.subscriptions.cancel(conflicting.stripeSubscriptionId);
    } else if (conflicting.id) {
      const updatedConflicting = await prisma.subscription.update({
        where: {
          tenancyId_id: {
            tenancyId: tenancy.id,
            id: conflicting.id,
          },
        },
        data: {
          status: SubscriptionStatus.canceled,
          cancelAtPeriodEnd: true,
          canceledAt: now,
          endedAt: now,
        },
      });
      await bulldozerWriteSubscription(updatedConflicting);
    }
  }

  if (!selectedPrice) {
    return { type: "one_time", purchaseId: null };
  }

  if (!selectedPrice.interval) {
    const purchase = await prisma.oneTimePurchase.create({
      data: {
        tenancyId: tenancy.id,
        customerId,
        customerType: typedToUppercase(customerType),
        productId,
        priceId,
        product,
        quantity,
        creationSource,
      },
    });
    // dual write - prisma and bulldozer
    await bulldozerWriteOneTimePurchase(purchase);
    return { type: "one_time", purchaseId: purchase.id };
  }

  const subscription = await prisma.subscription.create({
    data: {
      tenancyId: tenancy.id,
      customerId,
      customerType: typedToUppercase(customerType),
      status: "active",
      productId,
      priceId,
      product,
      quantity,
      currentPeriodStart: now,
      currentPeriodEnd: addInterval(now, selectedPrice.interval!),
      cancelAtPeriodEnd: false,
      creationSource,
    },
  });
  // dual write - prisma and bulldozer
  await bulldozerWriteSubscription(subscription);

  return { type: "subscription", subscriptionId: subscription.id };
}

import.meta.vitest?.describe("free trial helpers", (test) => {
  test("getEffectiveFreeTrial prefers price-level over product-level", ({ expect }) => {
    expect(getEffectiveFreeTrial(
      { freeTrial: [30, "day"] },
      { freeTrial: [7, "day"] },
    )).toEqual([7, "day"]);
    expect(getEffectiveFreeTrial(
      { freeTrial: [30, "day"] },
      {},
    )).toEqual([30, "day"]);
    expect(getEffectiveFreeTrial(
      {},
      { freeTrial: [14, "day"] },
    )).toEqual([14, "day"]);
    expect(getEffectiveFreeTrial({}, {})).toBeUndefined();
    // null is absent (??), not an opt-out of product-level trial
    expect(getEffectiveFreeTrial(
      { freeTrial: [30, "day"] },
      { freeTrial: null },
    )).toEqual([30, "day"]);
    // Stripe trial_period_days must follow the same price-over-product resolution.
    expect(getStripeTrialPeriodDays(getEffectiveFreeTrial(
      { freeTrial: [30, "day"] },
      { freeTrial: [7, "day"] },
    ) ?? throwErr("expected price-level free trial"))).toBe(7);
  });

  test("assertFreeTrialAllowedForPurchase rejects OTP and $0 prices", ({ expect }) => {
    expect(() => assertFreeTrialAllowedForPurchase(
      { USD: "19.00" },
      [7, "day"],
    )).toThrow(/recurring/);
    expect(() => assertFreeTrialAllowedForPurchase(
      { USD: "0", interval: [1, "month"] },
      [7, "day"],
    )).toThrow(/\$0/);
    expect(() => assertFreeTrialAllowedForPurchase(
      { USD: "19.00", interval: [1, "month"] },
      [7, "day"],
    )).not.toThrow();
  });

  test("getStripeTrialPeriodDays uses calendar helpers and enforces Stripe max", ({ expect }) => {
    const from = new Date("2026-01-31T12:00:00.000Z");
    const days = getStripeTrialPeriodDays([1, "month"], from);
    expect(days).toBe(getIntervalsElapsed(from, addInterval(from, [1, "month"]), [1, "day"]));
    expect(getStripeTrialPeriodDays([14, "day"], from)).toBe(14);
    expect(getStripeTrialPeriodDays([2, "week"], from)).toBe(14);
    expect(() => getStripeTrialPeriodDays([3, "year"], from)).toThrow(/730/);
  });

  test("getClientSecretFromStripeSubscription requires the expected intent type", ({ expect }) => {
    const setup = getClientSecretFromStripeSubscription({
      pending_setup_intent: { client_secret: "seti_test_secret" },
      latest_invoice: {
        confirmation_secret: { client_secret: "pi_should_not_win" },
      },
    } as Stripe.Subscription, true);
    expect(setup).toEqual({ type: "setup", clientSecret: "seti_test_secret" });

    expect(() => getClientSecretFromStripeSubscription({
      pending_setup_intent: null,
      latest_invoice: {
        confirmation_secret: { client_secret: "pi_test_secret" },
      },
    } as Stripe.Subscription, true)).toThrow(/SetupIntent/);

    const payment = getClientSecretFromStripeSubscription({
      pending_setup_intent: { client_secret: "seti_ignored" },
      latest_invoice: {
        confirmation_secret: { client_secret: "pi_test_secret" },
      },
    } as Stripe.Subscription, false);
    expect(payment).toEqual({ type: "payment", clientSecret: "pi_test_secret" });
  });

  test("setupIntentClientSecretFromSubscription reads an expanded pending SetupIntent", ({ expect }) => {
    expect(setupIntentClientSecretFromSubscription({
      pending_setup_intent: { client_secret: "seti_from_sub" },
    } as Stripe.Subscription)).toBe("seti_from_sub");
    expect(setupIntentClientSecretFromSubscription({
      pending_setup_intent: "seti_unexpanded",
    } as Stripe.Subscription)).toBeNull();
    expect(setupIntentClientSecretFromSubscription({
      pending_setup_intent: null,
    } as Stripe.Subscription)).toBeNull();
  });
});

import.meta.vitest?.describe("stripe customer de-dupe", (test) => {
  const customer = (id: string, metadata: Record<string, string>, created: number): StripeCustomerLookup => ({
    id,
    created,
    metadata,
  });

  test("selectStripeCustomersMatchingType prefers typed rows over untyped", ({ expect }) => {
    const untyped = customer("cus_old", { customerId: "team-1" }, 1);
    const typed = customer("cus_team", { customerId: "team-1", customerType: CustomerType.TEAM }, 2);
    const user = customer("cus_user", { customerId: "team-1", customerType: CustomerType.USER }, 3);
    expect(selectStripeCustomersMatchingType({
      customers: [untyped, typed, user],
      expectedType: CustomerType.TEAM,
    }).map((c) => c.id)).toEqual(["cus_team"]);
  });

  test("selectStripeCustomersMatchingType falls back to untyped when no typed row exists", ({ expect }) => {
    const untyped = customer("cus_old", { customerId: "team-1" }, 1);
    expect(selectStripeCustomersMatchingType({
      customers: [untyped],
      expectedType: CustomerType.TEAM,
    }).map((c) => c.id)).toEqual(["cus_old"]);
  });

  test("pickNewestStripeCustomer returns the later created id", ({ expect }) => {
    expect(pickNewestStripeCustomer([
      customer("cus_a", {}, 10),
      customer("cus_b", {}, 50),
      customer("cus_c", {}, 20),
    ])?.id).toBe("cus_b");
  });
});


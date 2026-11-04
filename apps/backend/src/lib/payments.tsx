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

/**
 * Stripe status is `active` or `trialing`.
 *
 * A sub set to cancel at period end stays `active` in Stripe, so this returns
 * true for it. To ask "will it renew?", use `isSubscriptionCancelable`. To ask
 * "does the customer still get the product?", use `isSubscriptionInEffect`.
 */
export function isActiveSubscription(subscription: { status: string }): boolean {
  const s = subscription.status;
  return s === SubscriptionStatus.active || s === SubscriptionStatus.trialing;
}

/**
 * Active and not already winding down. Used by both the product list's
 * `is_cancelable` and the cancel route's filter — keep them in sync so
 * `is_cancelable: false` always implies the DELETE returns 400.
 */
export function isSubscriptionCancelable(subscription: { status: string, cancelAtPeriodEnd: boolean }): boolean {
  return isActiveSubscription(subscription) && !subscription.cancelAtPeriodEnd;
}

/**
 * Picks the representative sub when several in-effect subs share a productId
 * (stackable products): cancelable > active > in-effect. The middle tier is
 * for pending-cancel Stripe subs, which stay `active` and would otherwise
 * shadow a cancelable sibling.
 */
export function subscriptionDisplayRank(subscription: { status: string, cancelAtPeriodEnd: boolean }): number {
  return isSubscriptionCancelable(subscription) ? 2 : isActiveSubscription(subscription) ? 1 : 0;
}

/**
 * The subscription still confers its product/items, regardless of whether it
 * will renew. Deliberately status-agnostic and `endedAt`-based, mirroring
 * Bulldozer's grant timefold (grants run from row insert until
 * `endedAtMillis`; every terminal writer sets `endedAt`).
 */
export function isSubscriptionInEffect(
  subscription: { endedAtMillis: number | null } | { endedAt: Date | null },
  nowMillis: number,
): boolean {
  const endedAtMillis = "endedAtMillis" in subscription
    ? subscription.endedAtMillis
    : subscription.endedAt != null ? subscription.endedAt.getTime() : null;
  return endedAtMillis == null || endedAtMillis > nowMillis;
}

/**
 * Active, or winding down but still paid through — the subs a customer can
 * still act on: switch away from, or have replaced by a same-line purchase.
 * Narrower than `isSubscriptionInEffect`, which also covers `past_due` /
 * `incomplete` subs; those still entitle, but can't take a plan change until
 * their payment clears. `replaceableSubs` in `grantProductToCustomer` is the
 * Prisma-query mirror of this predicate — keep the two in sync.
 */
export function isSubscriptionSwitchable(
  subscription: { status: string } & ({ endedAtMillis: number | null } | { endedAt: Date | null }),
  nowMillis: number,
): boolean {
  return isActiveSubscription(subscription)
    || (subscription.status === SubscriptionStatus.canceled && isSubscriptionInEffect(subscription, nowMillis));
}

/**
 * The billing period a subscription is in right now, rolled forward from the
 * stored one if it has lapsed.
 *
 * Local (non-Stripe) subs never renew: `currentPeriodEnd` is frozen at grant
 * time, so a monthly sub granted in January still reads "period ends Jan 31"
 * in March while remaining in effect (`endedAt` null). Copying that stale
 * boundary into `endedAt` on cancel would end the sub in the past — revoking
 * access the moment the customer cancels, and retroactively rewriting grant
 * history for the elapsed window. Advancing by whole periods puts the
 * boundary where a renewing sub would have it.
 *
 * Period length comes from the stored period rather than the price interval so
 * this needs no parsing of the (untrusted) product snapshot; month/year subs
 * drift by at most a day or two, which a wind-down date can absorb.
 */
export function getCurrentBillingPeriod(
  subscription: { currentPeriodStartMillis: number, currentPeriodEndMillis: number },
  nowMillis: number,
): { start: Date, end: Date } {
  const { currentPeriodStartMillis: start, currentPeriodEndMillis: end } = subscription;
  const periodLength = end - start;
  if (end > nowMillis || periodLength <= 0) {
    // Still inside the stored period, or a degenerate one we can't extrapolate
    // from — clamp so a lapsed degenerate period never lands in the past.
    return { start: new Date(start), end: new Date(Math.max(end, nowMillis)) };
  }
  const periodsElapsed = Math.ceil((nowMillis - end) / periodLength);
  return {
    start: new Date(start + periodsElapsed * periodLength),
    end: new Date(end + periodsElapsed * periodLength),
  };
}

import.meta.vitest?.describe("getCurrentBillingPeriod", (test) => {
  const MONTH = 30 * 24 * 60 * 60 * 1000;
  const jan1 = new Date("2026-01-01T00:00:00Z").getTime();

  test("returns the stored period while it is still running", ({ expect }) => {
    const period = getCurrentBillingPeriod(
      { currentPeriodStartMillis: jan1, currentPeriodEndMillis: jan1 + MONTH },
      jan1 + MONTH / 2,
    );
    expect(period.start.getTime()).toBe(jan1);
    expect(period.end.getTime()).toBe(jan1 + MONTH);
  });

  test("rolls a lapsed period forward to the one containing `now`", ({ expect }) => {
    const period = getCurrentBillingPeriod(
      { currentPeriodStartMillis: jan1, currentPeriodEndMillis: jan1 + MONTH },
      jan1 + 2.5 * MONTH,
    );
    expect(period.start.getTime()).toBe(jan1 + 2 * MONTH);
    expect(period.end.getTime()).toBe(jan1 + 3 * MONTH);
  });

  test("never returns an end in the past, even for a degenerate period", ({ expect }) => {
    const now = jan1 + 5 * MONTH;
    const period = getCurrentBillingPeriod(
      { currentPeriodStartMillis: jan1, currentPeriodEndMillis: jan1 },
      now,
    );
    expect(period.end.getTime()).toBe(now);
  });
});

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
  const matchesCustomer = (customer: Stripe.Customer) => {
    const storedType = customer.metadata.customerType;
    if (!storedType) return true;
    return storedType === stripeCustomerType;
  };

  const stripeCustomerSearch = await options.stripe.customers.search({
    query: `metadata['customerId']:'${options.customerId}'`,
  });
  let matches = stripeCustomerSearch.data.filter(matchesCustomer);

  if (matches.length === 0) {
    // Stripe's search is eventually consistent; fall back to listing to ensure we can find a newly created customer.
    let startingAfter: string | undefined = undefined;
    for (let i = 0; i < 10; i++) {
      const page: Stripe.ApiList<Stripe.Customer> = await options.stripe.customers.list({
        limit: 100,
        ...startingAfter ? { starting_after: startingAfter } : {},
      });
      const exactMatches = page.data.filter((customer) => (
        customer.metadata.customerId === options.customerId && matchesCustomer(customer)
      ));
      if (exactMatches.length > 0) {
        matches = exactMatches;
        break;
      }
      if (useStripeMock && page.data.length > 0) {
        matches = [page.data[0]];
        break;
      }
      if (!page.has_more || page.data.length === 0) {
        break;
      }
      startingAfter = page.data[page.data.length - 1].id;
    }
  }

  if (matches.length > 1) {
    throw new HexclaveAssertionError("Multiple Stripe customers found for customerId; customerType filtering was ambiguous", {
      customerId: options.customerId,
      customerType: options.customerType,
      stripeCustomerIds: matches.map((c) => c.id),
    });
  }
  return matches[0] ?? null;
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
  conflictingSubscriptions: Array<{ id: string, stripeSubscriptionId: string | null, status: SubscriptionStatus, cancelAtPeriodEnd: boolean }>,
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
  let conflictingSubscriptions: Array<{ id: string, stripeSubscriptionId: string | null, status: SubscriptionStatus, cancelAtPeriodEnd: boolean }> = [];
  const productLineId = product.productLineId;
  const addOnBaseProductIds = product.isAddOnTo ? typedKeys(product.isAddOnTo) : [];
  const isStackableSelfMatch = (pid: string) =>
    productId != null && pid === productId && product.stackable === true;

  // Same-product duplicate guards. Step 4 reads bulldozer's lagged ownedProducts;
  // a duplicate request during lag would slip past it and silently re-grant.
  // We query Prisma directly so the sub guard is symmetric with the OTP guard
  // and works for products with no productLineId.
  // Includes canceled-at-period-end subs: they still back their product, so
  // a same-line purchase must treat them as replaceable conflicts, not OTPs.
  // This is the query form of `isSubscriptionSwitchable` — narrower than
  // isSubscriptionInEffect so a payment retry of an incomplete sub isn't
  // rejected as ProductAlreadyGranted below. Keep the two in sync.
  const replaceableSubs = await prisma.subscription.findMany({
    where: {
      tenancyId,
      customerType: typedToUppercase(customerType),
      customerId,
      OR: [
        { status: { in: [SubscriptionStatus.active, SubscriptionStatus.trialing] } },
        { status: SubscriptionStatus.canceled, endedAt: { gt: new Date() } },
      ],
    },
    select: { id: true, stripeSubscriptionId: true, productId: true, product: true, status: true, cancelAtPeriodEnd: true },
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
    if (activeOtp || replaceableSubs.some(s => s.productId === productId)) {
      throw new KnownErrors.ProductAlreadyGranted(productId, customerId);
    }
  }

  if (productLineId) {
    conflictingSubscriptions = replaceableSubs
      .filter(s =>
        (s.product as Product).productLineId === productLineId
        && !addOnBaseProductIds.includes(s.productId ?? "")
        && !isStackableSelfMatch(s.productId ?? ""),
      )
      .map(s => ({ id: s.id, stripeSubscriptionId: s.stripeSubscriptionId, status: s.status, cancelAtPeriodEnd: s.cancelAtPeriodEnd }));

    // If ownedProducts shows a same-line holding but there's no active subscription
    // backing it, the customer owns via OTP — which can't be replaced by a switch.
    // (We still rely on bulldozer here because OTPs aren't part of the duplicate-
    // request race we're guarding above and OTP propagation lag is low-stakes.)
    const subBackedProductIds = new Set(replaceableSubs.map(s => s.productId ?? "__null__"));
    const otpInProductLine = Object.entries(ownedProducts).some(
      ([pid, p]) =>
        p.productLineId === productLineId
        && p.quantity > 0
        && !addOnBaseProductIds.includes(pid)
        && !isStackableSelfMatch(pid)
        && !subBackedProductIds.has(pid),
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
});


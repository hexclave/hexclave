import type { CustomerType, PromoCodeRedemptionPurchaseKind } from "@/generated/prisma/client";
import { getClientSecretFromStripeSubscription, resolveSetupClientSecretForZeroFirstInvoice } from "@/lib/payments";
import { toPromoCodeRow } from "@/lib/payments/promo-code-api";
import {
  couponDiscountsFromPromos,
  isLingeringSubscriptionPromo,
  normalizePromoCodeName,
  releasePendingRedemptionRow,
  reserveAndCreatePendingRedemption,
  succeedPendingRedemptionRow,
  throwIfPromoNotRedeemable,
  validatePromoCodesForPurchase,
  type PromoCodeRow,
} from "@/lib/payments/promo-codes";
import type { PrismaClientTransaction } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import Stripe from "stripe";

export type PromoCodeProjectPolicy = {
  allowPromoCodes: boolean,
  allowStackingPromoCodes: boolean,
};

export function promoCodeProjectPolicy(payments: { allowPromoCodes?: boolean, allowStackingPromoCodes?: boolean }): PromoCodeProjectPolicy {
  const allowPromoCodes = payments.allowPromoCodes === true;
  return {
    allowPromoCodes,
    allowStackingPromoCodes: allowPromoCodes && payments.allowStackingPromoCodes === true,
  };
}

export function assertPromoCodesCapability(policy: PromoCodeProjectPolicy, options: { wantsPromoCodes: boolean, wantsStacking: boolean }): void {
  if (options.wantsPromoCodes && !policy.allowPromoCodes) {
    throw new KnownErrors.PromoCodesDisabled();
  }
  if (options.wantsStacking && !policy.allowStackingPromoCodes) {
    throw new KnownErrors.PromoCodeStackingDisabled();
  }
}

export async function loadPromoCodesByNames(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  codeNames: string[],
}): Promise<Map<string, PromoCodeRow>> {
  const names = [...new Set(options.codeNames.map(normalizePromoCodeName).filter((name) => name.length > 0))];
  if (names.length === 0) return new Map();
  const rows = await options.prisma.promoCode.findMany({
    where: {
      tenancyId: options.tenancyId,
      codeName: { in: names },
    },
  });
  return new Map(rows.map((row) => [row.codeName, toPromoCodeRow(row)]));
}

export async function validateAppliedPromoCodes(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  codeNames: string[],
  productId: string | null,
  originalStripeUnits: number,
  allowStacking: boolean,
  isOneTime: boolean,
  now?: Date,
}) {
  const promosByName = await loadPromoCodesByNames({
    prisma: options.prisma,
    tenancyId: options.tenancyId,
    codeNames: options.codeNames,
  });
  return validatePromoCodesForPurchase({
    promosByName,
    codeNames: options.codeNames,
    productId: options.productId,
    originalStripeUnits: options.originalStripeUnits,
    allowStacking: options.allowStacking,
    isOneTime: options.isOneTime,
    now: options.now,
  });
}

export function subscriptionDiscountParams(options: {
  promos: PromoCodeRow[],
  hasFreeTrial: boolean,
}): { discounts?: Stripe.SubscriptionCreateParams.Discount[], metadata: Record<string, string> } {
  const metadata = {
    promoCodeIds: options.promos.map((promo) => promo.id).join(","),
  };
  if (options.promos.length === 0) {
    return { metadata };
  }
  if (options.hasFreeTrial) {
    // Coupon clocks start when Stripe first applies the coupon. The $0 trial
    // invoice must not consume `once`, and must not count as month 1 of a
    // `repeating` (fixed-duration) coupon. Attach on the first real invoice.
    return { metadata };
  }
  return {
    discounts: couponDiscountsFromPromos(options.promos),
    metadata,
  };
}

export async function recordPendingRedemptions(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  promos: PromoCodeRow[],
  purchaseKind: PromoCodeRedemptionPurchaseKind,
  stripePaymentIntentId?: string,
  stripeSubscriptionId?: string,
}): Promise<string[]> {
  const redemptionIds: string[] = [];
  try {
    for (const promo of options.promos) {
      const createdId = await reserveAndCreatePendingRedemption({
        prisma: options.prisma,
        tenancyId: options.tenancyId,
        promoCodeId: promo.id,
        customerId: options.customerId,
        customerType: options.customerType,
        purchaseKind: options.purchaseKind,
        stripePaymentIntentId: options.stripePaymentIntentId,
        stripeSubscriptionId: options.stripeSubscriptionId,
      });
      if (createdId == null) {
        const current = await options.prisma.promoCode.findUnique({
          where: {
            tenancyId_id: {
              tenancyId: options.tenancyId,
              id: promo.id,
            },
          },
        });
        if (current != null) {
          throwIfPromoNotRedeemable(toPromoCodeRow(current));
        }
        throw new KnownErrors.PromoCodeRedemptionLimitReached(promo.codeName);
      }
      redemptionIds.push(createdId);
    }
    return redemptionIds;
  } catch (error) {
    for (const redemptionId of redemptionIds) {
      await releasePendingRedemptionRow({
        prisma: options.prisma,
        tenancyId: options.tenancyId,
        redemptionId,
      });
    }
    throw error;
  }
}

export async function succeedPendingRedemptions(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  redemptionIds?: string[],
  stripePaymentIntentId?: string,
  stripeSubscriptionId?: string,
  oneTimePurchaseId?: string,
  subscriptionId?: string,
}): Promise<void> {
  if (options.redemptionIds == null && options.stripePaymentIntentId == null && options.stripeSubscriptionId == null) {
    throw new HexclaveAssertionError("succeedPendingRedemptions requires redemptionIds or a Stripe object id");
  }
  const pending = await options.prisma.promoCodeRedemption.findMany({
    where: {
      tenancyId: options.tenancyId,
      status: "pending",
      ...(options.redemptionIds != null ? { id: { in: options.redemptionIds } } : {}),
      ...(options.stripePaymentIntentId != null ? { stripePaymentIntentId: options.stripePaymentIntentId } : {}),
      ...(options.stripeSubscriptionId != null ? { stripeSubscriptionId: options.stripeSubscriptionId } : {}),
    },
  });
  for (const redemption of pending) {
    await succeedPendingRedemptionRow({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionId: redemption.id,
      oneTimePurchaseId: options.oneTimePurchaseId,
      subscriptionId: options.subscriptionId,
    });
  }
}

export async function releasePendingRedemptions(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  redemptionIds?: string[],
  stripePaymentIntentId?: string,
  stripeSubscriptionId?: string,
}): Promise<void> {
  if (options.redemptionIds == null && options.stripePaymentIntentId == null && options.stripeSubscriptionId == null) {
    throw new HexclaveAssertionError("releasePendingRedemptions requires redemptionIds or a Stripe object id");
  }
  const pending = options.redemptionIds != null
    ? options.redemptionIds.map((id) => ({ id }))
    : await options.prisma.promoCodeRedemption.findMany({
      where: {
        tenancyId: options.tenancyId,
        status: "pending",
        ...(options.stripePaymentIntentId != null ? { stripePaymentIntentId: options.stripePaymentIntentId } : {}),
        ...(options.stripeSubscriptionId != null ? { stripeSubscriptionId: options.stripeSubscriptionId } : {}),
      },
      select: { id: true },
    });
  for (const redemption of pending) {
    await releasePendingRedemptionRow({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionId: redemption.id,
    });
  }
}

export async function attachStripeObjectIdsToRedemptions(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  redemptionIds: string[],
  stripePaymentIntentId?: string,
  stripeSubscriptionId?: string,
}): Promise<void> {
  if (options.redemptionIds.length === 0) return;
  if (options.stripePaymentIntentId == null && options.stripeSubscriptionId == null) {
    throw new HexclaveAssertionError("attachStripeObjectIdsToRedemptions requires a Stripe object id");
  }
  await options.prisma.promoCodeRedemption.updateMany({
    where: {
      tenancyId: options.tenancyId,
      id: { in: options.redemptionIds },
    },
    data: {
      ...(options.stripePaymentIntentId != null ? { stripePaymentIntentId: options.stripePaymentIntentId } : {}),
      ...(options.stripeSubscriptionId != null ? { stripeSubscriptionId: options.stripeSubscriptionId } : {}),
    },
  });
}

type PromoReserveArgs = {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  customerId: string,
  customerType: CustomerType,
  promos: PromoCodeRow[],
  purchaseKind: PromoCodeRedemptionPurchaseKind,
};

async function reservePromoRedemptions(options: PromoReserveArgs): Promise<string[]> {
  if (options.promos.length === 0) return [];
  return await recordPendingRedemptions({
    prisma: options.prisma,
    tenancyId: options.tenancyId,
    customerId: options.customerId,
    customerType: options.customerType,
    promos: options.promos,
    purchaseKind: options.purchaseKind,
  });
}

async function releasePromoRedemptions(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  redemptionIds: string[],
}): Promise<void> {
  if (options.redemptionIds.length === 0) return;
  await releasePendingRedemptions({
    prisma: options.prisma,
    tenancyId: options.tenancyId,
    redemptionIds: options.redemptionIds,
  });
}

async function bindPendingPromoToStripe(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  redemptionIds: string[],
  stripeSubscriptionId?: string,
  stripePaymentIntentId?: string,
}): Promise<void> {
  if (options.redemptionIds.length === 0) return;
  await attachStripeObjectIdsToRedemptions(options);
}

async function bindGrantIdentityToPending(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  redemptionIds: string[],
  oneTimePurchaseId?: string,
  subscriptionId?: string,
}): Promise<void> {
  if (options.redemptionIds.length === 0) return;
  if (options.oneTimePurchaseId == null && options.subscriptionId == null) return;
  await options.prisma.promoCodeRedemption.updateMany({
    where: {
      tenancyId: options.tenancyId,
      id: { in: options.redemptionIds },
      status: "pending",
    },
    data: {
      ...(options.oneTimePurchaseId != null ? { oneTimePurchaseId: options.oneTimePurchaseId } : {}),
      ...(options.subscriptionId != null ? { subscriptionId: options.subscriptionId } : {}),
    },
  });
}

async function findPendingWithGrantIdentity(options: PromoReserveArgs): Promise<Array<{ id: string, promoCodeId: string }>> {
  if (options.promos.length === 0) return [];
  return await options.prisma.promoCodeRedemption.findMany({
    where: {
      tenancyId: options.tenancyId,
      customerId: options.customerId,
      customerType: options.customerType,
      promoCodeId: { in: options.promos.map((promo) => promo.id) },
      status: "pending",
      OR: [
        { oneTimePurchaseId: { not: null } },
        { subscriptionId: { not: null } },
      ],
    },
    select: { id: true, promoCodeId: true },
  });
}

/**
 * Stripe rejected the attach (create/update threw). No coupon on a live
 * object. Free the slot; do not increment numRedemptions.
 */
async function releaseBecauseStripeRejectedAttach(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  redemptionIds: string[],
  error: unknown,
}): Promise<never> {
  await releasePromoRedemptions(options);
  throw options.error;
}

/**
 * Stripe already attached the coupon, then a later step failed. Undo Stripe
 * first. Only release the slot if undo succeeded — otherwise two customers
 * could take a limited code.
 */
async function undoAttachedCouponThenRelease(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  redemptionIds: string[],
  undo: () => Promise<void>,
  error: unknown,
}): Promise<never> {
  try {
    await options.undo();
  } catch (rollbackError) {
    throw new HexclaveAssertionError("Stripe coupon is still attached; pending redemptions were not released", { cause: rollbackError });
  }
  await releasePromoRedemptions(options);
  throw options.error;
}

export type CheckoutCardCollection =
  | { type: "none" }
  | { type: "setup_intent", customerId: string }
  | { type: "client_secret", shouldExpectSetupIntent: boolean };

export type CheckoutSubscriptionAttachResult = {
  subscription: Stripe.Subscription,
  redemptionIds: string[],
  setupClientSecret: string | null,
  paymentClientSecret: string | null,
};

async function collectCheckoutCardSecrets(options: {
  stripe: Stripe,
  subscription: Stripe.Subscription,
  tenancyId: string,
  cardCollection: CheckoutCardCollection,
}): Promise<{ setupClientSecret: string | null, paymentClientSecret: string | null }> {
  if (options.cardCollection.type === "none") {
    return { setupClientSecret: null, paymentClientSecret: null };
  }
  if (options.cardCollection.type === "setup_intent") {
    const setupClientSecret = await resolveSetupClientSecretForZeroFirstInvoice({
      stripe: options.stripe,
      subscription: options.subscription,
      customerId: options.cardCollection.customerId,
      tenancyId: options.tenancyId,
    });
    return { setupClientSecret, paymentClientSecret: null };
  }
  const clientSecret = getClientSecretFromStripeSubscription(
    options.subscription,
    options.cardCollection.shouldExpectSetupIntent,
  );
  return {
    setupClientSecret: clientSecret.type === "setup" ? clientSecret.clientSecret : null,
    paymentClientSecret: clientSecret.type === "payment" ? clientSecret.clientSecret : null,
  };
}

/**
 * Hosted checkout: creating a subscription attaches the coupon immediately
 * but the customer has not paid (`default_incomplete`). Bind the Stripe id
 * onto pending rows. Do not succeed / increment numRedemptions.
 */
export async function createCheckoutSubscription(options: PromoReserveArgs & {
  stripe: Stripe,
  params: Stripe.SubscriptionCreateParams,
  cardCollection: CheckoutCardCollection,
}): Promise<CheckoutSubscriptionAttachResult> {
  const redemptionIds = await reservePromoRedemptions(options);
  let subscription: Stripe.Subscription;
  try {
    subscription = await options.stripe.subscriptions.create(options.params);
  } catch (error) {
    return await releaseBecauseStripeRejectedAttach({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      error,
    });
  }
  try {
    const secrets = await collectCheckoutCardSecrets({
      stripe: options.stripe,
      subscription,
      tenancyId: options.tenancyId,
      cardCollection: options.cardCollection,
    });
    await bindPendingPromoToStripe({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      stripeSubscriptionId: subscription.id,
    });
    return { subscription, redemptionIds, ...secrets };
  } catch (error) {
    return await undoAttachedCouponThenRelease({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      undo: async () => {
        await options.stripe.subscriptions.cancel(subscription.id);
      },
      error,
    });
  }
}

/**
 * Hosted checkout: in-place plan replace. Same confirmation rule as create —
 * coupon is on Stripe, purchase is not complete. Undo is restore-previous,
 * not cancel.
 */
export async function updateCheckoutSubscription(options: PromoReserveArgs & {
  stripe: Stripe,
  subscriptionId: string,
  params: Stripe.SubscriptionUpdateParams,
  previousSnapshot: InPlaceSubscriptionSnapshot,
  cardCollection: CheckoutCardCollection,
}): Promise<CheckoutSubscriptionAttachResult> {
  const redemptionIds = await reservePromoRedemptions(options);
  let subscription: Stripe.Subscription;
  try {
    subscription = await options.stripe.subscriptions.update(options.subscriptionId, options.params);
  } catch (error) {
    return await releaseBecauseStripeRejectedAttach({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      error,
    });
  }
  try {
    const secrets = await collectCheckoutCardSecrets({
      stripe: options.stripe,
      subscription,
      tenancyId: options.tenancyId,
      cardCollection: options.cardCollection,
    });
    await bindPendingPromoToStripe({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      stripeSubscriptionId: subscription.id,
    });
    return { subscription, redemptionIds, ...secrets };
  } catch (error) {
    return await undoAttachedCouponThenRelease({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      undo: async () => {
        await options.stripe.subscriptions.update(
          options.subscriptionId,
          inPlaceSubscriptionRestoreParams(options.previousSnapshot),
        );
      },
      error,
    });
  }
}

/**
 * Hosted checkout one-time: PaymentIntent create attaches the coupon on an
 * unconfirmed intent. Bind only. Succeed on the payment webhook.
 */
export async function createCheckoutPaymentIntent(options: PromoReserveArgs & {
  stripe: Stripe,
  params: Stripe.PaymentIntentCreateParams,
}): Promise<{ paymentIntent: Stripe.PaymentIntent, redemptionIds: string[] }> {
  const redemptionIds = await reservePromoRedemptions(options);
  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await options.stripe.paymentIntents.create(options.params);
  } catch (error) {
    return await releaseBecauseStripeRejectedAttach({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      error,
    });
  }
  try {
    if (typeof paymentIntent.client_secret !== "string") {
      throwErr(500, "No client secret returned from Stripe for payment intent");
    }
    await bindPendingPromoToStripe({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      stripePaymentIntentId: paymentIntent.id,
    });
    return { paymentIntent, redemptionIds };
  } catch (error) {
    return await undoAttachedCouponThenRelease({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      undo: async () => {
        await options.stripe.paymentIntents.cancel(paymentIntent.id);
      },
      error,
    });
  }
}

/**
 * Switch uses `error_if_incomplete`: Stripe returning means the card was
 * charged and the coupon is attached. Bind only here. The route writes our
 * Subscription row, then succeeds the pending redemptions (numRedemptions++).
 */
export async function createSwitchSubscription(options: PromoReserveArgs & {
  stripe: Stripe,
  params: Stripe.SubscriptionCreateParams,
}): Promise<{ subscription: Stripe.Subscription, redemptionIds: string[] }> {
  const redemptionIds = await reservePromoRedemptions(options);
  let subscription: Stripe.Subscription;
  try {
    subscription = await options.stripe.subscriptions.create(options.params);
  } catch (error) {
    return await releaseBecauseStripeRejectedAttach({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      error,
    });
  }
  try {
    await bindPendingPromoToStripe({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      stripeSubscriptionId: subscription.id,
    });
    return { subscription, redemptionIds };
  } catch (error) {
    return await undoAttachedCouponThenRelease({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      undo: async () => {
        await options.stripe.subscriptions.cancel(subscription.id);
      },
      error,
    });
  }
}

export async function updateSwitchSubscription(options: PromoReserveArgs & {
  stripe: Stripe,
  subscriptionId: string,
  params: Stripe.SubscriptionUpdateParams,
  previousSnapshot: InPlaceSubscriptionSnapshot,
}): Promise<{ subscription: Stripe.Subscription, redemptionIds: string[] }> {
  const redemptionIds = await reservePromoRedemptions(options);
  let subscription: Stripe.Subscription;
  try {
    subscription = await options.stripe.subscriptions.update(options.subscriptionId, options.params);
  } catch (error) {
    return await releaseBecauseStripeRejectedAttach({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      error,
    });
  }
  try {
    await bindPendingPromoToStripe({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      stripeSubscriptionId: options.subscriptionId,
    });
    return { subscription, redemptionIds };
  } catch (error) {
    return await undoAttachedCouponThenRelease({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
      undo: async () => {
        await options.stripe.subscriptions.update(
          options.subscriptionId,
          inPlaceSubscriptionRestoreParams(options.previousSnapshot),
        );
      },
      error,
    });
  }
}

/**
 * Test-mode / $0 OTP: no Stripe coupon. Grant is the purchase. If grant
 * throws, release. If grant returns, stamp the purchase/subscription id on
 * the still-pending rows, then succeed (numRedemptions++). A later
 * succeed failure must not release — the product is already granted.
 *
 * Retry after grant+stamp but before succeed: pending rows already carry
 * the grant identity, so we succeed those and must not grant again. Crash
 * after grant but before stamp still has no identity to recover from.
 */
export async function grantProductAndSucceedPromo(options: PromoReserveArgs & {
  grant: () => Promise<{ oneTimePurchaseId?: string, subscriptionId?: string }>,
}): Promise<void> {
  if (options.promos.length === 0) {
    await options.grant();
    return;
  }

  const boundPending = await findPendingWithGrantIdentity(options);
  if (boundPending.length > 0) {
    await succeedPendingRedemptions({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds: boundPending.map((row) => row.id),
    });
    const coveredPromoIds = new Set(boundPending.map((row) => row.promoCodeId));
    if (options.promos.every((promo) => coveredPromoIds.has(promo.id))) {
      return;
    }
    const uncoveredPromoIds = options.promos
      .filter((promo) => !coveredPromoIds.has(promo.id))
      .map((promo) => promo.id);
    const alreadySucceeded = await options.prisma.promoCodeRedemption.findMany({
      where: {
        tenancyId: options.tenancyId,
        customerId: options.customerId,
        customerType: options.customerType,
        promoCodeId: { in: uncoveredPromoIds },
        status: "succeeded",
      },
      select: { promoCodeId: true },
    });
    for (const row of alreadySucceeded) {
      coveredPromoIds.add(row.promoCodeId);
    }
    if (!options.promos.every((promo) => coveredPromoIds.has(promo.id))) {
      throw new HexclaveAssertionError("Pending redemptions have a grant identity for only some of the requested promo codes; refusing to grant again", {
        requestedPromoIds: options.promos.map((promo) => promo.id),
        coveredPromoIds: [...coveredPromoIds],
      });
    }
    return;
  }

  const redemptionIds = await reservePromoRedemptions(options);
  let granted: { oneTimePurchaseId?: string, subscriptionId?: string };
  try {
    granted = await options.grant();
  } catch (error) {
    await releasePromoRedemptions({
      prisma: options.prisma,
      tenancyId: options.tenancyId,
      redemptionIds,
    });
    throw error;
  }
  if (redemptionIds.length === 0) return;
  await bindGrantIdentityToPending({
    prisma: options.prisma,
    tenancyId: options.tenancyId,
    redemptionIds,
    oneTimePurchaseId: granted.oneTimePurchaseId,
    subscriptionId: granted.subscriptionId,
  });
  await succeedPendingRedemptions({
    prisma: options.prisma,
    tenancyId: options.tenancyId,
    redemptionIds,
    oneTimePurchaseId: granted.oneTimePurchaseId,
    subscriptionId: granted.subscriptionId,
  });
}

export async function listLiveHexclaveRedemptions(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  stripeSubscriptionId: string,
}): Promise<Array<{ id: string, stripeCouponId: string }>> {
  const rows = await options.prisma.promoCodeRedemption.findMany({
    where: {
      tenancyId: options.tenancyId,
      stripeSubscriptionId: options.stripeSubscriptionId,
      status: "succeeded",
      subscriptionDiscountRemovedAt: null,
    },
    select: {
      id: true,
      promoCode: {
        select: { stripeCouponId: true },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    stripeCouponId: row.promoCode.stripeCouponId,
  }));
}

export async function markHexclaveDiscountsRemoved(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  redemptionIds: string[],
}): Promise<void> {
  if (options.redemptionIds.length === 0) return;
  await options.prisma.promoCodeRedemption.updateMany({
    where: {
      tenancyId: options.tenancyId,
      id: { in: options.redemptionIds },
    },
    data: { subscriptionDiscountRemovedAt: new Date() },
  });
}

export type ExpandedStripeDiscount = {
  id: string,
  coupon: string | { id: string },
};

export function requireExpandedDiscount(discount: string | ExpandedStripeDiscount): ExpandedStripeDiscount {
  if (typeof discount === "string") {
    throw new HexclaveAssertionError("Subscription discounts must be expanded", { discount });
  }
  if (discount.id.length === 0) {
    throw new HexclaveAssertionError("Expanded discount is missing id", { discount });
  }
  return discount;
}

export function couponIdFromExpandedDiscount(discount: ExpandedStripeDiscount): string {
  const coupon = discount.coupon;
  return typeof coupon === "string" ? coupon : coupon.id;
}

export function keepNonHexclaveDiscountRefs(
  subscriptionDiscounts: ReadonlyArray<string | ExpandedStripeDiscount>,
  hexclaveCouponIds: ReadonlySet<string>,
): Stripe.SubscriptionUpdateParams.Discount[] {
  const kept: Stripe.SubscriptionUpdateParams.Discount[] = [];
  for (const discount of subscriptionDiscounts) {
    const expanded = requireExpandedDiscount(discount);
    const couponId = couponIdFromExpandedDiscount(expanded);
    if (hexclaveCouponIds.has(couponId)) continue;
    kept.push({ discount: expanded.id });
  }
  return kept;
}

export function inPlaceSubscriptionDiscountFields(options: {
  promoAttach: { discounts?: Stripe.SubscriptionCreateParams.Discount[] },
  subscriptionDiscounts: ReadonlyArray<string | ExpandedStripeDiscount>,
  hexclaveCouponIds: ReadonlySet<string>,
}): { discounts?: Stripe.SubscriptionUpdateParams.Discount[] } {
  const incoming = options.promoAttach.discounts;
  if (incoming == null && options.hexclaveCouponIds.size === 0) {
    // Omit `discounts` so Stripe leaves the existing array alone.
    return {};
  }
  // Stripe's `discounts` param replaces the whole array. Never send `[]` as
  // "Hexclave is live" — that would wipe merchant coupons. Walk expanded
  // discounts, keep every non-Hexclave as `{ discount: id }` (same as
  // remainingDiscountsAfterRemovingCoupon), and only emit `[]` when that
  // walk found nothing to keep (Hexclave was the entire list). Stripe has
  // no other way to drop the last coupon.
  const kept = keepNonHexclaveDiscountRefs(options.subscriptionDiscounts, options.hexclaveCouponIds);
  if (incoming != null) {
    return { discounts: [...kept, ...incoming] };
  }
  if (kept.length === 0) {
    return { discounts: [] };
  }
  return { discounts: kept };
}

export type InPlaceSubscriptionSnapshot = {
  itemId: string,
  priceId: string,
  quantity: number,
  discounts: Stripe.SubscriptionUpdateParams.Discount[],
  metadata: Stripe.Metadata,
};

export function inPlaceSubscriptionSnapshot(subscription: Stripe.Subscription): InPlaceSubscriptionSnapshot {
  if (subscription.items.data.length === 0) {
    throw new HexclaveAssertionError("Stripe subscription has no items", { subscriptionId: subscription.id });
  }
  const item = subscription.items.data[0];
  const price = item.price;
  const priceId = typeof price === "string" ? price : price.id;
  if (priceId.length === 0) {
    throw new HexclaveAssertionError("Stripe subscription item is missing price id", { subscriptionId: subscription.id, itemId: item.id });
  }
  return {
    itemId: item.id,
    priceId,
    quantity: item.quantity ?? 1,
    discounts: keepNonHexclaveDiscountRefs(subscription.discounts, new Set()),
    metadata: subscription.metadata,
  };
}

export function inPlaceSubscriptionRestoreParams(snapshot: InPlaceSubscriptionSnapshot): Stripe.SubscriptionUpdateParams {
  return {
    items: [{
      id: snapshot.itemId,
      price: snapshot.priceId,
      quantity: snapshot.quantity,
    }],
    discounts: snapshot.discounts,
    metadata: snapshot.metadata,
    proration_behavior: "none",
  };
}

export function remainingDiscountsAfterRemovingCoupon(options: {
  subscriptionDiscounts: ReadonlyArray<string | { id: string, coupon: string | { id: string } }>,
  couponIdToRemove: string,
}): Stripe.SubscriptionUpdateParams.Discount[] {
  const remaining: Stripe.SubscriptionUpdateParams.Discount[] = [];
  for (const discount of options.subscriptionDiscounts) {
    if (typeof discount === "string") {
      throw new HexclaveAssertionError("Subscription discounts must be expanded to remove a single coupon", { discount });
    }
    const coupon = discount.coupon;
    const couponId = typeof coupon === "string" ? coupon : coupon.id;
    if (couponId === options.couponIdToRemove) continue;
    if (discount.id.length === 0) {
      throw new HexclaveAssertionError("Expanded discount is missing id", { discount });
    }
    remaining.push({ discount: discount.id });
  }
  return remaining;
}

export function promoCodeIdsMetadataWithout(raw: string | undefined, promoCodeIdToRemove: string): string {
  if (raw == null || raw.length === 0) return "";
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id !== promoCodeIdToRemove)
    .join(",");
}

export async function attachPromoCouponsAfterTrial(options: {
  prisma: PrismaClientTransaction,
  stripe: Stripe,
  tenancyId: string,
  subscription: Stripe.Subscription,
  draftInvoiceId?: string,
}): Promise<void> {
  const promoCodeIdsRaw = Object.hasOwn(options.subscription.metadata, "promoCodeIds")
    ? options.subscription.metadata.promoCodeIds
    : undefined;
  if (promoCodeIdsRaw == null || promoCodeIdsRaw.length === 0) return;
  const promoCodeIds = promoCodeIdsRaw.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  if (promoCodeIds.length === 0) return;
  const promos = await options.prisma.promoCode.findMany({
    where: {
      tenancyId: options.tenancyId,
      id: { in: promoCodeIds },
    },
  });
  if (promos.length === 0) return;
  const discounts = couponDiscountsFromPromos(promos.map(toPromoCodeRow));
  // Put once + lingering on the subscription after the $0 trial invoice is
  // already paid. The next invoice (first real charge) inherits them.
  // Attaching on invoice.created is too late: Stripe finalizes that invoice
  // before our background webhook runs, so the first charge would be list
  // price and `once` would never appear.
  if (options.subscription.status === "trialing") {
    const latestInvoiceRef = options.subscription.latest_invoice;
    const latestInvoiceId = typeof latestInvoiceRef === "string"
      ? latestInvoiceRef
      : latestInvoiceRef?.id;
    if (latestInvoiceId == null) return;
    const latestInvoice = await options.stripe.invoices.retrieve(latestInvoiceId);
    if (latestInvoice.status === "draft" || latestInvoice.status === "open") {
      return;
    }
  }
  if (options.subscription.discounts.length === 0 && discounts.length > 0) {
    await options.stripe.subscriptions.update(options.subscription.id, {
      discounts,
      proration_behavior: "none",
    });
  }
  if (options.draftInvoiceId != null && discounts.length > 0) {
    const draftInvoice = await options.stripe.invoices.retrieve(options.draftInvoiceId, { expand: ["discounts"] });
    if (draftInvoice.status === "draft") {
      const hexclaveCouponIds = new Set(promos.map((promo) => promo.stripeCouponId));
      const kept = keepNonHexclaveDiscountRefs(draftInvoice.discounts, hexclaveCouponIds);
      await options.stripe.invoices.update(options.draftInvoiceId, {
        discounts: [...kept, ...discounts],
      });
    }
  }
}

export function splitPromoDiscountsForFirstRealCharge(promos: PromoCodeRow[]): {
  subscriptionDiscounts: Stripe.SubscriptionUpdateParams.Discount[],
  invoiceDiscounts: Stripe.InvoiceUpdateParams.Discount[],
} {
  const discounts = couponDiscountsFromPromos(promos);
  return {
    subscriptionDiscounts: discounts,
    invoiceDiscounts: discounts,
  };
}

export function isTrialCreationInvoice(invoice: {
  billing_reason: string | null,
  subtotal: number,
  total: number,
}): boolean {
  // Only the unpaid/trial checkout invoice. A paid first invoice must set
  // promoInitialInvoicePaid so first_payment coupons are not reattached on
  // the next cycle. $0 cycle invoices are renewals, not trial creation.
  return invoice.billing_reason === "subscription_create" && invoice.subtotal === 0;
}

/**
 * Stripe applies stacked `once` + `forever` coupons to the first invoice, then
 * drops `once` discounts. In that swap it can also drop `forever` / repeating
 * coupons (Dashboard then shows only the last `once` code). Re-attach the
 * lingering coupons on cycle invoices so renewals keep them. Skip proration
 * invoices — replacing discounts there would strip `once` codes from the
 * switch charge.
 *
 * Do not restore until the first real (post-trial) invoice has been paid.
 * Restoring lingering-only on that first invoice would strip `once` codes
 * that still need to apply.
 */
export function promoCouponActionForInvoice(options: {
  billingReason: string | null,
  promoInitialInvoicePaid: boolean,
  hasPromoCodeIds: boolean,
}): "attach_all" | "restore_lingering" | "none" {
  if (!options.hasPromoCodeIds) return "none";
  // The checkout $0 trial invoice. Coupons stay in metadata until the first
  // invoice that actually bills the subscription.
  if (options.billingReason === "subscription_create") return "none";
  if (!options.promoInitialInvoicePaid) return "attach_all";
  if (options.billingReason === "subscription_cycle") return "restore_lingering";
  return "none";
}

export async function markPromoInitialInvoicePaid(options: {
  stripe: Stripe,
  subscription: Stripe.Subscription,
}): Promise<void> {
  const promoCodeIdsRaw = Object.hasOwn(options.subscription.metadata, "promoCodeIds")
    ? options.subscription.metadata.promoCodeIds
    : undefined;
  if (promoCodeIdsRaw == null || promoCodeIdsRaw.length === 0) return;
  if (options.subscription.metadata.promoInitialInvoicePaid === "true") return;
  await options.stripe.subscriptions.update(options.subscription.id, {
    metadata: {
      ...options.subscription.metadata,
      promoInitialInvoicePaid: "true",
    },
  });
}

export async function restoreLingeringSubscriptionCoupons(options: {
  prisma: PrismaClientTransaction,
  stripe: Stripe,
  tenancyId: string,
  subscription: Stripe.Subscription,
}): Promise<void> {
  const promoCodeIdsRaw = Object.hasOwn(options.subscription.metadata, "promoCodeIds")
    ? options.subscription.metadata.promoCodeIds
    : undefined;
  if (promoCodeIdsRaw == null || promoCodeIdsRaw.length === 0) return;
  const promoCodeIds = promoCodeIdsRaw.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  if (promoCodeIds.length === 0) return;
  const promos = await options.prisma.promoCode.findMany({
    where: {
      tenancyId: options.tenancyId,
      id: { in: promoCodeIds },
    },
  });
  const lingering = promos.map(toPromoCodeRow).filter(isLingeringSubscriptionPromo);
  if (lingering.length === 0) return;
  const discounts = restoreLingeringDiscountUpdates({
    lingering,
    subscriptionDiscounts: options.subscription.discounts,
  });
  if (discounts == null) return;
  await options.stripe.subscriptions.update(options.subscription.id, {
    discounts,
    proration_behavior: "none",
  });
}

/**
 * Re-applying a `repeating` coupon (`{ coupon }`) starts a new
 * duration_in_months window. A 3-month code then lasts 3 months from the
 * first charge plus another 3 from restore (minus overlap) — extra invoices.
 * Reuse existing Stripe discount ids for repeating (and forever that is still
 * attached). Only mint a new coupon application for missing **forever** codes.
 */
export function restoreLingeringDiscountUpdates(options: {
  lingering: PromoCodeRow[],
  subscriptionDiscounts: ReadonlyArray<string | ExpandedStripeDiscount>,
}): Stripe.SubscriptionUpdateParams.Discount[] | null {
  const hexclaveCouponIds = new Set(options.lingering.map((promo) => promo.stripeCouponId));
  const discountIdByCouponId = new Map<string, string>();
  const foreign: Stripe.SubscriptionUpdateParams.Discount[] = [];
  for (const discount of options.subscriptionDiscounts) {
    const expanded = requireExpandedDiscount(discount);
    const couponId = couponIdFromExpandedDiscount(expanded);
    if (couponId.length > 0) {
      discountIdByCouponId.set(couponId, expanded.id);
    }
    if (!hexclaveCouponIds.has(couponId)) {
      foreign.push({ discount: expanded.id });
    }
  }

  const forever = options.lingering.filter((promo) => promo.subscriptionBehavior === "forever");
  const repeating = options.lingering.filter((promo) => promo.subscriptionBehavior === "fixed_duration");
  const missingForever = forever.filter((promo) => !discountIdByCouponId.has(promo.stripeCouponId));
  if (missingForever.length === 0) {
    return null;
  }

  const reused: Stripe.SubscriptionUpdateParams.Discount[] = [];
  for (const promo of [...repeating, ...forever]) {
    const discountId = discountIdByCouponId.get(promo.stripeCouponId);
    if (discountId != null) {
      reused.push({ discount: discountId });
    }
  }
  return [
    ...foreign,
    ...reused,
    ...couponDiscountsFromPromos(missingForever),
  ];
}

export function parsePromoCodeNames(value: string[] | undefined): string[] {
  if (value == null) return [];
  const trimmed = value.map((name) => name.trim());
  // A missing/empty array means "no codes". A non-empty list that contains
  // blanks is invalid — do not coerce it to "no codes".
  if (trimmed.some((name) => name.length === 0)) {
    throw new KnownErrors.PromoCodeInvalid("Promo code name is required.");
  }
  return trimmed;
}

import.meta.vitest?.describe("parsePromoCodeNames", (test) => {
  test("treats missing or [] as no codes, and rejects blank entries", ({ expect }) => {
    expect(parsePromoCodeNames(undefined)).toEqual([]);
    expect(parsePromoCodeNames([])).toEqual([]);
    expect(parsePromoCodeNames([" SWITCH10 "])).toEqual(["SWITCH10"]);
    expect(() => parsePromoCodeNames([""])).toThrow(KnownErrors.PromoCodeInvalid);
    expect(() => parsePromoCodeNames(["", "  "])).toThrow(KnownErrors.PromoCodeInvalid);
    expect(() => parsePromoCodeNames(["SWITCH10", ""])).toThrow(KnownErrors.PromoCodeInvalid);
  });
});

import.meta.vitest?.describe("assertPromoCodesCapability", (test) => {
  const disabled = promoCodeProjectPolicy({ allowPromoCodes: false, allowStackingPromoCodes: true });
  const promoOnly = promoCodeProjectPolicy({ allowPromoCodes: true, allowStackingPromoCodes: false });
  const both = promoCodeProjectPolicy({ allowPromoCodes: true, allowStackingPromoCodes: true });

  test("rejects promo usage when the project gate is off", ({ expect }) => {
    expect(disabled).toEqual({ allowPromoCodes: false, allowStackingPromoCodes: false });
    expect(() => assertPromoCodesCapability(disabled, { wantsPromoCodes: true, wantsStacking: false })).toThrow(KnownErrors.PromoCodesDisabled);
    expect(() => assertPromoCodesCapability(disabled, { wantsPromoCodes: false, wantsStacking: false })).not.toThrow();
  });

  test("rejects stacking when stacking is off, even if promos are on", ({ expect }) => {
    expect(promoOnly.allowStackingPromoCodes).toBe(false);
    expect(() => assertPromoCodesCapability(promoOnly, { wantsPromoCodes: true, wantsStacking: true })).toThrow(KnownErrors.PromoCodeStackingDisabled);
    expect(() => assertPromoCodesCapability(both, { wantsPromoCodes: true, wantsStacking: true })).not.toThrow();
  });
});

import.meta.vitest?.describe("subscriptionDiscountParams", (test) => {
  const promo: PromoCodeRow = {
    id: "promo-1",
    tenancyId: "tenancy-1",
    codeName: "SAVE10",
    discountType: "percent",
    discountAmount: 10,
    currency: "USD",
    applicableProductIds: null,
    maxRedemptions: null,
    numRedemptions: 0,
    pendingRedemptions: 0,
    subscriptionBehavior: "first_payment",
    subscriptionDiscountDurationMonths: null,
    availabilityType: "always",
    startsAt: null,
    endsAt: null,
    pausedAt: null,
    endedAt: null,
    stripeCouponId: "coupon_1",
  };

  test("attaches coupons when there is no free trial", ({ expect }) => {
    expect(subscriptionDiscountParams({ promos: [promo], hasFreeTrial: false })).toEqual({
      discounts: [{ coupon: "coupon_1" }],
      metadata: { promoCodeIds: "promo-1" },
    });
  });

  test("stores promo ids but does not attach coupons during a free trial", ({ expect }) => {
    expect(subscriptionDiscountParams({ promos: [promo], hasFreeTrial: true })).toEqual({
      metadata: { promoCodeIds: "promo-1" },
    });
  });

  test("isLingeringSubscriptionPromo is false for first_payment and true for forever/fixed_duration", ({ expect }) => {
    expect(isLingeringSubscriptionPromo(promo)).toBe(false);
    expect(isLingeringSubscriptionPromo({ ...promo, subscriptionBehavior: "forever" })).toBe(true);
    expect(isLingeringSubscriptionPromo({
      ...promo,
      subscriptionBehavior: "fixed_duration",
    })).toBe(true);
  });
});

import.meta.vitest?.describe("splitPromoDiscountsForFirstRealCharge", (test) => {
  const once: PromoCodeRow = {
    id: "once",
    tenancyId: "tenancy-1",
    codeName: "ONCE",
    discountType: "percent",
    discountAmount: 50,
    currency: "USD",
    applicableProductIds: null,
    maxRedemptions: null,
    numRedemptions: 0,
    pendingRedemptions: 0,
    subscriptionBehavior: "first_payment",
    subscriptionDiscountDurationMonths: null,
    availabilityType: "always",
    startsAt: null,
    endsAt: null,
    pausedAt: null,
    endedAt: null,
    stripeCouponId: "coupon_once",
  };
  const repeating: PromoCodeRow = {
    ...once,
    id: "rep",
    codeName: "THREE",
    subscriptionBehavior: "fixed_duration",
    subscriptionDiscountDurationMonths: 3,
    stripeCouponId: "coupon_rep",
  };

  test("puts once and repeating on both the subscription and the first real invoice", ({ expect }) => {
    expect(splitPromoDiscountsForFirstRealCharge([once, repeating])).toEqual({
      subscriptionDiscounts: [{ coupon: "coupon_once" }, { coupon: "coupon_rep" }],
      invoiceDiscounts: [{ coupon: "coupon_once" }, { coupon: "coupon_rep" }],
    });
  });
});

import.meta.vitest?.describe("promoCouponActionForInvoice", (test) => {
  test("skips the $0 trial creation invoice", ({ expect }) => {
    expect(promoCouponActionForInvoice({
      billingReason: "subscription_create",
      promoInitialInvoicePaid: false,
      hasPromoCodeIds: true,
    })).toBe("none");
  });

  test("attaches once+lingering on the first real invoice, including subscription_cycle after a trial", ({ expect }) => {
    expect(promoCouponActionForInvoice({
      billingReason: "subscription_cycle",
      promoInitialInvoicePaid: false,
      hasPromoCodeIds: true,
    })).toBe("attach_all");
  });

  test("restores lingering only after the first real invoice has been paid", ({ expect }) => {
    expect(promoCouponActionForInvoice({
      billingReason: "subscription_cycle",
      promoInitialInvoicePaid: true,
      hasPromoCodeIds: true,
    })).toBe("restore_lingering");
  });
});

import.meta.vitest?.describe("isTrialCreationInvoice", (test) => {
  test("treats only a $0 subscription_create invoice as the trial invoice", ({ expect }) => {
    expect(isTrialCreationInvoice({ billing_reason: "subscription_create", subtotal: 0, total: 0 })).toBe(true);
    expect(isTrialCreationInvoice({ billing_reason: "subscription_create", subtotal: 1000, total: 1000 })).toBe(false);
    expect(isTrialCreationInvoice({ billing_reason: "subscription_create", subtotal: 1000, total: 0 })).toBe(false);
    expect(isTrialCreationInvoice({ billing_reason: "subscription_cycle", subtotal: 0, total: 0 })).toBe(false);
    expect(isTrialCreationInvoice({ billing_reason: "subscription_cycle", subtotal: 1000, total: 0 })).toBe(false);
    expect(isTrialCreationInvoice({ billing_reason: "subscription_cycle", subtotal: 1000, total: 1000 })).toBe(false);
  });
});

import.meta.vitest?.describe("restoreLingeringDiscountUpdates", (test) => {
  const forever: PromoCodeRow = {
    id: "f",
    tenancyId: "tenancy-1",
    codeName: "FOREVER",
    discountType: "percent",
    discountAmount: 10,
    currency: "USD",
    applicableProductIds: null,
    maxRedemptions: null,
    numRedemptions: 0,
    pendingRedemptions: 0,
    subscriptionBehavior: "forever",
    subscriptionDiscountDurationMonths: null,
    availabilityType: "always",
    startsAt: null,
    endsAt: null,
    pausedAt: null,
    endedAt: null,
    stripeCouponId: "coupon_forever",
  };
  const repeating: PromoCodeRow = {
    ...forever,
    id: "r",
    codeName: "THREE",
    subscriptionBehavior: "fixed_duration",
    subscriptionDiscountDurationMonths: 3,
    stripeCouponId: "coupon_rep",
  };

  test("does not re-apply repeating coupons (that would restart duration_in_months)", ({ expect }) => {
    expect(restoreLingeringDiscountUpdates({
      lingering: [repeating, forever],
      subscriptionDiscounts: [{ id: "di_rep", coupon: "coupon_rep" }],
    })).toEqual([
      { discount: "di_rep" },
      { coupon: "coupon_forever" },
    ]);
    expect(restoreLingeringDiscountUpdates({
      lingering: [repeating],
      subscriptionDiscounts: [],
    })).toBeNull();
    expect(restoreLingeringDiscountUpdates({
      lingering: [repeating, forever],
      subscriptionDiscounts: [
        { id: "di_rep", coupon: "coupon_rep" },
        { id: "di_for", coupon: "coupon_forever" },
      ],
    })).toBeNull();
    expect(restoreLingeringDiscountUpdates({
      lingering: [repeating, forever],
      subscriptionDiscounts: [
        { id: "di_rep", coupon: "coupon_rep" },
        { id: "di_merchant", coupon: "coupon_merchant" },
      ],
    })).toEqual([
      { discount: "di_merchant" },
      { discount: "di_rep" },
      { coupon: "coupon_forever" },
    ]);
    expect(() => restoreLingeringDiscountUpdates({
      lingering: [forever],
      subscriptionDiscounts: ["di_string"],
    })).toThrow(HexclaveAssertionError);
  });
});

import.meta.vitest?.describe("remainingDiscountsAfterRemovingCoupon", (test) => {
  test("keeps other stacked discounts by discount id so repeating duration is not restarted", ({ expect }) => {
    expect(remainingDiscountsAfterRemovingCoupon({
      subscriptionDiscounts: [
        { id: "di_x", coupon: "coupon_x" },
        { id: "di_merchant", coupon: "coupon_merchant" },
        { id: "di_y", coupon: "coupon_y" },
      ],
      couponIdToRemove: "coupon_x",
    })).toEqual([{ discount: "di_merchant" }, { discount: "di_y" }]);
    expect(remainingDiscountsAfterRemovingCoupon({
      subscriptionDiscounts: [{ id: "di_x", coupon: "coupon_x" }],
      couponIdToRemove: "coupon_x",
    })).toEqual([]);
    expect(() => remainingDiscountsAfterRemovingCoupon({
      subscriptionDiscounts: ["di_x"],
      couponIdToRemove: "coupon_x",
    })).toThrow(HexclaveAssertionError);
  });
});

import.meta.vitest?.describe("promoCodeIdsMetadataWithout", (test) => {
  test("strips one id and leaves the rest", ({ expect }) => {
    expect(promoCodeIdsMetadataWithout("promo-x,promo-y", "promo-x")).toBe("promo-y");
    expect(promoCodeIdsMetadataWithout("promo-x", "promo-x")).toBe("");
    expect(promoCodeIdsMetadataWithout(undefined, "promo-x")).toBe("");
  });
});

import.meta.vitest?.describe("inPlaceSubscriptionDiscountFields", (test) => {
  test("keeps merchant discount ids and only emits [] after walking the expanded list", ({ expect }) => {
    expect(inPlaceSubscriptionDiscountFields({
      promoAttach: { discounts: [{ coupon: "c_new" }] },
      subscriptionDiscounts: [
        { id: "di_hex", coupon: "c_hex" },
        { id: "di_merchant", coupon: "c_merchant" },
      ],
      hexclaveCouponIds: new Set(["c_hex"]),
    })).toEqual({ discounts: [{ discount: "di_merchant" }, { coupon: "c_new" }] });
    expect(inPlaceSubscriptionDiscountFields({
      promoAttach: {},
      subscriptionDiscounts: [
        { id: "di_hex", coupon: "c_hex" },
        { id: "di_merchant", coupon: "c_merchant" },
      ],
      hexclaveCouponIds: new Set(["c_hex"]),
    })).toEqual({ discounts: [{ discount: "di_merchant" }] });
    expect(inPlaceSubscriptionDiscountFields({
      promoAttach: {},
      subscriptionDiscounts: [{ id: "di_hex", coupon: "c_hex" }],
      hexclaveCouponIds: new Set(["c_hex"]),
    })).toEqual({ discounts: [] });
    expect(inPlaceSubscriptionDiscountFields({
      promoAttach: {},
      subscriptionDiscounts: [{ id: "di_merchant", coupon: "c_merchant" }],
      hexclaveCouponIds: new Set(),
    })).toEqual({});
    expect(() => inPlaceSubscriptionDiscountFields({
      promoAttach: {},
      subscriptionDiscounts: ["di_unexpanded"],
      hexclaveCouponIds: new Set(["c_hex"]),
    })).toThrow(HexclaveAssertionError);
  });
});

import.meta.vitest?.describe("createCheckoutSubscription", (test) => {
  const reservationPromo: PromoCodeRow = {
    id: "promo-1",
    tenancyId: "tenancy-1",
    codeName: "SAVE10",
    discountType: "percent",
    discountAmount: 10,
    currency: "USD",
    applicableProductIds: null,
    maxRedemptions: null,
    numRedemptions: 0,
    pendingRedemptions: 0,
    subscriptionBehavior: "first_payment",
    subscriptionDiscountDurationMonths: null,
    availabilityType: "always",
    startsAt: null,
    endsAt: null,
    pausedAt: null,
    endedAt: null,
    stripeCouponId: "coupon_1",
  };

  function fakeReservationPrisma(hooks: {
    onRelease?: () => void,
    onAttach?: () => void,
  }) {
    return {
      $queryRaw: async () => [{ id: "redemption-1" }],
      $executeRaw: async () => {
        hooks.onRelease?.();
        return 1;
      },
      promoCodeRedemption: {
        updateMany: async () => {
          hooks.onAttach?.();
          return { count: 1 };
        },
      },
    } as unknown as PrismaClientTransaction;
  }

  const reserveArgs = {
    tenancyId: "tenancy-1",
    customerId: "customer-1",
    customerType: "USER" as const,
    promos: [reservationPromo],
    purchaseKind: "subscription" as const,
  };

  test("releases and does not cancel when Stripe rejects the create", async ({ expect }) => {
    let released = 0;
    let canceled = 0;
    const stripe = {
      subscriptions: {
        create: async () => {
          throw new Error("stripe rejected");
        },
        cancel: async () => {
          canceled += 1;
        },
      },
    } as unknown as Stripe;
    await expect(createCheckoutSubscription({
      ...reserveArgs,
      prisma: fakeReservationPrisma({ onRelease: () => {
        released += 1;
      } }),
      stripe,
      params: { customer: "cus_1", items: [] },
      cardCollection: { type: "none" },
    })).rejects.toThrow("stripe rejected");
    expect(released).toBe(1);
    expect(canceled).toBe(0);
  });

  test("cancels then releases when bind fails after create", async ({ expect }) => {
    let released = 0;
    let canceled = 0;
    const stripe = {
      subscriptions: {
        create: async () => ({ id: "sub_1" }),
        cancel: async () => {
          canceled += 1;
        },
      },
    } as unknown as Stripe;
    await expect(createCheckoutSubscription({
      ...reserveArgs,
      prisma: fakeReservationPrisma({
        onRelease: () => {
          released += 1;
        },
        onAttach: () => {
          throw new Error("bind failed");
        },
      }),
      stripe,
      params: { customer: "cus_1", items: [] },
      cardCollection: { type: "none" },
    })).rejects.toThrow("bind failed");
    expect(canceled).toBe(1);
    expect(released).toBe(1);
  });

  test("does not release when cancel after attach fails", async ({ expect }) => {
    let released = 0;
    const stripe = {
      subscriptions: {
        create: async () => ({ id: "sub_1" }),
        cancel: async () => {
          throw new Error("cancel failed");
        },
      },
    } as unknown as Stripe;
    await expect(createCheckoutSubscription({
      ...reserveArgs,
      prisma: fakeReservationPrisma({
        onRelease: () => {
          released += 1;
        },
        onAttach: () => {
          throw new Error("bind failed");
        },
      }),
      stripe,
      params: { customer: "cus_1", items: [] },
      cardCollection: { type: "none" },
    })).rejects.toBeInstanceOf(HexclaveAssertionError);
    expect(released).toBe(0);
  });
});

import.meta.vitest?.describe("grantProductAndSucceedPromo", (test) => {
  const reservationPromo: PromoCodeRow = {
    id: "promo-1",
    tenancyId: "tenancy-1",
    codeName: "SAVE10",
    discountType: "percent",
    discountAmount: 10,
    currency: "USD",
    applicableProductIds: null,
    maxRedemptions: null,
    numRedemptions: 0,
    pendingRedemptions: 0,
    subscriptionBehavior: "first_payment",
    subscriptionDiscountDurationMonths: null,
    availabilityType: "always",
    startsAt: null,
    endsAt: null,
    pausedAt: null,
    endedAt: null,
    stripeCouponId: "coupon_1",
  };

  function fakePrisma(options: {
    boundPending?: Array<{ id: string, promoCodeId: string }>,
    alreadySucceeded?: Array<{ promoCodeId: string }>,
    onUpdateMany?: () => void,
  } = {}) {
    let executeRawCalls = 0;
    let grantIdentityLookups = 0;
    const prisma = {
      $queryRaw: async () => [{ id: "redemption-1" }],
      $executeRaw: async () => {
        executeRawCalls += 1;
        return 1;
      },
      promoCodeRedemption: {
        findMany: async (args: { where?: { OR?: unknown, status?: string } }) => {
          if (args.where?.OR != null) {
            grantIdentityLookups += 1;
            return options.boundPending ?? [];
          }
          if (args.where?.status === "succeeded") {
            return options.alreadySucceeded ?? [];
          }
          return [{ id: "redemption-1" }];
        },
        updateMany: async () => {
          options.onUpdateMany?.();
          return { count: 1 };
        },
      },
    } as unknown as PrismaClientTransaction;
    return {
      prisma,
      executeRawCalls: () => executeRawCalls,
      grantIdentityLookups: () => grantIdentityLookups,
    };
  }

  test("releases when grant throws, and does not release after a successful grant", async ({ expect }) => {
    const thrown = fakePrisma();
    await expect(grantProductAndSucceedPromo({
      prisma: thrown.prisma,
      tenancyId: "tenancy-1",
      customerId: "customer-1",
      customerType: "USER",
      promos: [reservationPromo],
      purchaseKind: "one_time",
      grant: async () => {
        throw new Error("grant failed");
      },
    })).rejects.toThrow("grant failed");
    expect(thrown.executeRawCalls()).toBe(1);

    let stamped = false;
    const granted = fakePrisma({
      onUpdateMany: () => {
        stamped = true;
      },
    });
    await expect(grantProductAndSucceedPromo({
      prisma: granted.prisma,
      tenancyId: "tenancy-1",
      customerId: "customer-1",
      customerType: "USER",
      promos: [reservationPromo],
      purchaseKind: "one_time",
      grant: async () => ({ oneTimePurchaseId: "purchase-1" }),
    })).resolves.toBeUndefined();
    expect(stamped).toBe(true);
    expect(granted.executeRawCalls()).toBe(1);
  });

  test("retries succeed pending rows that already have a grant identity without granting again", async ({ expect }) => {
    let grantCalls = 0;
    const retry = fakePrisma({
      boundPending: [{ id: "redemption-1", promoCodeId: "promo-1" }],
    });
    await expect(grantProductAndSucceedPromo({
      prisma: retry.prisma,
      tenancyId: "tenancy-1",
      customerId: "customer-1",
      customerType: "USER",
      promos: [reservationPromo],
      purchaseKind: "one_time",
      grant: async () => {
        grantCalls += 1;
        return { oneTimePurchaseId: "purchase-1" };
      },
    })).resolves.toBeUndefined();
    expect(grantCalls).toBe(0);
    expect(retry.grantIdentityLookups()).toBe(1);
    expect(retry.executeRawCalls()).toBe(1);
  });

  test("refuses to grant again when only some requested promos have a grant identity", async ({ expect }) => {
    let grantCalls = 0;
    const secondPromo: PromoCodeRow = { ...reservationPromo, id: "promo-2", codeName: "SAVE20" };
    const partial = fakePrisma({
      boundPending: [{ id: "redemption-1", promoCodeId: "promo-1" }],
      alreadySucceeded: [],
    });
    await expect(grantProductAndSucceedPromo({
      prisma: partial.prisma,
      tenancyId: "tenancy-1",
      customerId: "customer-1",
      customerType: "USER",
      promos: [reservationPromo, secondPromo],
      purchaseKind: "one_time",
      grant: async () => {
        grantCalls += 1;
        return { oneTimePurchaseId: "purchase-1" };
      },
    })).rejects.toThrow("refusing to grant again");
    expect(grantCalls).toBe(0);
    expect(partial.executeRawCalls()).toBe(1);
  });

  test("retries succeed when remaining requested promos already succeeded", async ({ expect }) => {
    let grantCalls = 0;
    const secondPromo: PromoCodeRow = { ...reservationPromo, id: "promo-2", codeName: "SAVE20" };
    const retry = fakePrisma({
      boundPending: [{ id: "redemption-1", promoCodeId: "promo-1" }],
      alreadySucceeded: [{ promoCodeId: "promo-2" }],
    });
    await expect(grantProductAndSucceedPromo({
      prisma: retry.prisma,
      tenancyId: "tenancy-1",
      customerId: "customer-1",
      customerType: "USER",
      promos: [reservationPromo, secondPromo],
      purchaseKind: "one_time",
      grant: async () => {
        grantCalls += 1;
        return { oneTimePurchaseId: "purchase-1" };
      },
    })).resolves.toBeUndefined();
    expect(grantCalls).toBe(0);
    expect(retry.executeRawCalls()).toBe(1);
  });
});

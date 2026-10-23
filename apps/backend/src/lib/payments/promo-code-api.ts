import type { PromoCode } from "@/generated/prisma/client";
import {
  derivePromoCodeStatus,
  formatDiscountLabel,
  parseApplicableProductIds,
  type PromoCodeRow,
  type PromoCodeStatus,
} from "@/lib/payments/promo-codes";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

export function toPromoCodeRow(promo: PromoCode): PromoCodeRow {
  return {
    id: promo.id,
    tenancyId: promo.tenancyId,
    codeName: promo.codeName,
    discountType: promo.discountType,
    discountAmount: promo.discountAmount,
    currency: promo.currency,
    applicableProductIds: promo.applicableProductIds,
    maxRedemptions: promo.maxRedemptions,
    numRedemptions: promo.numRedemptions,
    pendingRedemptions: promo.pendingRedemptions,
    subscriptionBehavior: promo.subscriptionBehavior,
    subscriptionDiscountDurationMonths: promo.subscriptionDiscountDurationMonths,
    availabilityType: promo.availabilityType,
    startsAt: promo.startsAt,
    endsAt: promo.endsAt,
    pausedAt: promo.pausedAt,
    endedAt: promo.endedAt,
    stripeCouponId: promo.stripeCouponId,
  };
}

export function formatPromoAvailability(promo: PromoCodeRow): string {
  if (promo.availabilityType === "always") return "Always";
  const startsAt = promo.startsAt ?? throwErr("between_dates promo is missing startsAt");
  const endsAt = promo.endsAt ?? throwErr("between_dates promo is missing endsAt");
  return `${formatPromoDate(startsAt)} – ${formatPromoDate(endsAt)}`;
}

export function formatPromoDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function statusDetailForPromo(promo: PromoCodeRow, now: Date = new Date()): string | null {
  const status = derivePromoCodeStatus(promo, now);
  switch (status) {
    case "scheduled": {
      return promo.startsAt != null ? `Starts ${formatPromoDate(promo.startsAt)}` : null;
    }
    case "paused": {
      return promo.pausedAt != null ? `Since ${formatPromoDate(promo.pausedAt)}` : null;
    }
    case "expired": {
      if (promo.endsAt != null && promo.endsAt < now) return `Since ${formatPromoDate(promo.endsAt)}`;
      return "Since redemption limit";
    }
    case "ended": {
      return promo.endedAt != null ? `Since ${formatPromoDate(promo.endedAt)}` : null;
    }
    case "active": {
      return null;
    }
    default: {
      throwErr(`Unknown promo status ${status}`);
    }
  }
}

export function productsLabelForPromo(promo: PromoCodeRow, productNames: Map<string, string>): string {
  const ids = parseApplicableProductIds(promo.applicableProductIds);
  if (ids == null) return "All products";
  return ids.map((id) => productNames.get(id) ?? id).join(", ");
}

export function serializePromoCode(options: {
  promo: PromoCodeRow,
  productNames: Map<string, string>,
  hasActiveSubscriptionRedemptions: boolean,
  now?: Date,
}) {
  const now = options.now ?? new Date();
  const status: PromoCodeStatus = derivePromoCodeStatus(options.promo, now);
  return {
    id: options.promo.id,
    code_name: options.promo.codeName,
    status,
    status_detail: statusDetailForPromo(options.promo, now),
    discount_type: options.promo.discountType,
    discount_amount: Number(options.promo.discountAmount.toString()),
    discount_label: formatDiscountLabel(options.promo.discountType, options.promo.discountAmount),
    products_label: productsLabelForPromo(options.promo, options.productNames),
    applicable_product_ids: parseApplicableProductIds(options.promo.applicableProductIds),
    num_redemptions: options.promo.numRedemptions,
    max_redemptions: options.promo.maxRedemptions,
    availability: formatPromoAvailability(options.promo),
    availability_type: options.promo.availabilityType,
    starts_at_millis: options.promo.startsAt?.getTime() ?? null,
    ends_at_millis: options.promo.endsAt?.getTime() ?? null,
    paused_at_millis: options.promo.pausedAt?.getTime() ?? null,
    ended_at_millis: options.promo.endedAt?.getTime() ?? null,
    subscription_behavior: options.promo.subscriptionBehavior,
    subscription_discount_duration_months: options.promo.subscriptionDiscountDurationMonths,
    has_active_subscription_redemptions: options.hasActiveSubscriptionRedemptions,
  };
}

export function catalogProductNames(products: Record<string, { displayName?: string } | undefined>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [id, product] of Object.entries(products)) {
    names.set(id, product?.displayName ?? id);
  }
  return names;
}

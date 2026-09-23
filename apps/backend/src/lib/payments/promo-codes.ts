import { Prisma, type CustomerType, type PromoCodeRedemptionPurchaseKind } from "@/generated/prisma/client";
import type { PrismaClientTransaction } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { getStripeOneTimeMinAmount } from "@hexclave/shared/dist/payments/stripe-limits";
import { moneyAmountSchema } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { moneyAmountToStripeUnits } from "@hexclave/shared/dist/utils/currencies";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import Stripe from "stripe";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

// Amount-off is DECIMAL(10, 4) (max 999999.9999). Cap at $999,999 — the largest
// integer the column can store, and this repo's Stripe charge max (999_999 * 100
// cents). Do not cap at 999999.9999: toFixed(2) rounds that to 1000000.
export const MAX_PROMO_AMOUNT_DISCOUNT_USD = 999_999;

export type PromoCodeStatus = "active" | "scheduled" | "paused" | "expired" | "ended";
export type PromoCodeDiscountType = "percent" | "amount";
export type PromoCodeSubscriptionBehavior = "first_payment" | "fixed_duration" | "forever";
export type PromoCodeAvailabilityType = "always" | "between_dates";

export type PromoCodeRow = {
  id: string,
  tenancyId: string,
  codeName: string,
  discountType: PromoCodeDiscountType,
  discountAmount: Prisma.Decimal | string | number,
  currency: string,
  applicableProductIds: Prisma.JsonValue | null,
  maxRedemptions: number | null,
  numRedemptions: number,
  pendingRedemptions: number,
  subscriptionBehavior: PromoCodeSubscriptionBehavior,
  subscriptionDiscountDurationMonths: number | null,
  availabilityType: PromoCodeAvailabilityType,
  startsAt: Date | null,
  endsAt: Date | null,
  pausedAt: Date | null,
  endedAt: Date | null,
  stripeCouponId: string,
};

export function normalizePromoCodeName(codeName: string): string {
  return codeName.trim().toUpperCase();
}

export function parseApplicableProductIds(value: Prisma.JsonValue | null): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new HexclaveAssertionError("PromoCode.applicableProductIds must be null or a JSON array of product IDs", { value });
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new HexclaveAssertionError("PromoCode.applicableProductIds entries must be non-empty strings", { value });
    }
    ids.push(entry);
  }
  return ids;
}

/**
 * `endedAt` is a merchant action (they ended the code). `endsAt` is the
 * availability window. A code whose window has passed is `"expired"`, not
 * `"ended"`, unless the merchant also set `endedAt`.
 */
export function derivePromoCodeStatus(promo: PromoCodeRow, now: Date = new Date()): PromoCodeStatus {
  if (promo.endedAt != null) return "ended";
  if (isPermanentlyExpired(promo, now)) return "expired";
  if (promo.pausedAt != null) return "paused";
  if (promo.startsAt != null && promo.startsAt > now) return "scheduled";
  return "active";
}

export function isRedemptionCapacityConsumed(promo: Pick<PromoCodeRow, "maxRedemptions" | "numRedemptions" | "pendingRedemptions">): boolean {
  return promo.maxRedemptions != null && promo.numRedemptions + promo.pendingRedemptions >= promo.maxRedemptions;
}

export function isPermanentlyExpired(promo: PromoCodeRow, now: Date = new Date()): boolean {
  if (promo.endsAt != null && promo.endsAt < now) return true;
  return isRedemptionCapacityConsumed(promo);
}

export function canPausePromoCode(promo: PromoCodeRow, now: Date = new Date()): boolean {
  return promo.pausedAt == null && promo.endedAt == null && !isPermanentlyExpired(promo, now);
}

export function canResumePromoCode(promo: PromoCodeRow, now: Date = new Date()): boolean {
  return promo.pausedAt != null && promo.endedAt == null && !isPermanentlyExpired(promo, now);
}

export function canEndPromoCode(promo: PromoCodeRow): boolean {
  return promo.endedAt == null;
}

export function throwIfPromoNotRedeemable(promo: PromoCodeRow, now: Date = new Date()): void {
  const status = derivePromoCodeStatus(promo, now);
  switch (status) {
    case "ended": {
      throw new KnownErrors.PromoCodeEnded(promo.codeName);
    }
    case "expired": {
      // Admin status lumps date-window end and sold-out capacity into
      // "expired". Redeemers get the specific KnownError: a passed window is
      // expired; a consumed max_redemptions is a limit, not a date expiry.
      // Window end wins when both are true — the code is no longer in its
      // availability window regardless of remaining slots.
      if (promo.endsAt != null && promo.endsAt < now) {
        throw new KnownErrors.PromoCodeExpired(promo.codeName);
      }
      if (isRedemptionCapacityConsumed(promo)) {
        throw new KnownErrors.PromoCodeRedemptionLimitReached(promo.codeName);
      }
      throw new HexclaveAssertionError("Promo status is expired without a window end or redemption limit", { promoId: promo.id });
    }
    case "paused": {
      throw new KnownErrors.PromoCodePaused(promo.codeName);
    }
    case "scheduled": {
      throw new KnownErrors.PromoCodeNotYetAvailable(promo.codeName);
    }
    case "active": {
      return;
    }
    default: {
      throw new HexclaveAssertionError("Unknown promo status", { status });
    }
  }
}

export function promoAppliesToProduct(promo: PromoCodeRow, productId: string | null): boolean {
  const applicable = parseApplicableProductIds(promo.applicableProductIds);
  // All-products codes apply to catalog and inline checkouts. Product-restricted
  // codes cannot match an inline product (no catalog productId).
  if (applicable == null) return true;
  if (productId == null) return false;
  return applicable.includes(productId);
}

function promoDiscountDecimal(amount: Prisma.Decimal | string | number): Prisma.Decimal {
  // Parse from the decimal string. `Number("79.99") * 100` is 7998.999…;
  // never convert money through IEEE float.
  const parsed = new Prisma.Decimal(amount.toString());
  if (!parsed.isFinite()) {
    throw new HexclaveAssertionError("PromoCode.discountAmount is not a finite decimal", { amount });
  }
  return parsed;
}

function isUsdMoneyAmount(value: string): value is MoneyAmount {
  return moneyAmountSchema(USD_CURRENCY).defined().isValidSync(value);
}

function usdMajorUnitsToStripeUnits(amount: Prisma.Decimal | string | number): number {
  const moneyString = promoDiscountDecimal(amount).toFixed(USD_CURRENCY.decimals);
  if (!isUsdMoneyAmount(moneyString)) {
    throw new HexclaveAssertionError("PromoCode discountAmount is not a valid USD money amount", { amount: moneyString });
  }
  return moneyAmountToStripeUnits(moneyString, USD_CURRENCY);
}

export function applyPromoDiscountToStripeUnits(options: {
  remainingStripeUnits: number,
  discountType: PromoCodeDiscountType,
  discountAmount: Prisma.Decimal | string | number,
}): number {
  if (options.remainingStripeUnits < 0) {
    throw new HexclaveAssertionError("remainingStripeUnits must be non-negative", { remainingStripeUnits: options.remainingStripeUnits });
  }
  const amount = promoDiscountDecimal(options.discountAmount);
  if (options.discountType === "percent") {
    const percentHundredths = Number.parseInt(amount.mul(100).toFixed(0), 10);
    if (!Number.isFinite(percentHundredths)) {
      throw new HexclaveAssertionError("PromoCode percent discount is not a finite number", { amount: amount.toString() });
    }
    const discount = Math.round(options.remainingStripeUnits * percentHundredths / 10000);
    return Math.max(0, options.remainingStripeUnits - discount);
  }
  return Math.max(0, options.remainingStripeUnits - usdMajorUnitsToStripeUnits(amount));
}

export type ValidatedPromoCode = {
  promo: PromoCodeRow,
  netStripeUnitsAfter: number,
};

export function validatePromoCodesForPurchase(options: {
  promosByName: Map<string, PromoCodeRow>,
  codeNames: string[],
  productId: string | null,
  originalStripeUnits: number,
  allowStacking: boolean,
  isOneTime: boolean,
  now?: Date,
}): { originalStripeUnits: number, netStripeUnits: number, recurringStripeUnits: number, applied: ValidatedPromoCode[] } {
  const now = options.now ?? new Date();
  if (options.codeNames.length > 1 && !options.allowStacking) {
    throw new KnownErrors.PromoCodeStackingNotAllowed();
  }
  if (options.originalStripeUnits === 0 && options.codeNames.length > 0) {
    throw new KnownErrors.PromoCodeNothingToDiscount();
  }

  let remaining = options.originalStripeUnits;
  const applied: ValidatedPromoCode[] = [];
  const seen = new Set<string>();
  const resolved: PromoCodeRow[] = [];

  for (const rawName of options.codeNames) {
    const codeName = normalizePromoCodeName(rawName);
    if (codeName.length === 0) {
      throw new KnownErrors.PromoCodeInvalid("Promo code name is required.");
    }
    if (seen.has(codeName)) {
      throw new KnownErrors.PromoCodeInvalid(`Promo code ${JSON.stringify(codeName)} is already applied.`);
    }
    seen.add(codeName);

    const promo = options.promosByName.get(codeName);
    if (promo == null) {
      throw new KnownErrors.PromoCodeNotFound(codeName);
    }
    throwIfPromoNotRedeemable(promo, now);
    if (!promoAppliesToProduct(promo, options.productId)) {
      throw new KnownErrors.PromoCodeNotApplicableToProduct(codeName);
    }
    resolved.push(promo);
  }

  for (const promo of orderPromosForStacking(resolved)) {
    remaining = applyPromoDiscountToStripeUnits({
      remainingStripeUnits: remaining,
      discountType: promo.discountType,
      discountAmount: promo.discountAmount,
    });
    applied.push({ promo, netStripeUnitsAfter: remaining });
  }

  // One-time charges: $0 is allowed (full discount); any leftover below $0.50
  // is rejected. Recurring has no floor. See stripe-limits.ts for the processor
  // wording we do not show to customers.
  if (options.isOneTime && remaining > 0) {
    const minStripeUnits = usdMajorUnitsToStripeUnits(getStripeOneTimeMinAmount("USD"));
    if (remaining < minStripeUnits) {
      throw new KnownErrors.PromoCodeDiscountBelowMinimum();
    }
  }

  return {
    originalStripeUnits: options.originalStripeUnits,
    netStripeUnits: remaining,
    recurringStripeUnits: options.isOneTime
      ? remaining
      : applyOrderedPromosToStripeUnits(
        applied.map((entry) => entry.promo).filter(isLingeringSubscriptionPromo),
        options.originalStripeUnits,
      ),
    applied,
  };
}

export type CreatePromoCodeInput = {
  codeName: string,
  discountType: PromoCodeDiscountType,
  discountAmount: number,
  applicableProductIds: string[] | null,
  maxRedemptions: number | null,
  subscriptionBehavior: PromoCodeSubscriptionBehavior,
  subscriptionDiscountDurationMonths: number | null,
  availabilityType: PromoCodeAvailabilityType,
  startsAt: Date | null,
  endsAt: Date | null,
};

export function validateCreatePromoCodeInput(input: CreatePromoCodeInput): CreatePromoCodeInput {
  const codeName = normalizePromoCodeName(input.codeName);
  if (codeName.length === 0) {
    throw new KnownErrors.PromoCodeInvalid("Codename is required.");
  }
  if (!Number.isFinite(input.discountAmount) || input.discountAmount <= 0) {
    throw new KnownErrors.PromoCodeInvalid("Discount must be greater than 0.");
  }
  if (input.discountType === "percent" && input.discountAmount > 100) {
    throw new KnownErrors.PromoCodeInvalid("Percentage discounts cannot be greater than 100.");
  }
  if (input.discountType === "amount") {
    if (input.discountAmount > MAX_PROMO_AMOUNT_DISCOUNT_USD) {
      throw new KnownErrors.PromoCodeInvalid("Amount discounts cannot be greater than $999,999.");
    }
    const amount = new Prisma.Decimal(input.discountAmount);
    if (!amount.eq(amount.toDecimalPlaces(2))) {
      throw new KnownErrors.PromoCodeInvalid("Amount discounts must use at most 2 decimal places.");
    }
  }
  if (input.applicableProductIds != null && input.applicableProductIds.length === 0) {
    throw new KnownErrors.PromoCodeInvalid("Select at least one product, or apply to all products.");
  }
  if (input.maxRedemptions != null && (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1)) {
    throw new KnownErrors.PromoCodeInvalid("Maximum redemptions must be a positive integer or unlimited.");
  }
  if (input.subscriptionBehavior === "fixed_duration") {
    if (input.subscriptionDiscountDurationMonths == null || !Number.isInteger(input.subscriptionDiscountDurationMonths) || input.subscriptionDiscountDurationMonths < 1) {
      throw new KnownErrors.PromoCodeInvalid("Fixed-duration subscription discounts require a number of months.");
    }
  } else if (input.subscriptionDiscountDurationMonths != null) {
    throw new KnownErrors.PromoCodeInvalid("Subscription discount duration months is only valid for a fixed-duration promo.");
  }
  if (input.availabilityType === "always") {
    if (input.startsAt != null || input.endsAt != null) {
      throw new KnownErrors.PromoCodeInvalid("Always-available promo codes cannot have a start or end date.");
    }
  } else {
    if (input.startsAt == null || input.endsAt == null) {
      throw new KnownErrors.PromoCodeInvalid("A date-window promo code requires both a start and an end date.");
    }
    if (input.startsAt >= input.endsAt) {
      throw new KnownErrors.PromoCodeInvalid("Promo code start date must be before the end date.");
    }
  }
  return {
    ...input,
    codeName,
  };
}

export function stripeCouponCreateParamsFromPromo(tenancyId: string, input: CreatePromoCodeInput): Stripe.CouponCreateParams {
  const validated = validateCreatePromoCodeInput(input);
  const params: Stripe.CouponCreateParams = {
    name: validated.codeName,
    duration: validated.subscriptionBehavior === "first_payment"
      ? "once"
      : validated.subscriptionBehavior === "forever"
        ? "forever"
        : "repeating",
    metadata: {
      tenancyId,
      codeName: validated.codeName,
    },
  };
  if (validated.discountType === "percent") {
    params.percent_off = validated.discountAmount;
  } else {
    params.amount_off = usdMajorUnitsToStripeUnits(validated.discountAmount);
    params.currency = "usd";
  }
  if (validated.subscriptionBehavior === "fixed_duration") {
    // Stripe starts this clock when the coupon is first applied. We apply
    // after any free-trial $0 invoice, so N months = first real charge + N-1
    // further cycles.
    params.duration_in_months = validated.subscriptionDiscountDurationMonths
      ?? throwErr("fixed_duration requires subscriptionDiscountDurationMonths after validation");
  }
  return params;
}

export function stripeCouponIdempotencyKey(tenancyId: string, codeName: string): string {
  return `hexclave-promo-coupon:${tenancyId}:${normalizePromoCodeName(codeName)}`;
}

export function mapStripeCouponCreateError(error: unknown): KnownErrors["PromoCodeStripeCreateFailed"] {
  if (error instanceof Stripe.errors.StripeIdempotencyError) {
    return new KnownErrors.PromoCodeStripeCreateFailed("A promo code with this name is already being created. Try again with a different name.");
  }
  // Only merchant-caused Stripe failures become a 400. Connection, rate-limit,
  // and API errors must stay internal 500s and must not leak Stripe text.
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return new KnownErrors.PromoCodeStripeCreateFailed("Stripe rejected the coupon. Check the discount values and try again.");
  }
  throw error;
}

/**
 * Must stay aligned with the reservation UPDATE WHERE in
 * `reserveAndCreatePendingRedemption`. Windowed codes are reservable while
 * now is inside [startsAt, endsAt]; always-available codes have null dates.
 */
export function promoIsWithinReservationWindow(promo: Pick<PromoCodeRow, "startsAt" | "endsAt">, now: Date): boolean {
  if (promo.startsAt != null && promo.startsAt > now) return false;
  if (promo.endsAt != null && promo.endsAt < now) return false;
  return true;
}

export async function reserveAndCreatePendingRedemption(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  promoCodeId: string,
  customerId: string,
  customerType: CustomerType,
  purchaseKind: PromoCodeRedemptionPurchaseKind,
  stripePaymentIntentId?: string,
  stripeSubscriptionId?: string,
}): Promise<string | null> {
  // One statement: increment pending only when the code is still redeemable
  // (pause/end/window/capacity), then insert the pending row from that UPDATE.
  // If the UPDATE matches 0 rows the INSERT is a no-op. startsAt/endsAt use
  // the same predicates as promoIsWithinReservationWindow / throwIfPromoNotRedeemable.
  const rows = await options.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH reserved AS (
      UPDATE "PromoCode"
      SET "pendingRedemptions" = "pendingRedemptions" + 1
      WHERE "tenancyId" = ${options.tenancyId}::uuid
        AND "id" = ${options.promoCodeId}::uuid
        AND "endedAt" IS NULL
        AND "pausedAt" IS NULL
        AND ("startsAt" IS NULL OR "startsAt" <= NOW())
        AND ("endsAt" IS NULL OR "endsAt" >= NOW())
        AND (
          "maxRedemptions" IS NULL
          OR "numRedemptions" + "pendingRedemptions" < "maxRedemptions"
        )
      RETURNING "id", "tenancyId"
    )
    INSERT INTO "PromoCodeRedemption" (
      "id",
      "tenancyId",
      "promoCodeId",
      "customerId",
      "customerType",
      "status",
      "purchaseKind",
      "stripePaymentIntentId",
      "stripeSubscriptionId",
      "createdAt"
    )
    SELECT
      gen_random_uuid(),
      reserved."tenancyId",
      reserved."id",
      ${options.customerId},
      ${options.customerType}::"CustomerType",
      'pending'::"PromoCodeRedemptionStatus",
      ${options.purchaseKind}::"PromoCodeRedemptionPurchaseKind",
      ${options.stripePaymentIntentId ?? null},
      ${options.stripeSubscriptionId ?? null},
      NOW()
    FROM reserved
    RETURNING "id"::text AS id
  `);
  return rows[0]?.id ?? null;
}

export async function succeedPendingRedemptionRow(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  redemptionId: string,
  oneTimePurchaseId?: string,
  subscriptionId?: string,
}): Promise<void> {
  await options.prisma.$executeRaw(Prisma.sql`
    WITH updated AS (
      UPDATE "PromoCodeRedemption"
      SET
        status = 'succeeded'::"PromoCodeRedemptionStatus"
        ${options.oneTimePurchaseId != null ? Prisma.sql`, "oneTimePurchaseId" = ${options.oneTimePurchaseId}::uuid` : Prisma.empty}
        ${options.subscriptionId != null ? Prisma.sql`, "subscriptionId" = ${options.subscriptionId}::uuid` : Prisma.empty}
      WHERE "tenancyId" = ${options.tenancyId}::uuid
        AND "id" = ${options.redemptionId}::uuid
        AND status = 'pending'::"PromoCodeRedemptionStatus"
      RETURNING "promoCodeId", "tenancyId"
    )
    UPDATE "PromoCode" AS p
    SET
      "pendingRedemptions" = GREATEST(p."pendingRedemptions" - 1, 0),
      "numRedemptions" = p."numRedemptions" + 1
    FROM updated
    WHERE p."tenancyId" = updated."tenancyId"
      AND p."id" = updated."promoCodeId"
  `);
}

export async function releasePendingRedemptionRow(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  redemptionId: string,
}): Promise<void> {
  await options.prisma.$executeRaw(Prisma.sql`
    WITH updated AS (
      UPDATE "PromoCodeRedemption"
      SET status = 'released'::"PromoCodeRedemptionStatus"
      WHERE "tenancyId" = ${options.tenancyId}::uuid
        AND "id" = ${options.redemptionId}::uuid
        AND status = 'pending'::"PromoCodeRedemptionStatus"
      RETURNING "promoCodeId", "tenancyId"
    )
    UPDATE "PromoCode" AS p
    SET "pendingRedemptions" = GREATEST(p."pendingRedemptions" - 1, 0)
    FROM updated
    WHERE p."tenancyId" = updated."tenancyId"
      AND p."id" = updated."promoCodeId"
  `);
}

export function couponDiscountsFromPromos(promos: PromoCodeRow[]): Stripe.SubscriptionCreateParams.Discount[] {
  return orderPromosForStacking(promos).map((promo) => ({ coupon: promo.stripeCouponId }));
}

/**
 * Mixed percent + amount-off discounts do not commute. Apply every percent
 * first (they commute with each other), then every amount-off, so the
 * customer's typed order cannot change the charged price. Stripe applies
 * stacked coupons in attach order, so this is also the order we send.
 */
export function isLingeringSubscriptionPromo(promo: { subscriptionBehavior: PromoCodeSubscriptionBehavior }): boolean {
  return promo.subscriptionBehavior === "forever" || promo.subscriptionBehavior === "fixed_duration";
}

export function applyOrderedPromosToStripeUnits(promos: PromoCodeRow[], originalStripeUnits: number): number {
  let remaining = originalStripeUnits;
  for (const promo of orderPromosForStacking(promos)) {
    remaining = applyPromoDiscountToStripeUnits({
      remainingStripeUnits: remaining,
      discountType: promo.discountType,
      discountAmount: promo.discountAmount,
    });
  }
  return remaining;
}

export function orderPromosForStacking(promos: PromoCodeRow[]): PromoCodeRow[] {
  const percents: PromoCodeRow[] = [];
  const amounts: PromoCodeRow[] = [];
  for (const promo of promos) {
    if (promo.discountType === "percent") {
      percents.push(promo);
    } else {
      amounts.push(promo);
    }
  }
  return [...percents, ...amounts];
}

export function formatDiscountLabel(discountType: PromoCodeDiscountType, discountAmount: Prisma.Decimal | string | number): string {
  const amount = promoDiscountDecimal(discountAmount);
  if (discountType === "percent") {
    return `${trimTrailingZerosFromDecimalString(amount.toFixed(4))}% off`;
  }
  // Amount-off is charged at Stripe's 2 USD decimals, so the label matches what we send.
  return `$${trimTrailingZerosFromDecimalString(amount.toFixed(USD_CURRENCY.decimals))} off`;
}

function trimTrailingZerosFromDecimalString(value: string): string {
  return value.replace(/\.?0+$/, "");
}

import.meta.vitest?.describe("derivePromoCodeStatus", (test) => {
  const base = (): PromoCodeRow => ({
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
  });

  const now = new Date("2026-06-15T00:00:00.000Z");

  test("ended wins over everything", ({ expect }) => {
    expect(derivePromoCodeStatus({
      ...base(),
      endedAt: new Date("2026-01-01"),
      pausedAt: new Date("2026-01-02"),
      endsAt: new Date("2026-01-03"),
      availabilityType: "between_dates",
      startsAt: new Date("2025-01-01"),
    }, now)).toBe("ended");
  });

  test("window expiry while paused is expired", ({ expect }) => {
    expect(derivePromoCodeStatus({
      ...base(),
      availabilityType: "between_dates",
      startsAt: new Date("2026-01-01"),
      endsAt: new Date("2026-01-10"),
      pausedAt: new Date("2026-01-05"),
    }, now)).toBe("expired");
  });

  test("redemption limit is expired", ({ expect }) => {
    expect(derivePromoCodeStatus({
      ...base(),
      maxRedemptions: 10,
      numRedemptions: 8,
      pendingRedemptions: 2,
    }, now)).toBe("expired");
  });

  test("paused when not expired", ({ expect }) => {
    expect(derivePromoCodeStatus({
      ...base(),
      pausedAt: new Date("2026-06-01"),
    }, now)).toBe("paused");
  });

  test("scheduled when starts in the future", ({ expect }) => {
    expect(derivePromoCodeStatus({
      ...base(),
      availabilityType: "between_dates",
      startsAt: new Date("2026-12-01"),
      endsAt: new Date("2026-12-31"),
    }, now)).toBe("scheduled");
  });

  test("active otherwise", ({ expect }) => {
    expect(derivePromoCodeStatus(base(), now)).toBe("active");
  });

  test("sold-out codes throw redemption-limit, not expired", ({ expect }) => {
    expect(() => throwIfPromoNotRedeemable({
      ...base(),
      maxRedemptions: 1,
      numRedemptions: 1,
    }, now)).toThrow(KnownErrors.PromoCodeRedemptionLimitReached);
    expect(() => throwIfPromoNotRedeemable({
      ...base(),
      maxRedemptions: 1,
      pendingRedemptions: 1,
    }, now)).toThrow(KnownErrors.PromoCodeRedemptionLimitReached);
  });

  test("window end throws expired even when capacity is also consumed", ({ expect }) => {
    expect(() => throwIfPromoNotRedeemable({
      ...base(),
      availabilityType: "between_dates",
      startsAt: new Date("2026-01-01"),
      endsAt: new Date("2026-01-10"),
      maxRedemptions: 1,
      numRedemptions: 1,
    }, now)).toThrow(KnownErrors.PromoCodeExpired);
  });

  test("reservation window allows in-range dates and rejects before start / after end", ({ expect }) => {
    expect(promoIsWithinReservationWindow(base(), now)).toBe(true);
    expect(promoIsWithinReservationWindow({
      startsAt: new Date("2026-06-01"),
      endsAt: new Date("2026-06-30"),
    }, now)).toBe(true);
    expect(promoIsWithinReservationWindow({
      startsAt: new Date("2026-06-15"),
      endsAt: new Date("2026-06-30"),
    }, now)).toBe(true);
    expect(promoIsWithinReservationWindow({
      startsAt: new Date("2026-06-16"),
      endsAt: new Date("2026-06-30"),
    }, now)).toBe(false);
    expect(promoIsWithinReservationWindow({
      startsAt: new Date("2026-01-01"),
      endsAt: new Date("2026-06-14"),
    }, now)).toBe(false);
  });

  test("pause only when not already paused, ended, or expired", ({ expect }) => {
    expect(canPausePromoCode(base(), now)).toBe(true);
    expect(canPausePromoCode({ ...base(), pausedAt: new Date("2026-06-01") }, now)).toBe(false);
    expect(canPausePromoCode({ ...base(), endedAt: new Date("2026-06-01") }, now)).toBe(false);
    expect(canPausePromoCode({
      ...base(),
      availabilityType: "between_dates",
      startsAt: new Date("2026-01-01"),
      endsAt: new Date("2026-01-10"),
    }, now)).toBe(false);
  });

  test("resume only when paused and not ended or expired", ({ expect }) => {
    expect(canResumePromoCode(base(), now)).toBe(false);
    expect(canResumePromoCode({ ...base(), pausedAt: new Date("2026-06-01") }, now)).toBe(true);
    expect(canResumePromoCode({
      ...base(),
      pausedAt: new Date("2026-01-05"),
      endedAt: new Date("2026-06-01"),
    }, now)).toBe(false);
    expect(canResumePromoCode({
      ...base(),
      pausedAt: new Date("2026-01-05"),
      availabilityType: "between_dates",
      startsAt: new Date("2026-01-01"),
      endsAt: new Date("2026-01-10"),
    }, now)).toBe(false);
  });
});

import.meta.vitest?.describe("validateCreatePromoCodeInput", (test) => {
  const input = {
    codeName: "SAVE10",
    discountType: "percent" as const,
    discountAmount: 10,
    applicableProductIds: null,
    maxRedemptions: null,
    subscriptionBehavior: "first_payment" as const,
    subscriptionDiscountDurationMonths: null,
    availabilityType: "always" as const,
    startsAt: null,
    endsAt: null,
  };

  test("rejects percent over 100 and amount over $999,999", ({ expect }) => {
    expect(() => validateCreatePromoCodeInput({ ...input, discountAmount: 101 })).toThrowError(KnownErrors.PromoCodeInvalid);
    expect(() => validateCreatePromoCodeInput({
      ...input,
      discountType: "amount",
      discountAmount: MAX_PROMO_AMOUNT_DISCOUNT_USD + 1,
    })).toThrowError(KnownErrors.PromoCodeInvalid);
    expect(validateCreatePromoCodeInput({
      ...input,
      discountType: "amount",
      discountAmount: MAX_PROMO_AMOUNT_DISCOUNT_USD,
    }).discountAmount).toBe(MAX_PROMO_AMOUNT_DISCOUNT_USD);
  });

  test("rejects amount discounts with more than 2 decimal places", ({ expect }) => {
    expect(() => validateCreatePromoCodeInput({
      ...input,
      discountType: "amount",
      discountAmount: 10.001,
    })).toThrowError(KnownErrors.PromoCodeInvalid);
    expect(validateCreatePromoCodeInput({
      ...input,
      discountType: "amount",
      discountAmount: 10.25,
    }).discountAmount).toBe(10.25);
  });
});

import.meta.vitest?.describe("promoAppliesToProduct", (test) => {
  const promo = (applicableProductIds: PromoCodeRow["applicableProductIds"]): PromoCodeRow => ({
    id: "promo-1",
    tenancyId: "tenancy-1",
    codeName: "SAVE10",
    discountType: "percent",
    discountAmount: 10,
    currency: "USD",
    applicableProductIds,
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
  });

  test("all-products codes apply to catalog and inline products", ({ expect }) => {
    expect(promoAppliesToProduct(promo(null), "pro")).toBe(true);
    expect(promoAppliesToProduct(promo(null), null)).toBe(true);
  });

  test("product-restricted codes reject inline products", ({ expect }) => {
    expect(promoAppliesToProduct(promo(["pro"]), null)).toBe(false);
    expect(promoAppliesToProduct(promo(["pro"]), "pro")).toBe(true);
    expect(promoAppliesToProduct(promo(["pro"]), "other")).toBe(false);
  });
});

import.meta.vitest?.describe("stripeCouponCreateParamsFromPromo", (test) => {
  const input = {
    codeName: "SAVE10",
    discountType: "percent" as const,
    discountAmount: 10,
    applicableProductIds: null,
    maxRedemptions: null,
    subscriptionBehavior: "first_payment" as const,
    subscriptionDiscountDurationMonths: null,
    availabilityType: "always" as const,
    startsAt: null,
    endsAt: null,
  };

  test("maps first_payment to once, forever to forever, fixed_duration to repeating", ({ expect }) => {
    expect(stripeCouponCreateParamsFromPromo("tenancy-1", input).duration).toBe("once");
    expect(stripeCouponCreateParamsFromPromo("tenancy-1", {
      ...input,
      subscriptionBehavior: "forever",
    }).duration).toBe("forever");
    expect(stripeCouponCreateParamsFromPromo("tenancy-1", {
      ...input,
      subscriptionBehavior: "fixed_duration",
      subscriptionDiscountDurationMonths: 3,
    })).toMatchObject({
      duration: "repeating",
      duration_in_months: 3,
    });
  });
});

import.meta.vitest?.describe("mapStripeCouponCreateError", (test) => {
  test("maps invalid-request and idempotency errors, rethrows other Stripe errors", ({ expect }) => {
    const invalid = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      message: "invalid coupon",
    });
    expect(mapStripeCouponCreateError(invalid)).toBeInstanceOf(KnownErrors.PromoCodeStripeCreateFailed);

    const idempotent = new Stripe.errors.StripeIdempotencyError({
      type: "idempotency_error",
      message: "already creating",
    });
    expect(mapStripeCouponCreateError(idempotent)).toBeInstanceOf(KnownErrors.PromoCodeStripeCreateFailed);

    const rateLimit = new Stripe.errors.StripeRateLimitError({
      type: "rate_limit_error",
      message: "slow down",
    });
    expect(() => mapStripeCouponCreateError(rateLimit)).toThrow(rateLimit);
  });
});

import.meta.vitest?.describe("applyPromoDiscountToStripeUnits", (test) => {
  test("percent of remaining, then amount-off, never below zero", ({ expect }) => {
    const afterPercent = applyPromoDiscountToStripeUnits({
      remainingStripeUnits: 7999,
      discountType: "percent",
      discountAmount: 25,
    });
    expect(afterPercent).toBe(5999);
    expect(applyPromoDiscountToStripeUnits({
      remainingStripeUnits: afterPercent,
      discountType: "amount",
      discountAmount: 10,
    })).toBe(4999);
    expect(applyPromoDiscountToStripeUnits({
      remainingStripeUnits: 500,
      discountType: "amount",
      discountAmount: 10,
    })).toBe(0);
  });

  test("amount-off uses decimal strings, not Number * 100", ({ expect }) => {
    expect(applyPromoDiscountToStripeUnits({
      remainingStripeUnits: 8000,
      discountType: "amount",
      discountAmount: "79.99",
    })).toBe(1);
    expect(applyPromoDiscountToStripeUnits({
      remainingStripeUnits: 1999,
      discountType: "amount",
      discountAmount: new Prisma.Decimal("19.99"),
    })).toBe(0);
  });
});

import.meta.vitest?.describe("formatDiscountLabel", (test) => {
  test("trims zeros and rounds amount-off to USD cents", ({ expect }) => {
    expect(formatDiscountLabel("percent", "10.5000")).toBe("10.5% off");
    expect(formatDiscountLabel("amount", "10")).toBe("$10 off");
    expect(formatDiscountLabel("amount", "19.99")).toBe("$19.99 off");
    expect(formatDiscountLabel("amount", "12.3456")).toBe("$12.35 off");
  });
});

import.meta.vitest?.describe("orderPromosForStacking", (test) => {
  const stackingPromo = (overrides: Partial<PromoCodeRow>): PromoCodeRow => ({
    id: "promo-1",
    tenancyId: "tenancy-1",
    codeName: "SAVE",
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
    ...overrides,
  });

  test("percent then amount is independent of typed order", ({ expect }) => {
    const percent = stackingPromo({ id: "p", codeName: "PCT", discountType: "percent", discountAmount: 25, stripeCouponId: "c_pct" });
    const amount = stackingPromo({ id: "a", codeName: "USD", discountType: "amount", discountAmount: 10, stripeCouponId: "c_amt" });
    const namesFirst = ["PCT", "USD"];
    const namesReversed = ["USD", "PCT"];
    const byName = new Map([["PCT", percent], ["USD", amount]]);
    const first = validatePromoCodesForPurchase({
      promosByName: byName,
      codeNames: namesFirst,
      productId: "team",
      originalStripeUnits: 4900,
      allowStacking: true,
      isOneTime: false,
    });
    const second = validatePromoCodesForPurchase({
      promosByName: byName,
      codeNames: namesReversed,
      productId: "team",
      originalStripeUnits: 4900,
      allowStacking: true,
      isOneTime: false,
    });
    expect(first.netStripeUnits).toBe(2675);
    expect(second.netStripeUnits).toBe(2675);
    expect(first.applied.map((entry) => entry.promo.codeName)).toEqual(["PCT", "USD"]);
    expect(second.applied.map((entry) => entry.promo.codeName)).toEqual(["PCT", "USD"]);
  });
});

import.meta.vitest?.describe("validatePromoCodesForPurchase", (test) => {
  const promo = (overrides: Partial<PromoCodeRow> = {}): PromoCodeRow => ({
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
    ...overrides,
  });

  test("rejects stacking when disabled", ({ expect }) => {
    expect(() => validatePromoCodesForPurchase({
      promosByName: new Map([["A", promo({ codeName: "A" })], ["B", promo({ id: "2", codeName: "B" })]]),
      codeNames: ["A", "B"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
    })).toThrow(KnownErrors.PromoCodeStackingNotAllowed);
  });

  test("rejects promo on a $0 catalog price", ({ expect }) => {
    expect(() => validatePromoCodesForPurchase({
      promosByName: new Map([["SAVE10", promo()]]),
      codeNames: ["SAVE10"],
      productId: "pro",
      originalStripeUnits: 0,
      allowStacking: false,
      isOneTime: false,
    })).toThrow(KnownErrors.PromoCodeNothingToDiscount);
  });

  test("rejects OTP net between 0 and the one-time $0.50 minimum", ({ expect }) => {
    expect(() => validatePromoCodesForPurchase({
      promosByName: new Map([["ALMOST", promo({ codeName: "ALMOST", discountType: "amount", discountAmount: 9.60 })]]),
      codeNames: ["ALMOST"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
    })).toThrow(KnownErrors.PromoCodeDiscountBelowMinimum);
  });

  test("allows OTP net of 0", ({ expect }) => {
    const result = validatePromoCodesForPurchase({
      promosByName: new Map([["FREE", promo({ codeName: "FREE", discountType: "percent", discountAmount: 100 })]]),
      codeNames: ["FREE"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
    });
    expect(result.netStripeUnits).toBe(0);
    expect(result.recurringStripeUnits).toBe(0);
  });

  test("recurringStripeUnits ignores first_payment codes", ({ expect }) => {
    const percent = promo({
      id: "p",
      codeName: "HALF",
      discountType: "percent",
      discountAmount: 50,
      subscriptionBehavior: "first_payment",
    });
    const amount = promo({
      id: "a",
      codeName: "SIX",
      discountType: "amount",
      discountAmount: 6,
      subscriptionBehavior: "first_payment",
      stripeCouponId: "coupon_2",
    });
    const forever = promo({
      id: "f",
      codeName: "KEEP",
      discountType: "percent",
      discountAmount: 10,
      subscriptionBehavior: "forever",
      stripeCouponId: "coupon_3",
    });
    const firstOnly = validatePromoCodesForPurchase({
      promosByName: new Map([["HALF", percent], ["SIX", amount]]),
      codeNames: ["HALF", "SIX"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: true,
      isOneTime: false,
    });
    expect(firstOnly.netStripeUnits).toBe(0);
    expect(firstOnly.recurringStripeUnits).toBe(1000);

    const mixed = validatePromoCodesForPurchase({
      promosByName: new Map([["HALF", percent], ["KEEP", forever]]),
      codeNames: ["HALF", "KEEP"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: true,
      isOneTime: false,
    });
    expect(mixed.netStripeUnits).toBe(450);
    expect(mixed.recurringStripeUnits).toBe(900);
  });

  test("rejects codes that do not apply to the product", ({ expect }) => {
    expect(() => validatePromoCodesForPurchase({
      promosByName: new Map([["SAVE10", promo({ applicableProductIds: ["other"] })]]),
      codeNames: ["SAVE10"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
    })).toThrow(KnownErrors.PromoCodeNotApplicableToProduct);
  });

  test("inline products accept all-products codes and reject restricted codes", ({ expect }) => {
    const allProducts = validatePromoCodesForPurchase({
      promosByName: new Map([["SAVE10", promo({ applicableProductIds: null })]]),
      codeNames: ["SAVE10"],
      productId: null,
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
    });
    expect(allProducts.netStripeUnits).toBe(900);
    expect(() => validatePromoCodesForPurchase({
      promosByName: new Map([["SAVE10", promo({ applicableProductIds: ["pro"] })]]),
      codeNames: ["SAVE10"],
      productId: null,
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
    })).toThrow(KnownErrors.PromoCodeNotApplicableToProduct);
  });

  test("rejects missing, paused, ended, expired, and scheduled codes", ({ expect }) => {
    expect(() => validatePromoCodesForPurchase({
      promosByName: new Map(),
      codeNames: ["MISSING"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
    })).toThrow(KnownErrors.PromoCodeNotFound);

    expect(() => validatePromoCodesForPurchase({
      promosByName: new Map([["SAVE10", promo({ pausedAt: new Date("2026-01-01") })]]),
      codeNames: ["SAVE10"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
      now: new Date("2026-06-15"),
    })).toThrow(KnownErrors.PromoCodePaused);

    expect(() => validatePromoCodesForPurchase({
      promosByName: new Map([["SAVE10", promo({ endedAt: new Date("2026-01-01") })]]),
      codeNames: ["SAVE10"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
    })).toThrow(KnownErrors.PromoCodeEnded);

    expect(() => validatePromoCodesForPurchase({
      promosByName: new Map([["SAVE10", promo({
        availabilityType: "between_dates",
        startsAt: new Date("2026-01-01"),
        endsAt: new Date("2026-01-10"),
      })]]),
      codeNames: ["SAVE10"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
      now: new Date("2026-06-15"),
    })).toThrow(KnownErrors.PromoCodeExpired);

    expect(() => validatePromoCodesForPurchase({
      promosByName: new Map([["SAVE10", promo({
        availabilityType: "between_dates",
        startsAt: new Date("2026-12-01"),
        endsAt: new Date("2026-12-31"),
      })]]),
      codeNames: ["SAVE10"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
      now: new Date("2026-06-15"),
    })).toThrow(KnownErrors.PromoCodeNotYetAvailable);

    expect(() => validatePromoCodesForPurchase({
      promosByName: new Map([["SAVE10", promo({ maxRedemptions: 1, numRedemptions: 1 })]]),
      codeNames: ["SAVE10"],
      productId: "pro",
      originalStripeUnits: 1000,
      allowStacking: false,
      isOneTime: true,
    })).toThrow(KnownErrors.PromoCodeRedemptionLimitReached);
  });
});

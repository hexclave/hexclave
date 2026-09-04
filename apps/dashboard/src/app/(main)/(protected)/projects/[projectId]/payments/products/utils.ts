import { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { getStripeOneTimeMinAmount } from "@hexclave/shared/dist/payments/stripe-limits";
import { isValidUserSpecifiedId, moneyAmountSchema, sanitizeUserSpecifiedId } from "@hexclave/shared/dist/schema-fields";
import { SUPPORTED_CURRENCIES, type MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { moneyAmountToStripeUnits } from "@hexclave/shared/dist/utils/currencies";
import type { DayInterval } from "@hexclave/shared/dist/utils/dates";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

// ============================================================================
// Types
// ============================================================================

export type Product = CompleteConfig['payments']['products'][keyof CompleteConfig['payments']['products']];
export type Price = Product['prices'][string];
export type PricesObject = Product['prices'];

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_INTERVAL_UNITS: DayInterval[1][] = ['day', 'week', 'month', 'year'];
export const PRICE_INTERVAL_UNITS: DayInterval[1][] = ['week', 'month', 'year'];

// ============================================================================
// Interval Formatting
// ============================================================================

/**
 * Formats a day interval as a frequency label (e.g., "monthly", "Every 3 weeks")
 */
export function intervalLabel(tuple: DayInterval | undefined): string | null {
  if (!tuple) return null;
  const [count, unit] = tuple;
  if (count === 1) {
    return unit === 'year' ? 'yearly' : unit === 'month' ? 'monthly' : unit === 'week' ? 'weekly' : 'daily';
  }
  const plural = unit + 's';
  return `Every ${count} ${plural}`;
}

/**
 * Formats a day interval as a short label (e.g., "/mo", "/3wk")
 */
export function shortIntervalLabel(interval: DayInterval | 'never'): string {
  if (interval === 'never') return 'once';
  const [count, unit] = interval;
  const map: Record<DayInterval[1], string> = { day: 'd', week: 'wk', month: 'mo', year: 'yr' };
  const suffix = map[unit];
  return `/${count === 1 ? '' : count}${suffix}`;
}

/**
 * Formats a day interval as a duration label (e.g., "7 days", "1 month")
 */
export function freeTrialLabel(tuple: DayInterval | undefined): string | null {
  if (!tuple) return null;
  const [count, unit] = tuple;
  const plural = count === 1 ? unit : unit + 's';
  return `${count} ${plural}`;
}

// ============================================================================
// Price Utilities
// ============================================================================

/**
 * Builds a Price object from current state with all required fields
 * @param freeTrial - Pass `null` to explicitly remove free trial, `undefined` to compute from selection, or a DayInterval to set
 */
export function buildPriceUpdate(params: {
  amount: string,
  serverOnly: boolean,
  intervalSelection: 'one-time' | 'custom' | DayInterval[1],
  intervalCount: number,
  priceInterval: DayInterval[1] | undefined,
  freeTrialSelection: 'one-time' | 'custom' | DayInterval[1],
  freeTrialCount: number,
  freeTrialUnit: DayInterval[1] | undefined,
  freeTrial?: DayInterval | null,
}): Price {
  const { amount, serverOnly, intervalSelection, intervalCount, priceInterval, freeTrialSelection, freeTrialCount, freeTrialUnit, freeTrial } = params;

  const normalized = amount === '' ? '0.00' : (Number.isNaN(parseFloat(amount)) ? '0.00' : parseFloat(amount).toFixed(2));

  const intervalObj = intervalSelection === 'one-time' ? undefined : ([
    intervalSelection === 'custom' ? intervalCount : 1,
    (intervalSelection === 'custom' ? (priceInterval || 'month') : intervalSelection) as DayInterval[1]
  ] as DayInterval);

  // If freeTrial is explicitly null, don't include it
  // If freeTrial is a DayInterval, use it
  // If freeTrial is undefined, compute from selection state
  let freeTrialObj: DayInterval | undefined;
  if (freeTrial === null) {
    freeTrialObj = undefined;
  } else if (freeTrial !== undefined) {
    freeTrialObj = freeTrial;
  } else {
    freeTrialObj = freeTrialSelection === 'one-time' ? undefined : ([
      freeTrialSelection === 'custom' ? freeTrialCount : 1,
      (freeTrialSelection === 'custom' ? (freeTrialUnit || 'day') : freeTrialSelection) as DayInterval[1]
    ] as DayInterval);
  }

  return {
    USD: normalized,
    serverOnly,
    ...(intervalObj ? { interval: intervalObj } : {}),
    ...(freeTrialObj ? { freeTrial: freeTrialObj } : {}),
  };
}

/**
 * Formats a price for display (e.g., "$9.99 / month (7 days free)").
 * Always disambiguates between recurring and one-time charges so a bare
 * amount like "$0.00" or "$9.99" never appears (which would leave users
 * guessing whether it's monthly, yearly, or a one-off).
 */
export function formatPriceDisplay(price: Price): string {
  let display = `$${price.USD}`;
  if (price.interval) {
    const [count, unit] = price.interval;
    display += count === 1 ? ` / ${unit}` : ` / ${count} ${unit}s`;
  } else {
    display += ' one-time';
  }
  if (price.freeTrial) {
    const [count, unit] = price.freeTrial;
    display += ` (${count} ${unit}${count > 1 ? 's' : ''} free)`;
  }
  return display;
}

/**
 * Builds a fresh $0 price entry. Used as the "Make free" handler on product forms.
 *
 * We model "free" as a monthly recurring $0 subscription rather than a $0
 * one-time charge because Stripe rejects PaymentIntents below the per-currency
 * minimum (USD: $0.50) — a $0 one-time price is literally unprocessable through
 * the checkout flow. Stripe does, however, allow $0 recurring subscription
 * items: they create a $0 invoice each cycle with no payment attempt, which
 * matches "this product is free for the customer" semantics. The monthly
 * interval is arbitrary but matches the most common free-tier expectation; it
 * also governs when included items with `expires: 'when-purchase-expires'` or
 * `'when-repeated'` get re-granted.
 *
 * TODO(default-plans): replace the [1, 'month'] interval default with the
 * default-plan grant flow once that exists; the interval is only here to
 * keep Stripe's recurring-sub path happy.
 */
export function createFreePrice(): PricesObject {
  return {
    [generateUniqueId('price')]: {
      USD: '0.00',
      serverOnly: false,
      interval: [1, 'month'],
    },
  };
}

/**
 * Returns a human-readable error if Stripe would reject this price at checkout,
 * or `null` if it's valid. Mirrors the per-currency one-time minimum from
 * stack-shared/payments/stripe-limits; recurring $0 subs are allowed.
 */
export function getPriceCheckoutError(price: Price): string | null {
  if (price.USD == null || !moneyAmountSchema(USD_CURRENCY).defined().isValidSync(price.USD)) {
    return `Price amount is not a valid non-negative number (got ${JSON.stringify(price.USD)})`;
  }
  const amountStripeUnits = moneyAmountToStripeUnits(price.USD as MoneyAmount, USD_CURRENCY);
  if (!price.interval) {
    const minOneTime = getStripeOneTimeMinAmount('USD');
    const minOneTimeStripeUnits = moneyAmountToStripeUnits(
      minOneTime.toFixed(USD_CURRENCY.decimals) as MoneyAmount,
      USD_CURRENCY,
    );
    if (amountStripeUnits === 0) {
      return "$0 one-time prices can't be checked out — switch to a recurring interval to offer it for free.";
    }
    if (amountStripeUnits < minOneTimeStripeUnits) {
      return `One-time prices must be at least $${minOneTime.toFixed(2)} (Stripe minimum) — customers can't complete checkout below this amount.`;
    }
  }
  return null;
}

/**
 * Returns true if `prices` is the canonical "free product" shape: exactly one
 * entry with USD `'0'`/`'0.00'`, no free-trial, no server-only. Accepts both
 * `'0'` and `'0.00'` so rows written before `createFreePrice()` still match.
 * An interval is allowed (a free product is a $0 recurring sub).
 */
export function isFreePrices(prices: PricesObject): boolean {
  const entries = Object.values(prices);
  if (entries.length !== 1) return false;
  const [price] = entries;
  return (price.USD === '0' || price.USD === '0.00')
    && !price.freeTrial
    && !price.serverOnly;
}

// ============================================================================
// ID Validation & Generation
// ============================================================================

// Re-export utilities from schema-fields for convenience
export { getUserSpecifiedIdErrorMessage, isValidUserSpecifiedId, sanitizeUserSpecifiedId } from "@hexclave/shared/dist/schema-fields";

/**
 * Validates if an ID matches the required pattern.
 * @deprecated Use isValidUserSpecifiedId instead for consistency with schema validation
 */
export function isValidId(id: string): boolean {
  return isValidUserSpecifiedId(id);
}

/**
 * Generates a unique ID with a given prefix
 */
export function generateUniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).slice(2, 8)}`;
}

/**
 * Sanitizes user input into a valid ID format.
 * @deprecated Use sanitizeUserSpecifiedId instead for consistency with schema validation
 */
export function sanitizeId(input: string): string {
  return sanitizeUserSpecifiedId(input);
}

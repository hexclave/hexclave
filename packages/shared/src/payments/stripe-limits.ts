/**
 * Processor charge floors shared by backend and frontend.
 * Source: https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
 *
 * Stripe's wording (not ours to show customers): they enforce a minimum so
 * their fee does not exceed the charge. "Subscription charges support
 * zero-amount charges to account for coupons and free trials. However, any
 * non-zero amount is still subject to the applicable minimum." That is why
 * $0 OTP-via-100%-off and $0 recurring are allowed, but $0.01–$0.49 OTP is not.
 */
export const STRIPE_ONE_TIME_MIN_AMOUNT_BY_CURRENCY = {
  USD: 0.50,
} as const;

export type StripeSupportedCurrency = keyof typeof STRIPE_ONE_TIME_MIN_AMOUNT_BY_CURRENCY;

export function getStripeOneTimeMinAmount(currency: StripeSupportedCurrency): number {
  return STRIPE_ONE_TIME_MIN_AMOUNT_BY_CURRENCY[currency];
}

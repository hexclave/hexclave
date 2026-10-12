import { createHash } from "node:crypto";

/**
 * Stripe idempotency key for creating the Stripe customer of a Hexclave customer.
 *
 * Two requests that both fail to find the customer (Stripe's search index lags behind
 * recent writes) would otherwise each create one, and the next lookup then finds two
 * and fails. With a key derived from the customer, Stripe returns the same customer to
 * every attempt within its idempotency window.
 */
export function makeStripeCustomerCreateIdempotencyKey(options: {
  tenancyId: string,
  stripeCustomerType: "USER" | "TEAM",
  customerId: string,
}): string {
  const fingerprint = `${options.tenancyId}:${options.stripeCustomerType}:${options.customerId}`;
  return `customer-create:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
}

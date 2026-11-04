import { describe, expect, it } from "vitest";
import { makeStripeCustomerCreateIdempotencyKey } from "./stripe-customer-idempotency";

describe("makeStripeCustomerCreateIdempotencyKey", () => {
  const base = { tenancyId: "tenancy-a", stripeCustomerType: "USER" as const, customerId: "customer-1" };

  it("is stable for the same Hexclave customer, so concurrent creates share one Stripe customer", () => {
    expect(makeStripeCustomerCreateIdempotencyKey(base)).toBe(makeStripeCustomerCreateIdempotencyKey({ ...base }));
    expect(makeStripeCustomerCreateIdempotencyKey(base)).toMatch(/^customer-create:[0-9a-f]{32}$/);
  });

  it("differs per tenancy, customer type and customer", () => {
    const key = makeStripeCustomerCreateIdempotencyKey(base);
    expect(makeStripeCustomerCreateIdempotencyKey({ ...base, tenancyId: "tenancy-b" })).not.toBe(key);
    expect(makeStripeCustomerCreateIdempotencyKey({ ...base, stripeCustomerType: "TEAM" })).not.toBe(key);
    expect(makeStripeCustomerCreateIdempotencyKey({ ...base, customerId: "customer-2" })).not.toBe(key);
  });
});

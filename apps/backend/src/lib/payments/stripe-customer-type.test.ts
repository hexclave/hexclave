import { describe, expect, it } from "vitest";
import { customerTypeToStripeCustomerType, stripeCustomerMatchesCustomerType, type PaymentsCustomerType } from "./stripe-customer-type";

describe("customerTypeToStripeCustomerType", () => {
  it("maps every Hexclave customer type to its own Stripe metadata value", () => {
    expect({
      user: customerTypeToStripeCustomerType("user"),
      team: customerTypeToStripeCustomerType("team"),
      custom: customerTypeToStripeCustomerType("custom"),
    }).toMatchInlineSnapshot(`
      {
        "custom": "CUSTOM",
        "team": "TEAM",
        "user": "USER",
      }
    `);
  });
});

describe("stripeCustomerMatchesCustomerType", () => {
  const matches = (customerType: PaymentsCustomerType, storedType: string | undefined) => stripeCustomerMatchesCustomerType(
    { metadata: storedType === undefined ? {} : { customerType: storedType } },
    customerType,
  );

  it("does not reuse a Stripe customer tagged TEAM for a custom customer", () => {
    expect({
      customOnCustom: matches("custom", "CUSTOM"),
      customOnTeam: matches("custom", "TEAM"),
      customOnUntyped: matches("custom", undefined),
      teamOnTeam: matches("team", "TEAM"),
      teamOnCustom: matches("team", "CUSTOM"),
      userOnUser: matches("user", "USER"),
      userOnTeam: matches("user", "TEAM"),
    }).toMatchInlineSnapshot(`
      {
        "customOnCustom": true,
        "customOnTeam": false,
        "customOnUntyped": true,
        "teamOnCustom": false,
        "teamOnTeam": true,
        "userOnTeam": false,
        "userOnUser": true,
      }
    `);
  });
});

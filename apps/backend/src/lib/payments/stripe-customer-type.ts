import { CustomerType } from "@/generated/prisma/client";
import type Stripe from "stripe";

export type PaymentsCustomerType = "user" | "team" | "custom";

/**
 * The `customerType` stored in a Stripe customer's metadata. `syncStripeSubscriptions` reads it back to decide whose
 * subscription it is, so every Hexclave customer type maps to its own value: a `custom` customer must not be stored as
 * `TEAM`, or its subscriptions are recorded for a team and the customer never gets the product (#2131).
 */
export function customerTypeToStripeCustomerType(customerType: PaymentsCustomerType): CustomerType {
  switch (customerType) {
    case "user": {
      return CustomerType.USER;
    }
    case "team": {
      return CustomerType.TEAM;
    }
    case "custom": {
      return CustomerType.CUSTOM;
    }
  }
}

/**
 * Whether a Stripe customer found by its `customerId` metadata belongs to the given Hexclave customer type. Stripe
 * customers without a stored type predate that metadata and are accepted.
 */
export function stripeCustomerMatchesCustomerType(
  stripeCustomer: Pick<Stripe.Customer, "metadata">,
  customerType: PaymentsCustomerType,
): boolean {
  const storedType: string | undefined = stripeCustomer.metadata.customerType;
  if (!storedType) return true;
  return storedType === customerTypeToStripeCustomerType(customerType);
}

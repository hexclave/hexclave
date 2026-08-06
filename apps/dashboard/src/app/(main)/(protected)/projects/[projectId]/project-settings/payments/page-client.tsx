"use client";

import { PageLayout } from "../../page-layout";
import { PaymentMethods } from "../../payments/settings/payment-methods";
import { StripeConnectionCheck } from "../../payments/settings/stripe-connection-check";
import { TestModeToggle } from "../../payments/settings/test-mode-toggle";

export default function PageClient() {
  return (
    <PageLayout
      title="Payments"
      description="Connect Stripe and configure payment methods for this environment."
    >
      <div className="space-y-5 max-w-3xl pb-[20px]">
        <StripeConnectionCheck />
        <TestModeToggle />
        <PaymentMethods />
      </div>
    </PageLayout>
  );
}

"use client";

import { DesignCard } from "@/components/design-components";
import { PageLayout } from "../../page-layout";
import { PaymentMethods } from "../../payments/settings/payment-methods";
import { StripeConnectionCheck } from "../../payments/settings/stripe-connection-check";
import { TestModeToggle } from "../../payments/settings/test-mode-toggle";
import { CreditCardIcon } from "@phosphor-icons/react";

export default function PageClient() {
  return (
    <PageLayout
      title="Payments environment"
      description="Test mode, Stripe connection, and payment methods for this environment."
    >
      <div className="space-y-5 max-w-3xl pb-[20px]">
        <DesignCard
          title="Providers"
          subtitle="Connect Stripe and configure how payments run in this environment."
          icon={CreditCardIcon}
        >
          <div className="space-y-5">
            <StripeConnectionCheck />
            <TestModeToggle />
            <PaymentMethods />
          </div>
        </DesignCard>
      </div>
    </PageLayout>
  );
}

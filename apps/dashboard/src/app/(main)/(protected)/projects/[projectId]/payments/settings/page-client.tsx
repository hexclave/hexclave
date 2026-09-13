"use client";

import { Switch, Typography } from "@/components/ui";
import { DesignCard } from "@/components/design-components";
import { useUpdateConfig } from "@/components/config-update";
import { cn } from "@/lib/utils";
import { LockIcon, TicketIcon } from "@phosphor-icons/react";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useRef, useState } from "react";
import { PageLayout } from "../../page-layout";
import { useAdminApp } from "../../use-admin-app";
import { PaymentMethods } from "./payment-methods";
import { StripeConnectionCheck } from "./stripe-connection-check";
import { TestModeToggle } from "./test-mode-toggle";

export default function PageClient() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const paymentsConfig = project.useConfig().payments;
  const updateConfig = useUpdateConfig();

  const [optimisticBlocked, setOptimisticBlocked] = useState<boolean | null>(null);
  const latestRequestIdRef = useRef(0);
  const blocked = optimisticBlocked ?? paymentsConfig.blockNewPurchases;

  const handleBlockChange = (checked: boolean) => {
    setOptimisticBlocked(checked);
    const nextRequestId = ++latestRequestIdRef.current;
    runAsynchronouslyWithAlert((async () => {
      try {
        await updateConfig({
          adminApp,
          configUpdate: { "payments.blockNewPurchases": checked },
          pushable: true,
        });
      } finally {
        // Only clear the optimistic value if this is the most recent toggle —
        // otherwise a slow earlier request can clobber a newer optimistic value
        // and momentarily snap the UI back to the stale config value.
        if (nextRequestId === latestRequestIdRef.current) {
          setOptimisticBlocked(null);
        }
      }
    })());
  };

  return (
    <PageLayout
      title="Settings"
      description="Manage a few global payment behaviors."
    >
      <div className="space-y-5 max-w-3xl pb-[20px]">
        <StripeConnectionCheck />
        <TestModeToggle />
        <PaymentMethods />

        <DesignCard
          title="Checkout Controls"
          subtitle="Pause new purchases without affecting existing subscriptions."
          icon={LockIcon}
          gradient={blocked ? "orange" : "default"}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <div className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 transition-colors duration-150 hover:transition-none",
                blocked
                  ? "bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400 ring-amber-500/20"
                  : "bg-foreground/[0.05] text-muted-foreground ring-foreground/[0.08]"
              )}>
                <LockIcon className="h-4 w-4" weight="duotone" />
              </div>
              <div className="space-y-1 min-w-0">
                <Typography className="text-sm font-medium text-foreground">
                  Block new purchases
                </Typography>
                <Typography variant="secondary" className="text-xs">
                  Stops new checkouts while keeping existing subscriptions active.
                </Typography>
              </div>
            </div>
            <Switch checked={blocked} onCheckedChange={handleBlockChange} />
          </div>
        </DesignCard>

        <DesignCard
          title="Promo codes"
          subtitle="Allow promo codes on hosted checkout and plan switches."
          icon={TicketIcon}
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1 min-w-0">
                <Typography className="text-sm font-medium text-foreground">
                  Allow promo codes
                </Typography>
                <Typography variant="secondary" className="text-xs">
                  Required before checkout URLs can show a promo field, and before codes can be applied on a plan switch.
                </Typography>
              </div>
              <Switch
                checked={paymentsConfig.allowPromoCodes === true}
                onCheckedChange={async (checked) => {
                  await updateConfig({
                    adminApp,
                    configUpdate: { "payments.allowPromoCodes": checked },
                    pushable: true,
                  });
                }}
              />
            </div>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1 min-w-0">
                <Typography className="text-sm font-medium text-foreground">
                  Allow stacking promo codes
                </Typography>
                <Typography variant="secondary" className="text-xs">
                  Lets more than one promo code be applied to a checkout or plan switch.
                </Typography>
              </div>
              <Switch
                checked={paymentsConfig.allowPromoCodes === true && paymentsConfig.allowStackingPromoCodes === true}
                disabled={paymentsConfig.allowPromoCodes !== true}
                onCheckedChange={async (checked) => {
                  await updateConfig({
                    adminApp,
                    configUpdate: { "payments.allowStackingPromoCodes": checked },
                    pushable: true,
                  });
                }}
              />
            </div>
          </div>
        </DesignCard>
      </div>
    </PageLayout>
  );
}

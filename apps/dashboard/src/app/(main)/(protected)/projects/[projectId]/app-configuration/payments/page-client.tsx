"use client";

import { Switch, Typography } from "@/components/ui";
import { DesignCard } from "@/components/design-components";
import { Link } from "@/components/link";
import { useUpdateConfig } from "@/components/config-update";
import { cn } from "@/lib/utils";
import { LockIcon, PackageIcon } from "@phosphor-icons/react";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useRef, useState } from "react";
import { PageLayout } from "../../page-layout";
import { useAdminApp, useProjectId } from "../../use-admin-app";

export default function PageClient() {
  const adminApp = useAdminApp();
  const projectId = useProjectId();
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
        if (nextRequestId === latestRequestIdRef.current) {
          setOptimisticBlocked(null);
        }
      }
    })());
  };

  return (
    <PageLayout
      title="Payments catalog"
      description="Products, product lines, and checkout controls from hexclave.config.ts."
    >
      <div className="space-y-5 max-w-3xl pb-[20px]">
        <DesignCard
          title="Catalog"
          subtitle="Define product lines, products, and items."
          icon={PackageIcon}
        >
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/projects/${projectId}/app-configuration/payments/product-lines`}
              className="text-sm font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-400"
            >
              Product lines
            </Link>
            <span className="text-muted-foreground">·</span>
            <Link
              href={`/projects/${projectId}/app-configuration/payments/products`}
              className="text-sm font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-400"
            >
              Products &amp; items
            </Link>
          </div>
        </DesignCard>

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
      </div>
    </PageLayout>
  );
}

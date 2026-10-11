"use client";

import { DesignBadge, DesignButton, DesignCard } from "@/components/design-components";
import { ActionDialog, Alert, AlertDescription, Card, CardContent, CopyField, SimpleTooltip, Typography } from "@/components/ui";
import { getAppStageLabel } from "@/lib/apps-utils";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import type { DataWarehouseCredentialsJson } from "@hexclave/shared/dist/interface/admin-interface";
import { ITEM_IDS, resolvePlanId } from "@hexclave/shared/dist/plans";
import { ArrowClockwiseIcon, DatabaseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMemo, useState, type ReactNode } from "react";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";

const stageLabel = getAppStageLabel("data-warehouse-alpha");
const UNENTITLED_MESSAGE = "Available on the Team plan and above.";

export default function PageClient() {
  return (
    <AppEnabledGuard appId="data-warehouse-alpha">
      <DataWarehousePage />
    </AppEnabledGuard>
  );
}

function DataWarehousePage() {
  const adminApp = useAdminApp();
  const warehouse = adminApp.useDataWarehouse();
  const [credentials, setCredentials] = useState<DataWarehouseCredentialsJson | null>(null);

  const handleProvision = async () => {
    setCredentials(await adminApp.provisionDataWarehouse());
  };

  const handleRotate = async () => {
    setCredentials(await adminApp.rotateDataWarehousePassword());
  };

  const isProvisioned = warehouse.status === "ready";

  // The boundary wraps the whole page rather than only its content: rotation lives in
  // the page header, and the backend requires the entitlement for it too, so the header
  // has to know. The upgrade banner comes back as a node to keep it where it was.
  return (
    <EntitlementBoundary>
      {(isEntitled, upgradeBanner) => (
        <PageLayout
          title="Data Warehouse"
          description={stageLabel != null ? <DesignBadge label={stageLabel} color="purple" size="sm" /> : undefined}
          actions={isProvisioned ? (
            <SimpleTooltip tooltip={isEntitled ? null : UNENTITLED_MESSAGE}>
              <DesignButton variant="secondary" className="gap-2" onClick={handleRotate} disabled={!isEntitled}>
                <ArrowClockwiseIcon className="h-4 w-4" />
                Rotate password
              </DesignButton>
            </SimpleTooltip>
          ) : undefined}
        >
          <div className="flex flex-1 flex-col gap-4">
            {upgradeBanner}
            {isProvisioned ? (
              <DesignCard icon={DatabaseIcon} title="Your warehouse">
                <div className="grid gap-3 sm:grid-cols-2">
                  <CopyField type="input" label="Database" value={warehouse.database_name ?? ""} monospace />
                  <CopyField type="input" label="Host" value={warehouse.connection.host} monospace />
                  <CopyField type="input" label="HTTP(S) port" value={String(warehouse.connection.https_port)} monospace />
                  <CopyField type="input" label="Native port" value={String(warehouse.connection.native_port)} monospace />
                  {warehouse.username != null && (
                    <CopyField type="input" label="Username" value={warehouse.username} monospace />
                  )}
                </div>
              </DesignCard>
            ) : (
              <div className="flex flex-1 w-full items-center justify-center self-stretch px-3 py-8">
                <Card className="w-full max-w-sm">
                  <CardContent className="p-8 text-center">
                    <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
                      <DatabaseIcon className="h-6 w-6" />
                    </div>
                    <Typography type="h3" className="mb-4">Set up your warehouse</Typography>
                    <Typography type="p" variant="secondary" className="mt-2">
                      Get a private database for your project data.
                    </Typography>
                    <div className="mt-8 flex justify-center">
                      {/* Wraps the button rather than sitting on it: a disabled button
                          emits no pointer events, so Radix would never see the hover. */}
                      <SimpleTooltip tooltip={isEntitled ? null : UNENTITLED_MESSAGE}>
                        <DesignButton
                          className="gap-2"
                          onClick={handleProvision}
                          disabled={!isEntitled}
                          loading={warehouse.status === "provisioning"}
                        >
                          <DatabaseIcon className="h-4 w-4" />
                          {warehouse.status === "failed" ? "Try again" : "Provision"}
                        </DesignButton>
                      </SimpleTooltip>
                    </div>
                    {warehouse.status === "failed" && (
                      <Typography type="p" variant="secondary" className="mt-4 text-xs">
                        {warehouse.error ?? "Provisioning failed."}
                      </Typography>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            <PasswordDialog credentials={credentials} onClose={() => setCredentials(null)} />
          </div>
        </PageLayout>
      )}
    </EntitlementBoundary>
  );
}

/** The password is not retrievable afterwards, so this is the only chance to copy it. */
function PasswordDialog({ credentials, onClose }: { credentials: DataWarehouseCredentialsJson | null, onClose: () => void }) {
  return (
    <ActionDialog
      open={credentials != null}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="Your password"
      okButton={{ label: "Done" }}
    >
      <div className="hexclave-sensitive flex flex-col gap-3">
        <Typography type="p" variant="secondary">
          Save this password somewhere safe. It is not shown again. If you lose it, rotate it to get a new one.
        </Typography>
        <CopyField type="input" label="Password" value={credentials?.password ?? ""} monospace isSecret />
      </div>
    </ActionDialog>
  );
}

type EntitlementChildren = (isEntitled: boolean, upgradeBanner: ReactNode) => ReactNode;

/**
 * Tells the page whether the plan allows provisioning and rotation, and hands back the
 * upgrade banner for the page to place; the backend enforces the requirement independently.
 *
 * Split in two because `team.useItem` is a hook: the outer half decides whether there
 * is a billing team to read, the inner half reads it. Projects with no billing team,
 * and deployments that do not enforce plan limits, count as entitled.
 */
function EntitlementBoundary({ children }: { children: EntitlementChildren }) {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const planUsage = adminApp.usePlanUsage();
  const user = useDashboardInternalUser();
  const teams = user.useTeams();

  const ownerTeam = useMemo(
    () => teams.find(t => t.id === project.ownerTeamId),
    [teams, project.ownerTeamId],
  );

  if (!planUsage.arePlanLimitsEnforced || ownerTeam == null) {
    return <>{children(true, null)}</>;
  }

  return <EntitlementBoundaryInner team={ownerTeam}>{children}</EntitlementBoundaryInner>;
}

function EntitlementBoundaryInner({ team, children }: {
  team: {
    useItem: (itemId: string) => { quantity: number },
    useProducts: () => Array<{ id: string | null, type?: string }>,
    createCheckoutUrl: (options: { productId: string, returnUrl: string }) => Promise<string>,
  },
  children: EntitlementChildren,
}) {
  const item = team.useItem(ITEM_IDS.dataWarehouse);
  const products = team.useProducts();
  const planId = resolvePlanId(products);
  const isEntitled = item.quantity >= 1;

  const handleUpgrade = async () => {
    const checkoutUrl = await team.createCheckoutUrl({
      productId: planId === "free" ? "team" : "growth",
      returnUrl: window.location.href,
    });
    window.location.assign(checkoutUrl);
  };

  const upgradeBanner = isEntitled ? null : (
    <Alert>
      <WarningCircleIcon className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between gap-4">
        <span>{UNENTITLED_MESSAGE}</span>
        <DesignButton size="sm" onClick={handleUpgrade}>Upgrade</DesignButton>
      </AlertDescription>
    </Alert>
  );

  return <>{children(isEntitled, upgradeBanner)}</>;
}

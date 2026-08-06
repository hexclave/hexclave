"use client";

import {
  DesignButton,
  DesignListItemRow,
} from "@/components/design-components";
import { Link } from "@/components/link";
import { DatabaseIcon, ArrowRightIcon } from "@phosphor-icons/react";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useRouter } from "@/components/router";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp, useProjectId } from "../use-admin-app";

export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const projectId = useProjectId();
  const project = hexclaveAdminApp.useProject();
  const router = useRouter();

  const config = project.useConfig();
  const storeEntries = typedEntries(config.dataVault.stores);
  const configureHref = urlString`/projects/${projectId}/app-configuration/data-vault`;

  return (
    <AppEnabledGuard appId="data-vault">
      <PageLayout
        title="Data Vault"
        description="View encrypted data stores for this project. Create and edit stores in App Configuration."
        actions={
          <DesignButton asChild size="sm">
            <Link href={configureHref}>
              Configure stores
              <ArrowRightIcon className="h-4 w-4 ml-1.5" />
            </Link>
          </DesignButton>
        }
      >
        {storeEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="p-3 rounded-2xl bg-foreground/[0.04] mb-4">
              <DatabaseIcon className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-base font-semibold mb-1">No stores yet</h3>
            <p className="text-sm text-muted-foreground text-center mb-5 max-w-sm">
              Create data vault stores in App Configuration to securely store encrypted data.
            </p>
            <DesignButton asChild>
              <Link href={configureHref}>
                Open Data Vault settings
                <ArrowRightIcon className="h-4 w-4 ml-1.5" />
              </Link>
            </DesignButton>
          </div>
        ) : (
          <div className="space-y-3 max-w-3xl">
            {storeEntries.map(([storeId, store]) => (
              <DesignListItemRow
                key={storeId}
                icon={DatabaseIcon}
                title={storeId}
                subtitle={store.displayName || "No display name"}
                onClick={() => router.push(urlString`/projects/${projectId}/data-vault/stores/${storeId}`)}
              />
            ))}
          </div>
        )}
      </PageLayout>
    </AppEnabledGuard>
  );
}

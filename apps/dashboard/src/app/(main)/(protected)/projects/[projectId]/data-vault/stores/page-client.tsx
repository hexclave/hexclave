"use client";

import {
  DesignButton,
  DesignInput,
  DesignListItemRow,
} from "@/components/design-components";
import { ActionDialog, Label, toast } from "@/components/ui";
import { useUpdateConfig } from "@/components/config-update";
import { DatabaseIcon, PlusIcon } from "@phosphor-icons/react";
import { getUserSpecifiedIdErrorMessage, isValidUserSpecifiedId, sanitizeUserSpecifiedId } from "@hexclave/shared/dist/schema-fields";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import { useState } from "react";
import { useRouter } from "../../../../../../../components/router";
import { AppEnabledGuard } from "../../app-enabled-guard";
import { PageLayout } from "../../page-layout";
import { useAdminApp } from "../../use-admin-app";

export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const router = useRouter();
  const updateConfig = useUpdateConfig();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [newStoreId, setNewStoreId] = useState("");
  const [newStoreDisplayName, setNewStoreDisplayName] = useState("");

  const config = project.useConfig();
  const stores = config.dataVault.stores;
  const storeEntries = typedEntries(stores);

  const handleCreateStore = async () => {
    if (!newStoreId.trim()) {
      alert("Store ID is required");
      return "prevent-close" as const;
    }

    if (!isValidUserSpecifiedId(newStoreId)) {
      alert(getUserSpecifiedIdErrorMessage("storeId"));
      return "prevent-close" as const;
    }

    if (newStoreId in stores) {
      alert("A store with this ID already exists");
      return "prevent-close" as const;
    }

    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: {
        [`dataVault.stores.${newStoreId}`]: {
          displayName: newStoreDisplayName.trim() || `Store ${newStoreId}`,
        },
      },
      pushable: true,
    });

    toast({ title: "Data vault store created successfully" });
  };

  const handleStoreClick = (storeId: string) => {
    router.push(`/projects/${project.id}/data-vault/stores/${storeId}`);
  };

  return (
    <AppEnabledGuard appId="data-vault">
      <PageLayout
        title="Data Vault Stores"
        description="Create and manage encrypted data stores for this branch (hexclave.config.ts)."
        actions={
          <DesignButton onClick={() => setIsCreateDialogOpen(true)}>
            <PlusIcon className="h-4 w-4 mr-2" />
            Create Store
          </DesignButton>
        }
      >
        {storeEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="p-3 rounded-2xl bg-foreground/[0.04] mb-4">
              <DatabaseIcon className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-base font-semibold mb-1">No data vault stores yet</h3>
            <p className="text-sm text-muted-foreground text-center mb-5 max-w-sm">
              Create your first data vault store to start securely storing encrypted data
            </p>
            <DesignButton onClick={() => setIsCreateDialogOpen(true)}>
              <PlusIcon className="h-4 w-4 mr-2" />
              Create Your First Store
            </DesignButton>
          </div>
        ) : (
          <div className="space-y-3">
            {storeEntries.map(([storeId, store]) => (
              <DesignListItemRow
                key={storeId}
                icon={DatabaseIcon}
                title={storeId}
                subtitle={store.displayName || "No display name"}
                onClick={() => handleStoreClick(storeId)}
              />
            ))}
          </div>
        )}

        <ActionDialog
          open={isCreateDialogOpen}
          onOpenChange={(open) => {
            setIsCreateDialogOpen(open);
            if (!open) {
              setNewStoreId("");
              setNewStoreDisplayName("");
            }
          }}
          title="Create Data Vault Store"
          description="Create a new isolated store for encrypted data"
          okButton={{ label: "Create Store", onClick: handleCreateStore }}
          cancelButton
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="storeId">Store ID</Label>
              <DesignInput
                id="storeId"
                placeholder="e.g., user-secrets, api-keys"
                value={newStoreId}
                onChange={(e) => setNewStoreId(sanitizeUserSpecifiedId(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Letters, numbers, underscores, and hyphens only (cannot start with a hyphen)
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="displayName">Display Name (optional)</Label>
              <DesignInput
                id="displayName"
                placeholder="e.g., User Secrets"
                value={newStoreDisplayName}
                onChange={(e) => setNewStoreDisplayName(e.target.value)}
              />
            </div>
          </div>
        </ActionDialog>
      </PageLayout>
    </AppEnabledGuard>
  );
}

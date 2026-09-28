"use client";

import { CodeBlock } from "@/components/code-block";
import {
  DesignAlert,
  DesignButton,
  DesignCard,
  DesignEditableGrid,
  DesignInput,
  type DesignEditableGridItem,
} from "@/components/design-components";
import { ActionDialog, Label, toast } from "@/components/ui";
import { useUpdateConfig } from "@/components/config-update";
import { ArrowLeftIcon, CopyIcon, DatabaseIcon, HashIcon, TagIcon, TrashIcon } from "@phosphor-icons/react";
import { deindent } from "@hexclave/shared/dist/utils/strings";
import { useMemo, useState } from "react";
import { useRouter } from "../../../../../../../../components/router";
import { AppEnabledGuard } from "../../../app-enabled-guard";
import { PageLayout } from "../../../page-layout";
import { useAdminApp } from "../../../use-admin-app";

type PageClientProps = {
  storeId: string,
};

export default function PageClient({ storeId }: PageClientProps) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const router = useRouter();
  const updateConfig = useUpdateConfig();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [localDisplayName, setLocalDisplayName] = useState<string | undefined>(undefined);

  const config = project.useConfig();
  const store = config.dataVault.stores[storeId];
  const modifiedKeys = useMemo(() => new Set([
    ...(localDisplayName !== undefined ? ["display-name"] : []),
  ]), [localDisplayName]);

  if (!(storeId in config.dataVault.stores)) {
    return (
      <AppEnabledGuard appId="data-vault">
        <PageLayout title="Store Not Found">
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground mb-4">This data vault store does not exist.</p>
            <DesignButton onClick={() => router.push(`/projects/${project.id}/data-vault/stores`)}>
              <ArrowLeftIcon className="h-4 w-4 mr-2" />
              Back to Stores
            </DesignButton>
          </div>
        </PageLayout>
      </AppEnabledGuard>
    );
  }

  const displayName = localDisplayName ?? store.displayName;
  const hasChanges = localDisplayName !== undefined;

  const handleSaveDisplayName = async () => {
    if (localDisplayName !== undefined) {
      await updateConfig({
        adminApp: hexclaveAdminApp,
        configUpdate: {
          [`dataVault.stores.${storeId}.displayName`]: localDisplayName.trim() || store.displayName,
        },
        pushable: true,
      });
      toast({ title: "Display name updated successfully" });
      setLocalDisplayName(undefined);
    }
  };

  const handleDiscardDisplayName = () => {
    setLocalDisplayName(undefined);
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  };

  const handleDeleteStore = async () => {
    if (deleteConfirmation !== storeId) {
      return "prevent-close" as const;
    }

    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: { [`dataVault.stores.${storeId}`]: null },
      pushable: true,
    });

    toast({ title: "Data vault store deleted successfully" });
    router.push(`/projects/${project.id}/data-vault/stores`);
  };

  const storeDetailItems: DesignEditableGridItem[] = [
    {
      type: "custom",
      icon: <HashIcon className="h-3.5 w-3.5" />,
      name: "Store ID",
      children: (
        <div className="-ml-2 flex w-full items-center gap-2">
          <div className="flex h-7 min-w-0 flex-1 items-center rounded-xl border border-transparent px-2">
            <code className="truncate rounded-md bg-foreground/[0.04] px-2 py-0.5 text-sm">
              {storeId}
            </code>
          </div>
          <DesignButton
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0"
            onClick={() => copyToClipboard(storeId)}
          >
            <CopyIcon className="h-3.5 w-3.5" />
          </DesignButton>
        </div>
      ),
    },
    {
      itemKey: "display-name",
      type: "text",
      icon: <TagIcon className="h-3.5 w-3.5" />,
      name: "Display Name",
      value: displayName,
      placeholder: "Enter display name",
      onUpdate: async (val) => {
        if (val === store.displayName) {
          setLocalDisplayName(undefined);
        } else {
          setLocalDisplayName(val);
        }
      },
    },
  ];

  const serverExample = deindent`
    // In your .env file or environment variables:
    // HEXCLAVE_DATA_VAULT_SECRET=insert-a-randomly-generated-secret-here

    const store = await hexclaveServerApp.getDataVaultStore(${JSON.stringify(storeId)});

    // Each store is a key-value store. You can use any string as a key, for example user IDs
    const key = user.id;

    // Get a value for a specific key
    const value = await store.getValue(key, {
      secret: process.env.HEXCLAVE_DATA_VAULT_SECRET,
    });

    // Set a value for a specific key
    await store.setValue(key, "my-value", {
      secret: process.env.HEXCLAVE_DATA_VAULT_SECRET,
    });
  `;

  return (
    <AppEnabledGuard appId="data-vault">
      <PageLayout title="Data Vault Store" allowContentOverflow>
        <DesignCard
          title="Store Details"
          subtitle="View and manage this data vault store"
          icon={DatabaseIcon}
          glassmorphic
          actions={
            <DesignButton
              variant="destructive"
              size="sm"
              onClick={() => setIsDeleteDialogOpen(true)}
            >
              <TrashIcon className="h-3.5 w-3.5 mr-1.5" />
              Delete Store
            </DesignButton>
          }
        >
          <DesignEditableGrid
            items={storeDetailItems}
            columns={1}
            deferredSave
            hasChanges={hasChanges}
            onSave={handleSaveDisplayName}
            onDiscard={handleDiscardDisplayName}
            externalModifiedKeys={modifiedKeys}
          />
        </DesignCard>

        <DesignAlert
          variant="info"
          title="How Data Vault Works"
          description={<>
            A store securely saves key-value pairs with Hexclave. Plaintext keys and values are never written to a database; instead, they&apos;re encrypted and decrypted on-the-fly using envelope encryption with a rotating master key.
            <br /><br />
            To use the store, you&apos;ll need a random, unguessable secret. It can be any format, but for strong security it should be at least 32 characters long and provide 256 bits of entropy. <strong className="text-foreground/90">Even Hexclave</strong> can&apos;t access your data if you lose it, so keep it safe.
            <br /><br />
            Hexclave only stores hashes of your keys, so you can&apos;t list all keys in a store. Each value is encrypted with its key, the provided secret, and an additional encryption secret that is kept safe by Hexclave.
          </>}
        />

        <CodeBlock
          language="typescript"
          content={serverExample}
          title="Example Implementation"
          icon="code"
        />

        <ActionDialog
          open={isDeleteDialogOpen}
          onOpenChange={(open) => {
              setIsDeleteDialogOpen(open);
              if (!open) setDeleteConfirmation("");
          }}
          title="Delete Data Vault Store"
          description="This action cannot be undone. All encrypted data in this store will be permanently deleted."
          danger
          okButton={{
            label: "Delete Store",
            onClick: handleDeleteStore,
            props: { disabled: deleteConfirmation !== storeId },
          }}
          cancelButton
        >
          <div className="space-y-2">
            <Label htmlFor="confirmation">
              Type <strong>{storeId}</strong> to confirm deletion
            </Label>
            <DesignInput
              id="confirmation"
              value={deleteConfirmation}
              onChange={(e) => setDeleteConfirmation(e.target.value)}
              placeholder={storeId}
            />
          </div>
        </ActionDialog>
      </PageLayout>
    </AppEnabledGuard>
  );
}

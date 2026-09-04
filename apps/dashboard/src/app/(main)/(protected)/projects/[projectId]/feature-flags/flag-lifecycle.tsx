"use client";

import { DesignButton, DesignDialog, DesignDialogClose } from "@/components/design-components";
import { useUpdateConfig } from "@/components/config-update";
import { flagConfigPath } from "@/lib/feature-flags/config";
import { ArchiveIcon, ProhibitIcon } from "@phosphor-icons/react";
import { useAdminApp } from "../use-admin-app";

export type FlagLifecycleAction = "kill" | "restore" | "archive" | "unarchive";

export type PendingFlagLifecycleAction = {
  flagId: string,
  displayName: string,
  action: FlagLifecycleAction,
};

const ACTION_COPY: ReadonlyMap<FlagLifecycleAction, { title: string, description: string, confirmLabel: string, destructive: boolean }> = new Map([
  ["kill", {
    title: "Activate kill switch",
    description: "Every evaluation immediately serves the fallback variant, skipping all targeting. Use this to stop a misbehaving feature right away. You can restore the flag at any time.",
    confirmLabel: "Kill flag",
    destructive: true,
  }],
  ["restore", {
    title: "Restore flag",
    description: "The kill switch is released and the flag resumes normal evaluation with its configured rules and rollout.",
    confirmLabel: "Restore",
    destructive: false,
  }],
  ["archive", {
    title: "Archive flag",
    description: "Archived flags stop evaluating (clients receive the fallback) and are hidden from the default list, but their configuration and history are kept. Flags are archived instead of deleted so old references keep failing safely.",
    confirmLabel: "Archive",
    destructive: false,
  }],
  ["unarchive", {
    title: "Unarchive flag",
    description: "The flag returns to the list in its previous enabled/disabled state. Review its targeting before re-enabling.",
    confirmLabel: "Unarchive",
    destructive: false,
  }],
]);

/**
 * Confirmation dialog for the flag lifecycle quick actions (kill switch,
 * restore, archive, unarchive). Owns the config write so the flags list and
 * the flag editor page share one implementation of these semantics.
 */
export function FlagLifecycleConfirmDialog(props: {
  pending: PendingFlagLifecycleAction | null,
  onClose: () => void,
}) {
  const adminApp = useAdminApp();
  const updateConfig = useUpdateConfig();

  const copy = props.pending != null
    ? ACTION_COPY.get(props.pending.action) ?? throwMissingCopy(props.pending.action)
    : null;

  const perform = async () => {
    const pending = props.pending
      ?? throwErrState("The lifecycle confirm dialog performed an action without a pending state — it should be unmounted when pending is null.");
    const configUpdate = pending.action === "kill" || pending.action === "restore"
      ? { [`${flagConfigPath(pending.flagId)}.killed`]: pending.action === "kill" }
      : { [`${flagConfigPath(pending.flagId)}.archived`]: pending.action === "archive" };
    await updateConfig({ adminApp, configUpdate, pushable: true });
    props.onClose();
  };

  return (
    <DesignDialog
      open={props.pending != null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      size="md"
      icon={props.pending?.action === "kill" ? ProhibitIcon : ArchiveIcon}
      title={copy?.title ?? ""}
      description={props.pending != null ? `Flag: ${props.pending.displayName}` : undefined}
      footer={
        <>
          <DesignDialogClose asChild>
            <DesignButton variant="secondary" size="sm">Cancel</DesignButton>
          </DesignDialogClose>
          <DesignButton
            size="sm"
            variant={copy?.destructive ? "destructive" : "default"}
            onClick={perform}
          >
            {copy?.confirmLabel ?? "Confirm"}
          </DesignButton>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{copy?.description}</p>
    </DesignDialog>
  );
}

function throwMissingCopy(action: FlagLifecycleAction): never {
  throw new Error(`No dialog copy for flag lifecycle action ${action} — ACTION_COPY must cover every FlagLifecycleAction`);
}

function throwErrState(message: string): never {
  throw new Error(message);
}

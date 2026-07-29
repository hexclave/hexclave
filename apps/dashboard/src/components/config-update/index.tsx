'use client';

import { ActionDialog, Button } from "@/components/ui";
import { getPublicEnvVar } from "@/lib/env";
import type { PushedConfigSource, StackAdminApp } from "@hexclave/next";
import type { EnvironmentConfigOverrideOverride } from "@hexclave/shared/dist/config/schema";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import React, { useCallback, useContext, useState } from "react";

import { GithubPushDialog } from "./github-push-dialog";
import { RdeApplyDialog } from "./rde-apply-dialog";
import { ConfigUpdateDialogContext } from "./shared";

type ConfigUpdateDialogState = {
  isOpen: boolean,
  adminApp: StackAdminApp<false> | null,
  configUpdate: EnvironmentConfigOverrideOverride | null,
  resolve: ((result: boolean) => void) | null,
  source: PushedConfigSource | null,
};

type RdeDialogState = {
  isOpen: boolean,
  adminApp: StackAdminApp<false> | null,
  configUpdate: EnvironmentConfigOverrideOverride | null,
  resolve: ((result: boolean) => void) | null,
};

export function ConfigUpdateDialogProvider({ children }: { children: React.ReactNode }) {
  const [dialogState, setDialogState] = useState<ConfigUpdateDialogState>({
    isOpen: false,
    adminApp: null,
    configUpdate: null,
    resolve: null,
    source: null,
  });
  const [rdeState, setRdeState] = useState<RdeDialogState>({
    isOpen: false,
    adminApp: null,
    configUpdate: null,
    resolve: null,
  });
  const showPushableDialog = useCallback(async (adminApp: StackAdminApp<false>, configUpdate: EnvironmentConfigOverrideOverride): Promise<boolean> => {
    const project = await adminApp.getProject();
    const source = await project.getPushedConfigSource();

    let shouldUpdate = true;
    if (source.type !== "unlinked") {
      shouldUpdate = await new Promise((resolve) => {
        setDialogState({
          isOpen: true,
          adminApp,
          configUpdate,
          resolve,
          source,
        });
      });
    }

    if (shouldUpdate) {
      await project.updatePushedConfig(configUpdate);
      if (!project.isDevelopmentEnvironment) {
        await project.resetConfigOverrideKeys("environment", Object.keys(configUpdate));
      }
      return true;
    }
    return false;
  }, []);

  const showRdeApplyDialog = useCallback(async (adminApp: StackAdminApp<false>, configUpdate: EnvironmentConfigOverrideOverride): Promise<boolean> => {
    return await new Promise((resolve) => {
      setRdeState({ isOpen: true, adminApp, configUpdate, resolve });
    });
  }, []);

  const settleDialog = useCallback((result: boolean) => {
    const resolve = dialogState.resolve;
    setDialogState({
      isOpen: false,
      adminApp: null,
      configUpdate: null,
      resolve: null,
      source: null,
    });
    resolve?.(result);
  }, [dialogState.resolve]);

  const settleRdeDialog = useCallback((result: boolean) => {
    const resolve = rdeState.resolve;
    setRdeState({
      isOpen: false,
      adminApp: null,
      configUpdate: null,
      resolve: null,
    });
    resolve?.(result);
  }, [rdeState.resolve]);

  const projectId = dialogState.adminApp?.projectId;

  const renderDialog = () => {
    if (!dialogState.isOpen || !dialogState.source) {
      return null;
    }

    switch (dialogState.source.type) {
      case "pushed-from-github": {
        return (
          <GithubPushDialog
            open={dialogState.isOpen}
            adminApp={dialogState.adminApp}
            source={dialogState.source}
            configUpdate={dialogState.configUpdate}
            projectId={projectId}
            onSettle={settleDialog}
          />
        );
      }

      case "pushed-from-unknown": {
        return (
          <ActionDialog
            open={dialogState.isOpen}
            onClose={() => settleDialog(false)}
            title="Configuration Managed by CLI"
            description="This project's configuration was pushed via the Hexclave CLI."
            okButton={{
              label: "Go to App Configuration",
              onClick: async () => {
                window.location.href = `/projects/${projectId}/app-configuration`;
              },
            }}
            cancelButton={{
              label: "Cancel",
              onClick: async () => {
                settleDialog(false);
              },
            }}
          >
            <div className="text-sm text-muted-foreground space-y-2">
              <p>
                To make changes, you can either:
              </p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>Push updates through the Hexclave CLI</li>
                <li>Unlink the CLI in App Configuration to edit directly on this dashboard</li>
              </ul>
            </div>
          </ActionDialog>
        );
      }

      default: {
        return null;
      }
    }
  };

  return (
    <ConfigUpdateDialogContext.Provider value={{ showPushableDialog, showRdeApplyDialog }}>
      {children}
      {renderDialog()}
      {rdeState.isOpen && (
        <RdeApplyDialog
          open={rdeState.isOpen}
          adminApp={rdeState.adminApp}
          configUpdate={rdeState.configUpdate}
          onSettle={settleRdeDialog}
        />
      )}
    </ConfigUpdateDialogContext.Provider>
  );
}

function useConfigUpdateDialog() {
  const context = useContext(ConfigUpdateDialogContext);
  if (context == null) {
    throw new Error("useConfigUpdateDialog must be used within a ConfigUpdateDialogProvider");
  }
  return context;
}

export type UpdateConfigOptions = {
  adminApp: StackAdminApp<false>,
  configUpdate: EnvironmentConfigOverrideOverride,
  pushable: boolean,
};

export function useUpdateConfig() {
  const { showPushableDialog, showRdeApplyDialog } = useConfigUpdateDialog();

  return useCallback(async (options: UpdateConfigOptions): Promise<boolean> => {
    const { adminApp, configUpdate, pushable } = options;

    if (getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true") {
      if (!pushable) {
        throw new HexclaveAssertionError("These settings are read-only in a development environment. Update them in your production deployment instead.");
      }

      return await showRdeApplyDialog(adminApp, configUpdate);
    }

    if (pushable) {
      return await showPushableDialog(adminApp, configUpdate);
    }

    const project = await adminApp.getProject();
    if (project.isDevelopmentEnvironment) {
      alert("These settings are read-only in a development environment. Update them in your production deployment instead.");
      return false;
    }
    // eslint-disable-next-line no-restricted-syntax -- this is the hook implementation itself
    await project.updateConfig(configUpdate);
    return true;
  }, [showPushableDialog, showRdeApplyDialog]);
}

export type ConfigUpdateButtonProps = {
  adminApp: StackAdminApp<false>,
  configUpdate: () => Promise<EnvironmentConfigOverrideOverride>,
  pushable: boolean,
  onUpdated?: () => void | Promise<void>,
  actionType: "save" | "create",
  disabled?: boolean,
  className?: string,
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive" | "link",
  size?: "default" | "sm" | "lg" | "icon",
};

export function ConfigUpdateButton({
  adminApp,
  configUpdate,
  pushable,
  onUpdated,
  actionType,
  disabled,
  className,
  variant = "default",
  size = "default",
}: ConfigUpdateButtonProps) {
  const updateConfig = useUpdateConfig();

  const handleClick = async () => {
    const configUpdateValue = await configUpdate();
    const success = await updateConfig({
      adminApp,
      configUpdate: configUpdateValue,
      pushable,
    });
    if (success) {
      await onUpdated?.();
    }
  };

  const label = actionType === "save" ? "Save changes" : "Create";

  return (
    <Button
      onClick={handleClick}
      disabled={disabled}
      className={className}
      variant={variant}
      size={size}
    >
      {label}
    </Button>
  );
}

export type UnsavedChangesFooterProps = {
  hasChanges: boolean,
  adminApp: StackAdminApp<false>,
  configUpdate: () => Promise<EnvironmentConfigOverrideOverride>,
  pushable: boolean,
  onDiscard: () => void,
  onSaved?: () => void | Promise<void>,
  actionType?: "save" | "create",
};

export function UnsavedChangesFooter({
  hasChanges,
  adminApp,
  configUpdate,
  pushable,
  onDiscard,
  onSaved,
  actionType = "save",
}: UnsavedChangesFooterProps) {
  if (!hasChanges) {
    return null;
  }

  return (
    <div className="flex items-center justify-end gap-2 pt-4 border-t border-border/40">
      <Button
        variant="ghost"
        size="sm"
        onClick={onDiscard}
      >
        Discard changes
      </Button>
      <ConfigUpdateButton
        adminApp={adminApp}
        configUpdate={configUpdate}
        pushable={pushable}
        onUpdated={onSaved}
        actionType={actionType}
        size="sm"
      />
    </div>
  );
}

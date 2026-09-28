import { useAdminApp, useProjectId } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { useRouter } from "@/components/router";
import { Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui";
import { ALL_APPS_FRONTEND, AppFrontend, getAppPath, getDocumentationHref } from "@/lib/apps-frontend";
import { getAppEnableConfigUpdate, isAppEnabled } from "@/lib/apps-utils";
import { useUpdateConfig } from "@/components/config-update";
import { CheckIcon, DotsThreeVerticalIcon } from "@phosphor-icons/react";
import { ALL_APPS, AppId, getParentAppId } from "@hexclave/shared/dist/apps/apps-config";
import { appSquarePaddingExpression, appSquareWidthExpression, AppIcon as SharedAppIcon } from "@hexclave/shared/dist/apps/apps-ui";
import { useState } from "react";
import { AppWarningModal } from "./app-warning-modal";
import { Link } from "./link";

export { appSquarePaddingExpression, appSquareWidthExpression };

type AppSquareVariant = "default" | "installed" | "featured";

export function AppIcon({
  appId,
  className,
  variant = "default",
  enabled = false,
}: {
  appId: AppId,
  className?: string,
  variant?: AppSquareVariant,
  enabled?: boolean,
}) {
  const appFrontend: AppFrontend = ALL_APPS_FRONTEND[appId];

  return (
    <SharedAppIcon
      appId={appId}
      IconComponent={appFrontend.icon}
      LogoComponent={appFrontend.logo}
      className={className}
      enabled={enabled || variant === "installed"}
      cn={cn}
    />
  );
}

export function AppSquare({
  appId,
  variant = "default",
  showSubtitle = false,
  onToggleEnabled
}: {
  appId: AppId,
  variant?: AppSquareVariant,
  showSubtitle?: boolean,
  onToggleEnabled?: (enabled: boolean) => void,
}) {
  const app = ALL_APPS[appId];
  const [showWarningModal, setShowWarningModal] = useState(false);

  const projectId = useProjectId();
  const adminApp = useAdminApp()!;
  const project = adminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();
  const router = useRouter();

  const isEnabled = isAppEnabled(config.apps.installed, appId);
  const appDetailsPath = `/projects/${projectId}/apps/${appId}`;
  const appFrontend = ALL_APPS_FRONTEND[appId];
  const parentAppId = getParentAppId(appId);
  const parentApp = parentAppId == null ? null : ALL_APPS[parentAppId];
  const parentAppFrontend = parentAppId == null ? null : ALL_APPS_FRONTEND[parentAppId];
  const parentAppEnabled = parentAppId == null ? false : isAppEnabled(config.apps.installed, parentAppId);
  const parentDestinationPath = parentAppId == null || parentAppFrontend == null
    ? null
    : parentAppEnabled
      ? getAppPath(projectId, appFrontend)
      : `/projects/${projectId}/apps/${parentAppId}`;

  const handleToggleEnabled = async () => {
    // Show warning modal for alpha/beta apps when enabling
    if (!isEnabled && app.stage !== "stable") {
      setShowWarningModal(true);
      return;
    }

    // Direct disable for enabled apps or enable for stable apps
    await performToggle();
  };

  const performToggle = async () => {
    await updateConfig({
      adminApp,
      configUpdate: isEnabled
        ? { [`apps.installed.${appId}.enabled`]: false }
        : getAppEnableConfigUpdate(appId),
      pushable: true,
    });
    onToggleEnabled?.(!isEnabled);
  };

  return (
    <>
      <div className="group relative">
        <Link
          href={appDetailsPath}
          className={cn(
            "flex flex-col items-center p-3 sm:p-4 rounded-xl sm:rounded-2xl cursor-pointer",
            "bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800",
            // Hover/active states - button-like feel
            "hover:bg-gray-100 dark:hover:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600",
            "active:scale-[0.98] active:bg-gray-150 dark:active:bg-gray-750",
            // Transitions only on hover-out
            "transition-[transform,background-color,border-color,box-shadow] duration-150 hover:transition-none",
            isEnabled && "border-green-500/40 dark:border-green-500/30 bg-green-50/30 dark:bg-green-950/20 hover:bg-green-100/50 dark:hover:bg-green-900/30"
          )}
        >
          {/* Icon container */}
          <div className="flex items-center justify-center w-full mb-3">
            <AppIcon
              appId={appId}
              variant={isEnabled ? "installed" : variant}
            />
          </div>

          {/* Text container */}
          <div className="w-full flex flex-col items-center">
            <span className={cn(
              "text-[11px] sm:text-xs font-medium text-center w-full line-clamp-1",
              "text-gray-900 dark:text-gray-100"
            )}>
              {app.displayName}
            </span>

            {showSubtitle && (
              <span className="mt-1 text-[9px] sm:text-[10px] text-gray-500 dark:text-gray-400 text-center line-clamp-2 w-full leading-normal">
                {app.subtitle}
              </span>
            )}
          </div>
        </Link>

        {/* Three-dot menu in top-right corner */}
        <div className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 z-10">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "p-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:transition-none",
                  "hover:bg-gray-200 dark:hover:bg-gray-700",
                  "focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                )}
                onClick={(e) => e.preventDefault()}
              >
                <DotsThreeVerticalIcon className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[120px]">
              {parentDestinationPath == null ? (
                <DropdownMenuItem onClick={handleToggleEnabled} className="cursor-pointer">
                  {isEnabled ? 'Disable' : 'Enable'}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => router.push(parentDestinationPath)} className="cursor-pointer">
                  Go to {parentApp?.displayName ?? "parent app"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Status badge - enabled checkmark */}
        {isEnabled && (
          <div className="absolute top-2 right-8 sm:top-3 sm:right-9 w-5 h-5 sm:w-6 sm:h-6 bg-green-500 rounded-full flex items-center justify-center shadow-md z-10">
            <CheckIcon className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-white" weight="bold" />
          </div>
        )}

        {/* Status badge - alpha/beta */}
        {!isEnabled && app.stage !== "stable" && (
          <div className="absolute top-2 right-8 sm:top-3 sm:right-9 z-10">
            <div className={cn(
              "px-1.5 sm:px-2 py-0.5 rounded sm:rounded-md text-[8px] sm:text-[10px] font-bold uppercase tracking-wide border",
              app.stage === "alpha"
                ? "bg-orange-500/10 text-orange-500 border-orange-500/50"
                : "bg-blue-500/10 text-blue-500 border-blue-500/50"
            )}>
              {app.stage === "alpha" ? "Alpha" : "Beta"}
            </div>
          </div>
        )}
      </div>

      {/* Warning Modal */}
      {app.stage !== "stable" && (
        <AppWarningModal
          isOpen={showWarningModal}
          onClose={() => setShowWarningModal(false)}
          onConfirm={() => void performToggle()}
          appName={app.displayName}
          stage={app.stage as "alpha" | "beta"}
        />
      )}
    </>
  );
}

// Compact version for lists
export function AppListItem({
  appId,
  onEnable,
  showActions = true
}: {
  appId: AppId,
  onEnable?: () => void | Promise<void>,
  showActions?: boolean,
}) {
  const app = ALL_APPS[appId];
  const appFrontend = ALL_APPS_FRONTEND[appId];
  const [isLoading, setIsLoading] = useState(false);

  const adminApp = useAdminApp()!;
  const project = adminApp.useProject();
  const config = project.useConfig();

  const isEnabled = isAppEnabled(config.apps.installed, appId);
  const appPath = getAppPath(project.id, appFrontend);
  const appDestinationPath = getDocumentationHref(appFrontend) ?? appPath;
  const appDetailsPath = `/projects/${project.id}/apps/${appId}`;
  const router = useRouter();
  const parentAppId = getParentAppId(appId);
  const parentApp = parentAppId == null ? null : ALL_APPS[parentAppId];
  const parentAppFrontend = parentAppId == null ? null : ALL_APPS_FRONTEND[parentAppId];
  const parentAppEnabled = parentAppId == null ? false : isAppEnabled(config.apps.installed, parentAppId);
  const parentDestinationPath = parentAppId == null || parentAppFrontend == null
    ? null
    : parentAppEnabled
      ? appPath
      : `/projects/${project.id}/apps/${parentAppId}`;

  const handleEnable = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    setIsLoading(true);
    try {
      await onEnable?.();
    } catch (error) {
      // Re-throw to let Button component handle it via runAsynchronouslyWithAlert
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Link
      href={parentDestinationPath ?? (isEnabled ? appDestinationPath : appDetailsPath)}
      className={cn(
        "flex items-center gap-3 p-3 rounded-lg transition-all",
        "hover:bg-gray-50 dark:hover:bg-gray-800/50",
        isEnabled && "bg-green-50/50 dark:bg-green-900/10 border border-green-200 dark:border-green-800"
      )}
    >
      <AppIcon
        appId={appId}
        variant={isEnabled ? "installed" : "default"}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {app.displayName}
          </span>
          {app.stage !== "stable" && (
            <div className={cn(
              "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide",
              "border",
              app.stage === "alpha"
                ? "bg-orange-50 dark:bg-orange-950/30 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800"
                : "bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800"
            )}>
              {app.stage === "alpha" ? "Alpha" : "Beta"}
            </div>
          )}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
          {app.subtitle}
        </p>
      </div>

      {showActions && (
        <div className="flex items-center gap-2">
          {isEnabled ? (
            <CheckIcon className="w-4 h-4 text-green-500" />
          ) : parentDestinationPath != null ? (
            <Button
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                router.push(parentDestinationPath);
              }}
              variant="plain"
              size="plain"
              className="px-3 py-1 text-xs font-medium bg-muted text-foreground rounded-md hover:bg-muted/80 transition-colors"
            >
              Go to {parentApp?.displayName ?? "parent"}
            </Button>
          ) : (
            <Button
              onClick={handleEnable}
              loading={isLoading}
              variant="plain"
              size="plain"
              className="px-3 py-1 text-xs font-medium bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors"
            >
              Enable
            </Button>
          )}
        </div>
      )}
    </Link>
  );
}

"use client";

import { AppIcon } from "@/components/app-square";
import { Link } from "@/components/link";
import { Badge, Button, ScrollArea } from "@/components/ui";
import { ALL_APPS_FRONTEND, getAppPath, getItemPath, hasNavigationItems, type NavigableAppFrontend } from "@/lib/apps-frontend";
import { getUninstalledAppIds } from "@/lib/apps-utils";
import { classifyClickHouseSqlVsPrompt } from "@/lib/classify-query";
import { cn } from "@/lib/utils";
import { ChartBarIcon, CheckIcon, CubeIcon, DownloadSimpleIcon, GearIcon, GlobeIcon, HardDriveIcon, InfoIcon, KeyIcon, LayoutIcon, LightningIcon, Palette, PlayIcon, PlusIcon, ShieldCheckIcon, SparkleIcon, UsersIcon } from "@phosphor-icons/react";
import { ALL_APPS, ALL_APP_TAGS, getParentAppId, type AppId } from "@hexclave/shared/dist/apps/apps-config";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import Image from "next/image";
import React, { memo, useEffect, useMemo } from "react";
import { AIChatPreview } from "./commands/ask-ai";
import { CreateDashboardPreview } from "./commands/create-dashboard/create-dashboard-preview";
import { RunQueryPreview } from "./commands/run-query";

export type CmdKPreviewProps = {
  isSelected: boolean,
  query: string,
  registerOnFocus: (onFocus: () => void) => void,
  unregisterOnFocus: (onFocus: () => void) => void,
  /** Called when user navigates back (left arrow) from this preview */
  onBlur: () => void,
  /** Register nested commands that will appear as a new column */
  registerNestedCommands: (commands: CmdKCommand[]) => void,
  /** Navigate into the nested column (call after registering commands) */
  navigateToNested: () => void,
  /** Close the command center dialog */
  onClose: () => void,
  /** Current nesting depth (0 = first preview) */
  depth: number,
  /** Current pathname for checking active state */
  pathname: string,
};

// Available App Preview Component - shows app store page in preview panel
const AvailableAppPreview = memo(function AvailableAppPreview({
  appId,
  onEnable,
  goToParentHref,
  onClose,
}: {
  appId: AppId,
  onEnable?: () => Promise<void>,
  goToParentHref?: string,
  onClose?: () => void,
}) {
  const app = ALL_APPS[appId];
  const appFrontend = ALL_APPS_FRONTEND[appId];
  const parentAppId = getParentAppId(appId);
  const parentApp = parentAppId == null ? null : ALL_APPS[parentAppId];

  const features = [
    { icon: ShieldCheckIcon, label: "Secure" },
    { icon: LightningIcon, label: "Quick Setup" },
    { icon: CheckIcon, label: "Production Ready" },
  ];

  return (
    <div className="flex flex-col h-full w-full">
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Header */}
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 flex-shrink-0">
              <AppIcon
                appId={appId}
                className="shadow-md ring-1 ring-black/5 dark:ring-white/10 w-full h-full"
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-base font-semibold text-foreground truncate">
                  {app.displayName}
                </h3>
                {app.stage !== "stable" && (
                  <Badge
                    variant={app.stage === "alpha" ? "destructive" : "secondary"}
                    className="text-[9px] px-1.5 py-0"
                  >
                    {app.stage === "alpha" ? "Alpha" : "Beta"}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">
                {app.subtitle}
              </p>
            </div>
          </div>

          {/* Tags */}
          <div className="flex flex-wrap gap-1.5">
            {(app.tags as Array<keyof typeof ALL_APP_TAGS>).map((tag) => (
              <div
                key={tag}
                className={cn(
                  "px-2 py-0.5 rounded-full text-[10px] font-medium",
                  tag === "expert"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {ALL_APP_TAGS[tag].displayName}
              </div>
            ))}
          </div>

          {/* Features */}
          <div className="grid grid-cols-3 gap-2">
            {features.map((feature, index) => (
              <div
                key={index}
                className="flex flex-col items-center gap-1 p-2 rounded-lg bg-muted/50 border border-border/50"
              >
                <feature.icon className="w-3.5 h-3.5 text-blue-500" />
                <span className="text-[9px] text-muted-foreground text-center">
                  {feature.label}
                </span>
              </div>
            ))}
          </div>

          {/* Enable Button */}
          <div className="flex items-center gap-3">
            {parentApp == null ? (
              <Button
                onClick={() => {
                  if (onEnable == null) return;
                  runAsynchronouslyWithAlert(onEnable());
                }}
                size="sm"
                className="flex-1 bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white font-medium"
              >
                Enable App
              </Button>
            ) : (
              <Button
                asChild
                size="sm"
                className="flex-1 bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white font-medium"
              >
                <Link href={goToParentHref ?? "#"} onClick={onClose}>
                  Go to {parentApp.displayName}
                </Link>
              </Button>
            )}
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <InfoIcon className="w-3 h-3" />
              <span>Free</span>
            </div>
          </div>
          {parentApp != null && (
            <p className="text-[11px] text-muted-foreground">
              This app is part of the {parentApp.displayName} app.
            </p>
          )}

          {/* Stage Warning */}
          {app.stage !== "stable" && (
            <div
              className={cn(
                "p-2.5 rounded-lg border-l-2 text-[11px]",
                app.stage === "alpha"
                  ? "bg-red-50 dark:bg-red-950/20 border-red-500 text-red-800 dark:text-red-300"
                  : "bg-amber-50 dark:bg-amber-950/20 border-amber-500 text-amber-800 dark:text-amber-300"
              )}
            >
              {app.stage === "alpha" && (
                <><strong>Alpha:</strong> Early development, may have bugs.</>
              )}
              {app.stage === "beta" && (
                <><strong>Beta:</strong> Being tested, generally stable.</>
              )}
            </div>
          )}

          {/* Screenshots */}
          {appFrontend.screenshots.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-foreground mb-2">Preview</h4>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {appFrontend.screenshots.map((screenshot: string, index: number) => (
                  <div
                    key={index}
                    className="relative h-32 w-48 rounded-lg shadow-sm flex-shrink-0 overflow-hidden border border-border"
                  >
                    <Image
                      src={screenshot}
                      alt={`${app.displayName} screenshot ${index + 1}`}
                      fill
                      className="object-cover select-none"
                      draggable={false}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Description */}
          <div>
            <h4 className="text-xs font-medium text-foreground mb-2">About</h4>
            <div className="text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none">
              {appFrontend.storeDescription}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
});

// Factory to create available app preview components
function createAvailableAppPreview(
  appId: AppId,
  onEnable?: () => Promise<void>,
  goToParentHref?: string
): React.ComponentType<CmdKPreviewProps> {
  return function AvailableAppPreviewWrapper({ onClose }: CmdKPreviewProps) {
    return <AvailableAppPreview appId={appId} onEnable={onEnable} goToParentHref={goToParentHref} onClose={onClose} />;
  };
}

export type CmdKCommand = {
  id: string,
  icon: React.ReactNode,
  label: string,
  description: string,
  keywords?: string[],
  onAction: {
    type: "focus",
  } | {
    type: "action",
    action: () => void | Promise<void>,
  } | {
    type: "navigate",
    href: string,
  },
  preview: null | React.ComponentType<CmdKPreviewProps>,
  /** If true, the preview renders a visual component that should be shown in the preview panel */
  hasVisualPreview?: boolean,
  /** Optional highlight color for special styling (e.g., "purple" for AI commands) */
  highlightColor?: string,
};

type ProjectShortcutDefinition = {
  id: string,
  icon: React.FunctionComponent<React.SVGProps<SVGSVGElement>>,
  label: string,
  description: string,
  href: string,
  keywords: string[],
  requiredApps?: AppId[],
};

const PROJECT_SHORTCUTS: ProjectShortcutDefinition[] = [
  {
    id: "navigation/users",
    icon: UsersIcon,
    label: "Users",
    description: "Navigation",
    href: "/users",
    keywords: ["users", "user", "people", "members", "accounts"],
  },
  {
    id: "navigation/dashboards",
    icon: ChartBarIcon,
    label: "Dashboards",
    description: "Navigation",
    href: "/dashboards",
    keywords: ["dashboards", "dashboard", "charts", "insights", "metrics"],
  },
  {
    id: "settings/trusted-domains",
    icon: GlobeIcon,
    label: "Trusted Domains",
    description: "Settings",
    href: "/domains",
    keywords: ["domains", "trusted domains", "custom domain", "handler", "allowlist"],
    requiredApps: ["authentication"],
  },
  {
    id: "emails/themes",
    icon: Palette,
    label: "Email Themes",
    description: "Emails",
    href: "/email-themes",
    keywords: ["email themes", "themes", "branding", "style", "templates"],
    requiredApps: ["emails"],
  },
  {
    id: "data-vault/stores",
    icon: HardDriveIcon,
    label: "Data Vault Stores",
    description: "Data Vault",
    href: "/data-vault/stores",
    keywords: ["data vault", "stores", "vault", "secrets", "encrypted storage"],
    requiredApps: ["data-vault"],
  },
  {
    id: "payments/new-product",
    icon: PlusIcon,
    label: "Create Product",
    description: "Payments",
    href: "/payments/products/new",
    keywords: ["create product", "new product", "payments", "pricing", "catalog"],
    requiredApps: ["payments"],
  },
];

function toCommandIdSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Factory to create app preview components that show navigation items
function createAppPreview(appId: AppId, projectId: string, appFrontend: NavigableAppFrontend): React.ComponentType<CmdKPreviewProps> {
  // Pre-compute these outside the component since they're static per appId
  const app = ALL_APPS[appId];

  // Pre-compute nested commands since they're static
  const IconComponent = appFrontend.icon;
  const nestedCommands: CmdKCommand[] = appFrontend.navigationItems.map((navItem) => ({
    id: `apps/${appId}/nav/${navItem.displayName.toLowerCase().replace(/\s+/g, '-')}`,
    icon: <IconComponent className="h-3.5 w-3.5 text-muted-foreground" />,
    label: navItem.displayName,
    description: app.displayName,
    keywords: [app.displayName.toLowerCase(), navItem.displayName.toLowerCase()],
    onAction: { type: "navigate" as const, href: getItemPath(projectId, appFrontend, navItem) },
    preview: null,
  }));

  return function AppPreview({
    registerOnFocus,
    unregisterOnFocus,
    registerNestedCommands,
    navigateToNested,
  }: CmdKPreviewProps) {
    useEffect(() => {
      const focusHandler = () => {
        registerNestedCommands(nestedCommands);
        navigateToNested();
      };
      registerOnFocus(focusHandler);
      return () => unregisterOnFocus(focusHandler);
    }, [registerOnFocus, unregisterOnFocus, registerNestedCommands, navigateToNested]);

    return null; // No visual preview, just nested commands
  };
}

// Cache for app preview components to avoid recreating them
const appPreviewCache = new Map<string, React.ComponentType<CmdKPreviewProps>>();

function getOrCreateAppPreview(appId: AppId, projectId: string): React.ComponentType<CmdKPreviewProps> {
  const cacheKey = `${appId}:${projectId}`;
  let preview = appPreviewCache.get(cacheKey);
  if (!preview) {
    const appFrontend = ALL_APPS_FRONTEND[appId];
    if (!hasNavigationItems(appFrontend)) {
      throw new Error(`App ${appId} has no navigation items`);
    }
    preview = createAppPreview(appId, projectId, appFrontend);
    appPreviewCache.set(cacheKey, preview);
  }
  return preview;
}

export function useCmdKCommands({
  projectId,
  enabledApps,
  query,
  onEnableApp,
}: {
  projectId: string,
  enabledApps: AppId[],
  query: string,
  onEnableApp?: (appId: AppId) => Promise<void>,
}): CmdKCommand[] {
  return useMemo(() => {
    const commands: CmdKCommand[] = [];
    const pushUniqueNavigateCommand = (command: CmdKCommand) => {
      if (command.onAction.type !== "navigate") {
        commands.push(command);
        return;
      }

      const href = command.onAction.href;
      const alreadyExists = commands.some((existingCommand) =>
        existingCommand.onAction.type === "navigate" &&
        existingCommand.onAction.href === href
      );
      if (!alreadyExists) {
        commands.push(command);
      }
    };
    const queryClassification = classifyClickHouseSqlVsPrompt(query, { readonlyOnly: true });
    const shouldPrioritizeRunQuery = queryClassification.kind === "sql";

    // Overview
    commands.push({
      id: "navigation/overview",
      icon: <GlobeIcon className="h-3.5 w-3.5 text-muted-foreground" />,
      label: "Overview",
      description: "Navigation",
      keywords: ["home", "dashboard", "main"],
      onAction: { type: "navigate", href: `/projects/${projectId}` },
      preview: null,
    });

    // Core navigation and power-tool shortcuts
    for (const shortcut of PROJECT_SHORTCUTS) {
      if (shortcut.requiredApps != null && !shortcut.requiredApps.every((appId) => enabledApps.includes(appId))) {
        continue;
      }

      const IconComponent = shortcut.icon;
      pushUniqueNavigateCommand({
        id: shortcut.id,
        icon: <IconComponent className="h-3.5 w-3.5 text-muted-foreground" />,
        label: shortcut.label,
        description: shortcut.description,
        keywords: shortcut.keywords,
        onAction: { type: "navigate", href: `/projects/${projectId}${shortcut.href}` },
        preview: null,
      });
    }

    // Installed apps - with preview for navigation items
    for (const appId of enabledApps) {
      const app = ALL_APPS[appId];
      const appFrontend = ALL_APPS_FRONTEND[appId];
      // Some enabled apps might not have navigation metadata yet
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!app || !appFrontend) continue;
      const parentAppId = getParentAppId(appId);
      const parentApp = parentAppId == null ? null : ALL_APPS[parentAppId];

      const IconComponent = appFrontend.icon;
      if (!hasNavigationItems(appFrontend)) {
        commands.push({
          id: `apps/${appId}`,
          icon: <IconComponent className="h-3.5 w-3.5 stroke-emerald-600 dark:stroke-emerald-400" />,
          label: app.displayName,
          description: parentApp == null ? "Installed app" : `Part of ${parentApp.displayName}`,
          keywords: [
            app.displayName.toLowerCase(),
            app.subtitle.toLowerCase(),
            appId,
            appFrontend.href.toLowerCase(),
            appFrontend.href.toLowerCase().replace(/-/g, " "),
            ...app.tags,
            "installed",
            "app",
            ...(parentApp == null ? [] : [parentApp.displayName.toLowerCase(), "sub-app"]),
          ],
          onAction: { type: "navigate", href: getAppPath(projectId, appFrontend) },
          preview: null,
          highlightColor: "app",
        });
        continue;
      }

      const hasNestedNavigation = appFrontend.navigationItems.length > 0;
      commands.push({
        id: `apps/${appId}`,
        icon: <IconComponent className="h-3.5 w-3.5 stroke-emerald-600 dark:stroke-emerald-400" />,
        label: parentApp == null ? app.displayName : `${parentApp.displayName} › ${app.displayName}`,
        description: parentApp == null ? "Installed app" : `Part of ${parentApp.displayName}`,
        keywords: [
          app.displayName.toLowerCase(),
          app.subtitle.toLowerCase(),
          appId,
          appFrontend.href.toLowerCase(),
          appFrontend.href.toLowerCase().replace(/-/g, " "),
          ...app.tags,
          "installed",
          "app",
          ...(parentApp == null ? [] : [parentApp.displayName.toLowerCase(), "sub-app"]),
        ],
        onAction: { type: "navigate", href: getAppPath(projectId, appFrontend) },
        preview: hasNestedNavigation ? getOrCreateAppPreview(appId, projectId) : null,
        highlightColor: "app",
      });

      // Flatten app pages so they're directly searchable without nesting
      for (const navItem of appFrontend.navigationItems) {
        const itemPath = getItemPath(projectId, appFrontend, navItem);
        pushUniqueNavigateCommand({
          id: `apps/${appId}/page/${toCommandIdSegment(navItem.displayName)}`,
          icon: <IconComponent className="h-3.5 w-3.5 text-muted-foreground" />,
          label: parentApp == null
            ? `${app.displayName}: ${navItem.displayName}`
            : `${parentApp.displayName} › ${app.displayName} › ${navItem.displayName}`,
          description: parentApp == null
            ? `Page in ${app.displayName}`
            : `Page in ${app.displayName}, part of ${parentApp.displayName}`,
          keywords: [
            app.displayName.toLowerCase(),
            navItem.displayName.toLowerCase(),
            `${app.displayName.toLowerCase()} ${navItem.displayName.toLowerCase()}`,
            appId,
            "page",
            "navigate",
          ],
          onAction: { type: "navigate", href: itemPath },
          preview: null,
          highlightColor: "app",
        });
      }
    }

    // Available (uninstalled) apps
    const uninstalledApps = getUninstalledAppIds(enabledApps);
    for (const appId of uninstalledApps) {
      const app = ALL_APPS[appId];
      const appFrontend = ALL_APPS_FRONTEND[appId];
      // Some apps might not have frontend metadata yet
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!app || !appFrontend) continue;
      const parentAppId = getParentAppId(appId);
      const parentApp = parentAppId == null ? null : ALL_APPS[parentAppId];
      const parentAppFrontend = parentAppId == null ? null : ALL_APPS_FRONTEND[parentAppId];
      const isParentEnabled = parentAppId == null ? false : enabledApps.includes(parentAppId);
      const parentDestination = parentAppId == null || parentAppFrontend == null
        ? null
        : isParentEnabled
          ? getAppPath(projectId, appFrontend)
          : `/projects/${projectId}/apps/${parentAppId}`;

      const IconComponent = appFrontend.icon;
      const hasPreview = onEnableApp !== undefined;

      commands.push({
        id: `store/${appId}`,
        icon: (
          <div className="relative">
            <IconComponent className="h-3.5 w-3.5 text-muted-foreground/50" />
            <DownloadSimpleIcon className="h-2 w-2 text-muted-foreground absolute -bottom-0.5 -right-0.5" />
          </div>
        ),
        label: app.displayName,
        description: parentApp == null ? "Available to install" : `Part of ${parentApp.displayName}`,
        keywords: [
          app.displayName.toLowerCase(),
          app.subtitle.toLowerCase(),
          appId,
          ...app.tags,
          "available",
          "install",
          "store",
          "app",
          ...(parentApp == null ? [] : ["sub-app", parentApp.displayName.toLowerCase()]),
        ],
        onAction: parentApp == null
          ? hasPreview
            ? { type: "focus" }
            : { type: "navigate", href: `/projects/${projectId}/apps/${appId}` }
          : { type: "navigate", href: parentDestination ?? `/projects/${projectId}/apps/${appId}` },
        preview: parentApp == null && hasPreview
          ? createAvailableAppPreview(
            appId,
            () => onEnableApp(appId),
            undefined
          )
          : null,
        hasVisualPreview: parentApp == null && hasPreview,
      });
    }

    // Settings items
    commands.push({
      id: "settings/explore-apps",
      icon: <CubeIcon className="h-3.5 w-3.5 text-muted-foreground" />,
      label: "Explore Apps",
      description: "Settings",
      keywords: ["apps", "marketplace", "store", "install"],
      onAction: { type: "navigate", href: `/projects/${projectId}/apps` },
      preview: null,
    });

    commands.push({
      id: "settings/project-keys",
      icon: <KeyIcon className="h-3.5 w-3.5 text-muted-foreground" />,
      label: "Project Keys",
      description: "Settings",
      keywords: ["api", "keys", "credentials", "secret"],
      onAction: { type: "navigate", href: `/projects/${projectId}/project-keys` },
      preview: null,
    });

    commands.push({
      id: "settings/project-settings",
      icon: <GearIcon className="h-3.5 w-3.5 text-muted-foreground" />,
      label: "Project Settings",
      description: "Settings",
      keywords: ["config", "configuration", "options"],
      onAction: { type: "navigate", href: `/projects/${projectId}/project-settings` },
      preview: null,
    });

    // AI-powered options (only when there's a query)
    if (query.trim()) {
      const askAiCommand: CmdKCommand = {
        id: "ai/ask",
        icon: <SparkleIcon className="h-3.5 w-3.5 text-purple-400" />,
        label: `Ask AI`,
        description: "Get an AI-powered answer from Hexclave docs",
        keywords: ["ai", "assistant", "help", "question"],
        onAction: { type: "focus" },
        preview: AIChatPreview,
        hasVisualPreview: true,
        highlightColor: "purple",
      };

      const runQueryCommand: CmdKCommand = {
        id: "query/run",
        icon: <PlayIcon className="h-3.5 w-3.5 text-amber-500" />,
        label: `Run Query`,
        description: "Execute ClickHouse SQL analytics queries",
        keywords: ["run", "execute", "query", "action", "command", "vibecode", "sql", "clickhouse", "analytics"],
        onAction: { type: "focus" },
        preview: RunQueryPreview,
        hasVisualPreview: true,
        highlightColor: "gold",
      };

      const orderedQueryCommands = shouldPrioritizeRunQuery
        ? [runQueryCommand, askAiCommand]
        : [askAiCommand, runQueryCommand];

      commands.push(...orderedQueryCommands);

      commands.push({
        id: "create/dashboard",
        icon: <LayoutIcon className="h-3.5 w-3.5 text-cyan-500" />,
        label: `Create Dashboard`,
        description: "Generate custom dashboards for your users",
        keywords: ["create", "dashboard", "generate", "ui", "interface", "panel"],
        onAction: { type: "focus" },
        preview: CreateDashboardPreview,
        hasVisualPreview: true,
        highlightColor: "cyan",
      });
    }

    return commands;
  }, [projectId, enabledApps, query, onEnableApp]);
}

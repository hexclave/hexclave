'use client';

import { CmdKSearch, CmdKTrigger } from "@/components/cmdk-search";
import { DashboardUserButton } from "@/components/dashboard-user-button";
import { Link } from "@/components/link";
import { Logo } from "@/components/logo";
import { ProjectSwitcher } from "@/components/project-switcher";
import { HexclaveCompanion } from "@/components/hexclave-companion";
import ThemeToggle from "@/components/theme-toggle";
import {
  Button,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Typography,
} from "@/components/ui";
import { WalkthroughProvider } from "@/components/walkthrough/walkthrough-provider";
import { ALL_APPS_FRONTEND, DUMMY_ORIGIN, getAppPath, getItemPath, hasNavigationItems, testAppPath, testItemPath, type NavigableAppFrontend } from "@/lib/apps-frontend";
import { getAppEnableConfigUpdate, getEnabledAppIds, getEnabledNavigableAppIds } from "@/lib/apps-utils";
import { useUpdateConfig } from "@/components/config-update";
import { cn } from "@/lib/utils";
import {
  CaretDownIcon,
  CaretRightIcon,
  DatabaseIcon,
  ChartBarIcon,
  CubeIcon,
  GearIcon,
  GlobeIcon,
  ListIcon,
  PlusIcon,
  SidebarIcon,
  UsersIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { TooltipPortal } from "@radix-ui/react-tooltip";
import { ALL_APPS, type AppId } from "@hexclave/shared/dist/apps/apps-config";
import { usePathname } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { useAdminApp, useProjectId } from "./use-admin-app";

type Item = {
  name: React.ReactNode,
  href: string,
  icon: PhosphorIcon,
  regex?: RegExp,
  type: 'item',
};

type AppSection = {
  appId?: AppId,
  name: string,
  icon: React.FunctionComponent<React.SVGProps<SVGSVGElement>>,
  items: {
    name: string,
    href: string,
    external?: boolean,
    match: (fullUrl: URL) => boolean,
  }[],
  firstItemHref?: string,
  firstItemExternal?: boolean,
};

type BottomItem = {
  name: string,
  href: string,
  icon: PhosphorIcon,
  external?: boolean,
  regex?: RegExp,
};

// Bottom navigation items (always visible)
const bottomItems: BottomItem[] = [
  {
    name: 'Explore Apps',
    href: '/apps',
    icon: CubeIcon,
    regex: /^\/projects\/[^\/]+\/apps(\/.*)?$/,
  },
];

// Overview item (always at top)
const overviewItem: Item = {
  name: "Overview",
  href: "/",
  regex: /^\/projects\/[^\/]+\/?$/,
  icon: GlobeIcon,
  type: 'item'
};

const usersItem: Item = {
  name: "Users",
  href: "/users",
  regex: /^\/projects\/[^\/]+\/users(\/.*)?$/,
  icon: UsersIcon,
  type: "item",
};

const dashboardsItem: Item = {
  name: "Dashboards",
  href: "/dashboards",
  regex: /^\/projects\/[^\/]+\/dashboards(\/.*)?$/,
  icon: ChartBarIcon,
  type: 'item',
};

// Internal-only pages that are rendered solely for the internal project.
const internalToolsItem: AppSection = {
  name: "Internal tools",
  icon: DatabaseIcon,
  firstItemHref: "/platform-analytics",
  items: [
    {
      name: "External DB Sync",
      href: "/external-db-sync",
      match: (fullUrl: URL) => /^\/projects\/[^\/]+\/external-db-sync(\/.*)?$/.test(fullUrl.pathname),
    },
    {
      name: "Platform Analytics",
      href: "/platform-analytics",
      match: (fullUrl: URL) => /^\/projects\/[^\/]+\/platform-analytics(\/.*)?$/.test(fullUrl.pathname),
    },
    {
      name: "Newly Created Projects",
      href: "/newly-created-projects",
      match: (fullUrl: URL) => /^\/projects\/[^\/]+\/newly-created-projects(\/.*)?$/.test(fullUrl.pathname),
    },
    {
      name: "Ask Hexclave History",
      href: "/ask-hexclave-history",
      match: (fullUrl: URL) => /^\/projects\/[^\/]+\/ask-hexclave-history(\/.*)?$/.test(fullUrl.pathname),
    },
    {
      name: "Sign-up Risk Inspector",
      href: "/sign-up-risk-inspector",
      match: (fullUrl: URL) => /^\/projects\/[^\/]+\/sign-up-risk-inspector(\/.*)?$/.test(fullUrl.pathname),
    },
  ],
};

const projectSettingsItem: AppSection = {
  name: "Project Settings",
  icon: GearIcon,
  firstItemHref: "/project-settings",
  items: [
    {
      name: "General",
      href: "/project-settings",
      match: (fullUrl: URL) => /^\/projects\/[^\/]+\/project-settings\/?$/.test(fullUrl.pathname),
    },
    {
      name: "Billing & Usage",
      href: "/project-settings/usage",
      match: (fullUrl: URL) => /^\/projects\/[^\/]+\/project-settings\/usage(\/.*)?$/.test(fullUrl.pathname),
    },
    {
      name: "Secrets",
      href: "/project-settings/secrets",
      match: (fullUrl: URL) => /^\/projects\/[^\/]+\/project-settings\/secrets(\/.*)?$/.test(fullUrl.pathname),
    },
    {
      name: "Project Keys",
      href: "/project-keys",
      match: (fullUrl: URL) => /^\/projects\/[^\/]+\/project-keys(\/.*)?$/.test(fullUrl.pathname),
    },
    {
      name: "Trusted Domains",
      href: "/domains",
      match: (fullUrl: URL) => /^\/projects\/[^\/]+\/domains(\/.*)?$/.test(fullUrl.pathname),
    },
  ],
};

function NavItem({
  item,
  href,
  onClick,
  isExpanded,
  onToggle,
  isCollapsed,
  onExpandSidebar,
}: {
  item: Item | AppSection,
  href?: string,
  onClick?: () => void,
  isExpanded?: boolean,
  onToggle?: () => void,
  isCollapsed?: boolean,
  onExpandSidebar?: () => void,
}) {
  const pathname = usePathname();
  const isSection = 'items' in item;
  const subItemsRef = useRef<HTMLDivElement>(null);
  const currentUrl = useMemo(() => {
    try {
      return new URL(pathname, DUMMY_ORIGIN);
    } catch {
      return null;
    }
  }, [pathname]);

  // If this is a collapsible section
  const IconComponent = item.icon;
  const isDirectItemActive = "type" in item && item.regex?.test(pathname);

  const matchesCurrentUrl = (sectionItem: AppSection["items"][number]) => {
    if (!currentUrl) {
      return false;
    }
    try {
      return sectionItem.match(currentUrl);
    } catch {
      return false;
    }
  };

  const isSectionActive = isSection
    ? item.items.some((sectionItem) => matchesCurrentUrl(sectionItem))
    : false;

  const isHighlighted = isDirectItemActive || isSectionActive;

  const activeItemClasses = "bg-white/70 text-foreground shadow-sm ring-1 ring-white/60 dark:bg-transparent dark:bg-gradient-to-r dark:from-blue-500/[0.15] dark:to-blue-500/[0.08] dark:shadow-[0_0_12px_rgba(59,130,246,0.15)] dark:ring-blue-500/20";
  const activeSectionClasses = "text-foreground hover:bg-white/55 dark:hover:bg-background/60";
  const inactiveClasses = cn(
    "hover:bg-white/55 dark:hover:bg-background/60",
    "text-muted-foreground hover:text-foreground"
  );

  const buttonClasses = cn(
    "group flex h-8 w-full items-center justify-between rounded-lg pl-2 pr-0.5 py-2 text-left text-sm font-semibold transition-all duration-150 hover:transition-none",
    isHighlighted ? (isSection ? activeSectionClasses : activeItemClasses) : inactiveClasses,
    "cursor-pointer"
  );

  const iconClasses = cn(
    "h-4 w-4 flex-shrink-0 transition-colors duration-150 group-hover:transition-none",
    isHighlighted
      ? "text-indigo-700 dark:text-blue-400"
      : "text-muted-foreground group-hover:text-foreground"
  );

  const caretClasses = cn(
    "h-[13px] w-[13px] flex-shrink-0 transition-all duration-150 group-hover:transition-none",
    isHighlighted
      ? "text-indigo-700 dark:text-blue-400"
      : "text-muted-foreground group-hover:text-foreground",
    isSection && isExpanded && "rotate-180"
  );

  if (isCollapsed) {
    // For sections, navigate to the first item when collapsed
    const collapsedHref = isSection && item.firstItemHref ? item.firstItemHref : href;
    const collapsedTarget = isSection && item.firstItemExternal ? "_blank" : undefined;

    return (
      <div className="flex justify-center">
        <Tooltip>
          <TooltipTrigger asChild>
            {isSection ? (
              <Button
                asChild
                variant="ghost"
                size="sm"
                className={cn(
                  "h-9 w-9 p-0 justify-center rounded-lg transition-all duration-150 hover:transition-none",
                  isHighlighted
                    ? "text-foreground hover:bg-white/40 dark:hover:bg-background/60"
                    : "hover:bg-white/40 dark:hover:bg-background/60 text-muted-foreground hover:text-foreground"
                )}
              >
                <Link href={collapsedHref ?? "#"} target={collapsedTarget} onClick={onClick}>
                  <IconComponent className={iconClasses} />
                </Link>
              </Button>
            ) : (
              <Button
                asChild
                variant="ghost"
                size="sm"
                className={cn(
                  "h-9 w-9 p-0 justify-center rounded-lg transition-all duration-150 hover:transition-none",
                  isHighlighted
                    ? "bg-white/70 shadow-sm ring-1 ring-white/60 dark:bg-blue-500/[0.12] dark:shadow-[0_0_12px_rgba(59,130,246,0.15)] dark:ring-blue-500/20"
                    : "hover:bg-white/40 dark:hover:bg-background/60 text-muted-foreground hover:text-foreground"
                )}
              >
                <Link href={href ?? "#"} onClick={onClick} className="flex items-center justify-center">
                  <IconComponent className={iconClasses} />
                </Link>
              </Button>
            )}
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent side="right" className="!z-[9999]">
              {item.name}
            </TooltipContent>
          </TooltipPortal>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="transition-[margin] duration-200">
      {isSection ? (
        <div className={buttonClasses}>
          <Link
            href={item.firstItemHref ?? href ?? "#"}
            onClick={() => {
              if (!isExpanded) {
                onToggle?.();
              }
              onClick?.();
            }}
            className="flex min-w-0 flex-1 items-center gap-3"
          >
            <IconComponent className={iconClasses} />
            <span className="truncate text-sm">{item.name}</span>
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggle?.();
            }}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? `Collapse ${item.name}` : `Expand ${item.name}`}
            className="h-7 w-7 rounded-md p-0 text-muted-foreground transition-all duration-150 hover:bg-white/30 hover:text-foreground hover:transition-none dark:hover:bg-background/40"
          >
            <CaretDownIcon weight="bold" className={caretClasses} />
          </Button>
        </div>
      ) : (
        <Button
          asChild
          variant="ghost"
          size="sm"
          className={buttonClasses}
        >
          <Link href={href ?? "#"} onClick={onClick} className="flex w-full items-center gap-3">
            <IconComponent className={iconClasses} />
            <span className="flex-1 truncate text-sm">{item.name}</span>
          </Link>
        </Button>
      )}

      {isSection && (
        <div
          ref={subItemsRef}
          style={{
            height: isExpanded
              ? subItemsRef.current
                ? `${subItemsRef.current.scrollHeight}px`
                : undefined
              : "0px",
          }}
          className={cn(
            "ml-[0.5px] w-[calc(100%-1px)] overflow-hidden transition-[height] duration-200",
            !isExpanded && "h-0"
          )}
        >
          <div className="space-y-2 py-2 pl-3">
            {item.items.map((navItem) => (
              <NavSubItem key={navItem.href} item={navItem} href={navItem.href} onClick={onClick} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NavSubItem({
  item,
  href,
  onClick,
}: {
  item: AppSection["items"][number],
  href: string,
  onClick?: () => void,
}) {
  const pathname = usePathname();
  const isActive = useMemo(() => {
    try {
      return item.match(new URL(pathname, DUMMY_ORIGIN));
    } catch {
      return false;
    }
  }, [item, pathname]);
  return (
    <Link
      href={href}
      target={item.external ? "_blank" : undefined}
      onClick={onClick}
      className={cn(
        "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150 hover:transition-none",
        isActive
          ? "bg-white/70 text-foreground shadow-sm ring-1 ring-white/60 dark:bg-transparent dark:bg-gradient-to-r dark:from-blue-500/[0.15] dark:to-blue-500/[0.08] dark:shadow-[0_0_12px_rgba(59,130,246,0.15)] dark:ring-blue-500/20"
          : "text-muted-foreground hover:text-foreground hover:bg-white/40 dark:hover:bg-background/60"
      )}
    >
      <span className="relative flex h-2 w-2 items-center justify-center">
        <span
          className={cn(
            "h-2 w-2 rounded-full transition-all duration-150 group-hover:transition-none",
            isActive
              ? "bg-indigo-700 dark:bg-blue-400"
              : "bg-muted-foreground/40 group-hover:bg-indigo-500/50 dark:group-hover:bg-blue-500/50"
          )}
        />
      </span>
      <span className="truncate leading-none">{item.name}</span>
    </Link>
  );
}

// Memoized component for app navigation items to prevent unnecessary re-renders
function AppNavItem({
  appId,
  projectId,
  isExpanded,
  onToggle,
  isCollapsed,
  onExpandSidebar,
  onClick,
}: {
  appId: AppId,
  projectId: string,
  isExpanded: boolean,
  onToggle: () => void,
  isCollapsed?: boolean,
  onExpandSidebar?: () => void,
  onClick?: () => void,
}) {
  const app = ALL_APPS[appId];
  const appFrontend = ALL_APPS_FRONTEND[appId];

  // Memoize the item object to prevent NavItem re-renders
  const navItemData = useMemo(() => {
    if (!hasNavigationItems(appFrontend)) {
      return null;
    }
    const navigableFrontend: NavigableAppFrontend = appFrontend;
    const items = navigableFrontend.navigationItems
      .map((navItem) => ({
        name: navItem.displayName,
        href: getItemPath(projectId, navigableFrontend, navItem),
        external: navItem.external,
        match: (fullUrl: URL) => testItemPath(projectId, navigableFrontend, navItem, fullUrl),
      }));
    return {
      name: app.displayName,
      appId,
      items,
      href: getAppPath(projectId, appFrontend),
      icon: appFrontend.icon,
      firstItemHref: items[0]?.href,
      firstItemExternal: items[0]?.external,
    };
  }, [app.displayName, appId, appFrontend, projectId]);

  if (navItemData == null) {
    return null;
  }

  return (
    <NavItem
      item={navItemData}
      isExpanded={isExpanded}
      onToggle={onToggle}
      isCollapsed={isCollapsed}
      onExpandSidebar={onExpandSidebar}
      onClick={onClick}
    />
  );
}

function SidebarContent({
  projectId,
  onNavigate,
  isCollapsed,
  onToggleCollapse,
  isDrawer = false,
}: {
  projectId: string,
  onNavigate?: () => void,
  isCollapsed?: boolean,
  onToggleCollapse?: () => void,
  isDrawer?: boolean,
}) {
  const hexclaveAdminApp = useAdminApp();
  const pathname = usePathname();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();

  // Memoize enabledApps to prevent recalculation on every render
  const enabledApps = useMemo(() =>
    getEnabledNavigableAppIds(config.apps.installed),
    [config.apps.installed]
  );

  // Memoize getDefaultExpandedSections to prevent recreating the function
  const getDefaultExpandedSections = useCallback((): Set<AppId> => {
    const currentUrl = new URL(pathname, DUMMY_ORIGIN);
    for (const enabledApp of enabledApps) {
      const appFrontend = ALL_APPS_FRONTEND[enabledApp];
      if (!(appFrontend as any)) {
        continue;
      }
      if (testAppPath(projectId, appFrontend, currentUrl)) {
        return new Set([enabledApp]);
      }
    }
    return new Set(["authentication"]);
  }, [enabledApps, pathname, projectId]);

  const [expandedSections, setExpandedSections] = useState<Set<AppId>>(() => getDefaultExpandedSections());
  const [isProjectSettingsExpanded, setIsProjectSettingsExpanded] = useState(() =>
    /^\/projects\/[^\/]+\/(project-settings|project-keys|domains)(\/.*)?$/.test(pathname)
  );
  const [isInternalToolsExpanded, setIsInternalToolsExpanded] = useState(() =>
    /^\/projects\/[^\/]+\/(platform-analytics|external-db-sync|newly-created-projects|ask-hexclave-history|sign-up-risk-inspector)(\/.*)?$/.test(pathname)
  );
  const internalToolsSection = useMemo<AppSection>(() => ({
    ...internalToolsItem,
    firstItemHref: `/projects/${projectId}${internalToolsItem.firstItemHref ?? "/platform-analytics"}`,
    items: internalToolsItem.items.map((item) => ({
      ...item,
      href: `/projects/${projectId}${item.href}`,
    })),
  }), [projectId]);
  const projectSettingsSection = useMemo<AppSection>(() => ({
    ...projectSettingsItem,
    firstItemHref: `/projects/${projectId}${projectSettingsItem.firstItemHref ?? "/project-settings"}`,
    items: projectSettingsItem.items.map((item) => ({
      ...item,
      href: `/projects/${projectId}${item.href}`,
    })),
  }), [projectId]);

  const toggleSection = useCallback((appId: AppId) => {
    setExpandedSections(prev => {
      const newSet = new Set(prev);
      if (newSet.has(appId)) {
        newSet.delete(appId);
      } else {
        newSet.add(appId);
      }
      return newSet;
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn("flex flex-grow flex-col overflow-y-auto py-4 transition-all duration-200", isCollapsed ? "px-2" : "px-3")}
        style={{
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 24px, black calc(100% - 24px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 24px, black calc(100% - 24px), transparent 100%)',
        }}
      >
        <div className="space-y-2">
          <NavItem
            item={overviewItem}
            onClick={onNavigate}
            href={`/projects/${projectId}${overviewItem.href}`}
            isCollapsed={isCollapsed}
          />
          <NavItem
            item={usersItem}
            onClick={onNavigate}
            href={`/projects/${projectId}${usersItem.href}`}
            isCollapsed={isCollapsed}
          />
          <NavItem
            item={dashboardsItem}
            onClick={onNavigate}
            href={`/projects/${projectId}${dashboardsItem.href}`}
            isCollapsed={isCollapsed}
          />
          {projectId === "internal" && (
            <NavItem
              item={internalToolsSection}
              onClick={onNavigate}
              isExpanded={isInternalToolsExpanded}
              onToggle={() => setIsInternalToolsExpanded((value) => !value)}
              isCollapsed={isCollapsed}
            />
          )}
        </div>

        <div className={cn("mt-6 mb-3 transition-opacity duration-200", isCollapsed ? "opacity-0 h-0 mt-2 mb-0 overflow-hidden" : "opacity-100")}>
          <Typography className="px-1 text-xs font-semibold uppercase tracking-wide text-foreground/70">
            My Apps
          </Typography>
        </div>

        <div className={cn("space-y-2", isCollapsed && "mt-2")}>
          {enabledApps.map((appId) => (
            <AppNavItem
              key={appId}
              appId={appId}
              projectId={projectId}
              isExpanded={expandedSections.has(appId)}
              onToggle={() => toggleSection(appId)}
              isCollapsed={isCollapsed}
              onClick={onNavigate}
            />
          ))}
          {!isCollapsed && (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="mt-2 w-full justify-center gap-1.5 rounded-lg bg-transparent px-1.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/75 transition-colors duration-150 hover:bg-transparent hover:text-foreground hover:transition-none focus-visible:ring-border"
            >
              <Link href={`/projects/${projectId}/apps`} onClick={onNavigate} className="justify-center">
                <PlusIcon className="h-3.5 w-3.5" />
                <span>Install apps</span>
              </Link>
            </Button>
          )}
        </div>

        <div className="flex-grow" />
      </div>

      <div className={cn(
        "sticky bottom-0 border-t border-black/[0.06] dark:border-foreground/10 py-3 transition-all duration-200 bg-black/[0.03] dark:bg-foreground/[0.06] dark:backdrop-blur-xl",
        !isDrawer && "dark:rounded-b-2xl",
        isCollapsed ? "px-2" : "px-3",
      )}>
        <div className="space-y-2">
          {bottomItems.map((item) => (
            <NavItem
              key={item.name}
              onClick={onNavigate}
              item={{
                name: item.name,
                type: "item",
                href: item.href,
                icon: item.icon,
                regex: item.regex,
              }}
              href={item.external ? item.href : `/projects/${projectId}${item.href}`}
              isCollapsed={isCollapsed}
            />
          ))}
          <NavItem
            item={projectSettingsSection}
            onClick={onNavigate}
            isExpanded={isProjectSettingsExpanded}
            onToggle={() => setIsProjectSettingsExpanded((prev) => !prev)}
            isCollapsed={isCollapsed}
          />
        </div>

        {/* User button and collapse toggle */}
        <div className={cn(
          "mt-4 pt-3 border-t border-border/30 flex items-center gap-2 min-w-0",
          isCollapsed ? "justify-center" : "justify-between"
        )}>
          {!isCollapsed && (
            <div className="min-w-0 flex-1 overflow-hidden max-w-[calc(100%-3rem)]">
              <div className="w-full min-w-0 [&_button]:min-w-0 [&_button]:w-full [&_button]:max-w-full">
                <DashboardUserButton showUserInfo />
              </div>
            </div>
          )}
          {onToggleCollapse && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onToggleCollapse}
                  className="h-8 w-8 p-1 flex-shrink-0 text-muted-foreground hover:text-foreground hover:bg-background/60 rounded-lg transition-all duration-150 hover:transition-none"
                >
                  <SidebarIcon className={cn("h-4 w-4 transition-transform duration-200", isCollapsed && "rotate-180")} />
                </Button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent side="right" className="!z-[9999]">
                  {isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                </TooltipContent>
              </TooltipPortal>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

function SpotlightSearchWrapper({ projectId }: { projectId: string }) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();

  const enabledApps = useMemo(() =>
    getEnabledAppIds(config.apps.installed),
    [config.apps.installed]
  );

  const handleEnableApp = useCallback(async (appId: AppId) => {
    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: getAppEnableConfigUpdate(appId),
      pushable: true,
    });
  }, [hexclaveAdminApp, updateConfig]);

  return <CmdKSearch projectId={projectId} enabledApps={enabledApps} onEnableApp={handleEnableApp} />;
}

export default function SidebarLayout(props: { children?: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const projectId = useProjectId();
  const pathname = usePathname();
  // Custom dashboard detail pages have a transparent iframe background; the companion should match.
  const isCustomDashboardPage = /\/dashboards\/[^/]+/.test(pathname);

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);

  return (
    <WalkthroughProvider>
      <TooltipProvider>
        <div className="mx-auto w-full flex h-screen min-h-0 flex-col overflow-y-auto dark:bg-background dark:shadow-2xl dark:border-x dark:border-border/5">
          {/* Header - Glassmorphic with vertical blur gradient (light) / Floating card (dark) */}
          <div className="sticky top-0 z-20 relative dark:top-3 dark:mx-3 dark:mb-3 dark:mt-3 dark:rounded-2xl">
            {/* Vertical blur layer behind header - light mode only */}
            <div
              className="absolute inset-0 h-[calc(100%+0.75rem)] pointer-events-none dark:hidden"
              style={{
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                maskImage: 'linear-gradient(to bottom, black 50%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, black 50%, transparent 100%)',
              }}
            />
            <div className="relative flex h-14 items-center justify-between px-5 dark:bg-foreground/5 dark:px-4 dark:border dark:border-foreground/5 dark:backdrop-blur-2xl dark:shadow-sm dark:rounded-2xl">
              {/* Left section: Logo + Menu + Project Switcher */}
              <div className="flex grow-1 items-center gap-2">
                {/* Mobile: Menu button */}
                <Sheet onOpenChange={(open) => setSidebarOpen(open)} open={sidebarOpen}>
                  <SheetTitle className="hidden">
                    Sidebar Menu
                  </SheetTitle>
                  <SheetTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="lg:hidden h-9 w-9 p-0 text-muted-foreground hover:text-foreground"
                    >
                      <ListIcon className="h-4 w-4" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent
                    aria-describedby={undefined}
                    side='left'
                    className="w-[248px] bg-white/90 dark:bg-foreground/5 border-black/[0.06] dark:border-foreground/5 p-0 backdrop-blur-sm shadow-md"
                    hasCloseButton={false}
                  >
                    <SidebarContent projectId={projectId} onNavigate={() => setSidebarOpen(false)} isDrawer />
                  </SheetContent>
                </Sheet>

                {/* Desktop: Logo + Breadcrumb + Project Switcher */}
                <div className="hidden lg:flex items-center gap-2">
                  <Logo height={24} href="/" />
                  <CaretRightIcon className="h-4 w-4 text-muted-foreground/50" />
                  <ProjectSwitcher currentProjectId={projectId} />
                </div>

                {/* Mobile: Logo */}
                <div className="lg:hidden">
                  <Logo full height={24} href="/projects" />
                </div>
              </div>

              {/* Middle section: Control Center */}
              <div className="grow-1">
                <CmdKTrigger />
              </div>

              {/* Right section: Search, Theme toggle and User button */}
              <div className="flex grow-1 gap-2 items-center">
                <ThemeToggle />
                <DashboardUserButton />
              </div>
            </div>
          </div>

          {/* Spotlight Search */}
          <SpotlightSearchWrapper projectId={projectId} />

          {/* Body Layout (Left Sidebar + Content + Right Companion) */}
          <div className="relative flex flex-1 items-start w-full has-[[data-contained-height]]:min-h-0 has-[[data-contained-height]]:items-stretch">
            {/* Left Sidebar - Sticky */}
            <aside
              className={cn(
              "sticky top-14 h-[calc(100vh-3.5rem)] hidden flex-col lg:flex z-[10] transition-[width] duration-200 ease-in-out dark:top-20 dark:h-[calc(100vh-6rem)] dark:ml-3 dark:bg-foreground/5 dark:border dark:border-foreground/5 dark:backdrop-blur-2xl dark:rounded-2xl dark:shadow-sm",
              isCollapsed ? "w-[64px]" : "w-[248px]"
            )}
            >
              <SidebarContent
                projectId={projectId}
                isCollapsed={isCollapsed}
                onToggleCollapse={toggleCollapsed}
              />
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 min-w-0 pt-1 pb-3 px-3 lg:pl-0 lg:pr-24 dark:py-0 dark:px-2 dark:pb-3 dark:lg:pr-24 has-[[data-contained-height]]:flex has-[[data-contained-height]]:min-h-0 has-[[data-contained-height]]:flex-col">
              <div className={cn(
              "relative flex min-w-0 flex-col overflow-visible has-[[data-full-bleed]]:h-full",
              // Light mode card styling (companion gutter is on <main>, not here — avoids empty card chrome behind Stack Companion)
              "min-h-[calc(100vh-4.5rem)] bg-white/80 backdrop-blur-xl shadow-[0_4px_24px_rgba(0,0,0,0.06),0_1px_4px_rgba(0,0,0,0.04)] rounded-2xl border border-black/[0.06]",
              // Dark mode: remove card styling
              "dark:bg-transparent dark:backdrop-blur-none dark:shadow-none dark:rounded-none dark:border-0",
              // Contained pages own their internal scroll regions, so the shell must pass down a finite flex height instead of sizing to content.
              "has-[[data-contained-height]]:flex-1 has-[[data-contained-height]]:min-h-0 has-[[data-contained-height]]:overflow-hidden",
              // Full-bleed pages (email editors etc.): remove card styling in light mode too
              "has-[[data-full-bleed]]:min-h-0 has-[[data-full-bleed]]:bg-transparent has-[[data-full-bleed]]:backdrop-blur-none has-[[data-full-bleed]]:shadow-none has-[[data-full-bleed]]:rounded-none has-[[data-full-bleed]]:border-0",
            )}>
                {props.children}
              </div>
            </main>

            {/* Stack Companion - overlay with reserved content gutter */}
            <div className="pointer-events-none absolute top-0 right-2 bottom-0 z-30 hidden lg:block">
              <HexclaveCompanion className="pointer-events-auto" glassBg={isCustomDashboardPage} />
            </div>
          </div>
        </div>
      </TooltipProvider>
    </WalkthroughProvider>
  );
}

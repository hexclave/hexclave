"use client";

import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, normalizeSidebarWidth } from "../lib/sidebar-size";
import { AccountMenu } from "./AccountMenu";
import { ThemeToggle } from "./ThemeToggle";
import { Resizer, cn, useResizableWidth } from "./design";

export type AppTab = "overview" | "calls" | "feature-requests" | "knowledge" | "usage" | "feedback";

const SIDEBAR_WIDTH_STORAGE_KEY = "internal-tool-sidebar-width";
const MCP_ITEMS: ReadonlyArray<{ id: AppTab, label: string }> = [
  { id: "calls", label: "MCP Review" },
  { id: "feature-requests", label: "Feature Requests" },
  { id: "feedback", label: "Feedback" },
];
const CONTENT_ITEMS: ReadonlyArray<{ id: AppTab, label: string }> = [
  { id: "knowledge", label: "Knowledge Base" },
];
const UNIFIED_AI_ITEMS: ReadonlyArray<{ id: AppTab, label: string }> = [
  { id: "usage", label: "AI Usage" },
];

export function isAppTab(value: string): value is AppTab {
  return value === "overview"
    || value === "calls"
    || value === "feature-requests"
    || value === "knowledge"
    || value === "usage"
    || value === "feedback";
}

export function appTabLabel(tab: AppTab): string {
  switch (tab) {
    case "overview": { return "Overview"; }
    case "calls": { return "MCP Review"; }
    case "feature-requests": { return "Feature Requests"; }
    case "knowledge": { return "Knowledge Base"; }
    case "usage": { return "AI Usage"; }
    case "feedback": { return "Feedback"; }
  }
}

function TabIcon({ tab }: { tab: AppTab }) {
  const iconClasses = "size-4 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.7]";
  switch (tab) {
    case "overview": {
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className={iconClasses}>
          <path d="M3.5 10.5V16h5v-5.5h3V16h5v-8L10 3 3.5 8v2.5Z" />
        </svg>
      );
    }
    case "calls": {
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className={iconClasses}>
          <path d="M4 4.5h12v8H9l-3.5 3v-3H4v-8Z" />
          <path d="M7 8.5h6" />
        </svg>
      );
    }
    case "feature-requests": {
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className={iconClasses}>
          <path d="M10 3.5a4.5 4.5 0 0 0-2.8 8v2h5.6v-2a4.5 4.5 0 0 0-2.8-8Z" />
          <path d="M8 16.5h4M7.8 8.5h4.4M10 6.3v4.4" />
        </svg>
      );
    }
    case "knowledge": {
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className={iconClasses}>
          <path d="M3.5 4.5h5A1.5 1.5 0 0 1 10 6v10a2 2 0 0 0-2-2H3.5V4.5ZM16.5 4.5h-5A1.5 1.5 0 0 0 10 6v10a2 2 0 0 1 2-2h4.5V4.5Z" />
        </svg>
      );
    }
    case "usage": {
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className={iconClasses}>
          <path d="M4 15.5V11M8 15.5V7.5M12 15.5v-10M16 15.5V9" />
        </svg>
      );
    }
    case "feedback": {
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className={iconClasses}>
          <path d="M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z" />
          <path d="M7.5 8.5h.01M12.5 8.5h.01M7.5 12c.8.7 1.63 1 2.5 1s1.7-.3 2.5-1" />
        </svg>
      );
    }
  }
}

function NavigationItem({
  id,
  label,
  activeTab,
  onNavigate,
}: {
  id: AppTab,
  label: string,
  activeTab: AppTab,
  onNavigate: (tab: AppTab) => void,
}) {
  const isActive = activeTab === id;
  return (
    <button
      type="button"
      title={label}
      onClick={() => onNavigate(id)}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center justify-center gap-2.5 rounded-lg px-2 text-left text-xs font-medium lg:justify-start lg:px-2.5",
        "transition-colors duration-150 hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        isActive
          ? "bg-foreground/[0.09] text-foreground ring-1 ring-foreground/[0.06]"
          : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      <TabIcon tab={id} />
      <span className="hidden min-w-0 flex-1 truncate lg:block">{label}</span>
    </button>
  );
}

function NavigationGroup({
  label,
  items,
  activeTab,
  onNavigate,
}: {
  label: string,
  items: ReadonlyArray<{ id: AppTab, label: string }>,
  activeTab: AppTab,
  onNavigate: (tab: AppTab) => void,
}) {
  return (
    <div className="space-y-1">
      <p className="hidden px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 lg:block">{label}</p>
      {items.map(item => (
        <NavigationItem key={item.id} {...item} activeTab={activeTab} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

export function AppSidebar({
  activeTab,
  onNavigate,
  displayName,
  email,
  onOpenAccountSettings,
  onSignOut,
}: {
  activeTab: AppTab,
  onNavigate: (tab: AppTab) => void,
  displayName?: string | null,
  email?: string | null,
  onOpenAccountSettings: () => Promise<void>,
  onSignOut: () => Promise<void>,
}) {
  const { width: sidebarWidth, isResizing, resizerProps } = useResizableWidth({
    label: "navigation sidebar",
    storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
    defaultWidth: DEFAULT_SIDEBAR_WIDTH,
    minWidth: MIN_SIDEBAR_WIDTH,
    maxWidth: MAX_SIDEBAR_WIDTH,
    normalize: normalizeSidebarWidth,
    edge: "right",
  });
  const trimmedDisplayName = displayName?.trim();
  const trimmedEmail = email?.trim();
  const accountName = trimmedDisplayName != null && trimmedDisplayName !== ""
    ? trimmedDisplayName
    : trimmedEmail != null && trimmedEmail !== "" ? trimmedEmail : "Signed-in user";
  const accountDetail = email != null && email.trim() !== "" && email !== accountName ? email : "Internal access";
  const accountInitial = accountName[0].toUpperCase();

  return (
    <aside
      style={{ width: sidebarWidth }}
      className={cn(
        "relative flex shrink-0 flex-col border-r border-black/[0.06] bg-card/80 backdrop-blur-xl max-lg:!w-[4.25rem] dark:border-white/[0.06]",
        isResizing && "select-none",
      )}
    >
      <div className="flex h-14 shrink-0 items-center justify-center gap-2.5 border-b border-black/[0.06] px-2 dark:border-white/[0.06] lg:justify-start lg:px-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-[11px] font-bold tracking-tight text-primary-foreground shadow-sm">
          HX
        </div>
        <div className="hidden min-w-0 lg:block">
          <h1 className="truncate text-sm font-semibold tracking-tight text-foreground">AI Operations</h1>
          <p className="truncate text-[10px] text-muted-foreground">Hexclave internal</p>
        </div>
      </div>

      <nav aria-label="Internal tool sections" className="flex flex-1 flex-col gap-4 overflow-y-auto p-2 lg:p-3">
        <NavigationItem id="overview" label="Overview" activeTab={activeTab} onNavigate={onNavigate} />
        <div className="mx-2 border-t border-black/[0.05] dark:border-white/[0.05] lg:hidden" />
        <NavigationGroup label="MCP" items={MCP_ITEMS} activeTab={activeTab} onNavigate={onNavigate} />
        <NavigationGroup label="Unified AI" items={UNIFIED_AI_ITEMS} activeTab={activeTab} onNavigate={onNavigate} />
        <NavigationGroup label="Content" items={CONTENT_ITEMS} activeTab={activeTab} onNavigate={onNavigate} />
      </nav>

      <div className="space-y-2 border-t border-black/[0.06] p-2 dark:border-white/[0.06] lg:p-3">
        <AccountMenu
          accountName={accountName}
          accountDetail={accountDetail}
          accountInitial={accountInitial}
          onOpenAccountSettings={onOpenAccountSettings}
          onSignOut={onSignOut}
        />
        <div className="border-t border-black/[0.05] pt-2 dark:border-white/[0.05]">
          <div className="mb-1.5 hidden items-center justify-between px-1 lg:flex">
            <span className="text-[10px] font-medium text-muted-foreground">Appearance</span>
          </div>
          <ThemeToggle />
        </div>
      </div>

      <Resizer {...resizerProps} />
    </aside>
  );
}

"use client";

import { useHexclaveApp, useUser } from "@hexclave/next";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { cn } from "../../components/design/cn";
import { useTheme, type Theme } from "../../lib/theme";
import { useConsoleData } from "../data/console-data";
import { needsHumanReview } from "../lib/mcp";
import { Icon, type IconName } from "../ui/icons";
import { useDismiss } from "../ui/overlays";
import { Kbd, StatusDot } from "../ui/primitives";
import { activeConsolePage, navSections, type ConsolePageId } from "./nav";

export function Sidebar({ collapsed, onToggleCollapsed, onOpenPalette, onNavigate }: {
  collapsed: boolean,
  onToggleCollapsed: () => void,
  onOpenPalette: () => void,
  /** Called after a nav click; the mobile drawer uses it to close itself. */
  onNavigate?: () => void,
}) {
  const pathname = usePathname();
  const active = activeConsolePage(pathname);
  const { mcp } = useConsoleData();
  const needsReviewCount = useMemo(() => mcp.rows.filter(needsHumanReview).length, [mcp.rows]);
  const counts = new Map<ConsolePageId, number>([["mcp", needsReviewCount]]);

  return (
    <aside
      aria-label="Console navigation"
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-[hsl(var(--sidebar))]",
        collapsed ? "w-[60px]" : "w-[240px]",
      )}
    >
      <div className={cn("flex h-14 shrink-0 items-center gap-2.5 px-3", collapsed && "justify-center")}>
        <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[hsl(var(--brand))] to-[hsl(var(--chart-2))] text-[10px] font-bold tracking-tight text-white shadow-sm">
          HX
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold leading-4 tracking-tight text-foreground">AI Operations</p>
            <p className="truncate text-[11px] leading-4 text-muted-foreground">Hexclave internal</p>
          </div>
        )}
        {!collapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="hidden size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground hover:transition-none md:grid"
          >
            <Icon name="sidebar" size="sm" />
          </button>
        )}
      </div>

      <div className="px-2.5 pb-2">
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="Search or jump to (Command K)"
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-lg border border-border bg-card text-xs text-muted-foreground shadow-[0_1px_1px_hsl(var(--foreground)/0.03)] transition-colors hover:bg-muted hover:text-foreground hover:transition-none",
            collapsed ? "justify-center px-0" : "px-2.5",
          )}
        >
          <Icon name="search" size="sm" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Jump to…</span>
              <Kbd>⌘K</Kbd>
            </>
          )}
        </button>
      </div>

      <nav className="hx-scroll flex-1 space-y-4 overflow-y-auto px-2.5 py-2">
        {navSections().map(section => (
          <div key={section.label ?? "root"} className="space-y-0.5">
            {section.label != null && !collapsed && (
              <p className="px-2 pb-1 text-[11px] font-medium text-muted-foreground/80">{section.label}</p>
            )}
            {section.label != null && collapsed && <div className="mx-2 mb-1.5 border-t border-border" />}
            {section.pages.map(page => {
              const isActive = active?.id === page.id;
              const count = counts.get(page.id);
              return (
                <Link
                  key={page.id}
                  href={page.href}
                  onClick={onNavigate}
                  aria-current={isActive ? "page" : undefined}
                  title={collapsed ? page.label : undefined}
                  className={cn(
                    "group relative flex h-8 items-center gap-2.5 rounded-lg text-[13px] transition-colors hover:transition-none",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                    collapsed ? "justify-center px-0" : "px-2",
                    isActive
                      ? "bg-card font-medium text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.06)] ring-1 ring-border"
                      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                  )}
                >
                  <Icon name={page.icon} className={cn(isActive && "text-[hsl(var(--brand))]")} />
                  {!collapsed && <span className="min-w-0 flex-1 truncate">{page.label}</span>}
                  {count != null && count > 0 && (
                    collapsed
                      ? <span className="absolute right-2 top-1.5 size-1.5 rounded-full bg-amber-500" />
                      : <span title={`${count} awaiting human review`} className="rounded-md bg-amber-500/15 px-1.5 text-[10.5px] font-semibold tabular-nums leading-5 text-amber-700 dark:text-amber-300">{count}</span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="space-y-1 border-t border-border p-2.5">
        <ConnectionStatus collapsed={collapsed} />
        <ThemeSwitch collapsed={collapsed} />
        <AccountButton collapsed={collapsed} />
        {collapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="hidden h-8 w-full place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground hover:transition-none md:grid"
          >
            <Icon name="sidebar" size="sm" />
          </button>
        )}
      </div>
    </aside>
  );
}

function ConnectionStatus({ collapsed }: { collapsed: boolean }) {
  const { connection } = useConsoleData();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), rootRef);
  const label = connection.state === "connected" ? "Live" : connection.state === "connecting" ? "Connecting…" : "Connection issue";
  const tone = connection.state === "connected" ? "green" : connection.state === "connecting" ? "amber" : "red";
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(previous => !previous)}
        aria-expanded={open}
        title={collapsed ? label : undefined}
        className={cn(
          "flex h-8 w-full items-center gap-2.5 rounded-lg text-xs transition-colors hover:bg-foreground/[0.04] hover:transition-none",
          collapsed ? "justify-center" : "px-2",
        )}
      >
        <span className="grid size-4 place-items-center"><StatusDot tone={tone} pulse={connection.state === "connected"} /></span>
        {!collapsed && <span className={cn("flex-1 text-left", connection.state === "error" ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground")}>{label}</span>}
        {!collapsed && <span className="text-[10.5px] text-muted-foreground/80">SpacetimeDB</span>}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
          <p className="font-medium text-foreground">{label}</p>
          {connection.errors.length === 0 ? (
            <p className="mt-1 leading-5 text-muted-foreground">
              {connection.state === "connected"
                ? "All four streams (MCP calls, AI requests, knowledge base, feedback) are subscribed and updating live."
                : "Establishing subscriptions. Retries back off automatically."}
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {connection.errors.map(error => (
                <div key={error.source}>
                  <p className="font-medium text-foreground">{error.source}</p>
                  <p className="mt-0.5 break-words font-mono text-[11px] leading-4 text-red-600 dark:text-red-400">{error.message}</p>
                </div>
              ))}
              <p className="leading-5 text-muted-foreground">Verify the <code className="font-mono">hexclave-ai-analytics</code> module is published and SpacetimeDB is reachable. Still retrying.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const THEME_OPTIONS: ReadonlyArray<{ value: Theme, label: string, icon: IconName }> = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
];

function ThemeSwitch({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme, mounted } = useTheme();
  if (collapsed) {
    const current = THEME_OPTIONS.find(option => option.value === theme) ?? THEME_OPTIONS[2];
    const next = THEME_OPTIONS[(THEME_OPTIONS.indexOf(current) + 1) % THEME_OPTIONS.length];
    return (
      <button
        type="button"
        onClick={() => setTheme(next.value)}
        aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
        title={`Theme: ${current.label}`}
        className="grid h-8 w-full place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground hover:transition-none"
      >
        <Icon name={mounted ? current.icon : "monitor"} size="sm" />
      </button>
    );
  }
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-0.5 rounded-lg border border-border bg-muted/60 p-0.5">
      {THEME_OPTIONS.map(option => {
        // Before hydration the stored theme is unknown, so nothing is highlighted until mounted.
        const selected = mounted && theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(option.value)}
            className={cn(
              "flex h-6 items-center justify-center gap-1 rounded-md text-[11px] transition-colors hover:transition-none",
              selected ? "bg-card font-medium text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon name={option.icon} size="xs" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function AccountButton({ collapsed }: { collapsed: boolean }) {
  const hexclaveApp = useHexclaveApp();
  const user = useUser({ or: "redirect" });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<"settings" | "sign-out" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), rootRef);

  const displayName = user.displayName?.trim();
  const email = user.primaryEmail?.trim();
  const name = displayName != null && displayName !== "" ? displayName : email != null && email !== "" ? email : "Signed-in user";
  const detail = email != null && email !== "" && email !== name ? email : "Internal access";

  async function run(action: "settings" | "sign-out") {
    setPending(action);
    setError(null);
    try {
      if (action === "settings") await hexclaveApp.redirectToAccountSettings();
      else await user.signOut();
    } catch (cause) {
      // Surfaced inline (not swallowed): the menu stays open showing what went wrong.
      setError(cause instanceof Error && cause.message !== "" ? cause.message : "Something went wrong");
      throw cause;
    } finally {
      setPending(null);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(previous => !previous)}
        title={collapsed ? `${name} · ${detail}` : undefined}
        className={cn(
          "flex h-10 w-full items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-foreground/[0.04] hover:transition-none",
          collapsed ? "justify-center" : "px-1.5",
          open && "bg-foreground/[0.04]",
        )}
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground/[0.08] text-[11px] font-semibold text-foreground">
          {name[0].toUpperCase()}
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">{name}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
          </span>
        )}
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-50 mb-2 w-60 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
          {error != null && <p role="alert" className="mx-1 mb-1 rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-700 dark:text-red-300">{error}</p>}
          <MenuItem icon="user" disabled={pending != null} onClick={() => run("settings")}>
            {pending === "settings" ? "Opening…" : "Account settings"}
          </MenuItem>
          <MenuItem icon="external" href="/">Legacy interface</MenuItem>
          <div className="my-1 border-t border-border" />
          <MenuItem icon="signOut" danger disabled={pending != null} onClick={() => run("sign-out")}>
            {pending === "sign-out" ? "Signing out…" : "Sign out"}
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, children, onClick, href, danger = false, disabled = false }: {
  icon: IconName,
  children: React.ReactNode,
  onClick?: () => Promise<void>,
  href?: string,
  danger?: boolean,
  disabled?: boolean,
}) {
  const classes = cn(
    "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:transition-none disabled:opacity-50",
    danger ? "text-red-600 hover:bg-red-500/10 dark:text-red-400" : "text-foreground hover:bg-muted",
  );
  if (href != null) {
    return <Link role="menuitem" href={href} className={classes}><Icon name={icon} size="sm" />{children}</Link>;
  }
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      // `run` renders failures inline in the menu and rethrows; runAsynchronously only reports them.
      onClick={() => {
        if (onClick != null) runAsynchronously(onClick);
      }}
      className={classes}
    >
      <Icon name={icon} size="sm" />
      {children}
    </button>
  );
}

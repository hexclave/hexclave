"use client";

import { DesignAlert, DesignButton, DesignPillToggle } from "@/components/design-components";
import { cn } from "@/lib/utils";
import { ArrowClockwiseIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import type { ElementType, ReactNode } from "react";
import {
  OBSERVABILITY_TIME_RANGE_OPTIONS,
  parseObservabilityTimeRangeId,
  type ObservabilityTimeRangeHours,
} from "./filters";

/**
 * Shared chrome for every page under the observability app (issues, logs,
 * traces, services, performance, registry).
 *
 * Each of those pages grew its own header toolbar, pane surface, split grid,
 * and loading/empty/error markup, so the same concept looked different on
 * every tab. The pieces here are the single spelling of each of those: pages
 * are expected to compose them rather than hand-roll equivalents, so a change
 * to the observability look lands everywhere at once.
 */

/**
 * The surface for panes we build by hand (a scroll list with its own header
 * bar, a waterfall) where `DesignCard`'s padding and heading chrome would get
 * in the way. Deliberately spelled with the same tokens `DesignCard` uses in
 * its glassmorphic variant, so a hand-built pane and a card sitting side by
 * side read as the same material.
 */
export const OBSERVABILITY_PANE_CLASSES =
  "rounded-2xl bg-white/90 ring-1 ring-black/[0.06] dark:bg-background/60 dark:ring-white/[0.06] dark:backdrop-blur-xl";

function ToolbarDivider() {
  return <span className="h-5 w-px shrink-0 bg-border/60" aria-hidden />;
}

/**
 * Canonical ordering for the actions slot of `ObservabilityPageLayout`:
 * scope the data (`filters`), report on it (`stats`), pick a window
 * (`range`), then act on it (`actions`). The only divider separates what you
 * are looking at from what you can do to it.
 */
export function ObservabilityToolbar({ filters, stats, range, actions }: {
  filters?: ReactNode,
  stats?: ReactNode,
  range?: ReactNode,
  actions?: ReactNode,
}) {
  const hasScope = filters != null || stats != null || range != null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters}
      {stats != null && (
        <div className="flex items-center gap-1 whitespace-nowrap text-xs">{stats}</div>
      )}
      {range}
      {actions != null && (
        <>
          {hasScope && <ToolbarDivider />}
          {actions}
        </>
      )}
    </div>
  );
}

export function ObservabilityTimeRangeToggle({ hours, onChange }: {
  hours: ObservabilityTimeRangeHours,
  onChange: (hours: ObservabilityTimeRangeHours) => void,
}) {
  return (
    <DesignPillToggle
      selected={String(hours)}
      onSelect={(id) => onChange(parseObservabilityTimeRangeId(id))}
      options={OBSERVABILITY_TIME_RANGE_OPTIONS}
      size="sm"
      glassmorphic={false}
    />
  );
}

export function ObservabilityRefreshButton({ onRefresh, loading }: {
  onRefresh: () => void | Promise<void>,
  loading?: boolean,
}) {
  return (
    <DesignButton
      variant="secondary"
      size="sm"
      className="shrink-0 gap-1.5"
      loading={loading}
      onClick={onRefresh}
    >
      <ArrowClockwiseIcon className="h-3.5 w-3.5" />
      Refresh
    </DesignButton>
  );
}

/**
 * The list-plus-detail shape shared by traces and registry.
 *
 * The sidebar pins below the floating header pill and is capped to the space
 * left under it. Sized against `dvh` rather than a container query because
 * these pages scroll the app shell, which is the viewport height — there is no
 * sized container to resolve `cqh` against.
 */
const OBSERVABILITY_STICKY_PANE_CLASSES = cn(
  // The pill's sticky offset (4.25rem, 5.75rem in dark) + its compacted height
  // (3.5rem) + a 0.75rem gap, matching `--data-grid-sticky-top` in the layout.
  "lg:sticky lg:top-[8.5rem] lg:max-h-[calc(100dvh-9.25rem)]",
  "dark:lg:top-[10rem] dark:lg:max-h-[calc(100dvh-10.75rem)]",
);

export function ObservabilitySplitLayout({ sidebarLabel, sidebar, detailLabel, detail }: {
  sidebarLabel: string,
  sidebar: ReactNode,
  detailLabel: string,
  detail: ReactNode,
}) {
  return (
    <div className="grid min-w-0 flex-1 gap-[var(--page-content-gap)] lg:grid-cols-[22rem_minmax(0,1fr)]">
      <aside className="min-h-0" aria-label={sidebarLabel}>
        <div
          className={cn(
            OBSERVABILITY_PANE_CLASSES,
            "flex h-full max-h-[45dvh] w-full flex-col overflow-hidden",
            OBSERVABILITY_STICKY_PANE_CLASSES,
          )}
        >
          {sidebar}
        </div>
      </aside>
      <section aria-label={detailLabel} className="flex min-w-0 flex-col self-start">
        {detail}
      </section>
    </div>
  );
}

export function ObservabilityPaneHeader({ children, className }: {
  children: ReactNode,
  className?: string,
}) {
  return (
    <div className={cn("flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2", className)}>
      {children}
    </div>
  );
}

export function ObservabilityPaneBody({ children, scroll, className }: {
  children: ReactNode,
  scroll?: boolean,
  className?: string,
}) {
  return (
    <div className={cn("min-h-0 flex-1", scroll === true && "overflow-y-auto", className)}>
      {children}
    </div>
  );
}

export function ObservabilityLoadingState({ label }: { label: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center gap-2 px-6 py-10 text-sm text-muted-foreground">
      <SpinnerGapIcon className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function ObservabilityEmptyState({ icon: Icon, title, description, children }: {
  icon?: ElementType,
  title: string,
  description?: ReactNode,
  children?: ReactNode,
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center px-6 py-10 text-center">
      {Icon != null && <Icon className="mb-4 h-8 w-8 text-muted-foreground/60" />}
      <p className="text-sm font-semibold">{title}</p>
      {description != null && (
        <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">{description}</p>
      )}
      {children != null && <div className="mt-4 max-w-full">{children}</div>}
    </div>
  );
}

/**
 * Every recoverable failure on these pages reads the same way: an error alert
 * with the retry inline, rather than a button floating below the alert.
 */
export function ObservabilityErrorState({ title, description, onRetry }: {
  title: string,
  description: ReactNode,
  onRetry?: () => void | Promise<void>,
}) {
  return (
    <DesignAlert variant="error" title={title} description={description}>
      {onRetry != null && (
        <DesignButton variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Retry
        </DesignButton>
      )}
    </DesignAlert>
  );
}

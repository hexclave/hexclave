"use client";

import { cn } from "@/lib/utils";
import React, { useEffect, useRef, useState } from "react";
import { Typography } from "@/components/ui";

// ─── Gradient types ───────────────────────────────────────────────────────────

export type AnalyticsCardGradient = "blue" | "cyan" | "purple" | "green" | "orange" | "slate";

export type AnalyticsChartType = "none" | "line" | "bar" | "stacked-bar" | "composed" | "donut";
export type AnalyticsTooltipType = "none" | "default" | "stacked" | "composed" | "visitors" | "revenue" | "donut";
export type AnalyticsHighlightMode = "none" | "bar-segment" | "series-hover" | "dot-hover" | "mixed";

export type AnalyticsAverageLineConfig = {
  movingAverage?: boolean,
  sevenDayAverage?: boolean,
  movingAverageDataKey?: string,
  sevenDayAverageDataKey?: string,
};

export type DesignAnalyticsChartConfig = {
  type: AnalyticsChartType,
  tooltipType?: AnalyticsTooltipType,
  highlightMode?: AnalyticsHighlightMode,
  averages?: AnalyticsAverageLineConfig,
};

// ─── Internal style maps ──────────────────────────────────────────────────────

const hoverTintClasses = new Map<AnalyticsCardGradient, string>([
  ["blue",   "group-hover:bg-blue-500/[0.03]"],
  ["purple", "group-hover:bg-purple-500/[0.03]"],
  ["green",  "group-hover:bg-emerald-500/[0.03]"],
  ["orange", "group-hover:bg-orange-500/[0.03]"],
  ["slate",  "group-hover:bg-slate-500/[0.02]"],
  ["cyan",   "group-hover:bg-cyan-500/[0.03]"],
]);

// ─── DesignAnalyticsCard ──────────────────────────────────────────────────────
//
// A glass-surface card designed as the standard shell for chart widgets on the
// overview page. Key differences from DesignCard:
//
//   - Lighter light-mode background (bg-white/90) vs dark (bg-background/60)
//     so charts and data pop against the page without competing with other cards.
//   - A "chart-card-tooltip-escape" CSS escape layer so Recharts tooltip
//     wrappers (which are position:absolute) are not clipped by the card's
//     overflow:hidden.
//   - Does NOT clip overflow by default, which allows chart axis labels and
//     floating tooltips to extend past the card bounds.
//   - `hover:z-10` so the hovered card's tooltip sits above adjacent cards.
//
// Props:
//   gradient  — accent tint shown on hover; defaults to "blue"
//   className — forwarded to the outer wrapper div

export type DesignAnalyticsCardProps = {
  gradient?: AnalyticsCardGradient,
  className?: string,
  chart?: DesignAnalyticsChartConfig,
  children: React.ReactNode,
};

export function DesignAnalyticsCard({
  gradient = "blue",
  className,
  chart,
  children,
}: DesignAnalyticsCardProps) {
  const hoverTint = hoverTintClasses.get(gradient) ?? "group-hover:bg-slate-500/[0.02]";
  const chartType = chart?.type ?? "none";
  const tooltipType = chart?.tooltipType ?? "none";
  const highlightMode = chart?.highlightMode ?? "none";
  const hasMovingAverage = chart?.averages?.movingAverage === true;
  const hasSevenDayAverage = chart?.averages?.sevenDayAverage === true;
  const hasAverageLines = hasMovingAverage || hasSevenDayAverage;

  return (
    <>
      <div
        className={cn(
          // Surface
          "group relative min-h-0 rounded-2xl",
          "bg-white/90 dark:bg-background/60 backdrop-blur-xl",
          // Border / shadow
          "ring-1 ring-black/[0.06] hover:ring-black/[0.1] dark:ring-white/[0.06] dark:hover:ring-white/[0.1]",
          "shadow-sm hover:shadow-md hover:z-10",
          // Transitions — enter is instant, exit fades
          "transition-all duration-150 hover:transition-none",
          // Required for Recharts tooltip overflow escape
          "analytics-card-tooltip-escape",
          className
        )}
        data-analytics-chart-type={chartType}
        data-analytics-tooltip-type={tooltipType}
        data-analytics-highlight-mode={highlightMode}
        data-analytics-has-average-lines={hasAverageLines ? "true" : "false"}
        data-analytics-has-moving-average={hasMovingAverage ? "true" : "false"}
        data-analytics-has-seven-day-average={hasSevenDayAverage ? "true" : "false"}
      >
        {/* Subtle gradient gloss */}
        <div className="absolute inset-0 bg-gradient-to-br from-foreground/[0.06] via-foreground/[0.02] dark:from-foreground/[0.03] dark:via-foreground/[0.01] to-transparent pointer-events-none rounded-2xl overflow-hidden" />
        {/* Gradient hover tint */}
        <div className={cn(
          "absolute inset-0 transition-colors duration-150 group-hover:transition-none pointer-events-none rounded-2xl overflow-hidden",
          hoverTint
        )} />
        {/* Content layer — must be relative so children stack above pseudo-layers */}
        <div className="relative h-full min-h-0 flex flex-col">
          {children}
        </div>
      </div>
    </>
  );
}

// ─── DesignAnalyticsCardHeader ────────────────────────────────────────────────
//
// Compact single-line header bar (label + optional right-side slot) separated
// from body by a thin divider. Used for ranked list cards, stat cards, and any
// card that wants a simple heading above the content area.

export type DesignAnalyticsCardHeaderProps = {
  label: React.ReactNode,
  right?: React.ReactNode,
  compact?: boolean,
  className?: string,
};

export function DesignAnalyticsCardHeader({
  label,
  right,
  compact = false,
  className,
}: DesignAnalyticsCardHeaderProps) {
  return (
    <div className={cn(
      "flex items-center justify-between border-b border-foreground/[0.05] shrink-0",
      compact ? "px-4 py-3" : "px-5 py-3.5",
      className
    )}>
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      {right != null && (
        <div className="shrink-0">{right}</div>
      )}
    </div>
  );
}

// ─── DesignChartLegend ────────────────────────────────────────────────────────
//
// A row of dot + label legend items that appears above or below a stacked chart.
// Used by sign-ups, emails sent, and any stacked-bar chart that needs a legend.

export type DesignChartLegendItem = {
  key: string,
  label: string,
  color: string,
};

export type DesignChartLegendProps = {
  items: readonly DesignChartLegendItem[],
  compact?: boolean,
  className?: string,
};

export function DesignChartLegend({
  items,
  compact = false,
  className,
}: DesignChartLegendProps) {
  return (
    <div className={cn(
      "flex items-center gap-3 flex-wrap",
      compact ? "px-4 pt-2" : "px-5 pt-2.5",
      className
    )}>
      {items.map((item) => (
        <div key={item.key} className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full shrink-0"
            style={{ backgroundColor: item.color }}
          />
          <span className="text-[10px] font-medium text-muted-foreground">
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── useInfiniteListWindow ────────────────────────────────────────────────────
//
// Shared hook for incremental list rendering driven by an IntersectionObserver.
// Renders BATCH_SIZE items initially, then reveals the next batch whenever the
// sentinel element at the bottom of the list scrolls into view of its scrollable
// container.
//
// Usage:
//   const { visibleCount, scrollRef, sentinelRef, hasMore } = useInfiniteListWindow(items.length);
//   <div ref={scrollRef} className="overflow-y-auto flex-1 min-h-0">
//     {items.slice(0, visibleCount).map(…)}
//     {hasMore && <div ref={sentinelRef} />}
//   </div>

const INFINITE_LIST_BATCH_SIZE = 12;

export type InfiniteListWindow = {
  visibleCount: number,
  scrollRef: React.RefObject<HTMLDivElement>,
  sentinelRef: React.RefObject<HTMLDivElement>,
  hasMore: boolean,
};

export function useInfiniteListWindow(
  totalCount: number,
  /** Reset visible count when this flag changes (e.g. tab switch). */
  resetKey?: string,
  /** Enable observation only when list UI is mounted. */
  enabled: boolean = true,
): InfiniteListWindow {
  const [visibleCount, setVisibleCount] = useState(() => Math.min(INFINITE_LIST_BATCH_SIZE, totalCount));
  // React 19 useRef<T>(null) returns RefObject<T | null>; cast to RefObject<T>
  // for compatibility with JSX ref props that expect RefObject<T>.
  const scrollRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;
  const sentinelRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;
  const hasMore = visibleCount < totalCount;

  // Reset whenever the list source or reset key changes.
  useEffect(() => {
    setVisibleCount(Math.min(INFINITE_LIST_BATCH_SIZE, totalCount));
  }, [totalCount, resetKey]);

  // Attach IntersectionObserver only when there is more to reveal.
  useEffect(() => {
    if (!enabled || !hasMore) return;
    // scrollRef.current and sentinelRef.current are typed non-null after the
    // cast above, but at mount they start as null at runtime. Guard explicitly.
    const root = scrollRef.current as HTMLDivElement | null;
    const target = sentinelRef.current as HTMLDivElement | null;
    if (root == null || target == null) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry.isIntersecting) return;
        setVisibleCount((c) => Math.min(c + INFINITE_LIST_BATCH_SIZE, totalCount));
      },
      { root, rootMargin: "120px 0px", threshold: 0.01 },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled, hasMore, totalCount]);

  return { visibleCount, scrollRef, sentinelRef, hasMore };
}

// ─── DesignInfiniteScrollList ─────────────────────────────────────────────────
//
// Scrollable list container that automatically appends a "Loading more…" sentinel
// and drives visibility via useInfiniteListWindow.
// Renders children as-is; the consumer slices by `window.visibleCount`.

export type DesignInfiniteScrollListProps = {
  totalCount: number,
  resetKey?: unknown,
  emptyMessage?: string,
  loadingLabel?: string,
  children: (window: InfiniteListWindow) => React.ReactNode,
  className?: string,
};

export function DesignInfiniteScrollList({
  totalCount,
  resetKey,
  emptyMessage = "No items",
  loadingLabel = "Loading more…",
  children,
  className,
}: DesignInfiniteScrollListProps) {
  const window = useInfiniteListWindow(totalCount, resetKey);

  if (totalCount === 0) {
    return (
      <div className={cn("flex items-center justify-center h-full", className)}>
        <Typography variant="secondary" className="text-xs">{emptyMessage}</Typography>
      </div>
    );
  }

  return (
    <div
      ref={window.scrollRef}
      className={cn("flex-1 min-h-0 overflow-y-auto", className)}
    >
      {children(window)}
      {window.hasMore && (
        <div ref={window.sentinelRef} className="py-2 text-center">
          <Typography variant="secondary" className="text-[10px]">{loadingLabel}</Typography>
        </div>
      )}
    </div>
  );
}

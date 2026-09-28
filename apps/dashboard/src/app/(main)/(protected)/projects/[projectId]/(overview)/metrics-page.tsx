'use client';

import { AppIcon } from "@/components/app-square";
import { DesignAnalyticsCard, DesignCategoryTabs, DesignChartLegend, DesignPillToggle, useInfiniteListWindow } from "@/components/design-components";
import { Link } from "@/components/link";
import { useRouter } from "@/components/router";
import { cn, SimpleTooltip, Typography } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ALL_APPS_FRONTEND, type AppId, getAppPath } from "@/lib/apps-frontend";
import { getEnabledAppIds } from "@/lib/apps-utils";
import {
  type AnalyticsOverviewFilters,
  type MetricsEmailOverview,
  type MetricsRecentEmail,
  useMetricsOrThrow,
} from "@/lib/hexclave-app-internals";
import {
  ChartLineIcon,
  CompassIcon,
  DesktopIcon,
  DeviceMobileIcon,
  DeviceTabletIcon,
  EnvelopeIcon,
  EnvelopeOpenIcon,
  FunnelIcon,
  GearIcon,
  GlobeIcon,
  MonitorIcon,
  SquaresFourIcon,
  WarningCircleIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import useResizeObserver from '@react-hook/resize-observer';
import { useUser } from "@hexclave/next";
import { ALL_APPS } from "@hexclave/shared/dist/apps/apps-config";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { LayoutGroup, motion, useReducedMotion, type Transition } from "motion/react";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import { type ElementType, type ReactNode, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnalyticsEventLimitBanner } from "../analytics/shared";
import { PageLayout } from "../page-layout";
import { useAdminApp, useProjectId } from "../use-admin-app";
import { UserPageMetricCard } from "../users/[userId]/user-page-metric-card";
import { GlobeSectionWithData } from "./globe-section-with-data";
import {
  ComposedAnalyticsChart,
  ComposedDataPoint,
  CustomDateRange,
  DonutChartDisplay,
  EmailStackedBarChartDisplay,
  EmailStackedDataPoint,
  filterStackedDatapointsByTimeRange,
  LineChartDisplayConfig,
  RevenueHoverChart,
  RevenueHoverDataPoint,
  StackedBarChartDisplay,
  StackedDataPoint,
  TabbedMetricsCard,
  TimeRange,
  TimeRangeToggle,
  VisitorsHoverChart,
  VisitorsHoverDataPoint
} from "./line-chart";
import { MetricsErrorFallback, MetricsLoadingFallback } from "./metrics-loading";
import { ReferrersWithAnalyticsCard, TopNamedListCard, TopRegionsCard } from "./top-lists";
import {
  ANALYTICS_CHART_METRIC_MODE_ORDER,
  toggleAnalyticsChartMetricMode,
  type AnalyticsChartMetricMode,
  type AnalyticsChartMode,
} from "./analytics-chart-mode";

const dailySignUpsConfig: LineChartDisplayConfig = {
  name: 'Daily Sign-Ups',
  chart: {
    activity: {
      label: "Sign-Ups",
      theme: { light: "hsl(221, 83%, 53%)", dark: "hsl(240, 71%, 70%)" },
    },
  },
};

function formatUsdFromCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function pagesPerVisitor(pageViews: number, visitors: number): number {
  return visitors > 0 ? pageViews / visitors : 0;
}

function formatPagesPerVisitor(value: number): string {
  if (!Number.isFinite(value)) return "0.0";
  return value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

const OVERVIEW_HEADER_COMPACT_SCROLL_TOP = 24;
const OVERVIEW_HEADER_MORPH_MS = 520;
const OVERVIEW_HEADER_TITLE_EXIT_MS = 150;
const overviewHeaderLayoutTransition: Transition = {
  duration: OVERVIEW_HEADER_MORPH_MS / 1000,
  ease: [0.32, 0.72, 0, 1],
};
const reducedOverviewHeaderLayoutTransition: Transition = {
  duration: 0,
};

const scrollableOverflowValues = new Set(["auto", "scroll", "overlay"]);

function findScrollContainer(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current != null) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (scrollableOverflowValues.has(overflowY) && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function useOverviewHeaderCompacted(enabled: boolean) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [compacted, setCompacted] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setCompacted(false);
      return;
    }

    const sentinel = sentinelRef.current;
    if (sentinel == null) return;

    const scrollContainer = findScrollContainer(sentinel);

    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      const nextCompacted = !entry.isIntersecting;
      setCompacted((current) => current === nextCompacted ? current : nextCompacted);
    }, {
      root: scrollContainer,
      rootMargin: `-${OVERVIEW_HEADER_COMPACT_SCROLL_TOP}px 0px 0px 0px`,
      threshold: 0,
    });

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [enabled]);

  return { compacted, sentinelRef };
}

function useRenderWhileClosing(open: boolean, durationMs: number): boolean {
  const [shouldRender, setShouldRender] = useState(open);

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      return;
    }

    const timeout = setTimeout(() => setShouldRender(false), durationMs);
    return () => clearTimeout(timeout);
  }, [durationMs, open]);

  return open || shouldRender;
}

function useDelayedTrue(value: boolean, delayMs: number): boolean {
  const [delayedValue, setDelayedValue] = useState(value);

  useEffect(() => {
    if (!value) {
      setDelayedValue(false);
      return;
    }

    const timeout = setTimeout(() => setDelayedValue(true), delayMs);
    return () => clearTimeout(timeout);
  }, [delayMs, value]);

  return delayedValue;
}

const BROWSER_SLUGS = new Map<string, string>([
  ["chrome", "googlechrome"],
  ["google chrome", "googlechrome"],
  ["firefox", "firefox"],
  ["safari", "safari"],
  ["edge", "microsoftedge"],
  ["microsoft edge", "microsoftedge"],
  ["opera", "opera"],
  ["samsung internet", "samsung"],
  ["brave", "brave"],
  ["vivaldi", "vivaldi"],
  ["duckduckgo", "duckduckgo"],
]);

const OS_SLUGS = new Map<string, string>([
  ["macos", "apple"],
  ["ios", "apple"],
  ["ipados", "apple"],
  ["windows", "windows11"],
  ["android", "android"],
  ["linux", "linux"],
  ["ubuntu", "ubuntu"],
  ["chromeos", "googlechrome"],
]);

function BrandIcon({ slug }: { slug: string | undefined }) {
  const [failed, setFailed] = useState(false);
  if (!slug || failed) {
    return <span aria-hidden className="h-3.5 w-3.5 shrink-0 rounded-sm bg-foreground/[0.06]" />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://cdn.simpleicons.org/${slug}`}
      alt=""
      width={14}
      height={14}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="h-3.5 w-3.5 shrink-0 object-contain opacity-90 [filter:invert(0)] dark:[filter:invert(1)_hue-rotate(180deg)]"
    />
  );
}

function browserIcon(name: string): ReactNode {
  return <BrandIcon slug={BROWSER_SLUGS.get(name.toLowerCase().trim())} />;
}

function osIcon(name: string): ReactNode {
  return <BrandIcon slug={OS_SLUGS.get(name.toLowerCase().trim())} />;
}

function deviceIcon(name: string): ReactNode {
  const key = name.toLowerCase().trim();
  if (key === "mobile") return <DeviceMobileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" weight="fill" />;
  if (key === "tablet") return <DeviceTabletIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" weight="fill" />;
  return <DesktopIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" weight="fill" />;
}

function calculatePeriodDelta(currentValue: number, previousValue: number): number | undefined {
  if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue)) {
    return undefined;
  }
  if (previousValue === 0) {
    return currentValue === 0 ? 0 : undefined;
  }
  return Number((((currentValue - previousValue) / previousValue) * 100).toFixed(1));
}

function SetupAppPrompt({
  projectId,
  appId,
  appLabel,
  metricLabel,
}: {
  projectId: string,
  appId: AppId,
  appLabel: string,
  metricLabel: string,
}) {
  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center px-4 py-4">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <Typography variant="secondary" className="text-xs">
          Enable{" "}
          <span className="font-semibold text-foreground">
            {appLabel}
          </span>{" "}
          in Explore Apps to track {metricLabel}.
        </Typography>
        <Link
          href={`/projects/${projectId}/apps/${appId}`}
          className="inline-flex items-center rounded-md bg-foreground/[0.08] px-3 py-1.5 text-[11px] font-medium text-foreground transition-colors duration-150 hover:bg-foreground/[0.12] hover:transition-none"
        >
          Open Explore Apps
        </Link>
      </div>
    </div>
  );
}

const FILTER_DIMENSIONS: Array<keyof AnalyticsOverviewFilters> = ["country_code", "referrer", "browser", "os", "device"];

const FILTER_DIMENSION_LABELS = new Map<keyof AnalyticsOverviewFilters, string>([
  ["country_code", "Country"],
  ["referrer", "Referrer"],
  ["browser", "Browser"],
  ["os", "OS"],
  ["device", "Device"],
]);

function analyticsFiltersKey(filters: AnalyticsOverviewFilters): string {
  const params = new URLSearchParams();
  for (const dimension of FILTER_DIMENSIONS) {
    const value = filters[dimension];
    if (value != null) {
      params.set(dimension, value);
    }
  }
  if (filters.since != null) params.set("since", filters.since);
  if (filters.until != null) params.set("until", filters.until);
  return params.toString();
}

// Matches getDateKey in line-chart.tsx: custom-range picker dates are
// local-midnight Dates, and the daily series keys are "YYYY-MM-DD".
function localDateKey(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Server-side date bounds for the top-N breakdowns (referrers, regions,
// browsers/OS/devices), derived from the chart time range. Quantized to the
// current UTC hour (1d) / UTC day (7d) so the metrics cache key stays stable
// across renders instead of changing every millisecond.
function analyticsDateRangeForTimeRange(
  timeRange: TimeRange,
  customDateRange: CustomDateRange | null,
): Pick<AnalyticsOverviewFilters, "since" | "until"> {
  switch (timeRange) {
    case "1d": {
      const latestHour = new Date();
      latestHour.setUTCMinutes(0, 0, 0);
      return { since: new Date(latestHour.getTime() - 23 * 60 * 60 * 1000).toISOString() };
    }
    case "7d": {
      const todayUtc = new Date();
      todayUtc.setUTCHours(0, 0, 0, 0);
      return { since: new Date(todayUtc.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString() };
    }
    case "30d":
    case "all": {
      return {};
    }
    case "custom": {
      if (customDateRange == null) {
        return {};
      }
      const untilExclusive = new Date(new Date(`${localDateKey(customDateRange.to)}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);
      return {
        since: `${localDateKey(customDateRange.from)}T00:00:00.000Z`,
        until: untilExclusive.toISOString(),
      };
    }
  }
}

function getFilterDimensionLabel(dimension: keyof AnalyticsOverviewFilters): string {
  const label = FILTER_DIMENSION_LABELS.get(dimension);
  if (label == null) {
    throw new Error(`Missing analytics filter dimension label: ${dimension}`);
  }
  return label;
}

function hasAnalyticsFilters(filters: AnalyticsOverviewFilters): boolean {
  return FILTER_DIMENSIONS.some((dimension) => filters[dimension] != null);
}

function FilterChipsBar({
  filters,
  onClear,
  onClearAll,
}: {
  filters: AnalyticsOverviewFilters,
  onClear: (dimension: keyof AnalyticsOverviewFilters) => void,
  onClearAll: () => void,
}) {
  const entries = FILTER_DIMENSIONS.flatMap((dimension) => {
    const value = filters[dimension];
    return value != null ? [{ dimension, value }] : [];
  });
  if (entries.length === 0) return null;

  return (
    <div className="flex min-w-0 max-w-[40vw] items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {entries.map(({ dimension, value }) => (
        <span
          key={dimension}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-foreground/[0.06] py-1 pl-2.5 pr-1 text-[11px] font-medium text-foreground ring-1 ring-foreground/[0.08]"
        >
          <span className="text-muted-foreground">{getFilterDimensionLabel(dimension)}:</span>
          <span className="max-w-36 truncate tabular-nums">{value}</span>
          <button
            type="button"
            aria-label={`Clear ${getFilterDimensionLabel(dimension)} filter`}
            onClick={() => onClear(dimension)}
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground hover:transition-none"
          >
            <XIcon className="h-2.5 w-2.5" weight="bold" />
          </button>
        </span>
      ))}
      {entries.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className="shrink-0 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground hover:transition-none"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

type FilterOption = {
  value: string,
  label: string,
};

type FilterDimensionConfig = {
  key: keyof AnalyticsOverviewFilters,
  label: string,
  options: FilterOption[],
};

function FilterMenuButton({ active }: { active: boolean }) {
  return (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        aria-label="Add analytics filter"
        className="inline-flex items-center rounded-xl bg-black/[0.08] p-1 transition-colors dark:bg-white/[0.04]"
      >
        <span
          className={cn(
            "relative flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-all duration-150 hover:bg-black/[0.06] hover:text-foreground hover:transition-none dark:hover:bg-white/[0.04]",
            active && "bg-background text-foreground shadow-sm ring-1 ring-black/[0.12] dark:ring-white/[0.06]",
          )}
        >
          <FunnelIcon className="h-3.5 w-3.5" weight={active ? "fill" : "regular"} />
        </span>
      </button>
    </DropdownMenuTrigger>
  );
}

function FilterMenu({
  filters,
  onToggle,
}: {
  filters: AnalyticsOverviewFilters,
  onToggle: (dimension: keyof AnalyticsOverviewFilters, value: string) => void,
}) {
  const active = hasAnalyticsFilters(filters);
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <FilterMenuButton active={active} />
      {/* The menu contents read metrics, but they render in the page header, which
          sits outside the overview's metrics error boundary. Without a boundary of
          its own, a failed metrics request thrown here escapes the route and lands
          in global-error.tsx, which navigates to "/" after three seconds — so a
          broken analytics query would kick the user off the project entirely.
          The overview below reports the failure, so the menu degrades to nothing. */}
      <ErrorBoundary errorComponent={FilterMenuErrorComponent}>
        <Suspense fallback={null}>
          <FilterMenuContent
            filters={filters}
            onSelect={(dimension, value) => {
              onToggle(dimension, value);
              setOpen(false);
            }}
          />
        </Suspense>
      </ErrorBoundary>
    </DropdownMenu>
  );
}

function FilterMenuErrorComponent({ error }: { error: unknown }) {
  useEffect(() => {
    captureError("metrics-page-filter-menu", error);
  }, [error]);
  return null;
}

function FilterMenuContent({
  filters,
  onSelect,
}: {
  filters: AnalyticsOverviewFilters,
  onSelect: (dimension: keyof AnalyticsOverviewFilters, value: string) => void,
}) {
  const adminApp = useAdminApp();
  // Read unfiltered metrics here so the menu keeps offering the full value set.
  // The visible overview preloads filtered data separately before swapping.
  const data = useMetricsOrThrow(adminApp, false);
  const analytics = data.analytics_overview;

  const dimensions = useMemo<FilterDimensionConfig[]>(() => [
    { key: "country_code", label: "Country", options: analytics.top_regions.slice(0, 15).map((r) => ({ value: r.country_code.toUpperCase(), label: r.country_code.toUpperCase() })) },
    { key: "referrer", label: "Referrer", options: analytics.top_referrers.slice(0, 15).map((r) => ({ value: r.referrer, label: r.referrer || "(direct)" })) },
    { key: "browser", label: "Browser", options: analytics.top_browsers.slice(0, 15).map((b) => ({ value: b.name, label: b.name })) },
    { key: "os", label: "OS", options: analytics.top_operating_systems.slice(0, 15).map((o) => ({ value: o.name, label: o.name })) },
    { key: "device", label: "Device", options: analytics.top_devices.slice(0, 15).map((d) => ({ value: d.name, label: d.name })) },
  ], [analytics.top_browsers, analytics.top_devices, analytics.top_operating_systems, analytics.top_referrers, analytics.top_regions]);

  const firstAvailableDimension = dimensions.find((dimension) => dimension.options.length > 0)?.key ?? "country_code";
  const [selectedDimension, setSelectedDimension] = useState<keyof AnalyticsOverviewFilters>(firstAvailableDimension);
  const selectedConfig = dimensions.find((dimension) => dimension.key === selectedDimension);
  if (selectedConfig == null) {
    throw new Error(`Missing analytics filter dimension: ${selectedDimension}`);
  }
  const selectedFilterValue = filters[selectedConfig.key];

  return (
    <DropdownMenuPortal>
      <DropdownMenuContent
        align="end"
        className="w-[min(30rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-black/[0.08] bg-white p-0 shadow-lg ring-1 ring-black/[0.06] dark:border-white/[0.08] dark:bg-background dark:ring-white/[0.08]"
      >
        <DropdownMenuLabel className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          Filter analytics by
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="grid grid-cols-[9rem_1fr] sm:grid-cols-[10rem_1fr]">
          <div className="border-r border-foreground/[0.08] p-1">
            {dimensions.map((dimension) => {
              const isSelected = dimension.key === selectedDimension;
              const activeValue = filters[dimension.key];
              return (
                <button
                  key={dimension.key}
                  type="button"
                  onClick={() => setSelectedDimension(dimension.key)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-foreground/[0.06] hover:transition-none",
                    isSelected ? "bg-foreground/[0.06] text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span className="font-medium">{dimension.label}</span>
                  {activeValue != null && (
                    <span className="max-w-14 truncate text-[10px] tabular-nums text-muted-foreground">
                      {activeValue}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex min-h-60 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-foreground/[0.08] px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-foreground">{selectedConfig.label}</div>
                {selectedFilterValue != null && (
                  <div className="truncate text-[10px] text-muted-foreground">
                    Current: {selectedFilterValue}
                  </div>
                )}
              </div>
              {selectedFilterValue != null && (
                <button
                  type="button"
                  onClick={() => onSelect(selectedConfig.key, selectedFilterValue)}
                  className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground hover:transition-none"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {selectedConfig.options.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                  No values
                </div>
              ) : (
                selectedConfig.options.map((option) => {
                  const isActive = selectedFilterValue === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => onSelect(selectedConfig.key, option.value)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-foreground/[0.06] hover:transition-none",
                        isActive ? "bg-foreground/[0.06] font-medium text-foreground" : "text-foreground",
                      )}
                    >
                      <span className="truncate">{option.label}</span>
                      {isActive && <XIcon className="h-3 w-3 shrink-0 text-muted-foreground" weight="bold" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  );
}

function ViewToggle({ view, onChange }: { view: "overview" | "globe", onChange: (view: "overview" | "globe") => void }) {
  return (
    <DesignPillToggle
      size="sm"
      glassmorphic={false}
      showLabels={false}
      options={[
        { id: "overview", label: "Overview", icon: ChartLineIcon },
        { id: "globe", label: "Globe", icon: GlobeIcon },
      ]}
      selected={view}
      onSelect={(id) => {
        if (id === "overview" || id === "globe") {
          onChange(id);
          return;
        }
        throw new Error(`Unsupported project overview view selected: ${id}`);
      }}
    />
  );
}

function OverviewHeaderChrome({
  title,
  actions,
  compacted,
  layoutCompacted,
  renderTitle,
  layoutTransition,
  animateLayout,
}: {
  title: string,
  actions: ReactNode,
  compacted: boolean,
  layoutCompacted: boolean,
  renderTitle: boolean,
  layoutTransition: Transition,
  animateLayout: boolean,
}) {
  return (
    <motion.div
      layout={animateLayout}
      transition={layoutTransition}
      className={cn(
        "pointer-events-auto relative w-full max-w-full",
        layoutCompacted && "ml-auto w-fit",
      )}
    >
      <motion.div
        layout={animateLayout}
        transition={layoutTransition}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-0 rounded-2xl border border-black/[0.06] bg-white/90 shadow-[0_2px_12px_rgba(0,0,0,0.04)] backdrop-blur-xl will-change-transform transition-[background-color,border-color,box-shadow,opacity] [transition-duration:520ms] [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none dark:border-0 dark:bg-transparent dark:shadow-none dark:backdrop-blur-none",
          layoutCompacted && "rounded-xl border-black/[0.08] bg-white/[0.78] shadow-[0_14px_34px_rgba(15,23,42,0.14)] ring-1 ring-white/[0.55] dark:border-white/[0.08] dark:bg-background/[0.72] dark:shadow-[0_14px_34px_rgba(0,0,0,0.26)] dark:ring-white/[0.08] dark:backdrop-blur-xl",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-5 top-0 z-10 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 transition-opacity [transition-duration:520ms] motion-reduce:transition-none dark:via-white/20",
          layoutCompacted && "opacity-100",
        )}
      />
      <div
        className={cn(
          "relative z-10 flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5 sm:py-4 dark:px-0 dark:py-0 dark:sm:px-0 dark:sm:py-0",
          layoutCompacted && "gap-0 sm:gap-0",
          layoutCompacted && "px-3 py-2 sm:px-4 sm:py-2.5 dark:px-4 dark:py-2.5 dark:sm:px-4 dark:sm:py-2.5",
        )}
      >
        {renderTitle && (
          <div
            className={cn(
              "min-w-0 transition-[opacity,transform,filter] duration-150 ease-out motion-reduce:transition-none sm:flex-1",
              compacted && "pointer-events-none opacity-0 blur-[1px]",
            )}
          >
            <Typography
              type="h2"
              className="truncate text-xl font-semibold tracking-tight sm:text-2xl"
            >
              {title}
            </Typography>
          </div>
        )}
        <motion.div
          layout={animateLayout}
          transition={layoutTransition}
          className={cn(
            "relative z-10 min-w-0 max-w-full flex-shrink-0 overflow-x-auto will-change-transform [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "transition-opacity [transition-duration:520ms] motion-reduce:transition-none",
            layoutCompacted && "opacity-95",
          )}
        >
          {actions}
        </motion.div>
      </div>
    </motion.div>
  );
}

function OverviewHeader({ title, actions, sticky }: { title: string, actions: ReactNode, sticky: boolean }) {
  const { compacted, sentinelRef } = useOverviewHeaderCompacted(sticky);
  const renderTitle = useRenderWhileClosing(!compacted, OVERVIEW_HEADER_TITLE_EXIT_MS);
  const shouldReduceMotion = useReducedMotion();
  const delayedCompacted = useDelayedTrue(compacted, shouldReduceMotion ? 0 : OVERVIEW_HEADER_TITLE_EXIT_MS);
  const layoutCompacted = sticky && (shouldReduceMotion ? compacted : delayedCompacted);
  const layoutTransition = shouldReduceMotion ? reducedOverviewHeaderLayoutTransition : overviewHeaderLayoutTransition;

  return (
    <>
      {sticky && (
        <div key="sentinel" ref={sentinelRef} aria-hidden className="-mb-[17px] h-px w-px" />
      )}
      <div
        key="header"
        className={cn(
          "relative z-30 w-full pointer-events-none",
          sticky && "sticky top-[4.25rem] mb-2 dark:top-[5.75rem]",
        )}
      >
        <LayoutGroup id="overview-sticky-header">
          <OverviewHeaderChrome
            title={title}
            actions={actions}
            compacted={sticky ? compacted : false}
            layoutCompacted={layoutCompacted}
            renderTitle={sticky ? renderTitle : true}
            layoutTransition={layoutTransition}
            animateLayout
          />
        </LayoutGroup>
      </div>
    </>
  );
}

function GlobeView({ includeAnonymous }: { includeAnonymous: boolean }) {
  // Fills the height granted by PageLayout's containedHeight mode (the globe
  // tab sets it) instead of guessing the chrome height with 100vh math, which
  // left a slight page scroll whenever the guess was off.
  return (
    <div className="relative min-h-0 w-full flex-1 overflow-hidden rounded-2xl bg-white/90 shadow-sm ring-1 ring-black/[0.06] backdrop-blur-xl dark:rounded-none dark:bg-transparent dark:shadow-none dark:ring-0 dark:backdrop-blur-none">
      <GlobeSectionWithData includeAnonymous={includeAnonymous} interactive />
    </div>
  );
}

function AnalyticsInChartPill({
  label,
  value,
  delta,
  color,
  isHighlighted,
  isSelected,
  controlsId,
  tabId,
  onToggle,
  onHoverPreview,
  onHoverEnd,
  onArrowNavigate,
}: {
  label: string,
  value: string,
  delta?: number,
  color: string,
  isHighlighted: boolean,
  isSelected: boolean,
  controlsId: string,
  tabId: string,
  onToggle: () => void,
  onHoverPreview: () => void,
  onHoverEnd: () => void,
  onArrowNavigate: (direction: 'next' | 'prev' | 'first' | 'last') => void,
}) {
  const tooltipByLabel = new Map([
    ["Daily Active Users", "Shows active users by day so you can see current product usage."],
    ["Visitors", "Sums each day's unique visitors across the selected period, so returning visitors count once per day."],
    ["Revenue", "Shows new revenue from payments for the selected period."],
  ]);

  return (
    <button
      type="button"
      id={tabId}
      aria-pressed={isSelected}
      aria-controls={controlsId}
      onMouseEnter={onHoverPreview}
      onMouseLeave={onHoverEnd}
      onClick={onToggle}
      onKeyDown={(event) => {
        const isNext = event.key === 'ArrowRight' || event.key === 'ArrowDown';
        const isPrev = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
        const isActivate = event.key === ' ' || event.key === 'Enter';
        if (isNext) {
          event.preventDefault();
          onArrowNavigate('next');
        } else if (isPrev) {
          event.preventDefault();
          onArrowNavigate('prev');
        } else if (event.key === 'Home') {
          event.preventDefault();
          onArrowNavigate('first');
        } else if (event.key === 'End') {
          event.preventDefault();
          onArrowNavigate('last');
        } else if (isActivate) {
          event.preventDefault();
          onToggle();
        }
      }}
      className={cn(
        "group/pill flex items-center gap-3 px-3.5 py-2.5 rounded-xl transition-colors hover:transition-none select-none flex-1",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/[0.18]",
        isHighlighted
          ? "bg-foreground/[0.06] ring-1 ring-foreground/[0.09]"
          : "hover:bg-foreground/[0.03]"
      )}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full shrink-0 transition-transform",
          isHighlighted ? "scale-125" : ""
        )}
        style={{ backgroundColor: color }}
      />
      <div className="flex flex-col gap-0.5 text-left min-w-0">
        <SimpleTooltip tooltip={tooltipByLabel.get(label)} inline className="w-fit">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider leading-none">
            {label}
          </span>
        </SimpleTooltip>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[15px] font-bold tabular-nums text-foreground leading-none">
            {value}
          </span>
          {delta != null && delta !== 0 && (
            <span className={cn(
              "text-[10px] font-semibold tabular-nums leading-none shrink-0",
              delta > 0 ? "text-emerald-500 dark:text-emerald-400" : delta < 0 ? "text-red-500 dark:text-red-400" : "text-muted-foreground"
            )}>
              {delta > 0 ? "+" : ""}{delta}%
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function AnalyticsChartWidget({
  composedData,
  dauStackedData,
  visitorsData,
  revenueData,
  dauLabel,
  dauTotal,
  visitorsLabel,
  revenueLabel,
  dauDelta,
  visitorsTotal,
  revenueTotal,
  visitorsDelta,
  revenueDelta,
  analyticsEnabled,
  paymentsEnabled,
  projectId,
  compact = false,
}: {
  composedData: ComposedDataPoint[],
  dauStackedData: StackedDataPoint[],
  visitorsData: VisitorsHoverDataPoint[],
  revenueData: RevenueHoverDataPoint[],
  dauLabel: string,
  dauTotal: string,
  visitorsLabel: string,
  revenueLabel: string,
  dauDelta?: number,
  visitorsTotal: string,
  revenueTotal: string,
  visitorsDelta?: number,
  revenueDelta?: number,
  analyticsEnabled: boolean,
  paymentsEnabled: boolean,
  projectId: string,
  compact?: boolean,
}) {
  const [selectedMode, setSelectedMode] = useState<AnalyticsChartMode>('default');
  const [previewMode, setPreviewMode] = useState<AnalyticsChartMode | null>(null);

  const tablistInstanceId = useId();
  const tabpanelId = `${tablistInstanceId}-panel`;
  const dauTabId = `${tablistInstanceId}-tab-dau`;
  const visitorsTabId = `${tablistInstanceId}-tab-visitors`;
  const revenueTabId = `${tablistInstanceId}-tab-revenue`;

  const activeMode: AnalyticsChartMode = previewMode ?? selectedMode;
  const displayMode: AnalyticsChartMode = activeMode;

  const handleHoverPreview = (mode: AnalyticsChartMetricMode) => {
    setPreviewMode(mode);
  };

  const handleHoverEnd = () => {
    setPreviewMode(null);
  };

  const handleSelect = (mode: AnalyticsChartMetricMode) => {
    setSelectedMode(mode);
    setPreviewMode(null);
  };

  const handleToggle = (mode: AnalyticsChartMetricMode) => {
    setSelectedMode((currentMode) => toggleAnalyticsChartMetricMode(currentMode, mode));
    setPreviewMode(null);
  };

  const handleArrowNavigate = (current: AnalyticsChartMetricMode, direction: 'next' | 'prev' | 'first' | 'last') => {
    const idx = ANALYTICS_CHART_METRIC_MODE_ORDER.indexOf(current);
    let nextIdx: number;
    switch (direction) {
      case 'next': {
        nextIdx = (idx + 1) % ANALYTICS_CHART_METRIC_MODE_ORDER.length;
        break;
      }
      case 'prev': {
        nextIdx = (idx - 1 + ANALYTICS_CHART_METRIC_MODE_ORDER.length) % ANALYTICS_CHART_METRIC_MODE_ORDER.length;
        break;
      }
      case 'first': {
        nextIdx = 0;
        break;
      }
      case 'last': {
        nextIdx = ANALYTICS_CHART_METRIC_MODE_ORDER.length - 1;
        break;
      }
    }
    handleSelect(ANALYTICS_CHART_METRIC_MODE_ORDER[nextIdx]);
  };

  const dauColor = "hsl(152, 38%, 52%)";
  const visitorsColor = "hsl(210, 84%, 64%)";
  const revenueColor = "hsl(268, 82%, 66%)";
  const chartViewportHeight = compact ? 260 : 320;

  return (
    <div className="flex flex-col gap-3 h-full">
      <DesignAnalyticsCard
        gradient="blue"
        className="h-full min-h-0"
        chart={{
          type: displayMode === "dau" ? "stacked-bar" : displayMode === "default" ? "composed" : "bar",
          tooltipType: displayMode === "dau"
            ? "stacked"
            : displayMode === "visitors"
              ? "visitors"
              : displayMode === "revenue"
                ? "revenue"
                : "composed",
          highlightMode: "mixed",
          averages: { movingAverage: true, sevenDayAverage: true },
        }}
      >
        <div
          className={cn(
            "flex-1 min-h-0 flex flex-col",
            compact ? "px-4 pt-2 pb-2" : "px-4 pt-3 pb-3",
          )}
          onMouseLeave={handleHoverEnd}
        >
          <div
            role="group"
            aria-label="Analytics chart metrics"
            className="flex items-stretch mb-2 -mx-1"
          >
            <AnalyticsInChartPill
              label={dauLabel}
              value={dauTotal}
              delta={dauDelta}
              color={dauColor}
              isHighlighted={activeMode === 'dau'}
              isSelected={selectedMode === 'dau'}
              tabId={dauTabId}
              controlsId={tabpanelId}
              onToggle={() => handleToggle('dau')}
              onHoverPreview={() => handleHoverPreview('dau')}
              onHoverEnd={handleHoverEnd}
              onArrowNavigate={(direction) => handleArrowNavigate('dau', direction)}
            />
            <div className="w-px bg-foreground/[0.07] shrink-0 my-1.5 mx-1" />
            <AnalyticsInChartPill
              label={visitorsLabel}
              value={visitorsTotal}
              delta={visitorsDelta}
              color={visitorsColor}
              isHighlighted={activeMode === 'visitors'}
              isSelected={selectedMode === 'visitors'}
              tabId={visitorsTabId}
              controlsId={tabpanelId}
              onToggle={() => handleToggle('visitors')}
              onHoverPreview={() => handleHoverPreview('visitors')}
              onHoverEnd={handleHoverEnd}
              onArrowNavigate={(direction) => handleArrowNavigate('visitors', direction)}
            />
            <div className="w-px bg-foreground/[0.07] shrink-0 my-1.5 mx-1" />
            <AnalyticsInChartPill
              label={revenueLabel}
              value={revenueTotal}
              delta={revenueDelta}
              color={revenueColor}
              isHighlighted={activeMode === 'revenue'}
              isSelected={selectedMode === 'revenue'}
              tabId={revenueTabId}
              controlsId={tabpanelId}
              onToggle={() => handleToggle('revenue')}
              onHoverPreview={() => handleHoverPreview('revenue')}
              onHoverEnd={handleHoverEnd}
              onArrowNavigate={(direction) => handleArrowNavigate('revenue', direction)}
            />
          </div>

          <div
            id={tabpanelId}
            role="region"
            aria-label="Analytics chart"
            className="flex-1 min-h-0 relative"
            style={{ minHeight: chartViewportHeight }}
          >
            <div className="h-full flex flex-col">
              {displayMode === 'default' && (
                composedData.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <Typography variant="secondary" className="text-xs">No data available</Typography>
                  </div>
                ) : (
                  <ComposedAnalyticsChart
                    datapoints={composedData}
                    showVisitors
                    showPageViews={analyticsEnabled}
                    showRevenue={paymentsEnabled}
                    compact={compact}
                  />
                )
              )}
              {displayMode === 'dau' && (
                dauStackedData.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <Typography variant="secondary" className="text-xs">No daily active user data available</Typography>
                  </div>
                ) : (
                  <StackedBarChartDisplay
                    datapoints={dauStackedData}
                    compact={compact}
                  />
                )
              )}
              {displayMode === 'visitors' && (
                !analyticsEnabled ? (
                  <div className="h-full min-h-0">
                    <SetupAppPrompt projectId={projectId} appId="analytics" appLabel="Analytics" metricLabel="visitor metrics" />
                  </div>
                ) : visitorsData.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <Typography variant="secondary" className="text-xs">No visitor data available</Typography>
                  </div>
                ) : (
                  <VisitorsHoverChart
                    datapoints={visitorsData}
                    compact={compact}
                  />
                )
              )}
              {displayMode === 'revenue' && (
                !paymentsEnabled ? (
                  <div className="h-full min-h-0">
                    <SetupAppPrompt projectId={projectId} appId="payments" appLabel="Payments" metricLabel="revenue metrics" />
                  </div>
                ) : revenueData.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <Typography variant="secondary" className="text-xs">No revenue data available</Typography>
                  </div>
                ) : (
                  <RevenueHoverChart
                    datapoints={revenueData}
                    compact={compact}
                  />
                )
              )}
            </div>
          </div>
        </div>
      </DesignAnalyticsCard>
    </div>
  );
}

type EmailItem = MetricsRecentEmail;

const emailStatusConfig = new Map<string, {
  label: string,
  icon: ElementType,
  bg: string,
  text: string,
  dot: string,
}>([
  ['sent',         { label: 'Sent',       icon: EnvelopeIcon,      bg: 'bg-blue-500/10 dark:bg-blue-500/15',    text: 'text-blue-600 dark:text-blue-400',    dot: 'bg-blue-500' }],
  ['opened',       { label: 'Opened',     icon: EnvelopeOpenIcon,  bg: 'bg-emerald-500/10 dark:bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' }],
  ['delivered',    { label: 'Delivered',  icon: EnvelopeIcon,      bg: 'bg-emerald-500/10 dark:bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' }],
  ['bounced',      { label: 'Bounced',    icon: XCircleIcon,       bg: 'bg-red-500/10 dark:bg-red-500/15',      text: 'text-red-600 dark:text-red-400',      dot: 'bg-red-500' }],
  ['error',        { label: 'Error',      icon: WarningCircleIcon, bg: 'bg-amber-500/10 dark:bg-amber-500/15',  text: 'text-amber-600 dark:text-amber-400',  dot: 'bg-amber-500' }],
  ['in_progress',  { label: 'Sending',    icon: EnvelopeIcon,      bg: 'bg-sky-500/10 dark:bg-sky-500/15',      text: 'text-sky-600 dark:text-sky-400',      dot: 'bg-sky-400' }],
]);

const fallbackEmailStatus = { label: 'Unknown', icon: EnvelopeIcon, bg: 'bg-foreground/[0.06]', text: 'text-muted-foreground', dot: 'bg-muted-foreground' };

function EmailListRow({ email }: { email: EmailItem }) {
  const key = email.status.toLowerCase().replace(/\s+/g, '_');
  const cfg = emailStatusConfig.get(key) ?? fallbackEmailStatus;
  const StatusIcon = cfg.icon;

  return (
    <div className="flex items-center gap-3 px-1 py-2.5 group">
      <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0", cfg.bg)}>
        <StatusIcon className={cn("h-3.5 w-3.5", cfg.text)} weight="fill" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium truncate text-foreground leading-tight">
          {email.subject}
        </div>
      </div>

      <div className={cn(
        "shrink-0 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        cfg.bg, cfg.text
      )}>
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", cfg.dot)} />
        {cfg.label}
      </div>
    </div>
  );
}

const emailLegendItems = [
  { key: 'ok',          label: 'Delivered', color: 'hsl(168, 38%, 48%)' },
  { key: 'in_progress', label: 'Sending',   color: 'hsl(213, 38%, 52%)' },
  { key: 'error',       label: 'Error',     color: 'hsl(355, 45%, 52%)' },
] as const;

function TabbedEmailsCard({
  stackedChartData,
  recentEmails,
  timeRange,
  customDateRange = null,
  compact = false,
}: {
  stackedChartData: EmailStackedDataPoint[],
  recentEmails: MetricsRecentEmail[],
  timeRange: TimeRange,
  customDateRange?: CustomDateRange | null,
  compact?: boolean,
}) {
  const [view, setView] = useState<'chart' | 'list'>('chart');
  const filteredDatapoints = filterStackedDatapointsByTimeRange(stackedChartData, timeRange, customDateRange);

  const listWindow = useInfiniteListWindow(recentEmails.length, view === "list" ? "list" : "chart", view === "list");

  return (
    <DesignAnalyticsCard
      gradient="orange"
      className="h-full min-h-0 flex flex-col"
      chart={{
        type: view === "chart" ? "stacked-bar" : "none",
        tooltipType: view === "chart" ? "stacked" : "none",
        highlightMode: view === "chart" ? "bar-segment" : "none",
      }}
    >
      <div className={cn("flex items-center justify-between border-b border-foreground/[0.05]", compact ? "px-4" : "px-5")}>
        <DesignCategoryTabs
          categories={[
            { id: "chart", label: "Emails Sent" },
            { id: "list", label: "Recent Emails" },
          ]}
          selectedCategory={view}
          onSelect={(selectedId) => {
            if (selectedId === "chart" || selectedId === "list") {
              setView(selectedId);
              return;
            }
            throw new Error(`Unsupported emails tab selected: ${selectedId}`);
          }}
          showBadge={false}
          size="sm"
          glassmorphic={false}
          gradient="blue"
          className="flex-1 min-w-0 border-0 [&>button]:rounded-none [&>button]:px-3 [&>button]:py-3.5 [&>button]:text-xs"
        />
        <SimpleTooltip tooltip="Shows sent email volume over time, with a recent-email list for delivery checks." type="info" className="ml-2" />
      </div>
      {view === 'chart' && (
        <DesignChartLegend items={emailLegendItems} compact={compact} />
      )}
      <div className={cn(
        view === 'chart'
          ? (compact ? "px-4 pt-1.5 pb-1" : "px-5 pt-2 pb-2")
          : (compact ? "px-4 pt-1 pb-2" : "px-5 pt-2 pb-3"),
        "flex flex-col flex-1 min-h-0",
        view === 'chart' ? "overflow-visible" : "overflow-hidden"
      )}>
        {view === 'chart' ? (
          filteredDatapoints.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <Typography variant="secondary" className="text-xs">No email data for this period</Typography>
            </div>
          ) : (
            <EmailStackedBarChartDisplay datapoints={filteredDatapoints} compact={compact} />
          )
        ) : (
          <div ref={listWindow.scrollRef} className="flex-1 overflow-y-auto min-h-0 pr-1 -mr-1">
            {recentEmails.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <Typography variant="secondary" className="text-xs">No recent emails</Typography>
              </div>
            ) : (
              <div className="divide-y divide-foreground/[0.04]">
                {recentEmails.slice(0, listWindow.visibleCount).map((email) => (
                  <EmailListRow key={email.id} email={email} />
                ))}
                {listWindow.hasMore && (
                  <div ref={listWindow.sentinelRef} className="py-2 text-center">
                    <Typography variant="secondary" className="text-[10px]">
                      Loading more...
                    </Typography>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </DesignAnalyticsCard>
  );
}

function EmailBreakdownCard({
  deliverabilityStatus,
  bounceRate,
  clickRate,
}: {
  deliverabilityStatus: MetricsEmailOverview['deliverability_status'],
  bounceRate: number,
  clickRate: number,
}) {
  const items = [
    { label: 'Delivered', count: deliverabilityStatus.delivered, color: '#10b981' },
    { label: 'Bounced', count: deliverabilityStatus.bounced, color: '#ef4444' },
    { label: 'In Progress', count: deliverabilityStatus.in_progress, color: '#06b6d4' },
    { label: 'Error', count: deliverabilityStatus.error, color: '#f59e0b' },
  ];
  const total = items.reduce((s, i) => s + i.count, 0);

  return (
    <DesignAnalyticsCard gradient="orange" className="h-full" chart={{ type: "none", tooltipType: "none", highlightMode: "none" }}>
      <div className="px-4 py-3 border-b border-foreground/[0.05]">
        <SimpleTooltip tooltip="Counts recent email delivery outcomes to help spot bounces and sending issues." inline className="w-fit">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Email Delivery</span>
        </SimpleTooltip>
      </div>
      <div className="p-4 pt-3 flex-1 flex flex-col gap-2.5">
        {total === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Typography variant="secondary" className="text-xs">No email data</Typography>
          </div>
        ) : (
          <>
            <div className="flex h-2 rounded-full overflow-hidden gap-px">
              {items.filter(i => i.count > 0).map((item, idx) => (
                <div key={idx} style={{ width: `${(item.count / total) * 100}%`, backgroundColor: item.color }} />
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              {items.filter(i => i.count > 0).map((item, idx) => (
                <div key={idx} className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <div className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                    <span className="text-[11px] text-foreground">{item.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {((item.count / total) * 100).toFixed(0)}%
                    </span>
                    <span className="text-[11px] font-medium text-foreground tabular-nums">
                      {item.count.toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="mt-auto pt-2 border-t border-foreground/[0.05] grid grid-cols-2 gap-2 text-center">
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Bounce Rate</div>
            <div className="text-sm font-semibold tabular-nums">{bounceRate}%</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Click Rate</div>
            <div className="text-sm font-semibold tabular-nums">{clickRate}%</div>
          </div>
        </div>
      </div>
    </DesignAnalyticsCard>
  );
}

function QuickAccessApps({ projectId, installedApps }: { projectId: string, installedApps: AppId[] }) {
  return (
    <div className={cn(
      "shrink-0 rounded-2xl bg-white/90 backdrop-blur-xl ring-1 ring-black/[0.06] shadow-sm",
      "dark:bg-transparent dark:backdrop-blur-none dark:ring-0 dark:shadow-none dark:rounded-none",
    )}>
      <div className="p-4 sm:p-5 dark:px-0">
        <div className="flex items-center gap-2 mb-3">
          <div className="p-1.5 rounded-lg bg-foreground/[0.04]">
            <SquaresFourIcon className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Quick Access
          </span>
        </div>

        {installedApps.length === 0 ? (
          <div className="flex items-center justify-center py-8 rounded-xl bg-foreground/[0.02] ring-1 ring-foreground/[0.06]">
            <Typography variant="secondary" className="text-sm text-center">
              No apps installed
            </Typography>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(90px,1fr))] gap-2">
            {installedApps.map((appId) => {
              const appFrontend = ALL_APPS_FRONTEND[appId];
              const appPath = getAppPath(projectId, appFrontend);
              const app = ALL_APPS[appId];
              return (
                <Link
                  key={appId}
                  href={appPath}
                  className="group flex flex-col items-center gap-2.5 pt-3 pb-2 rounded-xl hover:bg-foreground/[0.03] transition-all duration-150 hover:transition-none"
                  title={app.displayName}
                >
                  <div className="relative transition-transform duration-150 group-hover:transition-none group-hover:scale-105">
                    <AppIcon
                      appId={appId}
                      variant="installed"
                      className="shadow-sm group-hover:shadow-[0_0_20px_rgba(59,130,246,0.45)] group-hover:brightness-110 group-hover:saturate-110 transition-all duration-150 group-hover:transition-none"
                    />
                  </div>
                  <span
                    className="text-[11px] font-medium text-center group-hover:text-foreground transition-colors duration-150 group-hover:transition-none leading-tight w-full"
                    title={app.displayName}
                  >
                    {app.displayName}
                  </span>
                </Link>
              );
            })}

            <Link
              href={`/projects/${projectId}/apps`}
              className="group flex flex-col items-center gap-2.5 pt-3 pb-2 rounded-xl hover:bg-foreground/[0.03] transition-all duration-150 hover:transition-none"
              title="Explore apps"
            >
              <div className="relative transition-transform duration-150 group-hover:transition-none group-hover:scale-105">
                <div className="flex items-center justify-center w-[72px] h-[72px]">
                  <CompassIcon className="w-[30px] h-[30px] text-muted-foreground group-hover:text-foreground transition-colors duration-150 group-hover:transition-none" />
                </div>
              </div>
              <span className="text-[11px] font-medium text-center text-muted-foreground group-hover:text-foreground transition-colors duration-150 group-hover:transition-none leading-tight w-full">
                Explore
              </span>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MetricsPage() {
  const includeAnonymous = false;
  const [timeRange, setTimeRange] = useState<TimeRange>("30d");
  const [customDateRange, setCustomDateRange] = useState<CustomDateRange | null>(null);
  const [analyticsFilters, setAnalyticsFilters] = useState<AnalyticsOverviewFilters>({});
  const [loadedAnalyticsFilters, setLoadedAnalyticsFilters] = useState<AnalyticsOverviewFilters>({});
  const [view, setView] = useState<"overview" | "globe">("overview");
  const user = useUser();

  const displayName = user?.displayName || user?.primaryEmail || null;
  const truncatedName = displayName && displayName.length > 30 ? `${displayName.slice(0, 30)}...` : displayName;
  // The fetched filters combine the dimension chips with the date bounds from
  // the time-range toggle, so range changes re-query the top-N breakdowns too.
  const analyticsDateRange = useMemo(() => analyticsDateRangeForTimeRange(timeRange, customDateRange), [timeRange, customDateRange]);
  const requestedAnalyticsFilters = useMemo(() => ({ ...analyticsFilters, ...analyticsDateRange }), [analyticsFilters, analyticsDateRange]);
  const selectedFilterKey = analyticsFiltersKey(requestedAnalyticsFilters);
  const loadedFilterKey = analyticsFiltersKey(loadedAnalyticsFilters);
  const isUpdatingAnalyticsFilters = selectedFilterKey !== loadedFilterKey;

  const clearAnalyticsFilter = useCallback((dimension: keyof AnalyticsOverviewFilters) => {
    setAnalyticsFilters((previous) => ({ ...previous, [dimension]: undefined }));
  }, []);
  const clearAllAnalyticsFilters = useCallback(() => setAnalyticsFilters({}), []);
  const toggleAnalyticsFilter = useCallback((dimension: keyof AnalyticsOverviewFilters, value: string) => {
    setAnalyticsFilters((previous) => ({ ...previous, [dimension]: previous[dimension] === value ? undefined : value }));
  }, []);
  const markAnalyticsFiltersLoaded = useCallback(() => {
    setLoadedAnalyticsFilters(requestedAnalyticsFilters);
  }, [requestedAnalyticsFilters]);
  const headerTitle = `Welcome back${truncatedName ? `, ${truncatedName}` : ""}!`;
  const headerActions = (
    <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
      {view === "overview" && (
        <>
          <FilterChipsBar filters={analyticsFilters} onClear={clearAnalyticsFilter} onClearAll={clearAllAnalyticsFilters} />
          <FilterMenu filters={analyticsFilters} onToggle={toggleAnalyticsFilter} />
          <TimeRangeToggle
            timeRange={timeRange}
            onTimeRangeChange={setTimeRange}
            customDateRange={customDateRange}
            onCustomDateRangeChange={setCustomDateRange}
          />
        </>
      )}
      <ViewToggle view={view} onChange={setView} />
    </div>
  );

  return (
    <PageLayout
      fillWidth
      fullBleed
      containedHeight={view === "globe"}
    >
      {/* The globe tab is a contained, no-scroll scene. A sticky top offset would
          shift this bar over the globe card and clip the live-users badge. */}
      <OverviewHeader title={headerTitle} actions={headerActions} sticky={view === "overview"} />
      {view === "overview" && <AnalyticsEventLimitBanner />}
      <ErrorBoundary errorComponent={MetricsErrorComponent}>
        {/* Inside the error boundary so a failed filtered fetch surfaces the
            page's own error fallback instead of escaping to the layout. */}
        {view === "overview" && isUpdatingAnalyticsFilters && (
          <Suspense fallback={null}>
            <MetricsFilterPreloader
              includeAnonymous={includeAnonymous}
              filters={requestedAnalyticsFilters}
              filterKey={selectedFilterKey}
              onReady={markAnalyticsFiltersLoaded}
            />
          </Suspense>
        )}
        <Suspense fallback={<MetricsLoadingFallback />}>
          {view === "globe" ? (
            <GlobeView includeAnonymous={includeAnonymous} />
          ) : (
            <MetricsContent
              includeAnonymous={includeAnonymous}
              timeRange={timeRange}
              customDateRange={customDateRange}
              analyticsFilters={loadedAnalyticsFilters}
              selectedAnalyticsFilters={analyticsFilters}
              isUpdatingAnalyticsFilters={isUpdatingAnalyticsFilters}
              onToggleAnalyticsFilter={toggleAnalyticsFilter}
            />
          )}
        </Suspense>
      </ErrorBoundary>
    </PageLayout>
  );
}

function MetricsErrorComponent(props: { error: unknown, reset?: () => void }) {
  const error = props.error instanceof Error ? props.error : new Error(String(props.error));
  return <MetricsErrorFallback error={error} onRetryAction={props.reset} />;
}

function MetricsFilterPreloader({
  includeAnonymous,
  filters,
  filterKey,
  onReady,
}: {
  includeAnonymous: boolean,
  filters: AnalyticsOverviewFilters,
  filterKey: string,
  onReady: () => void,
}) {
  const adminApp = useAdminApp();
  useMetricsOrThrow(adminApp, includeAnonymous, filters);

  useEffect(() => {
    onReady();
  }, [filterKey, onReady]);

  return null;
}

function MetricsContent({
  includeAnonymous,
  timeRange,
  customDateRange,
  analyticsFilters,
  selectedAnalyticsFilters,
  isUpdatingAnalyticsFilters,
  onToggleAnalyticsFilter,
}: {
  includeAnonymous: boolean,
  timeRange: TimeRange,
  customDateRange: CustomDateRange | null,
  analyticsFilters: AnalyticsOverviewFilters,
  selectedAnalyticsFilters: AnalyticsOverviewFilters,
  isUpdatingAnalyticsFilters: boolean,
  onToggleAnalyticsFilter: (dimension: keyof AnalyticsOverviewFilters, value: string) => void,
}) {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();
  const projectId = useProjectId();
  const router = useRouter();
  const data = useMetricsOrThrow(adminApp, includeAnonymous, analyticsFilters);
  const installedApps = useMemo(
    () => getEnabledAppIds(config.apps.installed),
    [config.apps.installed]
  );
  const analyticsEnabled = installedApps.includes("analytics");
  const paymentsEnabled = installedApps.includes("payments");

  const auth = data.auth_overview;
  const payments = data.payments_overview;
  const email = data.email_overview;
  const analytics = data.analytics_overview;

  const recentEmails = email.recent_emails;
  const topReferrers = analytics.top_referrers;
  const dailyBounceRate = analytics.daily_bounce_rate;
  const dailyAvgSession = analytics.daily_avg_session_seconds;

  const dauSplit = auth.daily_active_users_split;
  const dauStackedData = useMemo<StackedDataPoint[]>(() => {
    const dateSet = new Set([
      ...dauSplit.new.map(d => d.date),
      ...dauSplit.retained.map(d => d.date),
      ...dauSplit.reactivated.map(d => d.date),
    ]);
    const newMap = new Map(dauSplit.new.map(d => [d.date, d.activity]));
    const retainedMap = new Map(dauSplit.retained.map(d => [d.date, d.activity]));
    const reactivatedMap = new Map(dauSplit.reactivated.map(d => [d.date, d.activity]));
    return [...dateSet].sort().map(date => ({
      date,
      new: newMap.get(date) ?? 0,
      retained: retainedMap.get(date) ?? 0,
      reactivated: reactivatedMap.get(date) ?? 0,
    }));
  }, [dauSplit.new, dauSplit.retained, dauSplit.reactivated]);
  const signUpsStackedData = useMemo<StackedDataPoint[]>(
    () => (timeRange === "1d" ? data.hourly_users : data.daily_users).map((point) => ({
      date: point.date,
      new: point.activity,
      retained: 0,
      reactivated: 0,
    })),
    [data.daily_users, data.hourly_users, timeRange],
  );
  const filteredDauStackedData = useMemo<StackedDataPoint[]>(
    () => timeRange === "1d"
      ? data.hourly_active_users.map((point) => ({
        date: point.date,
        new: point.activity,
        retained: 0,
        reactivated: 0,
      }))
      : filterStackedDatapointsByTimeRange(dauStackedData, timeRange, customDateRange),
    [data.hourly_active_users, dauStackedData, timeRange, customDateRange],
  );
  const dauTotalsByDate = useMemo<Map<string, number>>(
    () => new Map(dauStackedData.map((point) => [point.date, point.new + point.retained + point.reactivated])),
    [dauStackedData],
  );

  const emailStackedData = useMemo<EmailStackedDataPoint[]>(
    () => email.daily_emails_by_status,
    [email.daily_emails_by_status],
  );

  const allComposedData = useMemo<ComposedDataPoint[]>(() => {
    const dailyRev = analytics.daily_revenue;
    const dailyPageViews = analytics.daily_page_views;
    // When the analytics app isn't installed there are no `$page-view` events,
    // so fall back to token-refresh-derived anonymous visitors so the card has
    // something meaningful to render instead of a flat zero line.
    const dailyVis = analyticsEnabled ? analytics.daily_visitors : analytics.daily_anonymous_visitors_fallback;

    const visitorMap = new Map(dailyVis.map(d => [d.date, d.activity]));
    const pageViewMap = new Map(dailyPageViews.map(d => [d.date, d.activity]));
    const revenueMap = new Map(dailyRev.map(d => [d.date, d]));

    const allDates = new Set([
      ...dailyVis.map(d => d.date),
      ...dailyPageViews.map(d => d.date),
      ...dailyRev.map(d => d.date),
      ...dauStackedData.map(d => d.date),
    ]);

    const points = [...allDates].map(date => ({
      date,
      visitors: visitorMap.get(date) ?? 0,
      page_views: analyticsEnabled ? (pageViewMap.get(date) ?? 0) : 0,
      new_cents: paymentsEnabled ? (revenueMap.get(date)?.new_cents ?? 0) : 0,
      refund_cents: paymentsEnabled ? (revenueMap.get(date)?.refund_cents ?? 0) : 0,
      dau: dauTotalsByDate.get(date) ?? 0,
    })).sort((a, b) => stringCompare(a.date, b.date));

    return points;
  }, [analytics.daily_revenue, analytics.daily_page_views, analytics.daily_visitors, analytics.daily_anonymous_visitors_fallback, dauStackedData, dauTotalsByDate, analyticsEnabled, paymentsEnabled]);
  const hourlyComposedData = useMemo<ComposedDataPoint[]>(() => {
    const activeUserMap = new Map(analytics.hourly_active_users.map((point) => [point.date, point.activity]));
    const visitorMap = new Map(analytics.hourly_visitors.map((point) => [point.date, point.activity]));
    const pageViewMap = new Map(analytics.hourly_page_views.map((point) => [point.date, point.activity]));
    const allDates = new Set([
      ...analytics.hourly_active_users.map((point) => point.date),
      ...analytics.hourly_visitors.map((point) => point.date),
      ...analytics.hourly_page_views.map((point) => point.date),
    ]);

    return [...allDates]
      .map((date) => ({
        date,
        visitors: visitorMap.get(date) ?? 0,
        page_views: pageViewMap.get(date) ?? 0,
        new_cents: 0,
        refund_cents: 0,
        dau: activeUserMap.get(date) ?? 0,
      }))
      .sort((a, b) => stringCompare(a.date, b.date));
  }, [analytics.hourly_active_users, analytics.hourly_page_views, analytics.hourly_visitors]);
  const composedData = useMemo<ComposedDataPoint[]>(
    () => timeRange === "1d"
      ? hourlyComposedData
      : filterStackedDatapointsByTimeRange(allComposedData, timeRange, customDateRange),
    [allComposedData, hourlyComposedData, timeRange, customDateRange],
  );
  const filteredDailyPageViews = useMemo(
    () => timeRange === "1d"
      ? analytics.hourly_page_views
      : filterStackedDatapointsByTimeRange(analytics.daily_page_views, timeRange, customDateRange),
    [analytics.daily_page_views, analytics.hourly_page_views, timeRange, customDateRange],
  );

  const topCountries = useMemo<Array<{ country_code: string, count: number }>>(() => {
    return analytics.top_regions
      .filter((row) => row.country_code.length > 0 && Number.isFinite(row.count) && row.count > 0)
      .map((row) => ({ country_code: row.country_code.toUpperCase(), count: row.count }))
      .sort((a, b) => b.count - a.count || stringCompare(a.country_code, b.country_code))
      .slice(0, 3);
  }, [analytics.top_regions]);

  const visitorsHoverData = useMemo<VisitorsHoverDataPoint[]>(() => {
    if (!analyticsEnabled) {
      return [];
    }
    const pageViews = timeRange === "1d" ? analytics.hourly_page_views : analytics.daily_page_views;

    const pvMap = new Map(pageViews.map(d => [d.date, d.activity]));
    const allDates = new Set(pageViews.map(d => d.date));

    const points = [...allDates].map(date => ({
      date,
      page_views: pvMap.get(date) ?? 0,
      top_countries: topCountries,
    })).sort((a, b) => stringCompare(a.date, b.date));

    return timeRange === "1d" ? points : filterStackedDatapointsByTimeRange(points, timeRange, customDateRange);
  }, [analytics.daily_page_views, analytics.hourly_page_views, timeRange, customDateRange, topCountries, analyticsEnabled]);

  const revenueHoverData = useMemo<RevenueHoverDataPoint[]>(() => {
    if (!paymentsEnabled) {
      return [];
    }

    const points = analytics.daily_revenue.map(d => ({
      date: d.date,
      new_cents: d.new_cents,
      refund_cents: d.refund_cents,
    })).sort((a, b) => stringCompare(a.date, b.date));

    return filterStackedDatapointsByTimeRange(points, timeRange, customDateRange);
  }, [analytics.daily_revenue, timeRange, customDateRange, paymentsEnabled]);

  const inChartPillValues = useMemo(() => {
    const latestDauPoint = dauStackedData.at(-1);
    const latestDau = latestDauPoint == null
      ? 0
      : latestDauPoint.new + latestDauPoint.retained + latestDauPoint.reactivated;
    const previousDauPoint = dauStackedData.at(-2);
    const previousDau = previousDauPoint == null
      ? undefined
      : previousDauPoint.new + previousDauPoint.retained + previousDauPoint.reactivated;
    const visitorsTotalInRange = composedData.reduce((sum, row) => sum + row.visitors, 0);
    // Revenue is only available at daily granularity, so derive the total from the
    // daily revenue series (already filtered by the active range). The hourly composed
    // data used in the 1d view has no revenue, which would otherwise zero this out.
    const totalRevenueCentsInRange = revenueHoverData.reduce((sum, row) => sum + row.new_cents, 0);

    const composedIndexByDate = new Map(allComposedData.map((row, index) => [row.date, index]));
    const firstComposedPoint = composedData.at(0);
    const composedCurrentStartIndex = firstComposedPoint == null ? -1 : (composedIndexByDate.get(firstComposedPoint.date) ?? -1);
    const composedCurrentLength = composedData.length;
    const composedPreviousStartIndex = composedCurrentStartIndex - composedCurrentLength;
    const composedPreviousEndIndex = composedCurrentStartIndex - 1;
    const previousComposedWindow = composedPreviousStartIndex < 0
      ? []
      : allComposedData.slice(composedPreviousStartIndex, composedPreviousEndIndex + 1);
    const hasFullPreviousComposedWindow = previousComposedWindow.length === composedCurrentLength && composedCurrentLength > 0;
    const previousVisitorsTotal = previousComposedWindow.reduce((sum, row) => sum + row.visitors, 0);
    const previousRevenueTotalCents = previousComposedWindow.reduce((sum, row) => sum + row.new_cents, 0);

    return {
      dauTotal: formatCompact(latestDau),
      dauLabel: "Daily Active Users",
      dauDelta: previousDau == null ? undefined : calculatePeriodDelta(latestDau, previousDau),
      // Sum of per-bucket uniques — a visitor active on several days counts
      // once per day, so this is NOT deduplicated across the whole period.
      // Labeled "Visitors" (not "Unique Visitors") for that reason.
      visitorsTotal: formatCompact(visitorsTotalInRange),
      visitorsLabel: "Visitors",
      visitorsDelta: hasFullPreviousComposedWindow ? calculatePeriodDelta(visitorsTotalInRange, previousVisitorsTotal) : undefined,
      revenueTotal: paymentsEnabled
        ? formatUsdFromCents(totalRevenueCentsInRange)
        : "—",
      revenueLabel: "Revenue",
      revenueDelta: paymentsEnabled && hasFullPreviousComposedWindow ? calculatePeriodDelta(totalRevenueCentsInRange, previousRevenueTotalCents) : undefined,
    };
  }, [allComposedData, composedData, dauStackedData, paymentsEnabled, revenueHoverData]);

  const bounceByDate = useMemo(() => new Map(dailyBounceRate.map((point) => [point.date, point.activity])), [dailyBounceRate]);
  const sessionByDate = useMemo(() => new Map(dailyAvgSession.map((point) => [point.date, point.activity])), [dailyAvgSession]);

  const analyticsPeriodTotals = useMemo(() => {
    const totalVisitors = composedData.reduce((sum, row) => sum + row.visitors, 0);
    const totalPageViews = filteredDailyPageViews.reduce((sum, row) => sum + row.activity, 0);

    const composedIndexByDate = new Map(allComposedData.map((row, index) => [row.date, index]));
    const firstPoint = composedData.at(0);
    const startIndex = firstPoint == null ? -1 : (composedIndexByDate.get(firstPoint.date) ?? -1);
    const currentLength = composedData.length;
    const previousStart = startIndex - currentLength;
    const previousEnd = startIndex - 1;
    const previousWindow = previousStart < 0 ? [] : allComposedData.slice(previousStart, previousEnd + 1);
    const hasPreviousWindow = previousWindow.length === currentLength && currentLength > 0;
    const previousVisitors = previousWindow.reduce((sum, row) => sum + row.visitors, 0);
    const previousPageViews = previousWindow.reduce((sum, row) => sum + row.page_views, 0);

    const avgOf = (rows: Array<{ date: string }>, source: Map<string, number>) => {
      let sum = 0;
      let count = 0;
      for (const row of rows) {
        const value = source.get(row.date);
        if (value == null) continue;
        sum += value;
        count += 1;
      }
      return count > 0 ? sum / count : 0;
    };
    const avgBounce = avgOf(composedData, bounceByDate);
    const avgSession = avgOf(composedData, sessionByDate);
    const previousAvgBounce = avgOf(previousWindow, bounceByDate);
    const previousAvgSession = avgOf(previousWindow, sessionByDate);

    return {
      totalVisitors,
      pagesPerVisitor: pagesPerVisitor(totalPageViews, totalVisitors),
      previousPagesPerVisitor: pagesPerVisitor(previousPageViews, previousVisitors),
      avgBounce,
      avgSession,
      previousAvgBounce,
      previousAvgSession,
      hasPreviousWindow,
    };
  }, [allComposedData, bounceByDate, composedData, filteredDailyPageViews, sessionByDate]);

  const pagesPerVisitorSparkValues = useMemo(
    () => composedData.slice(-14).map((point) => pagesPerVisitor(point.page_views, point.visitors)),
    [composedData],
  );
  const mauSparkValues = useMemo(
    () => filteredDauStackedData.slice(-14).map((point) => point.new + point.retained + point.reactivated),
    [filteredDauStackedData],
  );
  const emailSparkValues = useMemo(
    () => filterStackedDatapointsByTimeRange(emailStackedData, timeRange, customDateRange)
      .slice(-14)
      .map((point) => point.ok + point.error + point.in_progress),
    [emailStackedData, timeRange, customDateRange],
  );
  const sessionSparkValues = useMemo(
    () => filterStackedDatapointsByTimeRange(dailyAvgSession, timeRange, customDateRange)
      .slice(-14)
      .map((point) => point.activity),
    [dailyAvgSession, timeRange, customDateRange],
  );
  const topRegionsByCountry = useMemo(() => {
    const entries = analytics.top_regions
      .filter((row) => row.country_code.length > 0 && Number.isFinite(row.count) && row.count > 0)
      .map((row) => [row.country_code.toUpperCase(), row.count]);
    return Object.fromEntries(entries);
  }, [analytics.top_regions]);

  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [gridContainerWidth, setGridContainerWidth] = useState(0);
  const [isLgViewport, setIsLgViewport] = useState(false);
  useLayoutEffect(() => {
    setGridContainerWidth(gridContainerRef.current?.getBoundingClientRect().width ?? 0);
  }, []);
  useLayoutEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsLgViewport(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);
  useResizeObserver(gridContainerRef, (entry) => setGridContainerWidth(entry.contentRect.width));

  const GLOBE_MIN_WIDTH = 352.5;
  const globeColumnWidth = (() => {
    if (!gridContainerWidth) return 0;
    const gap = 20;
    const availableWidth = gridContainerWidth - gap * 11;
    return (availableWidth / 12) * 5 + gap * 4;
  })();
  const shouldShowGlobe = isLgViewport && globeColumnWidth >= GLOBE_MIN_WIDTH;
  return (
    <div className={cn(
      "pb-6 flex flex-col gap-5 transition-opacity duration-200 ease-out",
      isUpdatingAnalyticsFilters ? "opacity-70" : "opacity-100",
    )}>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <UserPageMetricCard
          label="Pages / Visitor"
          tooltip="Page views divided by unique visitors for the selected period."
          value={analyticsEnabled ? formatPagesPerVisitor(analyticsPeriodTotals.pagesPerVisitor) : "—"}
          description="avg in period"
          gradient="blue"
          delta={analyticsEnabled && analyticsPeriodTotals.hasPreviousWindow ? {
            current: analyticsPeriodTotals.pagesPerVisitor,
            previous: analyticsPeriodTotals.previousPagesPerVisitor,
            comparisonLabel: "vs prev. period",
          } : undefined}
          spark={analyticsEnabled && pagesPerVisitorSparkValues.length >= 2 ? { values: pagesPerVisitorSparkValues } : undefined}
        />
        <UserPageMetricCard
          label="Monthly Active Users"
          tooltip="Unique users active during the current month."
          value={formatCompact(Math.min(auth.mau, data.total_users))}
          description="current"
          gradient="green"
          spark={mauSparkValues.length >= 2 ? { values: mauSparkValues } : undefined}
        />
        <UserPageMetricCard
          label="Total Emails Sent"
          tooltip="All emails sent by this project."
          value={formatCompact(email.emails_sent)}
          description="all time"
          gradient="orange"
          spark={emailSparkValues.length >= 2 ? { values: emailSparkValues } : undefined}
        />
        <UserPageMetricCard
          label="Avg. Session Time"
          tooltip="Average session duration from page views and clicks for the selected period."
          value={analyticsEnabled ? formatSeconds(analyticsPeriodTotals.avgSession) : "—"}
          description="in period"
          gradient="purple"
          delta={analyticsEnabled && analyticsPeriodTotals.hasPreviousWindow ? {
            current: analyticsPeriodTotals.avgSession,
            previous: analyticsPeriodTotals.previousAvgSession,
            comparisonLabel: "vs prev. period",
          } : undefined}
          spark={sessionSparkValues.length >= 2 ? { values: sessionSparkValues } : undefined}
        />
      </div>

      <div
        ref={gridContainerRef}
        className={cn(
          "grid gap-4 sm:gap-5 grid-cols-1 lg:grid-cols-12",
          "min-h-[400px] lg:h-[440px]",
        )}
      >
        {shouldShowGlobe && (
          <div data-walkthrough="overview-globe" className={cn(
            "hidden lg:flex lg:col-span-5 h-full relative items-center justify-center overflow-hidden",
            "rounded-2xl bg-white/90 backdrop-blur-xl ring-1 ring-black/[0.06] shadow-sm",
            "dark:bg-transparent dark:backdrop-blur-none dark:ring-0 dark:shadow-none dark:rounded-none",
          )}>
            <div className="pointer-events-none absolute top-0 left-0 z-10 px-5 pt-4 dark:px-1 dark:pt-0">
              <div className="flex items-center gap-2 mb-2">
                <div className="p-1.5 rounded-lg bg-foreground/[0.04]">
                  <GlobeIcon className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <SimpleTooltip tooltip="All project users, grouped by their latest known location." inline className="pointer-events-auto w-fit">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Total Users
                  </span>
                </SimpleTooltip>
              </div>
              <div className="text-4xl font-bold tracking-tight text-foreground pl-0.5">
                {data.total_users.toLocaleString()}
              </div>
            </div>
            <GlobeSectionWithData includeAnonymous={includeAnonymous} />
          </div>
        )}

        <div data-walkthrough="overview-metrics" className={cn(
          "h-full",
          shouldShowGlobe ? "lg:col-span-7" : "lg:col-span-12",
        )}>
          <AnalyticsChartWidget
            composedData={composedData}
            dauStackedData={filteredDauStackedData}
            visitorsData={visitorsHoverData}
            revenueData={revenueHoverData}
            analyticsEnabled={analyticsEnabled}
            paymentsEnabled={paymentsEnabled}
            projectId={projectId}
            dauLabel={inChartPillValues.dauLabel}
            dauTotal={inChartPillValues.dauTotal}
            visitorsLabel={inChartPillValues.visitorsLabel}
            revenueLabel={inChartPillValues.revenueLabel}
            dauDelta={inChartPillValues.dauDelta}
            visitorsTotal={inChartPillValues.visitorsTotal}
            revenueTotal={inChartPillValues.revenueTotal}
            visitorsDelta={inChartPillValues.visitorsDelta}
            revenueDelta={inChartPillValues.revenueDelta}
            compact={shouldShowGlobe}
          />
        </div>
      </div>

      <QuickAccessApps projectId={projectId} installedApps={installedApps} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-0 lg:h-[340px]">
        <div className="min-h-[340px] lg:min-h-0 lg:h-full">
          <TabbedMetricsCard
            config={dailySignUpsConfig}
            chartData={timeRange === "1d" ? data.hourly_users : data.daily_users}
            stackedChartData={signUpsStackedData}
            stackedLegendItems={[
              { key: "new", label: "Sign-Ups", color: "hsl(152, 38%, 52%)" },
            ]}
            listData={data.recently_registered}
            listTitle="Recent Sign-Ups"
            projectId={projectId}
            router={router}
            compact
            gradientColor="blue"
            timeRange={timeRange}
            customDateRange={customDateRange}
            chartDataIsPreFiltered={timeRange === "1d"}
            headerTooltip="New sign-ups over time, with recent users for quick follow-up."
          />
        </div>
        <div className="min-h-[340px] lg:min-h-0 lg:h-full">
          <TabbedEmailsCard
            stackedChartData={emailStackedData}
            recentEmails={recentEmails}
            timeRange={timeRange}
            customDateRange={customDateRange}
            compact
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <DonutChartDisplay
          datapoints={data.login_methods}
          compact
          gradientColor="blue"
        />
        <EmailBreakdownCard
          deliverabilityStatus={email.deliverability_status}
          bounceRate={email.bounce_rate}
          clickRate={email.click_rate}
        />
        <ReferrersWithAnalyticsCard
          topReferrers={topReferrers}
          headerTooltip="Referrers that sent the most unique visitors to this project."
          analyticsEnabled={analyticsEnabled}
          projectId={projectId}
          onSelectReferrer={(referrer) => onToggleAnalyticsFilter("referrer", referrer)}
          selectedReferrer={selectedAnalyticsFilters.referrer}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <TopRegionsCard
          usersByCountry={topRegionsByCountry}
          headerTooltip="Unique page-view visitors grouped by latest known country."
          onSelectCountry={(code) => onToggleAnalyticsFilter("country_code", code)}
          selectedCountry={selectedAnalyticsFilters.country_code}
        />
        <TopNamedListCard
          title="Top Browsers"
          headerTooltip="Browsers used most often by unique visitors."
          items={analytics.top_browsers}
          gradient="green"
          barClassName="bg-emerald-500/10 dark:bg-emerald-400/10"
          Icon={MonitorIcon}
          emptyLabel="No browser data"
          getRowIcon={browserIcon}
          onSelectItem={(name) => onToggleAnalyticsFilter("browser", name)}
          selectedItem={selectedAnalyticsFilters.browser}
        />
        <TopNamedListCard
          title="Operating Systems"
          headerTooltip="Operating systems used most often by unique visitors."
          items={analytics.top_operating_systems}
          gradient="orange"
          barClassName="bg-amber-500/10 dark:bg-amber-400/10"
          Icon={GearIcon}
          emptyLabel="No OS data"
          getRowIcon={osIcon}
          onSelectItem={(name) => onToggleAnalyticsFilter("os", name)}
          selectedItem={selectedAnalyticsFilters.os}
        />
        <TopNamedListCard
          title="Devices"
          headerTooltip="Device types used most often by unique visitors."
          items={analytics.top_devices}
          gradient="slate"
          barClassName="bg-slate-500/10 dark:bg-slate-400/10"
          Icon={DesktopIcon}
          emptyLabel="No device data"
          getRowIcon={deviceIcon}
          onSelectItem={(name) => onToggleAnalyticsFilter("device", name)}
          selectedItem={selectedAnalyticsFilters.device}
        />
      </div>
    </div>
  );
}

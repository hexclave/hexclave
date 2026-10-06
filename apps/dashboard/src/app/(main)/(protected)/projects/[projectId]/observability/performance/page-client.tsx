"use client";

import {
  DesignAlert,
  DesignAnalyticsCard,
  DesignAnalyticsCardHeader,
  DesignBadge,
  DesignButton,
  DesignChartContainer,
  DesignChartTooltipContent,
  DesignInput,
  DesignPillToggle,
  DesignSelectorDropdown,
  getDesignChartColor,
} from "@/components/design-components";
import { Link } from "@/components/link";
import { cn } from "@/lib/utils";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import {
  ArrowUpRightIcon,
  CheckCircleIcon,
  CursorClickIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AppEnabledGuard } from "../../app-enabled-guard";
import { useAdminApp } from "../../use-admin-app";
import { getBucketGranularity } from "../bucket-granularity";
import { formatCount, formatDuration } from "../format";
import { traceDetailHref } from "../issues/issue-links";
import { observabilityTimeRangeLabel } from "../filters";
import { ObservabilityPageLayout } from "../observability-page-layout";
import {
  ObservabilityErrorState,
  ObservabilityLoadingState,
  ObservabilityRefreshButton,
  ObservabilityTimeRangeToggle,
  ObservabilityToolbar,
} from "../page-chrome";
import {
  fetchPerformanceMetrics,
  fetchPerformancePageModel,
  formatWebVitalValue,
  getPerformanceMetricChartDomain,
  isPerformanceMetricType,
  rankPageInsights,
  selectAvailableTimelineMetric,
  sumPageBehavior,
  sortPerformancePages,
  webVitalByKey,
  webVitalRating,
  WEB_VITAL_METRICS,
  type PageInsight,
  type PagePerformance,
  type PerformanceMetricCatalogEntry,
  type PerformanceMetricResponse,
  type PerformancePageSort,
  type PerformanceTimeRangeHours,
  type PerformanceTimelineBucket,
  type PerformanceVitalsOverview,
  type VitalDistribution,
  type WebVitalMetricDefinition,
  type WebVitalMetricKey,
} from "./performance-data";

function formatMetricType(metricType: PerformanceMetricCatalogEntry["metric_type"]): string {
  if (metricType === "exponential_histogram") return "Exponential histogram";
  return metricType.charAt(0).toUpperCase() + metricType.slice(1);
}

function formatMetricValue(value: number | null, unit: string): string {
  if (value === null) return "Not numerically aggregated";
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  return unit === "" ? formatted : `${formatted} ${unit}`;
}

function formatMetricAxisValue(value: number, unit: string): string {
  const formatted = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format(value);
  return unit === "" ? formatted : `${formatted} ${unit}`;
}

function unixNanoToMilliseconds(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Cannot format invalid metric timestamp: ${value}`);
  const milliseconds = Number(BigInt(value) / BigInt(1_000_000));
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`Metric timestamp is outside the supported display range: ${value}`);
  return milliseconds;
}

function formatUnixNano(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(
    new Date(unixNanoToMilliseconds(value)),
  );
}

function formatMetricBucketLabel(value: string, hours: PerformanceTimeRangeHours): string {
  const date = new Date(unixNanoToMilliseconds(value));
  if (hours <= 24) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function metricSelectorValue(entry: PerformanceMetricCatalogEntry): string {
  return `${entry.metric_name}::${entry.metric_type}`;
}

function metricSelectorOptions(catalog: readonly PerformanceMetricCatalogEntry[]) {
  return catalog.map((entry) => ({
    value: metricSelectorValue(entry),
    label: `${entry.metric_name} · ${formatMetricType(entry.metric_type)}`,
  }));
}

function selectedCatalogEntry(
  response: PerformanceMetricResponse,
): PerformanceMetricCatalogEntry | null {
  if (response.selected_metric_name === null || response.selected_metric_type === null) return null;
  return response.catalog.find((entry) => (
    entry.metric_name === response.selected_metric_name && entry.metric_type === response.selected_metric_type
  )) ?? null;
}

function customMetricCatalog(catalog: readonly PerformanceMetricCatalogEntry[]): PerformanceMetricCatalogEntry[] {
  return catalog.filter((entry) => !WEB_VITAL_METRICS.some((metric) => metric.metricName === entry.metric_name));
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function goodShare(distribution: VitalDistribution): number | null {
  if (distribution.samples === 0) return null;
  return distribution.good / distribution.samples;
}

function ratingTextClass(color: ReturnType<typeof webVitalRating>["color"]): string {
  switch (color) {
    case "green": {
      return "text-emerald-600 dark:text-emerald-400";
    }
    case "orange": {
      return "text-amber-600 dark:text-amber-400";
    }
    case "red": {
      return "text-red-600 dark:text-red-400";
    }
    case "zinc": {
      return "text-muted-foreground";
    }
    default: {
      const exhaustive: never = color;
      throw new Error(`Unknown web vital rating color: ${exhaustive}`);
    }
  }
}

function cardGradientForRating(color: ReturnType<typeof webVitalRating>["color"]): "green" | "orange" | "cyan" | "slate" {
  switch (color) {
    case "green": {
      return "green";
    }
    case "orange": {
      return "orange";
    }
    case "red": {
      return "orange";
    }
    case "zinc": {
      return "slate";
    }
    default: {
      const exhaustive: never = color;
      throw new Error(`Unknown web vital rating color: ${exhaustive}`);
    }
  }
}

function VitalDistributionBar({ distribution, className }: { distribution: VitalDistribution, className?: string }) {
  if (distribution.samples === 0) {
    return <div className={cn("h-1.5 w-full rounded-full bg-foreground/[0.08]", className)} />;
  }
  const good = (distribution.good / distribution.samples) * 100;
  const needsWork = (distribution.needsWork / distribution.samples) * 100;
  const poor = (distribution.poor / distribution.samples) * 100;
  return (
    <div className={cn("flex h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]", className)} aria-hidden="true">
      {good > 0 && <span className="bg-emerald-500" style={{ width: `${good}%` }} />}
      {needsWork > 0 && <span className="bg-amber-500" style={{ width: `${needsWork}%` }} />}
      {poor > 0 && <span className="bg-red-500" style={{ width: `${poor}%` }} />}
    </div>
  );
}

function WebVitalHeroCard({
  metricKey,
  distribution,
  sampleNoun,
}: {
  metricKey: WebVitalMetricKey,
  distribution: VitalDistribution,
  sampleNoun: string,
}) {
  const metric = webVitalByKey(metricKey);
  const rating = webVitalRating(metric, distribution.p75);
  const share = goodShare(distribution);
  return (
    <DesignAnalyticsCard gradient={cardGradientForRating(rating.color)} className="overflow-hidden">
      <div className="flex h-full flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{metric.label}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{metric.description}</p>
          </div>
          <DesignBadge label={rating.label} color={rating.color} size="sm" />
        </div>
        <p className={cn("text-3xl font-semibold tabular-nums tracking-tight", ratingTextClass(rating.color))}>
          {formatWebVitalValue(metric, distribution.p75)}
        </p>
        <VitalDistributionBar distribution={distribution} />
        <p className="text-[11px] tabular-nums text-muted-foreground">
          {distribution.samples === 0
            ? `No ${sampleNoun} in this window`
            : `${share == null ? "" : `${formatPercent(share)} good · `}${formatCount(distribution.samples)} ${sampleNoun} · p75`}
        </p>
      </div>
    </DesignAnalyticsCard>
  );
}

function CompactVital({
  metricKey,
  distribution,
}: {
  metricKey: WebVitalMetricKey,
  distribution: VitalDistribution,
}) {
  const metric = webVitalByKey(metricKey);
  const rating = webVitalRating(metric, distribution.p75);
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{metric.label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", ratingTextClass(rating.color))}>
        {formatWebVitalValue(metric, distribution.p75)}
      </p>
      <div className="mt-2">
        <VitalDistributionBar distribution={distribution} />
      </div>
    </div>
  );
}

function timelineTooltipLabel(payload: readonly { payload?: unknown }[]): string {
  if (payload.length === 0) return "";
  const raw = payload[0].payload;
  if (typeof raw !== "object" || raw == null) return "";
  if (!("label" in raw) || !("views" in raw)) return "";
  const label = raw.label;
  const views = raw.views;
  if (typeof label !== "string" || typeof views !== "number") return "";
  return `${label} · ${formatCount(views)} views`;
}

function formatBucketLabel(bucketMs: number, hours: PerformanceTimeRangeHours): string {
  const date = new Date(bucketMs);
  if (hours === 1) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (hours === 24) return date.toLocaleTimeString([], { hour: "numeric" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function VitalsTimelineChart({
  buckets,
  hours,
  metricKey,
  onMetricKeyChange,
}: {
  buckets: readonly PerformanceTimelineBucket[],
  hours: PerformanceTimeRangeHours,
  metricKey: "lcp" | "inp",
  onMetricKeyChange: (key: "lcp" | "inp") => void,
}) {
  const metric = webVitalByKey(metricKey);
  const granularity = getBucketGranularity(hours);
  const color = getDesignChartColor(metricKey === "lcp" ? "cyan" : "purple");
  const chartData = buckets.map((bucket) => ({
    bucketMs: bucket.bucketMs,
    label: formatBucketLabel(bucket.bucketMs, hours),
    value: metricKey === "lcp" ? bucket.lcpP75 : bucket.inpP75,
    views: bucket.views,
  }));
  const valueCount = chartData.filter((point) => point.value != null).length;
  const hasValues = valueCount > 0;
  const domain = getPerformanceMetricChartDomain(chartData.map((point) => point.value), false);

  return (
    <DesignAnalyticsCard
      gradient="cyan"
      className="overflow-hidden"
      chart={{ type: "line", tooltipType: "default", highlightMode: "dot-hover" }}
    >
      <DesignAnalyticsCardHeader
        compact
        label="p75 over time"
        right={(
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-[11px] tabular-nums text-muted-foreground sm:inline">
              {granularity.label}
            </span>
            <DesignPillToggle
              selected={metricKey}
              onSelect={(id) => {
                if (id !== "lcp" && id !== "inp") throw new Error(`Unknown timeline metric: ${id}`);
                onMetricKeyChange(id);
              }}
              options={[
                { id: "lcp", label: "LCP" },
                { id: "inp", label: "INP" },
              ]}
              size="sm"
              glassmorphic={false}
            />
          </div>
        )}
      />
      <div className="h-52 px-2 pb-3 pt-2">
        {!hasValues ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No {metric.label} samples in this window.
          </div>
        ) : (
          <DesignChartContainer
            config={{ value: { label: `${metric.label} p75`, color } }}
            maxHeight={200}
            className="h-full w-full"
          >
            <AreaChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="performance-vital-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                minTickGap={28}
              />
              <YAxis
                domain={domain}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={44}
                tickFormatter={(value: number) => formatWebVitalValue(metric, value)}
              />
              <RechartsTooltip
                cursor={{ stroke: "hsl(var(--border))" }}
                content={
                  <DesignChartTooltipContent
                    labelFormatter={(_label, payload) => timelineTooltipLabel(payload)}
                    indicator="dot"
                  />
                }
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={1.5}
                fill="url(#performance-vital-fill)"
                connectNulls={false}
                dot={valueCount <= 24 ? { r: 2, fill: color, strokeWidth: 0 } : false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            </AreaChart>
          </DesignChartContainer>
        )}
      </div>
    </DesignAnalyticsCard>
  );
}

function BehaviorStat({
  label,
  value,
  hint,
  warn,
}: {
  label: string,
  value: string,
  hint?: string,
  warn?: boolean,
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", warn === true && "text-red-600 dark:text-red-400")}>{value}</p>
      {hint != null && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function insightCopy(insight: PageInsight): { title: string, detail: string } {
  switch (insight.kind) {
    case "slow-lcp": {
      return {
        title: "Slowest hard load",
        detail: `${insight.page.path} · p75 LCP ${formatWebVitalValue(webVitalByKey("lcp"), insight.page.lcpP75)}`,
      };
    }
    case "slow-inp": {
      return {
        title: "Slowest interactions",
        detail: `${insight.page.path} · p75 INP ${formatWebVitalValue(webVitalByKey("inp"), insight.page.inpP75)}`,
      };
    }
    case "rage": {
      return {
        title: "Rage clicks",
        detail: `${insight.page.path} · ${formatCount(insight.page.rageClicks)} bursts`,
      };
    }
    case "dead-clicks": {
      return {
        title: "Dead clicks",
        detail: `${insight.page.path} · ${formatPercent(insight.page.clicks === 0 ? 0 : insight.page.deadClicks / insight.page.clicks)} of clicks did nothing`,
      };
    }
    case "shallow": {
      return {
        title: "People leave early",
        detail: `${insight.page.path} · ${formatDuration(insight.page.avgTimeOnPageMs)} on page, ${insight.page.avgScrollRatio == null ? "no scroll" : formatPercent(insight.page.avgScrollRatio)} scrolled`,
      };
    }
    default: {
      const exhaustive: never = insight.kind;
      throw new Error(`Missing copy for performance insight: ${exhaustive}`);
    }
  }
}

function InsightsRow({
  insights,
  rangeLabel,
  onSelectPath,
}: {
  insights: readonly PageInsight[],
  rangeLabel: string,
  onSelectPath: (path: string) => void,
}) {
  if (insights.length === 0) {
    return (
      <DesignAnalyticsCard gradient="green">
        <div className="flex items-center gap-3 p-4">
          <CheckCircleIcon className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="min-w-0">
            <p className="text-sm font-medium">No obvious hotspots</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              No slow p75s, rage bursts, dead-click clusters, or bounce-like pages in the last {rangeLabel}.
            </p>
          </div>
        </div>
      </DesignAnalyticsCard>
    );
  }

  return (
    <DesignAnalyticsCard gradient="orange">
      <DesignAnalyticsCardHeader
        compact
        label="Where to look"
        right={<span className="text-[11px] text-muted-foreground">Not alerts — the pages that are costing you</span>}
      />
      <div className="grid gap-px sm:grid-cols-3">
        {insights.map((insight) => {
          const copy = insightCopy(insight);
          return (
            <button
              key={`${insight.kind}-${insight.page.path}`}
              type="button"
              onClick={() => onSelectPath(insight.page.path)}
              className="px-4 py-3 text-left transition-colors duration-150 hover:bg-foreground/[0.03] hover:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
            >
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{copy.title}</p>
              <p className="mt-1 truncate text-sm font-medium">{copy.detail}</p>
            </button>
          );
        })}
      </div>
    </DesignAnalyticsCard>
  );
}

const PAGE_GRID_CLASS = "grid grid-cols-[minmax(10rem,1.5fr)_4.5rem_5.5rem_5.5rem_4.5rem_5.5rem_4.5rem_4.25rem_4.25rem]";

function VitalCell({ metricKey, value, samples }: { metricKey: WebVitalMetricKey, value: number | null, samples: number }) {
  const metric = webVitalByKey(metricKey);
  const rating = webVitalRating(metric, value);
  return (
    <span className="text-right">
      <span className={cn("block text-xs tabular-nums", ratingTextClass(rating.color))}>
        {formatWebVitalValue(metric, value)}
      </span>
      <span className="mt-0.5 block text-[10px] tabular-nums text-muted-foreground">
        {samples === 0 ? "—" : `${formatCount(samples)}`}
      </span>
    </span>
  );
}

function PagesTable({
  pages,
  search,
  onSearch,
  sort,
  onSort,
  selectedPath,
  onSelectPath,
}: {
  pages: readonly PagePerformance[],
  search: string,
  onSearch: (value: string) => void,
  sort: PerformancePageSort,
  onSort: (sort: PerformancePageSort) => void,
  selectedPath: string | null,
  onSelectPath: (path: string) => void,
}) {
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matched = needle === ""
      ? [...pages]
      : pages.filter((page) => page.path.toLowerCase().includes(needle));
    return sortPerformancePages(matched, sort);
  }, [pages, search, sort]);

  return (
    <DesignAnalyticsCard gradient="slate">
      <DesignAnalyticsCardHeader
        label="Pages"
        right={(
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {filtered.length === pages.length
              ? `${pages.length} paths`
              : `${filtered.length} of ${pages.length}`}
          </span>
        )}
      />
      <div className="flex flex-wrap items-center gap-3 border-b border-foreground/[0.05] p-3">
        <div className="relative min-w-[12rem] flex-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <DesignInput
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Filter paths…"
            aria-label="Filter pages by path"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <DesignPillToggle
          selected={sort}
          onSelect={(id) => {
            if (id !== "views" && id !== "slowest" && id !== "friction") throw new Error(`Unknown page sort: ${id}`);
            onSort(id);
          }}
          options={[
            { id: "views", label: "Most viewed" },
            { id: "slowest", label: "Slowest" },
            { id: "friction", label: "Most friction" },
          ]}
          size="sm"
          glassmorphic={false}
        />
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[52rem]">
          <div className={cn(
            "items-center gap-3 border-b border-foreground/[0.05] px-4 py-2",
            "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground",
            PAGE_GRID_CLASS,
          )}>
            <span>Path</span>
            <span className="text-right">Views</span>
            <span className="text-right">LCP p75</span>
            <span className="text-right">INP p75</span>
            <span className="text-right">CLS p75</span>
            <span className="text-right">Time</span>
            <span className="text-right">Scroll</span>
            <span className="text-right">Rage</span>
            <span className="text-right">Dead</span>
          </div>
          {filtered.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              {pages.length === 0 ? "No page views in this window." : "No paths match this filter."}
            </p>
          ) : filtered.map((page) => {
            const selected = selectedPath === page.path;
            return (
              <button
                key={page.path}
                type="button"
                aria-pressed={selected}
                onClick={() => onSelectPath(page.path)}
                className={cn(
                  "w-full items-center gap-3 border-b border-foreground/[0.05] px-4 py-2.5 text-left last:border-b-0",
                  "transition-colors duration-150 hover:transition-none",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
                  PAGE_GRID_CLASS,
                  selected ? "bg-cyan-500/[0.07]" : "hover:bg-foreground/[0.025]",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs font-medium">{page.path}</span>
                  <span className="mt-0.5 block text-[10px] tabular-nums text-muted-foreground">
                    {formatCount(page.users)} {page.users === 1 ? "user" : "users"}
                    {page.softNavViews > 0 && ` · ${formatPercent(page.softNavViews / page.views)} SPA`}
                  </span>
                </span>
                <span className="text-right text-xs tabular-nums">{formatCount(page.views)}</span>
                <VitalCell metricKey="lcp" value={page.lcpP75} samples={page.lcpSamples} />
                <VitalCell metricKey="inp" value={page.inpP75} samples={page.inpSamples} />
                <VitalCell metricKey="cls" value={page.clsP75} samples={page.clsSamples} />
                <span className="text-right text-xs tabular-nums">{formatDuration(page.avgTimeOnPageMs)}</span>
                <span className="text-right text-xs tabular-nums">
                  {page.avgScrollRatio == null ? "—" : formatPercent(page.avgScrollRatio)}
                </span>
                <span className={cn(
                  "text-right text-xs tabular-nums",
                  page.rageClicks > 0 && "text-red-600 dark:text-red-400",
                )}>
                  {page.rageClicks === 0 ? "—" : formatCount(page.rageClicks)}
                </span>
                <span className={cn(
                  "text-right text-xs tabular-nums",
                  page.deadClicks > 0 && "text-amber-600 dark:text-amber-400",
                )}>
                  {page.deadClicks === 0 ? "—" : formatCount(page.deadClicks)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </DesignAnalyticsCard>
  );
}

function MetricSeries({ response, metric }: { response: PerformanceMetricResponse, metric: PerformanceMetricCatalogEntry }) {
  const showsPointVolume = metric.supports_numeric_aggregation === false;
  const color = getDesignChartColor(showsPointVolume ? "orange" : "cyan");
  const chartData = response.series.map((point) => ({
    label: formatMetricBucketLabel(point.bucket_start_unix_nano, response.window.hours),
    fullLabel: formatUnixNano(point.bucket_start_unix_nano),
    value: showsPointVolume ? point.point_count : point.numeric_value,
  }));
  const domain = getPerformanceMetricChartDomain(
    chartData.map((point) => point.value),
    showsPointVolume,
  );
  const hasValues = chartData.some((point) => point.value !== null);
  const valueLabel = showsPointVolume ? "Points" : "Average";

  return (
    <div className="space-y-3">
      <div
        className="h-40 rounded-xl bg-foreground/[0.025] p-2"
        aria-label={`${metric.metric_name} ${showsPointVolume ? "point volume" : "metric series"}`}
      >
        {!hasValues ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No points in this window.</div>
        ) : (
          <DesignChartContainer
            config={{ value: { label: valueLabel, color } }}
            maxHeight={144}
            className="h-full w-full aspect-auto"
          >
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="performance-metric-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.32} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                minTickGap={28}
              />
              <YAxis
                domain={domain}
                tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(value: number) => showsPointVolume
                  ? formatCount(value)
                  : formatMetricAxisValue(value, metric.metric_unit)}
              />
              <RechartsTooltip
                cursor={{ stroke: "hsl(var(--border))" }}
                content={
                  <DesignChartTooltipContent
                    labelFormatter={(_label, payload) => {
                      const fullLabel = payload[0]?.payload?.fullLabel;
                      return typeof fullLabel === "string" ? fullLabel : "";
                    }}
                    indicator={showsPointVolume ? "line" : "dot"}
                  />
                }
              />
              {showsPointVolume ? (
                <Bar dataKey="value" fill={color} fillOpacity={0.7} radius={[3, 3, 0, 0]} maxBarSize={24} isAnimationActive={false} />
              ) : (
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={color}
                  strokeWidth={1.5}
                  fill="url(#performance-metric-fill)"
                  connectNulls={false}
                  dot={chartData.length <= 48 ? { r: 2, fill: color, strokeWidth: 0 } : false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </DesignChartContainer>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {showsPointVolume ? "Point volume per bucket" : "Average value per bucket"}
      </p>
    </div>
  );
}

function NativeMetricsSection({
  response,
  metricSelector,
  onSelect,
  projectId,
}: {
  response: PerformanceMetricResponse,
  metricSelector: string,
  onSelect: (value: string) => void,
  projectId: string,
}) {
  const catalog = customMetricCatalog(response.catalog);
  const selected = catalog.find((entry) => (
    entry.metric_name === response.selected_metric_name && entry.metric_type === response.selected_metric_type
  )) ?? null;
  const latestPoint = response.series.at(-1);
  const selectedShowsPointVolume = selected?.supports_numeric_aggregation === false;

  if (catalog.length === 0) return null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 space-y-4">
        {response.partial.has_unsupported_metric_types && (
          <DesignAlert
            variant="warning"
            title="Some metric types are shown without numeric aggregation"
            description="Histogram, exponential histogram, and summary streams remain visible as point counts and exemplars. Numeric min/average/max values are shown only for gauge and sum streams."
          />
        )}
        {selected == null ? (
          <DesignAnalyticsCard gradient="cyan">
            <div className="p-4 text-sm text-muted-foreground">Select a metric stream to view its series.</div>
          </DesignAnalyticsCard>
        ) : (
          <DesignAnalyticsCard gradient="cyan" className="overflow-hidden">
            <DesignAnalyticsCardHeader
              label={selected.metric_name}
              right={<DesignBadge label={formatMetricType(selected.metric_type)} color="blue" size="sm" />}
            />
            <div className="space-y-5 p-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{selectedShowsPointVolume ? "Latest bucket points" : "Latest average"}</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">{selectedShowsPointVolume ? latestPoint?.point_count.toLocaleString() ?? "No points" : formatMetricValue(latestPoint?.numeric_value ?? null, selected.metric_unit)}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Metric points</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">{selected.point_count.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Last observed</p>
                  <p className="mt-1 text-sm font-medium">{formatUnixNano(selected.latest_time_unix_nano)}</p>
                </div>
              </div>
              <MetricSeries response={response} metric={selected} />
              {response.series.some((point) => point.exemplar != null) && (
                <div className="space-y-2 border-t border-foreground/[0.06] pt-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Trace exemplars</p>
                  {response.series.filter((point) => point.exemplar != null).slice(-3).map((point) => {
                    const exemplar = point.exemplar;
                    if (exemplar == null) return null;
                    return (
                      <Link
                        key={`${point.bucket_start_unix_nano}-${exemplar.trace_id}`}
                        href={traceDetailHref(projectId, exemplar.trace_id)}
                        className="flex items-center justify-between gap-3 rounded-xl bg-foreground/[0.025] px-3 py-2 text-xs ring-1 ring-foreground/[0.06] transition-colors duration-150 hover:bg-foreground/[0.05] hover:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <span className="min-w-0 truncate font-mono">{exemplar.trace_id}</span>
                        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                          Open trace <ArrowUpRightIcon className="h-3.5 w-3.5" />
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </DesignAnalyticsCard>
        )}
      </div>
      <DesignAnalyticsCard gradient="slate" className="overflow-hidden">
        <DesignAnalyticsCardHeader label="Custom streams" />
        <div className="space-y-2 p-4">
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="performance-metric-select">
            Stream
          </label>
          <DesignSelectorDropdown
            triggerId="performance-metric-select"
            value={metricSelector}
            onValueChange={onSelect}
            options={metricSelectorOptions(catalog)}
            size="sm"
            className="w-full"
          />
          <div className="space-y-2 pt-2">
            {catalog.slice(0, 8).map((entry) => (
              <button
                key={metricSelectorValue(entry)}
                type="button"
                onClick={() => onSelect(metricSelectorValue(entry))}
                className={cn(
                  "w-full rounded-xl p-3 text-left ring-1 ring-foreground/[0.06] transition-colors duration-150 hover:bg-foreground/[0.04] hover:transition-none",
                  metricSelector === metricSelectorValue(entry) && "bg-cyan-500/[0.06] ring-cyan-500/30",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium">{entry.metric_name}</span>
                  <DesignBadge label={formatMetricType(entry.metric_type)} color={entry.supports_numeric_aggregation ? "blue" : "orange"} size="sm" />
                </span>
                <span className="mt-1 block text-[11px] tabular-nums text-muted-foreground">
                  {entry.point_count.toLocaleString()} points{entry.metric_unit === "" ? "" : ` · ${entry.metric_unit}`}
                </span>
              </button>
            ))}
          </div>
        </div>
      </DesignAnalyticsCard>
    </div>
  );
}

function PerformancePageClient() {
  const adminApp = useAdminApp();
  const [hours, setHours] = useState<PerformanceTimeRangeHours>(24);
  const [metricSelector, setMetricSelector] = useState("");
  const [metricsResponse, setMetricsResponse] = useState<PerformanceMetricResponse | null>(null);
  const [overview, setOverview] = useState<PerformanceVitalsOverview | null>(null);
  const [pages, setPages] = useState<PagePerformance[]>([]);
  const [timeline, setTimeline] = useState<PerformanceTimelineBucket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PerformancePageSort>("views");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [timelineMetric, setTimelineMetric] = useState<"lcp" | "inp">("lcp");
  const requestSequence = useRef(0);

  const selectedMetric = useMemo(() => {
    const separator = metricSelector.lastIndexOf("::");
    if (separator < 0) return null;
    const type = metricSelector.slice(separator + 2);
    if (!isPerformanceMetricType(type)) {
      throw new Error(`Metric selector value carries an unknown metric type; selector values are built from catalog entries so this should be impossible: ${metricSelector}`);
    }
    return { name: metricSelector.slice(0, separator), type };
  }, [metricSelector]);

  const loadRum = useCallback(async () => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError(null);
    try {
      const model = await fetchPerformancePageModel(adminApp, hours, Date.now());
      if (sequence !== requestSequence.current) return;
      setOverview(model.overview);
      setPages(model.pages);
      setTimeline(model.timeline);
      setTimelineMetric((current) => selectAvailableTimelineMetric(model.timeline, current));
      setSelectedPath((current) => current != null && model.pages.some((page) => page.path === current) ? current : null);
    } catch (caught) {
      if (sequence === requestSequence.current) {
        setError(caught instanceof Error ? caught.message : "Page performance could not be loaded");
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [adminApp, hours]);

  const loadMetrics = useCallback(async () => {
    setMetricsError(null);
    try {
      const next = await fetchPerformanceMetrics(adminApp, {
        hours,
        metricName: selectedMetric?.name ?? null,
        metricType: selectedMetric?.type ?? null,
      });
      setMetricsResponse(next);
      const customCatalog = customMetricCatalog(next.catalog);
      const selected = selectedCatalogEntry(next);
      if (selected != null && customCatalog.some((entry) => metricSelectorValue(entry) === metricSelectorValue(selected))) {
        setMetricSelector(metricSelectorValue(selected));
      } else if (customCatalog.length === 0) {
        setMetricSelector("");
      } else {
        setMetricSelector(metricSelectorValue(customCatalog[0]));
      }
    } catch (caught) {
      setMetricsError(caught instanceof Error ? caught.message : "Native metrics could not be loaded");
    }
  }, [adminApp, hours, selectedMetric]);

  const load = useCallback(async () => {
    await Promise.all([loadRum(), loadMetrics()]);
  }, [loadRum, loadMetrics]);

  useEffect(() => {
    runAsynchronouslyWithAlert(loadRum);
  }, [loadRum]);

  useEffect(() => {
    runAsynchronouslyWithAlert(loadMetrics);
  }, [loadMetrics]);

  const rangeLabel = observabilityTimeRangeLabel(hours);
  const insights = useMemo(() => rankPageInsights(pages), [pages]);
  const behavior = useMemo(() => sumPageBehavior(pages), [pages]);
  const selectedPage = selectedPath == null ? null : pages.find((page) => page.path === selectedPath) ?? null;

  const headerActions = (
    <ObservabilityToolbar
      range={<ObservabilityTimeRangeToggle hours={hours} onChange={setHours} />}
      actions={<ObservabilityRefreshButton onRefresh={load} loading={loading} />}
    />
  );

  return (
    <AppEnabledGuard appId="observability">
      <ObservabilityPageLayout
        title="Performance"
        actions={headerActions}
      >
        {error != null && (
          <ObservabilityErrorState
            title="Page performance could not be loaded"
            description={error}
            onRetry={load}
          />
        )}

        {loading && overview == null ? (
          <DesignAnalyticsCard gradient="slate">
            <ObservabilityLoadingState label="Loading real-user performance…" />
          </DesignAnalyticsCard>
        ) : overview == null ? null : (
          <div className="flex flex-col gap-[var(--page-content-gap)]">
            <section aria-labelledby="core-web-vitals-heading" className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-2 px-1">
                <div>
                  <h2 id="core-web-vitals-heading" className="text-sm font-semibold">Core Web Vitals</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Field p75 from page-view spans. LCP is hard loads only; INP and CLS include SPA navigations.
                  </p>
                </div>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {overview.pageViews === 0
                    ? `No page views in ${rangeLabel}`
                    : `${formatCount(overview.pageViews)} views · ${formatCount(overview.users)} users`}
                </span>
              </div>
              <div className="grid gap-3 lg:grid-cols-3">
                <WebVitalHeroCard metricKey="lcp" distribution={overview.lcp} sampleNoun="hard loads" />
                <WebVitalHeroCard metricKey="inp" distribution={overview.inp} sampleNoun="interactions" />
                <WebVitalHeroCard metricKey="cls" distribution={overview.cls} sampleNoun="page views" />
              </div>
            </section>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]">
              <VitalsTimelineChart
                buckets={timeline}
                hours={hours}
                metricKey={timelineMetric}
                onMetricKeyChange={setTimelineMetric}
              />
              <DesignAnalyticsCard gradient="cyan" className="overflow-hidden">
                <DesignAnalyticsCardHeader
                  compact
                  label="On these pages"
                  right={<CursorClickIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                />
                <div className="grid grid-cols-2 gap-4 p-4">
                  <BehaviorStat
                    label="Rage clicks"
                    value={formatCount(behavior.rageClicks)}
                    hint="3+ clicks on the same spot"
                    warn={behavior.rageClicks > 0}
                  />
                  <BehaviorStat
                    label="Dead clicks"
                    value={formatCount(behavior.deadClicks)}
                    hint={behavior.clicks === 0 ? "No clicks" : `${formatPercent(behavior.deadClicks / behavior.clicks)} of ${formatCount(behavior.clicks)} clicks`}
                    warn={behavior.deadClicks > 0}
                  />
                  <BehaviorStat
                    label="Time on page"
                    value={formatDuration(overview.avgTimeOnPageMs)}
                    hint={overview.avgScrollRatio == null ? "No scroll depth yet" : `${formatPercent(overview.avgScrollRatio)} avg scroll`}
                  />
                  <BehaviorStat
                    label="Forms"
                    value={formatCount(behavior.formSubmits)}
                    hint={behavior.outboundClicks === 0 ? "No outbound clicks" : `${formatCount(behavior.outboundClicks)} outbound`}
                  />
                  <BehaviorStat
                    label="LCP mobile"
                    value={formatWebVitalValue(webVitalByKey("lcp"), overview.lcpP75Mobile)}
                    hint="Viewport under 768px"
                  />
                  <BehaviorStat
                    label="LCP desktop"
                    value={formatWebVitalValue(webVitalByKey("lcp"), overview.lcpP75Desktop)}
                    hint={overview.pageViews === 0 || overview.softNavViews === 0
                      ? "Hard loads"
                      : `${formatPercent(overview.softNavViews / overview.pageViews)} SPA navigations`}
                  />
                </div>
                {selectedPage != null && (
                  <div className="border-t border-foreground/[0.06] px-4 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Selected</p>
                    <p className="mt-1 truncate font-mono text-xs font-medium">{selectedPage.path}</p>
                    <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                      {formatCount(selectedPage.clicks)} clicks
                      {selectedPage.formSubmits > 0 && ` · ${formatCount(selectedPage.formSubmits)} forms`}
                      {selectedPage.outboundClicks > 0 && ` · ${formatCount(selectedPage.outboundClicks)} outbound`}
                    </p>
                  </div>
                )}
              </DesignAnalyticsCard>
            </div>

            <DesignAnalyticsCard gradient="slate" className="overflow-hidden">
              <div className="grid gap-4 p-4 sm:grid-cols-3">
                <CompactVital metricKey="fcp" distribution={overview.fcp} />
                <CompactVital metricKey="ttfb" distribution={overview.ttfb} />
                <CompactVital metricKey="fps" distribution={overview.fps} />
              </div>
            </DesignAnalyticsCard>

            <InsightsRow
              insights={insights}
              rangeLabel={rangeLabel}
              onSelectPath={(path) => {
                setSelectedPath(path);
                setSearch(path);
                setSort("friction");
              }}
            />

            <PagesTable
              pages={pages}
              search={search}
              onSearch={setSearch}
              sort={sort}
              onSort={setSort}
              selectedPath={selectedPath}
              onSelectPath={(path) => setSelectedPath((current) => current === path ? null : path)}
            />

            {metricsError != null && (
              <DesignAlert
                variant="warning"
                title="Custom metric streams could not be loaded"
                description={metricsError}
              />
            )}
            {metricsResponse != null && customMetricCatalog(metricsResponse.catalog).length > 0 && (
              <section aria-labelledby="custom-metrics-heading" className="space-y-3">
                <div className="px-1">
                  <h2 id="custom-metrics-heading" className="text-sm font-semibold">Custom metric streams</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Native OpenTelemetry gauges and sums, kept separate from page-view Web Vitals.
                  </p>
                </div>
                <NativeMetricsSection
                  response={metricsResponse}
                  metricSelector={metricSelector}
                  onSelect={setMetricSelector}
                  projectId={adminApp.projectId}
                />
              </section>
            )}
          </div>
        )}
      </ObservabilityPageLayout>
    </AppEnabledGuard>
  );
}

export default PerformancePageClient;

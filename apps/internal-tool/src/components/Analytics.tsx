import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { useMemo, useState } from "react";
import { useClockTick } from "../hooks/useClockTick";
import type { McpCallLogRow, QaEntriesRow } from "../types";
import { toDate } from "../utils";
import { formatPacificTableTime } from "../lib/pacific-time";
import { canReportP95, extent, formatMilliseconds, MIN_P95_SAMPLE_COUNT, nearestRankPercentile, percentage } from "../lib/stats";
import { FEATURE_REQUEST_FLAG_TYPE } from "../lib/feature-request-flag";
import {
  countActiveMcpFilters,
  DEFAULT_MCP_ANALYTICS_FILTERS,
  filterMcpCalls,
  MCP_TIME_RANGES,
  type McpAnalyticsFilters,
  parseHumanReviewState,
  parseQaState,
  parseStatusFilter,
  parseTimeRange,
} from "../lib/mcp-analytics-filters";
import { Badge, BarRow, Button, Card, chartColors, cn, EmptyState, FieldLabel, MetricCard, Pill, Select } from "./design";

const ACTIVITY_CHART_DAYS = 14;

export function Analytics({ rows: allRows, qaEntries, hasMoreHistory }: { rows: McpCallLogRow[], qaEntries: QaEntriesRow[], hasMoreHistory: boolean }) {
  const [filters, setFilters] = useState<McpAnalyticsFilters>(DEFAULT_MCP_ANALYTICS_FILTERS);
  // Calls awaiting a QA review flip from "pending" to "review-failed" after a fixed threshold, so
  // the filtered view re-evaluates against a ticking clock rather than a stale `now`.
  const now = useClockTick();

  const setFilter = <Key extends keyof McpAnalyticsFilters>(key: Key, value: McpAnalyticsFilters[Key]) => {
    setFilters(current => ({ ...current, [key]: value }));
  };

  // Tool options come from the loaded rows rather than a hardcoded list: the
  // MCP server's tool set changes without this app being redeployed, and an
  // option nobody can match is worse than a missing one.
  const toolNames = useMemo(
    () => Array.from(new Set(allRows.map(row => row.toolName))).sort(stringCompare),
    [allRows],
  );

  const rows = useMemo(() => filterMcpCalls(allRows, filters, now), [allRows, filters, now]);
  const activeFilterCount = countActiveMcpFilters(filters);

  const stats = useMemo(() => {
    const reviewed = rows.filter(r => r.qaOverallScore != null);
    const scores = reviewed.map(r => r.qaOverallScore ?? 0);
    const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

    const needsReview = rows.filter(r => r.qaNeedsHumanReview === true && r.humanReviewedAt == null).length;
    const humanReviewed = rows.filter(r => r.humanReviewedAt != null).length;
    const publishedCount = qaEntries.filter(r => r.published).length;
    const draftCount = qaEntries.filter(r => !r.published).length;

    // Score buckets
    const scoreBuckets = [
      { label: "90-100", min: 90, max: 100, color: chartColors.emerald },
      { label: "70-89", min: 70, max: 89, color: chartColors.green },
      { label: "50-69", min: 50, max: 69, color: chartColors.amber },
      { label: "30-49", min: 30, max: 49, color: chartColors.orange },
      { label: "0-29", min: 0, max: 29, color: chartColors.red },
    ].map(b => ({
      ...b,
      count: scores.filter(s => s >= b.min && s <= b.max).length,
    }));
    // Flag types
    const flagCounts = new Map<string, number>();
    for (const row of reviewed) {
      if (!row.qaFlagsJson) continue;
      for (const type of new Set(parseFlagTypes(row.qaFlagsJson).filter(type => type !== FEATURE_REQUEST_FLAG_TYPE))) {
        flagCounts.set(type, (flagCounts.get(type) ?? 0) + 1);
      }
    }
    const topFlags = Array.from(flagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    // Calls over time (last ACTIVITY_CHART_DAYS days). The chart's total, active-day count, and
    // first/last timestamps all come from the rows inside that window — the filtered set as a
    // whole can be much older (the default range is "all"), and describing it with a 14-day chart
    // would report calls the chart does not show.
    const dayMs = 24 * 60 * 60 * 1000;
    const dayBuckets: Array<{ label: string; count: number; date: Date }> = [];
    for (let i = ACTIVITY_CHART_DAYS - 1; i >= 0; i--) {
      const d = new Date(now - i * dayMs);
      d.setHours(0, 0, 0, 0);
      dayBuckets.push({
        label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        count: 0,
        date: d,
      });
    }
    const windowStart = dayBuckets[0].date.getTime();
    const windowCallTimes: number[] = [];
    for (const row of rows) {
      const rowTime = toDate(row.createdAt).getTime();
      if (rowTime < windowStart) continue;
      const dayStart = new Date(rowTime);
      dayStart.setHours(0, 0, 0, 0);
      const bucket = dayBuckets.find(b => b.date.getTime() === dayStart.getTime());
      if (bucket) bucket.count++;
      windowCallTimes.push(rowTime);
    }
    const maxDayCount = Math.max(...dayBuckets.map(b => b.count), 1);
    const nonEmptyDayCount = dayBuckets.filter(bucket => bucket.count > 0).length;
    const observed = extent(windowCallTimes);
    const activity = {
      total: windowCallTimes.length,
      dayBuckets,
      maxDayCount,
      nonEmptyDayCount,
      firstCallAt: observed?.min ?? null,
      lastCallAt: observed?.max ?? null,
    };

    // Duration stats
    const durations = rows.map(r => Number(r.durationMs)).filter(d => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
    const p95Duration = nearestRankPercentile(durations, 0.95);
    const maxDuration = durations.length > 0 ? durations[durations.length - 1] : null;

    // Tool usage
    const toolCounts = new Map<string, number>();
    for (const row of rows) {
      toolCounts.set(row.toolName, (toolCounts.get(row.toolName) ?? 0) + 1);
    }
    const toolUsage = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]);

    return {
      total: rows.length,
      reviewed: reviewed.length,
      avgScore,
      needsReview,
      humanReviewed,
      publishedCount,
      draftCount,
      scoreBuckets,
      topFlags,
      activity,
      avgDuration,
      p95Duration,
      maxDuration,
      durationSampleCount: durations.length,
      toolUsage,
    };
  }, [rows, qaEntries, now]);

  const reviewRate = percentage(stats.reviewed, stats.total);

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 rounded-xl border border-black/[0.06] bg-card shadow-sm ring-1 ring-black/[0.04] backdrop-blur-xl dark:border-white/[0.06] dark:ring-white/[0.04]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
          <div className="flex items-center gap-1.5">
            <FieldLabel>Range</FieldLabel>
            {MCP_TIME_RANGES.map(range => (
              <Pill key={range} active={filters.timeRange === range} onClick={() => setFilter("timeRange", range)}>
                {range}
              </Pill>
            ))}
          </div>
          <label className="grid grid-cols-[auto_10rem] items-center gap-1.5">
            <FieldLabel>Tool</FieldLabel>
            <Select value={filters.toolName} onChange={event => setFilter("toolName", event.target.value)}>
              <option value="">All tools</option>
              {toolNames.map(tool => (
                <option key={tool} value={tool}>{tool}</option>
              ))}
            </Select>
          </label>
          <label className="grid grid-cols-[auto_6rem] items-center gap-1.5">
            <FieldLabel>Status</FieldLabel>
            <Select value={filters.status} onChange={event => setFilter("status", parseStatusFilter(event.target.value))}>
              <option value="all">All</option>
              <option value="ok">OK</option>
              <option value="error">Error</option>
            </Select>
          </label>
          <label className="grid grid-cols-[auto_9rem] items-center gap-1.5">
            <FieldLabel>QA review</FieldLabel>
            <Select value={filters.qaState} onChange={event => setFilter("qaState", parseQaState(event.target.value))}>
              <option value="all">All reviews</option>
              <option value="pass">Pass (80+)</option>
              <option value="warn">Warn (50–79)</option>
              <option value="fail">Fail (&lt;50)</option>
              <option value="feature-request">Feature request</option>
              <option value="pending">Pending</option>
              <option value="review-failed">Review failed</option>
              <option value="error">Review error</option>
            </Select>
          </label>
          <label className="grid grid-cols-[auto_8rem] items-center gap-1.5">
            <FieldLabel>Human review</FieldLabel>
            <Select
              value={filters.humanReviewState}
              onChange={event => setFilter("humanReviewState", parseHumanReviewState(event.target.value))}
            >
              <option value="all">All</option>
              <option value="required">Required</option>
              <option value="reviewed">Reviewed</option>
              <option value="not-reviewed">Not reviewed</option>
            </Select>
          </label>
          <div className="ml-auto flex items-center gap-2">
            {activeFilterCount > 0 && (
              <Button variant="ghost" size="xs" onClick={() => setFilters(DEFAULT_MCP_ANALYTICS_FILTERS)}>
                Clear {activeFilterCount}
              </Button>
            )}
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {stats.total.toLocaleString()} of {allRows.length.toLocaleString()} calls
            </span>
          </div>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-4 gap-4">
        <MetricCard
          label={activeFilterCount > 0 ? "Matching Calls" : "Loaded Calls"}
          value={stats.total.toLocaleString()}
          subtitle={
            activeFilterCount > 0
              ? `of ${allRows.length.toLocaleString()} loaded`
              : hasMoreHistory ? "More history is available" : "Complete loaded history"
          }
          tooltip="MCP calls currently loaded in this browser, narrowed by the filters above. Use MCP Review to load older history when more is available."
        />
        <MetricCard
          label="Avg QA Score"
          value={stats.reviewed === 0 ? "—" : stats.avgScore.toString()}
          valueClassName={
            stats.reviewed === 0 ? "text-muted-foreground" :
              stats.avgScore >= 80 ? "text-emerald-600 dark:text-emerald-400" :
                stats.avgScore >= 50 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"
          }
          subtitle={reviewRate == null ? "No calls to review" : `${stats.reviewed} scored · ${reviewRate}% of calls`}
          tooltip="Arithmetic mean of qaOverallScore for calls with a completed automated QA score. Unreviewed calls are excluded."
        />
        <MetricCard
          label="Needs Review"
          value={stats.needsReview.toString()}
          valueClassName={stats.needsReview > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}
          subtitle={`${stats.humanReviewed} manually completed`}
          tooltip="Calls flagged by automated QA that have not yet been marked as human-reviewed."
        />
        <MetricCard
          label="Published Q&A"
          value={stats.publishedCount.toString()}
          subtitle={`${stats.draftCount} draft${stats.draftCount === 1 ? "" : "s"}`}
          tooltip="Published entries in the MCP knowledge base. Draft entries are shown separately."
        />
      </div>

      <Card title={`MCP call activity · last ${ACTIVITY_CHART_DAYS} days`}>
        <McpCallActivity
          total={stats.activity.total}
          buckets={stats.activity.dayBuckets}
          maxCount={stats.activity.maxDayCount}
          nonEmptyDayCount={stats.activity.nonEmptyDayCount}
          firstCallAt={stats.activity.firstCallAt}
          lastCallAt={stats.activity.lastCallAt}
        />
      </Card>

      <div className="grid grid-cols-2 gap-4">
        {/* QA Score Distribution */}
        <Card title="QA score distribution">
          {stats.reviewed === 0 ? (
            <EmptyState>No completed QA scores</EmptyState>
          ) : (
            <div className="space-y-2">
              {stats.scoreBuckets.map(bucket => {
                const pct = percentage(bucket.count, stats.reviewed) ?? 0;
                return (
                  <BarRow
                    key={bucket.label}
                    label={bucket.label}
                    labelClassName="w-16"
                    barClassName={bucket.color}
                    pct={pct}
                    value={`${pct}%`}
                    extra={<span className="w-14 text-right font-mono text-[10px] tabular-nums text-muted-foreground">{bucket.count} scored</span>}
                  />
                );
              })}
            </div>
          )}
        </Card>

        {/* Top Flag Types */}
        <Card title="QA reviews with each flag">
          {stats.topFlags.length === 0 ? (
            <EmptyState>No flags in completed reviews</EmptyState>
          ) : (
            <div className="space-y-2">
              {stats.topFlags.map(([type, count]) => {
                const pct = percentage(count, stats.reviewed) ?? 0;
                return (
                  <BarRow
                    key={type}
                    label={type}
                    labelClassName="w-32 font-mono"
                    barClassName={chartColors.orange}
                    pct={pct}
                    value={`${pct}%`}
                    extra={<span className="w-14 text-right font-mono text-[10px] tabular-nums text-muted-foreground">{count} reviews</span>}
                  />
                );
              })}
            </div>
          )}
        </Card>

        {/* Response Time */}
        <Card title="MCP latency summary">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Average</span>
              <span className="font-mono tabular-nums">{formatMilliseconds(stats.avgDuration)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">p95</span>
              <span className="font-mono tabular-nums">
                {canReportP95(stats.durationSampleCount) ? formatMilliseconds(stats.p95Duration) : "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Max</span>
              <span className="font-mono tabular-nums">{formatMilliseconds(stats.maxDuration)}</span>
            </div>
            <p className="pt-1 text-[10px] text-muted-foreground">
              {canReportP95(stats.durationSampleCount)
                ? `${stats.durationSampleCount} duration samples`
                : `p95 requires ${MIN_P95_SAMPLE_COUNT} samples · ${stats.durationSampleCount} available`}
            </p>
          </div>
        </Card>

        {/* Tool Usage */}
        <Card title="MCP calls by tool">
          {stats.toolUsage.length === 0 ? (
            <EmptyState>No calls yet</EmptyState>
          ) : (
            <div className="space-y-2">
              {stats.toolUsage.map(([tool, count]) => {
                const pct = percentage(count, stats.total) ?? 0;
                return (
                  <BarRow
                    key={tool}
                    label={<Badge color="purple" mono>{tool}</Badge>}
                    labelClassName="w-40"
                    barClassName={chartColors.purple}
                    pct={pct}
                    value={`${pct}%`}
                    extra={<span className="w-12 text-right font-mono text-[10px] tabular-nums text-muted-foreground">{count} calls</span>}
                  />
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function McpCallActivity({
  total,
  buckets,
  maxCount,
  nonEmptyDayCount,
  firstCallAt,
  lastCallAt,
}: {
  total: number,
  buckets: Array<{ label: string, count: number }>,
  maxCount: number,
  nonEmptyDayCount: number,
  firstCallAt: number | null,
  lastCallAt: number | null,
}) {
  if (total === 0) return <EmptyState>No matching MCP calls in the last {ACTIVITY_CHART_DAYS} days</EmptyState>;

  if (nonEmptyDayCount < 2) {
    const observedAt = firstCallAt == null
      ? "Unknown observation time"
      : formatPacificTableTime(new Date(firstCallAt));
    return (
      <div className="flex min-h-32 items-center justify-between gap-6 rounded-lg border border-dashed border-border/80 bg-muted/20 px-5 py-4">
        <div>
          <p className="text-sm font-medium text-foreground">Not enough activity for a trend</p>
          <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
            {total.toLocaleString()} {total === 1 ? "call" : "calls"} observed on one day. A trend needs calls on at least two days.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-xl font-semibold tabular-nums text-foreground">{total.toLocaleString()}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">First observed {observedAt}</p>
        </div>
      </div>
    );
  }

  const period = firstCallAt == null || lastCallAt == null
    ? null
    : `${new Date(firstCallAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${new Date(lastCallAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{total.toLocaleString()} calls across {nonEmptyDayCount} active days</span>
        {period == null ? null : <span>{period}</span>}
      </div>
      <div className="flex h-32 items-end gap-1">
        {buckets.map(bucket => (
          <div key={bucket.label} className="flex flex-1 flex-col items-center gap-1" title={`${bucket.label}: ${bucket.count} calls`}>
            <div className="flex w-full flex-1 items-end">
              <div
                className={cn("w-full rounded-t", chartColors.blue)}
                style={{ height: `${(bucket.count / maxCount) * 100}%` }}
              />
            </div>
            <span className="text-[9px] text-muted-foreground">{bucket.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function parseFlagTypes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(flag => {
      if (typeof flag !== "object" || flag == null || !("type" in flag) || typeof flag.type !== "string") return [];
      return [flag.type];
    });
  } catch {
    return [];
  }
}

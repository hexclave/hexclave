import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useMemo, useState } from "react";
import { useFilteredLogPages } from "../hooks/useFilteredLogPages";
import type { AiUsageTableFilters, PageCursor } from "../hooks/useSpacetimeDB";
import type { AiQueryLogRow } from "../types";
import { toDate } from "../utils";
import { canReportP95, MIN_P95_SAMPLE_COUNT, nearestRankPercentile, percentage } from "../lib/stats";
import { type HistoryPagingProps } from "./LoadOlderButton";
import { UsageDataGrid } from "./UsageDataGrid";
import {
  Alert,
  Badge,
  BarRow,
  Button,
  Card,
  chartColors,
  cn,
  EmptyState,
  FieldLabel,
  Input,
  MetricCard,
  Pill,
  Select,
} from "./design";

type TimeRange = "24h" | "7d" | "30d" | "all";
type AuthFilter = "all" | "authed" | "anon";
type ModeFilter = "all" | "stream" | "generate";
type StatusFilter = "all" | "ok" | "error";
const TIME_RANGES: readonly TimeRange[] = ["24h", "7d", "30d", "all"];

type Props = {
  view: "overview" | "logs",
  rows: AiQueryLogRow[],
  connectionState: "connecting" | "connected" | "error",
  connectionErrorMessage: string | null,
  onSelect: (row: AiQueryLogRow) => void,
  queryFilteredPage: (filters: AiUsageTableFilters, cursor: PageCursor | null, limit: number) => Promise<{
    rows: AiQueryLogRow[],
    nextBeforeCreatedAtMicros: bigint | undefined,
    nextBeforeId: bigint | undefined,
  }>,
} & HistoryPagingProps;

const ALL_SYSTEM_PROMPTS = [
  "command-center-ask-ai",
  "docs-ask-ai",
  "wysiwyg-edit",
  "email-wysiwyg-editor",
  "email-assistant-template",
  "email-assistant-theme",
  "email-assistant-draft",
  "create-dashboard",
  "run-query",
  "rewrite-template-source",
];

function parseModeFilter(value: string): ModeFilter {
  if (value === "all" || value === "stream" || value === "generate") return value;
  throw new Error(`Unexpected mode filter: ${value}`);
}

function parseTimeRange(value: string): TimeRange {
  if (value === "24h" || value === "7d" || value === "30d" || value === "all") return value;
  throw new Error(`Unexpected time range: ${value}`);
}

function parseAuthFilter(value: string): AuthFilter {
  if (value === "all" || value === "authed" || value === "anon") return value;
  throw new Error(`Unexpected auth filter: ${value}`);
}

function parseStatusFilter(value: string): StatusFilter {
  if (value === "all" || value === "ok" || value === "error") return value;
  throw new Error(`Unexpected status filter: ${value}`);
}

function usageRowId(row: AiQueryLogRow): string {
  return String(row.id);
}

function rangeStartMicros(range: TimeRange): bigint | undefined {
  if (range === "all") return undefined;
  const hours = range === "24h" ? 24 : range === "7d" ? 7 * 24 : 30 * 24;
  return BigInt(new Date().getTime() - hours * 60 * 60 * 1000) * 1000n;
}

export function Usage({ view, rows, connectionState, connectionErrorMessage, onSelect, queryFilteredPage, hasMoreHistory, isLoadingOlder, onLoadOlder }: Props) {
  const [timeRange, setTimeRange] = useState<TimeRange>("7d");
  const [systemPromptFilter, setSystemPromptFilter] = useState<Set<string>>(new Set());
  const [modelFilter, setModelFilter] = useState<Set<string>>(new Set());
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [authFilter, setAuthFilter] = useState<AuthFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [logTimeRange, setLogTimeRange] = useState<TimeRange>("all");
  const [logSystemPrompt, setLogSystemPrompt] = useState("");
  const [logModel, setLogModel] = useState("");
  const [logMode, setLogMode] = useState<ModeFilter>("all");
  const [logAuth, setLogAuth] = useState<AuthFilter>("all");
  const [logStatus, setLogStatus] = useState<StatusFilter>("all");
  const [logSnapshotVersion, setLogSnapshotVersion] = useState(0);

  const hasLogFilters = logTimeRange !== "all" || logSystemPrompt !== "" || logModel !== "" || logMode !== "all" || logAuth !== "all" || logStatus !== "all";
  const logFilters = useMemo<AiUsageTableFilters>(() => ({
    createdAtOrAfterMicros: rangeStartMicros(logTimeRange),
    systemPromptId: logSystemPrompt === "" ? undefined : logSystemPrompt,
    modelId: logModel === "" ? undefined : logModel,
    mode: logMode === "all" ? undefined : logMode,
    isAuthenticated: logAuth === "all" ? undefined : logAuth === "authed",
    hasError: logStatus === "all" ? undefined : logStatus === "error",
  }), [logAuth, logMode, logModel, logSnapshotVersion, logStatus, logSystemPrompt, logTimeRange]);
  const logQueryKey = [logTimeRange, logSystemPrompt, logModel, logMode, logAuth, logStatus, logSnapshotVersion].join("\u0000");
  const filteredPages = useFilteredLogPages({
    enabled: view === "logs" && hasLogFilters,
    queryKey: logQueryKey,
    filters: logFilters,
    fetchPage: queryFilteredPage,
    getRowId: usageRowId,
  });

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const rangeStart = useMemo(() => {
    switch (timeRange) {
      case "24h": {
        return now - 24 * 60 * 60 * 1000;
      }
      case "7d": {
        return now - 7 * 24 * 60 * 60 * 1000;
      }
      case "30d": {
        return now - 30 * 24 * 60 * 60 * 1000;
      }
      case "all": {
        return 0;
      }
    }
  }, [timeRange, now]);

  const filtered = useMemo(() => {
    return rows.filter(r => {
      const ts = toDate(r.createdAt).getTime();
      if (ts < rangeStart) return false;
      if (systemPromptFilter.size > 0 && !systemPromptFilter.has(r.systemPromptId)) return false;
      if (modelFilter.size > 0 && !modelFilter.has(r.modelId)) return false;
      if (modeFilter !== "all" && r.mode !== modeFilter) return false;
      if (authFilter === "authed" && !r.isAuthenticated) return false;
      if (authFilter === "anon" && r.isAuthenticated) return false;
      const isError = r.errorMessage != null && r.errorMessage !== "";
      if (statusFilter === "ok" && isError) return false;
      if (statusFilter === "error" && !isError) return false;
      return true;
    });
  }, [rows, rangeStart, systemPromptFilter, modelFilter, modeFilter, authFilter, statusFilter]);

  const stats = useMemo(() => {
    const totalCalls = filtered.length;
    const errorCalls = filtered.filter(r => r.errorMessage != null && r.errorMessage !== "").length;
    const inputTokens = filtered.reduce((a, r) => a + (r.inputTokens ?? 0), 0);
    const outputTokens = filtered.reduce((a, r) => a + (r.outputTokens ?? 0), 0);
    const cachedInputTokens = filtered.reduce((a, r) => a + (r.cachedInputTokens ?? 0), 0);
    const cacheCreationTokens = filtered.reduce((a, r) => a + (r.cacheCreationTokens ?? 0), 0);
    const cacheSavingsUsd = filtered.reduce((a, r) => a + (r.cacheDiscountUsd ?? 0), 0);
    const cacheSavingsReportedCalls = filtered.filter(r => r.cacheDiscountUsd != null).length;
    const totalCost = filtered.reduce((a, r) => a + (r.costUsd ?? 0), 0);
    const pricedCalls = filtered.filter(r => r.costUsd != null).length;
    const durations = filtered.map(r => Number(r.durationMs)).filter(d => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
    const p95Duration = nearestRankPercentile(durations, 0.95);

    let seriesStart: number;
    let seriesEnd: number;
    if (timeRange === "all" && filtered.length > 0) {
      seriesStart = Infinity;
      seriesEnd = -Infinity;
      for (const r of filtered) {
        const ts = toDate(r.createdAt).getTime();
        if (ts < seriesStart) seriesStart = ts;
        if (ts > seriesEnd) seriesEnd = ts;
      }
    } else {
      seriesStart = rangeStart;
      seriesEnd = now;
    }
    const spanMs = Math.max(0, seriesEnd - seriesStart);
    let bucketMs = spanMs <= 24 * 60 * 60 * 1000 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const bucketCount = Math.min(48, Math.max(1, Math.ceil(spanMs / bucketMs)));
    if (spanMs > bucketCount * bucketMs) {
      bucketMs = Math.ceil(spanMs / bucketCount);
    }
    const bucketLabelFmt: Intl.DateTimeFormatOptions = bucketMs === 60 * 60 * 1000
      ? { hour: "numeric" }
      : { month: "short", day: "numeric" };
    const bucketStart = seriesEnd - bucketCount * bucketMs;
    const timeBuckets: Array<{ label: string, start: number, calls: number }> = [];
    for (let i = 0; i < bucketCount; i++) {
      const start = bucketStart + i * bucketMs;
      timeBuckets.push({
        label: new Date(start).toLocaleString("en-US", bucketLabelFmt),
        start,
        calls: 0,
      });
    }
    for (const r of filtered) {
      const ts = toDate(r.createdAt).getTime();
      // Clamp the top boundary: a row at exactly seriesEnd computes idx === bucketCount
      // and would otherwise be dropped (the newest call always disappeared from charts).
      const idx = Math.min(Math.floor((ts - bucketStart) / bucketMs), bucketCount - 1);
      if (idx >= 0) {
        timeBuckets[idx].calls++;
      }
    }
    const maxCalls = Math.max(...timeBuckets.map(b => b.calls), 1);
    const nonEmptyTimeBucketCount = timeBuckets.filter(b => b.calls > 0).length;
    const firstCallAt = filtered.length === 0
      ? null
      : Math.min(...filtered.map(r => toDate(r.createdAt).getTime()));
    const lastCallAt = filtered.length === 0
      ? null
      : Math.max(...filtered.map(r => toDate(r.createdAt).getTime()));

    // Distributions
    const sysPromptCounts = new Map<string, number>();
    const modelCounts = new Map<string, number>();
    const toolCounts = new Map<string, number>();
    for (const r of filtered) {
      sysPromptCounts.set(r.systemPromptId, (sysPromptCounts.get(r.systemPromptId) ?? 0) + 1);
      modelCounts.set(r.modelId, (modelCounts.get(r.modelId) ?? 0) + 1);
      try {
        const parsedTools: unknown = JSON.parse(r.requestedToolsJson);
        if (!Array.isArray(parsedTools)) continue;
        const tools = new Set(parsedTools.filter((tool): tool is string => typeof tool === "string"));
        for (const tool of tools) toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      } catch { /* skip */ }
    }
    const sysPromptDist = Array.from(sysPromptCounts.entries()).sort((a, b) => b[1] - a[1]);
    const modelDist = Array.from(modelCounts.entries()).sort((a, b) => b[1] - a[1]);
    const toolDist = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]);

    // Cache Hit % per systemPromptId
    const cacheBySystemPrompt = new Map<string, { input: number, cached: number, calls: number }>();
    for (const r of filtered) {
      const existing = cacheBySystemPrompt.get(r.systemPromptId) ?? { input: 0, cached: 0, calls: 0 };
      existing.input += r.inputTokens ?? 0;
      existing.cached += r.cachedInputTokens ?? 0;
      existing.calls += 1;
      cacheBySystemPrompt.set(r.systemPromptId, existing);
    }
    const cacheHitBySystemPrompt = Array.from(cacheBySystemPrompt.entries())
      .map(([id, v]) => ({
        id,
        calls: v.calls,
        hitPct: v.input > 0 ? Math.min(100, Math.round((v.cached / v.input) * 100)) : 0,
        cached: v.cached,
        input: v.input,
      }))
      .sort((a, b) => b.input - a.input);

    // Latency histogram
    const latencyBuckets = [
      { label: "<500ms", max: 500, count: 0 },
      { label: "500ms–2s", max: 2000, count: 0 },
      { label: "2–10s", max: 10000, count: 0 },
      { label: "10–30s", max: 30000, count: 0 },
      { label: ">30s", max: Infinity, count: 0 },
    ];
    for (const d of durations) {
      const b = latencyBuckets.find(b => d < b.max);
      if (b) b.count++;
    }
    return {
      totalCalls, errorCalls, inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens, cacheSavingsUsd, cacheSavingsReportedCalls, totalCost, pricedCalls,
      avgDuration, p95Duration, durationSampleCount: durations.length,
      timeBuckets, maxCalls, nonEmptyTimeBucketCount, firstCallAt, lastCallAt,
      sysPromptDist, modelDist, toolDist,
      cacheHitBySystemPrompt,
      latencyBuckets,
    };
  }, [filtered, rangeStart, now]);

  const allSystemPrompts = useMemo(() => {
    const seen = new Set<string>(ALL_SYSTEM_PROMPTS);
    for (const r of rows) seen.add(r.systemPromptId);
    return Array.from(seen).sort();
  }, [rows]);

  const allModels = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) seen.add(r.modelId);
    return Array.from(seen).sort();
  }, [rows]);

  function toggle(set: Set<string>, val: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    setter(next);
  }

  const advancedFilterCount = systemPromptFilter.size + modelFilter.size;
  return (
    <div className="space-y-4">
      {connectionState === "error" && (
        <Alert>
          <p>
            Failed to connect to SpacetimeDB. Check the browser session response below, then verify the{" "}
            <code>hexclave-ai-analytics</code> module is published and the local SpacetimeDB container is reachable.
          </p>
          {connectionErrorMessage != null && connectionErrorMessage !== "" && (
            <pre className="mt-3 whitespace-pre-wrap rounded-lg border border-red-500/30 bg-red-500/10 p-3 font-mono text-xs">
              {connectionErrorMessage}
            </pre>
          )}
        </Alert>
      )}
      {view === "overview" && <div className="sticky top-0 z-10 rounded-xl border border-black/[0.06] bg-card shadow-sm ring-1 ring-black/[0.04] backdrop-blur-xl dark:border-white/[0.06] dark:ring-white/[0.04]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
          <div className="flex items-center gap-1.5">
            <FieldLabel>Range</FieldLabel>
            {TIME_RANGES.map(r => (
              <Pill key={r} active={timeRange === r} onClick={() => setTimeRange(r)}>{r}</Pill>
            ))}
          </div>
          <label className="grid grid-cols-[auto_7rem] items-center gap-1.5">
            <FieldLabel>Mode</FieldLabel>
            <Select value={modeFilter} onChange={event => setModeFilter(parseModeFilter(event.target.value))}>
              <option value="all">All</option>
              <option value="stream">Stream</option>
              <option value="generate">Generate</option>
            </Select>
          </label>
          <label className="grid grid-cols-[auto_9rem] items-center gap-1.5">
            <FieldLabel>Auth</FieldLabel>
            <Select value={authFilter} onChange={event => setAuthFilter(parseAuthFilter(event.target.value))}>
              <option value="all">All</option>
              <option value="authed">Authenticated</option>
              <option value="anon">Anonymous</option>
            </Select>
          </label>
          <label className="grid grid-cols-[auto_6rem] items-center gap-1.5">
            <FieldLabel>Status</FieldLabel>
            <Select value={statusFilter} onChange={event => setStatusFilter(parseStatusFilter(event.target.value))}>
              <option value="all">All</option>
              <option value="ok">OK</option>
              <option value="error">Error</option>
            </Select>
          </label>
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
            {connectionState === "connected" ? `${filtered.length} of ${rows.length} calls` : connectionState}
          </span>
        </div>

        <details className="group border-t border-black/[0.06] dark:border-white/[0.06]">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
            <span className="text-[8px] transition-transform group-open:rotate-90">▶</span>
            Prompt and model filters
            {advancedFilterCount > 0 && <Badge color="blue" size="xs">{advancedFilterCount} active</Badge>}
          </summary>
          <div className="space-y-2 border-t border-black/[0.04] px-3 py-2.5 dark:border-white/[0.04]">
            <div className="flex flex-wrap items-center gap-1.5">
              <FieldLabel className="w-24">System prompt</FieldLabel>
              {allSystemPrompts.map(sp => (
                <Pill
                  key={sp}
                  mono
                  active={systemPromptFilter.has(sp)}
                  onClick={() => toggle(systemPromptFilter, sp, setSystemPromptFilter)}
                >
                  {sp}
                </Pill>
              ))}
            </div>
            {allModels.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <FieldLabel className="w-24">Model</FieldLabel>
                {allModels.map(m => (
                  <Pill
                    key={m}
                    mono
                    active={modelFilter.has(m)}
                    onClick={() => toggle(modelFilter, m, setModelFilter)}
                  >
                    {m}
                  </Pill>
                ))}
              </div>
            )}
          </div>
        </details>
      </div>}

      {view === "overview" && (
        <>
          {/* Metric cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-9">
            <MetricCard
              label="Calls in Window"
              value={stats.totalCalls.toLocaleString()}
              subtitle={hasMoreHistory ? "Loaded history only" : "All available history loaded"}
              tooltip="AI requests matching the active filters among the history currently loaded in this browser."
            />
            <MetricCard
              label="Errors"
              value={stats.errorCalls.toLocaleString()}
              valueClassName={stats.errorCalls > 0 ? "text-red-600 dark:text-red-400" : undefined}
              subtitle={stats.totalCalls === 0 ? "No calls in window" : `${percentage(stats.errorCalls, stats.totalCalls)}% of filtered calls`}
              tooltip="Requests that failed. Counted as rows where errorMessage is non-empty (upstream provider error, timeout, or client abort)."
            />
            <MetricCard
              label="Input Tokens"
              value={stats.inputTokens.toLocaleString()}
              tooltip="Sum of provider-reported prompt tokens across filtered requests. Cached reads and cache writes are subsets reported separately."
            />
            <MetricCard
              label="Output Tokens"
              value={stats.outputTokens.toLocaleString()}
              tooltip="Sum of generated tokens across all filtered requests."
            />
            <MetricCard
              label="Cache Hit %"
              value={stats.inputTokens > 0 ? `${Math.min(100, Math.round((stats.cachedInputTokens / stats.inputTokens) * 100))}%` : "—"}
              valueClassName={stats.inputTokens > 0 && stats.cachedInputTokens / stats.inputTokens > 0.5 ? "text-emerald-600 dark:text-emerald-400" : undefined}
              tooltip="Share of input tokens served from cache vs. processed fresh. Computed as sum(cachedInputTokens) / sum(inputTokens). Higher = caching is doing its job."
            />
            <MetricCard
              label="Total Cost"
              value={stats.pricedCalls === 0 ? "—" : formatUsd(stats.totalCost)}
              subtitle={`${stats.pricedCalls} of ${stats.totalCalls} calls priced`}
              tooltip="Sum of available OpenRouter total_cost values. Calls whose generation usage has not been refined yet are excluded rather than assumed to be priced."
            />
            <MetricCard
              label="Cache Savings"
              value={stats.cacheSavingsReportedCalls === 0 ? "—" : `${stats.cacheSavingsUsd >= 0 ? "+" : "−"}${formatUsd(Math.abs(stats.cacheSavingsUsd))}`}
              valueClassName={stats.cacheSavingsReportedCalls === 0 ? undefined : stats.cacheSavingsUsd >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}
              subtitle={`${stats.cacheSavingsReportedCalls} of ${stats.totalCalls} calls reported`}
              tooltip="Sum of cache_discount values across filtered requests. Positive (green) means caching net-saved money; negative (red) means cold-start writes outweighed reads. Filter by systemPromptId to judge whether caching is worth keeping on a specific flow."
            />
            <MetricCard
              label="Avg Duration"
              value={stats.avgDuration == null ? "—" : `${stats.avgDuration.toLocaleString()}ms`}
              tooltip="Mean wall-clock time per request, in milliseconds."
            />
            <MetricCard
              label="p95 Duration"
              value={!canReportP95(stats.durationSampleCount) || stats.p95Duration == null ? "—" : `${stats.p95Duration.toLocaleString()}ms`}
              subtitle={!canReportP95(stats.durationSampleCount) ? `${stats.durationSampleCount} of ${MIN_P95_SAMPLE_COUNT} required samples` : `${stats.durationSampleCount} samples`}
              tooltip="Nearest-rank 95th percentile request duration. At least 95% of filtered requests completed at or below this value."
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Card title="Request activity">
              <RequestActivity
                totalCalls={stats.totalCalls}
                buckets={stats.timeBuckets}
                maxCalls={stats.maxCalls}
                nonEmptyBucketCount={stats.nonEmptyTimeBucketCount}
                firstCallAt={stats.firstCallAt}
                lastCallAt={stats.lastCallAt}
              />
            </Card>

            <Card title="Token mix">
              <CompositionBar items={[
                { label: "Input", value: stats.inputTokens, color: chartColors.cyan },
                { label: "Output", value: stats.outputTokens, color: chartColors.emerald },
              ]} />
            </Card>

            <Card title="Input cache coverage">
              <CompositionBar items={[
                { label: "Fresh", value: Math.max(0, stats.inputTokens - stats.cachedInputTokens), color: chartColors.neutral },
                { label: "Cached", value: Math.min(stats.inputTokens, stats.cachedInputTokens), color: chartColors.green },
              ]} />
              <p className="mt-3 text-[10px] text-muted-foreground">
                {stats.cacheCreationTokens.toLocaleString()} input tokens written to cache in this window.
              </p>
            </Card>

            <Card title="Cache Hit % by System Prompt">
              {stats.cacheHitBySystemPrompt.length === 0 ? (
                <EmptyState>No data</EmptyState>
              ) : (
                <div className="space-y-1.5">
                  {stats.cacheHitBySystemPrompt.map(entry => (
                    <BarRow
                      key={entry.id}
                      title={entry.id}
                      label={entry.id}
                      labelClassName="w-40 font-mono"
                      barClassName={
                        entry.hitPct >= 50 ? chartColors.emerald : entry.hitPct >= 20 ? chartColors.amber : chartColors.red
                      }
                      pct={entry.hitPct}
                      value={`${entry.hitPct}%`}
                      extra={<span className="w-12 text-right font-mono text-[10px] tabular-nums text-muted-foreground">{entry.calls} calls</span>}
                    />
                  ))}
                </div>
              )}
            </Card>

            <Card title="Requests by system prompt">
              <DistributionBars items={stats.sysPromptDist} color={chartColors.purple} total={stats.totalCalls} />
            </Card>

            <Card title="Requests by model">
              <DistributionBars items={stats.modelDist} color={chartColors.indigo} total={stats.totalCalls} />
            </Card>

            <Card title="Requests declaring each tool">
              <DistributionBars items={stats.toolDist} color={chartColors.orange} total={stats.totalCalls} />
            </Card>

            <Card title="Latency distribution">
              <div className="space-y-2">
                {stats.durationSampleCount === 0 ? <EmptyState>No duration data</EmptyState> : stats.latencyBuckets.map(b => {
                  const pct = percentage(b.count, stats.durationSampleCount) ?? 0;
                  return (
                    <BarRow
                      key={b.label}
                      label={b.label}
                      labelClassName="w-20"
                      barClassName={chartColors.pink}
                      pct={pct}
                      value={`${pct}%`}
                      extra={<span className="w-12 text-right font-mono text-[10px] tabular-nums text-muted-foreground">{b.count} calls</span>}
                    />
                  );
                })}
              </div>
            </Card>
          </div>
        </>
      )}

      {/* Call list */}
      {view === "logs" && (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-black/[0.06] bg-card p-3 shadow-sm ring-1 ring-black/[0.04] dark:border-white/[0.06] dark:ring-white/[0.04]">
            <label className="grid grid-cols-[auto_6rem] items-center gap-1.5">
              <FieldLabel>Range</FieldLabel>
              <Select value={logTimeRange} onChange={event => setLogTimeRange(parseTimeRange(event.target.value))}>
                <option value="all">All time</option>
                <option value="24h">24 hours</option>
                <option value="7d">7 days</option>
                <option value="30d">30 days</option>
              </Select>
            </label>
            <label className="grid min-w-52 flex-1 grid-cols-[auto_1fr] items-center gap-1.5">
              <FieldLabel>System prompt</FieldLabel>
              <Select value={logSystemPrompt} onChange={event => setLogSystemPrompt(event.target.value)}>
                <option value="">All prompts</option>
                {allSystemPrompts.map(prompt => <option key={prompt} value={prompt}>{prompt}</option>)}
              </Select>
            </label>
            <label className="grid min-w-48 flex-1 grid-cols-[auto_1fr] items-center gap-1.5">
              <FieldLabel>Model</FieldLabel>
              <Select value={logModel} onChange={event => setLogModel(event.target.value)}>
                <option value="">All models</option>
                {allModels.map(model => <option key={model} value={model}>{model}</option>)}
              </Select>
            </label>
            <label className="grid grid-cols-[auto_6rem] items-center gap-1.5">
              <FieldLabel>Mode</FieldLabel>
              <Select value={logMode} onChange={event => setLogMode(parseModeFilter(event.target.value))}>
                <option value="all">All</option>
                <option value="stream">Stream</option>
                <option value="generate">Generate</option>
              </Select>
            </label>
            <label className="grid grid-cols-[auto_7rem] items-center gap-1.5">
              <FieldLabel>Auth</FieldLabel>
              <Select value={logAuth} onChange={event => setLogAuth(parseAuthFilter(event.target.value))}>
                <option value="all">All</option>
                <option value="authed">Authenticated</option>
                <option value="anon">Anonymous</option>
              </Select>
            </label>
            <label className="grid grid-cols-[auto_6rem] items-center gap-1.5">
              <FieldLabel>Status</FieldLabel>
              <Select value={logStatus} onChange={event => setLogStatus(parseStatusFilter(event.target.value))}>
                <option value="all">All</option>
                <option value="ok">OK</option>
                <option value="error">Error</option>
              </Select>
            </label>
            {hasLogFilters && <Button variant="ghost" onClick={() => {
              setLogTimeRange("all");
              setLogSystemPrompt("");
              setLogModel("");
              setLogMode("all");
              setLogAuth("all");
              setLogStatus("all");
            }}>Clear filters</Button>}
            {hasLogFilters && <Button onClick={() => setLogSnapshotVersion(version => version + 1)} disabled={filteredPages.isLoading}>Refresh results</Button>}
            {/* Only worth saying when it is true and surprising: a filtered list
                is a point-in-time snapshot, so new calls do not stream into it.
                The unfiltered list is live, which is what people expect. */}
            {hasLogFilters && <span className="ml-auto text-[10px] text-muted-foreground">Snapshot results</span>}
          </div>
          {filteredPages.error != null && (
            <Alert>
              <div className="flex items-center justify-between gap-3">
                <span>{filteredPages.error}</span>
                <Button onClick={() => runAsynchronously(filteredPages.refresh)}>Retry query</Button>
              </div>
            </Alert>
          )}
          {(hasLogFilters ? filteredPages.rows : rows).length === 0 && !filteredPages.isLoading ? (
            <Card>
              <EmptyState className="py-12">
                <p className="text-lg">{hasLogFilters ? "No requests match these filters" : "No AI requests logged yet"}</p>
                {hasLogFilters && filteredPages.hasMore && <Button className="mt-3" onClick={() => runAsynchronously(filteredPages.loadMore)}>Continue searching</Button>}
              </EmptyState>
            </Card>
          ) : (
            <UsageDataGrid
              rows={hasLogFilters ? filteredPages.rows : rows}
              onSelect={onSelect}
              resetKey={hasLogFilters ? logQueryKey : "live"}
              hasMoreHistory={hasLogFilters ? filteredPages.hasMore : hasMoreHistory}
              isLoadingOlder={hasLogFilters ? filteredPages.isLoadingMore : isLoadingOlder}
              onLoadOlder={hasLogFilters ? filteredPages.loadMore : onLoadOlder}
              isLoading={hasLogFilters && filteredPages.isLoading}
            />
          )}
        </>
      )}
    </div>
  );
}
function formatUsd(value: number): string {
  if (value === 0) return "$0";
  return `$${value.toFixed(4)}`;
}

function DistributionBars({ items, color, total }: { items: Array<[string, number]>, color: string, total: number }) {
  if (items.length === 0) {
    return <EmptyState>No data</EmptyState>;
  }
  return (
    <div className="space-y-1.5">
      {items.map(([label, count]) => {
        const pct = percentage(count, total) ?? 0;
        return (
          <BarRow
            key={label}
            label={label}
            labelClassName="w-40 font-mono"
            barClassName={color}
            pct={pct}
            value={`${pct}%`}
            extra={<span className="w-12 text-right font-mono text-[10px] tabular-nums text-muted-foreground">{count} calls</span>}
          />
        );
      })}
    </div>
  );
}

function CompositionBar({ items }: { items: ReadonlyArray<{ label: string, value: number, color: string }> }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return <EmptyState>No token data</EmptyState>;
  return (
    <div className="py-2">
      <div className="flex h-3 overflow-hidden rounded-full bg-foreground/[0.07]">
        {items.map(item => (
          <div
            key={item.label}
            className={item.color}
            style={{ width: `${(item.value / total) * 100}%` }}
            title={`${item.label}: ${item.value.toLocaleString()} (${Math.round((item.value / total) * 100)}%)`}
          />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        {items.map(item => (
          <div key={item.label} className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className={cn("size-2 rounded-sm", item.color)} />
              {item.label}
            </div>
            <p className="mt-1 truncate font-mono text-xs font-medium tabular-nums text-foreground">
              {item.value.toLocaleString()} <span className="text-muted-foreground">({Math.round((item.value / total) * 100)}%)</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function RequestActivity({ totalCalls, buckets, maxCalls, nonEmptyBucketCount, firstCallAt, lastCallAt }: {
  totalCalls: number,
  buckets: ReadonlyArray<{ label: string, calls: number }>,
  maxCalls: number,
  nonEmptyBucketCount: number,
  firstCallAt: number | null,
  lastCallAt: number | null,
}) {
  if (totalCalls === 0) return <EmptyState>No requests in this window</EmptyState>;
  if (nonEmptyBucketCount < 2) {
    const observedAt = firstCallAt == null ? null : new Date(firstCallAt);
    const observedSpanMs = firstCallAt == null || lastCallAt == null ? 0 : lastCallAt - firstCallAt;
    return (
      <div className="flex h-32 flex-col justify-center">
        <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">{totalCalls.toLocaleString()}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {totalCalls === 1 ? "request" : "requests"} in one time bucket. A trend needs activity across at least two buckets.
        </p>
        {observedAt != null && (
          <p className="mt-3 font-mono text-[10px] text-muted-foreground">
            First {observedAt.toLocaleString()}{observedSpanMs > 0 ? ` · ${Math.max(1, Math.round(observedSpanMs / 60_000))} min observed span` : ""}
          </p>
        )}
      </div>
    );
  }
  return (
    <div>
      <div className="relative flex h-32 items-end gap-1 border-b border-black/[0.08] dark:border-white/[0.08]">
        <span className="absolute left-0 top-0 font-mono text-[9px] text-muted-foreground">{maxCalls}</span>
        {buckets.map((bucket, index) => (
          <div key={index} className="flex h-full flex-1 items-end" title={`${bucket.label}: ${bucket.calls} calls`}>
            <div className={cn("w-full rounded-t-sm", chartColors.blue)} style={{ height: `${(bucket.calls / maxCalls) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-muted-foreground">
        <span>{buckets[0]?.label}</span>
        <span>{buckets[buckets.length - 1]?.label}</span>
      </div>
    </div>
  );
}

import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useMemo, useState } from "react";
import { useClockTick } from "../hooks/useClockTick";
import { useFilteredLogPages } from "../hooks/useFilteredLogPages";
import type { AiUsageTableFilters, PageCursor } from "../hooks/useSpacetimeDB";
import { formatSignedUsd, formatUsd } from "../lib/format-usd";
import { formatPacificTimestamp } from "../lib/pacific-time";
import type { AiQueryLogRow } from "../types";
import { toDate } from "../utils";
import { canReportP95, extent, MIN_P95_SAMPLE_COUNT, nearestRankPercentile, percentage } from "../lib/stats";
import { type HistoryPagingProps } from "./LoadOlderButton";
import { emptyUsageFilters, hasUsageFilters, KNOWN_REQUESTED_TOOLS, matchesUsageFilters, parseUsageRow, usageFilterKey } from "../lib/usage-filters";
import { UsageInvestigationFilters } from "./UsageInvestigationFilters";
import { aiUsageScopeMatcher, type AiUsageScopeFilters, countActiveAiUsageScopeFilters, DEFAULT_AI_USAGE_SCOPE_FILTERS, toAiUsageTableFilters } from "../lib/ai-usage-filters";
import { AUTH_OPTIONS, type AuthState, CALL_STATUS_OPTIONS, MODE_OPTIONS, stringOptions } from "../lib/filter-options";
import { MultiFilter, TimeRangeFilter } from "./FilterFields";
import { UsageDataGrid } from "./UsageDataGrid";
import {
  Alert,
  BarRow,
  Button,
  Card,
  chartColors,
  cn,
  EmptyState,
  Metric,
  MetricStrip,
  Panel,
  PanelGrid,
  PanelSection,
} from "./design";

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

function usageRowId(row: AiQueryLogRow): string {
  return String(row.id);
}

export function Usage({ view, rows, connectionState, connectionErrorMessage, onSelect, queryFilteredPage, hasMoreHistory, isLoadingOlder, onLoadOlder }: Props) {
  const [investigation, setInvestigation] = useState(emptyUsageFilters);
  const investigationActive = hasUsageFilters(investigation);
  const investigationKey = usageFilterKey(investigation);
  // Overview and request log keep separate scopes (the Overview defaults to the last week, the log to
  // everything), but render one shared filter row bound to whichever view is showing.
  const [overviewScope, setOverviewScope] = useState<AiUsageScopeFilters>({ ...DEFAULT_AI_USAGE_SCOPE_FILTERS, timeRange: "7d" });
  const [logScope, setLogScope] = useState<AiUsageScopeFilters>(DEFAULT_AI_USAGE_SCOPE_FILTERS);
  const scope = view === "overview" ? overviewScope : logScope;
  const setScope = view === "overview" ? setOverviewScope : setLogScope;
  const setScopeFilter = <Key extends keyof AiUsageScopeFilters>(key: Key, value: AiUsageScopeFilters[Key]) => {
    setScope(current => ({ ...current, [key]: value }));
  };
  const timeRange = overviewScope.timeRange;
  const [logSnapshotVersion, setLogSnapshotVersion] = useState(0);

  const hasLogFilters = countActiveAiUsageScopeFilters(logScope) > 0;
  // logSnapshotVersion is a dependency on purpose: bumping it recomputes the range start ("now").
  const logFilters = useMemo(() => toAiUsageTableFilters(logScope, Date.now()), [logScope, logSnapshotVersion]);
  const logQueryKey = JSON.stringify([logScope.timeRange, logFilters.systemPromptIds, logFilters.modelIds, logFilters.mode ?? null, logFilters.isAuthenticated ?? null, logFilters.hasError ?? null, logSnapshotVersion]);
  const filteredPages = useFilteredLogPages({
    enabled: view === "logs" && hasLogFilters && !investigationActive,
    queryKey: logQueryKey,
    filters: logFilters,
    fetchPage: queryFilteredPage,
    getRowId: usageRowId,
  });

  const now = useClockTick();
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
    const matchesScope = aiUsageScopeMatcher(overviewScope, now);
    return rows.filter(r => matchesScope(r) && matchesUsageFilters(r, investigation));
  }, [rows, overviewScope, now, investigation]);

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

    // One pass over the (possibly very large, once older pages are loaded) row set; spreading
    // every timestamp into Math.min/Math.max would hit the argument-count limit and throw.
    const observed = extent(filtered.map(r => toDate(r.createdAt).getTime()));
    const firstCallAt = observed?.min ?? null;
    const lastCallAt = observed?.max ?? null;

    let seriesStart: number;
    let seriesEnd: number;
    if (timeRange === "all" && observed != null) {
      seriesStart = observed.min;
      seriesEnd = observed.max;
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

    // Distributions
    const sysPromptCounts = new Map<string, number>();
    const modelCounts = new Map<string, number>();
    const toolCounts = new Map<string, number>();
    for (const r of filtered) {
      sysPromptCounts.set(r.systemPromptId, (sysPromptCounts.get(r.systemPromptId) ?? 0) + 1);
      modelCounts.set(r.modelId, (modelCounts.get(r.modelId) ?? 0) + 1);
      for (const tool of parseUsageRow(r).requestedTools) {
        toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      }
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
  }, [filtered, rangeStart, now, timeRange]);

  const systemPromptOptions = useMemo(() => {
    const seen = new Set<string>(ALL_SYSTEM_PROMPTS);
    for (const r of rows) seen.add(r.systemPromptId);
    return stringOptions(Array.from(seen).sort());
  }, [rows]);

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) seen.add(r.modelId);
    return stringOptions(Array.from(seen).sort());
  }, [rows]);

  const toolOptions = useMemo(() => {
    const requested = new Set(KNOWN_REQUESTED_TOOLS);
    const called = new Set<string>();
    for (const row of rows) {
      const parsed = parseUsageRow(row);
      for (const tool of parsed.requestedTools) requested.add(tool);
      for (const tool of parsed.calledTools) called.add(tool);
    }
    return { requested: [...requested].sort(), called: [...called].sort() };
  }, [rows]);

  // These fields are not supported by the server paging procedure. While any are
  // active, use the shared loaded history so Load all history expands the results.
  const investigationLogRows = useMemo(() => {
    const matchesScope = aiUsageScopeMatcher(logScope, now);
    return rows.filter(row => matchesUsageFilters(row, investigation) && matchesScope(row));
  }, [rows, investigation, logScope, now]);
  const useServerFilters = hasLogFilters && !investigationActive;
  const logRows = investigationActive ? investigationLogRows : useServerFilters ? filteredPages.rows : rows;

  function clearFilters() {
    setOverviewScope(DEFAULT_AI_USAGE_SCOPE_FILTERS);
    setLogScope(DEFAULT_AI_USAGE_SCOPE_FILTERS);
  }

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
      <UsageInvestigationFilters
        filters={investigation}
        onChange={setInvestigation}
        requestedTools={toolOptions.requested}
        calledTools={toolOptions.called}
        onPreset={() => {
          clearFilters();
          const anonOnly = { ...DEFAULT_AI_USAGE_SCOPE_FILTERS, auth: new Set<AuthState>(["anon"]) };
          setOverviewScope(anonOnly);
          setLogScope(anonOnly);
          setInvestigation({ ...emptyUsageFilters(), toolCalls: new Set(["succeeded"]) });
        }}
        onClear={clearFilters}
        hasOtherFilters={countActiveAiUsageScopeFilters(scope) > 0}
        rowCount={rows.length}
        hasMoreHistory={hasMoreHistory}
        isLoadingOlder={isLoadingOlder}
        onLoadOlder={onLoadOlder}
        connected={connectionState === "connected"}
        summary={view === "overview"
          ? (connectionState === "connected" ? `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()} calls in scope` : connectionState)
          // Only worth saying when it is true and surprising: a filtered list is a point-in-time
          // snapshot, so new calls do not stream into it. The unfiltered list is live, as expected.
          : useServerFilters ? "Snapshot results" : undefined}
        actions={view === "logs" && useServerFilters
          ? <Button onClick={() => setLogSnapshotVersion(version => version + 1)} disabled={filteredPages.isLoading}>Refresh</Button>
          : undefined}
      >
        <TimeRangeFilter value={scope.timeRange} onChange={range => setScopeFilter("timeRange", range)} />
        <MultiFilter label="System prompt" mono controlClassName="w-36" options={systemPromptOptions} selected={scope.systemPromptIds} onChange={selected => setScopeFilter("systemPromptIds", selected)} />
        <MultiFilter label="Model" mono controlClassName="w-36" options={modelOptions} selected={scope.modelIds} onChange={selected => setScopeFilter("modelIds", selected)} />
        <MultiFilter label="Mode" controlClassName="w-24" options={MODE_OPTIONS} selected={scope.modes} onChange={selected => setScopeFilter("modes", selected)} />
        <MultiFilter label="Auth" controlClassName="w-28" options={AUTH_OPTIONS} selected={scope.auth} onChange={selected => setScopeFilter("auth", selected)} />
        <MultiFilter label="Status" controlClassName="w-24" options={CALL_STATUS_OPTIONS} selected={scope.statuses} onChange={selected => setScopeFilter("statuses", selected)} />
      </UsageInvestigationFilters>

      {view === "overview" && (
        <>
          <Panel>
            <MetricStrip layout="3-then-9">
              <Metric
                label="Calls"
                value={stats.totalCalls.toLocaleString()}
                subtitle={hasMoreHistory ? "Loaded history only" : "All available history loaded"}
                tooltip="AI requests matching the active filters among the history currently loaded in this browser."
              />
              <Metric
                label="Errors"
                value={stats.errorCalls.toLocaleString()}
                valueClassName={stats.errorCalls > 0 ? "text-red-600 dark:text-red-400" : undefined}
                subtitle={stats.totalCalls === 0 ? "No calls in window" : `${percentage(stats.errorCalls, stats.totalCalls)}% of filtered calls`}
                tooltip="Requests that failed. Counted as rows where errorMessage is non-empty (upstream provider error, timeout, or client abort)."
              />
              <Metric
                label="Input Tokens"
                value={stats.inputTokens.toLocaleString()}
                tooltip="Sum of provider-reported prompt tokens across filtered requests. Cached reads and cache writes are subsets reported separately."
              />
              <Metric
                label="Output Tokens"
                value={stats.outputTokens.toLocaleString()}
                tooltip="Sum of generated tokens across all filtered requests."
              />
              <Metric
                label="Cache Hit %"
                value={stats.inputTokens > 0 ? `${Math.min(100, Math.round((stats.cachedInputTokens / stats.inputTokens) * 100))}%` : "—"}
                valueClassName={stats.inputTokens > 0 && stats.cachedInputTokens / stats.inputTokens > 0.5 ? "text-emerald-600 dark:text-emerald-400" : undefined}
                tooltip="Share of input tokens served from cache vs. processed fresh. Computed as sum(cachedInputTokens) / sum(inputTokens). Higher = caching is doing its job."
              />
              <Metric
                label="Total Cost"
                value={stats.pricedCalls === 0 ? "—" : formatUsd(stats.totalCost)}
                subtitle={`${stats.pricedCalls} of ${stats.totalCalls} calls priced`}
                tooltip="Sum of available OpenRouter total_cost values. Calls whose generation usage has not been refined yet are excluded rather than assumed to be priced."
              />
              <Metric
                label="Cache Savings"
                value={stats.cacheSavingsReportedCalls === 0 ? "—" : formatSignedUsd(stats.cacheSavingsUsd)}
                valueClassName={stats.cacheSavingsReportedCalls === 0 ? undefined : stats.cacheSavingsUsd >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}
                subtitle={`${stats.cacheSavingsReportedCalls} of ${stats.totalCalls} calls reported`}
                tooltip="Sum of cache_discount values across filtered requests. Positive (green) means caching net-saved money; negative (red) means cold-start writes outweighed reads. Filter by systemPromptId to judge whether caching is worth keeping on a specific flow."
              />
              <Metric
                label="Avg Duration"
                value={stats.avgDuration == null ? "—" : `${stats.avgDuration.toLocaleString()}ms`}
                tooltip="Mean wall-clock time per request, in milliseconds."
              />
              <Metric
                label="p95 Duration"
                tooltipAlign="right"
                value={!canReportP95(stats.durationSampleCount) || stats.p95Duration == null ? "—" : `${stats.p95Duration.toLocaleString()}ms`}
                subtitle={!canReportP95(stats.durationSampleCount) ? `${stats.durationSampleCount} of ${MIN_P95_SAMPLE_COUNT} required samples` : `${stats.durationSampleCount} samples`}
                tooltip="Nearest-rank 95th percentile request duration. At least 95% of filtered requests completed at or below this value."
              />
            </MetricStrip>

            <PanelGrid>
              <PanelSection title="Request activity">
                <RequestActivity
                  totalCalls={stats.totalCalls}
                  buckets={stats.timeBuckets}
                  maxCalls={stats.maxCalls}
                  nonEmptyBucketCount={stats.nonEmptyTimeBucketCount}
                  firstCallAt={stats.firstCallAt}
                  lastCallAt={stats.lastCallAt}
                />
              </PanelSection>

              <PanelSection title="Token mix">
                <CompositionBar items={[
                  { label: "Input", value: stats.inputTokens, color: chartColors.cyan },
                  { label: "Output", value: stats.outputTokens, color: chartColors.emerald },
                ]} />
              </PanelSection>

              <PanelSection title="Input cache coverage">
                <CompositionBar items={[
                  { label: "Fresh", value: Math.max(0, stats.inputTokens - stats.cachedInputTokens), color: chartColors.neutral },
                  { label: "Cached", value: Math.min(stats.inputTokens, stats.cachedInputTokens), color: chartColors.green },
                ]} />
                <p className="mt-3 text-[10px] text-muted-foreground">
                  {stats.cacheCreationTokens.toLocaleString()} input tokens written to cache in this window.
                </p>
              </PanelSection>

              <PanelSection title="Cache Hit % by System Prompt">
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
              </PanelSection>

              <PanelSection title="Requests by system prompt">
                <DistributionBars items={stats.sysPromptDist} color={chartColors.purple} total={stats.totalCalls} />
              </PanelSection>

              <PanelSection title="Requests by model">
                <DistributionBars items={stats.modelDist} color={chartColors.indigo} total={stats.totalCalls} />
              </PanelSection>

              <PanelSection title="Requests declaring each tool">
                <DistributionBars items={stats.toolDist} color={chartColors.orange} total={stats.totalCalls} />
              </PanelSection>

              <PanelSection title="Latency distribution">
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
              </PanelSection>
            </PanelGrid>
          </Panel>
        </>
      )}

      {/* Call list */}
      {view === "logs" && (
        <>
          {useServerFilters && filteredPages.error != null && (
            <Alert>
              <div className="flex items-center justify-between gap-3">
                <span>{filteredPages.error}</span>
                <Button onClick={() => runAsynchronously(filteredPages.refresh)}>Retry query</Button>
              </div>
            </Alert>
          )}
          {/* A failed first page also has zero rows; only the retry alert above should speak for
              it, not a "nothing matched" card that reads like a genuine empty result. */}
          {logRows.length === 0 && !(useServerFilters && filteredPages.isLoading) ? (
            useServerFilters && filteredPages.error != null ? null : (
              <Card>
                <EmptyState className="py-12">
                  <p className="text-lg">{hasLogFilters || investigationActive ? "No requests match these filters" : "No AI requests logged yet"}</p>
                  {useServerFilters && filteredPages.hasMore && <Button className="mt-3" onClick={() => runAsynchronously(filteredPages.loadMore)}>Continue searching</Button>}
                </EmptyState>
              </Card>
            )
          ) : (
            <UsageDataGrid
              rows={logRows}
              onSelect={onSelect}
              resetKey={JSON.stringify([logQueryKey, investigationKey])}
              hasMoreHistory={useServerFilters ? filteredPages.hasMore : hasMoreHistory}
              isLoadingOlder={useServerFilters ? filteredPages.isLoadingMore : isLoadingOlder}
              onLoadOlder={useServerFilters ? filteredPages.loadMore : onLoadOlder}
              isLoading={useServerFilters && filteredPages.isLoading}
            />
          )}
        </>
      )}
    </div>
  );
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
            First {formatPacificTimestamp(observedAt)}{observedSpanMs > 0 ? ` · ${Math.max(1, Math.round(observedSpanMs / 60_000))} min observed span` : ""}
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

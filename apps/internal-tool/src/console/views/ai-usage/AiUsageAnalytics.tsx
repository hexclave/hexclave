"use client";

import { useMemo } from "react";
import { useClockTick } from "../../../hooks/useClockTick";
import { rangeStartMillis, type TimeRange } from "../../../lib/filter-options";
import { formatSignedUsd } from "../../../lib/format-usd";
import { canReportP95, extent, MIN_P95_SAMPLE_COUNT, nearestRankPercentile, percentage } from "../../../lib/stats";
import { parseUsageRow } from "../../../lib/usage-filters";
import type { AiQueryLogRow } from "../../../types";
import { toDate } from "../../../utils";
import { formatCompact, formatCost, formatDuration } from "../../lib/format";
import { isCallError } from "../../lib/mcp";
import { bucketize, seriesWindow, trendPercent } from "../../lib/series";
import { KpiCard } from "../../ui/blocks";
import { BarList, CHART_COLORS, SegmentBar, TimeSeriesChart } from "../../ui/charts";
import { Card, CardBody, CardHeader } from "../../ui/primitives";

const LATENCY_BANDS = [
  { label: "< 500ms", max: 500 },
  { label: "0.5–2s", max: 2_000 },
  { label: "2–10s", max: 10_000 },
  { label: "10–30s", max: 30_000 },
  { label: "> 30s", max: Number.POSITIVE_INFINITY },
];

function sumBy<Row>(rows: readonly Row[], value: (row: Row) => number | undefined): number {
  return rows.reduce((sum, row) => sum + (value(row) ?? 0), 0);
}

function countBy<Row>(rows: readonly Row[], keys: (row: Row) => Iterable<string>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const key of keys(row)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Usage analytics over the (already filtered) requests loaded in this browser. */
export function AiUsageAnalytics({ rows, timeRange, hasMoreHistory, onSelectFlow }: {
  rows: readonly AiQueryLogRow[],
  timeRange: TimeRange,
  hasMoreHistory: boolean,
  /** Narrows the page to one flow (system prompt) when a breakdown row is clicked. */
  onSelectFlow: (systemPromptId: string) => void,
}) {
  const now = useClockTick();
  const stats = useMemo(() => {
    const times = rows.map(row => toDate(row.createdAt).getTime());
    const window = seriesWindow(rangeStartMillis(timeRange, now), extent(times)?.min ?? null, now);
    const buckets = bucketize([
      rows.filter(row => !isCallError(row)).map(row => toDate(row.createdAt).getTime()),
      rows.filter(isCallError).map(row => toDate(row.createdAt).getTime()),
    ], window.start, window.end);
    const durations = rows.map(row => Number(row.durationMs)).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const inputTokens = sumBy(rows, row => row.inputTokens);
    const cachedInputTokens = sumBy(rows, row => row.cachedInputTokens);

    const cacheByFlow = new Map<string, { input: number, cached: number, calls: number }>();
    for (const row of rows) {
      const entry = cacheByFlow.get(row.systemPromptId) ?? { input: 0, cached: 0, calls: 0 };
      entry.input += row.inputTokens ?? 0;
      entry.cached += row.cachedInputTokens ?? 0;
      entry.calls += 1;
      cacheByFlow.set(row.systemPromptId, entry);
    }

    return {
      totals: buckets.map(bucket => bucket.values[0] + bucket.values[1]),
      buckets,
      errors: rows.filter(isCallError).length,
      inputTokens,
      outputTokens: sumBy(rows, row => row.outputTokens),
      cachedInputTokens,
      cacheCreationTokens: sumBy(rows, row => row.cacheCreationTokens),
      cost: sumBy(rows, row => row.costUsd),
      pricedCalls: rows.filter(row => row.costUsd != null).length,
      cacheSavings: sumBy(rows, row => row.cacheDiscountUsd),
      cacheSavingsReported: rows.filter(row => row.cacheDiscountUsd != null).length,
      cacheHitPct: inputTokens > 0 ? Math.min(100, Math.round((cachedInputTokens / inputTokens) * 100)) : null,
      avgDuration: durations.length === 0 ? null : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      p95Duration: canReportP95(durations.length) ? nearestRankPercentile(durations, 0.95) : null,
      durationSamples: durations.length,
      latency: LATENCY_BANDS.map((band, index) => ({
        ...band,
        count: durations.filter(value => value < band.max && (index === 0 || value >= LATENCY_BANDS[index - 1].max)).length,
      })),
      byFlow: countBy(rows, row => [row.systemPromptId]),
      byModel: countBy(rows, row => [row.modelId]),
      byTool: countBy(rows, row => parseUsageRow(row).requestedTools),
      cacheByFlow: [...cacheByFlow.entries()]
        .map(([flow, entry]) => ({ flow, calls: entry.calls, input: entry.input, hitPct: entry.input > 0 ? Math.min(100, Math.round((entry.cached / entry.input) * 100)) : 0 }))
        .sort((a, b) => b.input - a.input),
    };
  }, [rows, timeRange, now]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard
          label="Requests"
          value={rows.length.toLocaleString()}
          context={hasMoreHistory ? "in loaded history" : "all history"}
          spark={stats.totals}
          trend={trendPercent(stats.totals)}
          trendGoodWhen="neutral"
          info="AI requests matching the filters among the history loaded in this browser."
        />
        <KpiCard
          label="Total cost"
          value={stats.pricedCalls === 0 ? "—" : formatCost(stats.cost)}
          context={`${stats.pricedCalls.toLocaleString()} of ${rows.length.toLocaleString()} priced`}
          info="Sum of OpenRouter total_cost. Requests whose usage hasn't been refined yet are excluded rather than assumed free."
        />
        <KpiCard
          label="Cache hit rate"
          value={stats.cacheHitPct == null ? "—" : `${stats.cacheHitPct}%`}
          tone={stats.cacheHitPct == null ? "muted" : stats.cacheHitPct >= 50 ? "good" : "default"}
          context={stats.cacheSavingsReported === 0 ? "no savings reported" : `${formatSignedUsd(stats.cacheSavings)} saved`}
          info="sum(cachedInputTokens) / sum(inputTokens). Savings is the sum of cache_discount: negative means cache writes cost more than reads saved."
        />
        <KpiCard
          label="p95 latency"
          value={stats.p95Duration == null ? "—" : formatDuration(stats.p95Duration)}
          context={stats.p95Duration == null ? `needs ${MIN_P95_SAMPLE_COUNT} samples` : `avg ${formatDuration(stats.avgDuration)} · ${percentage(stats.errors, rows.length) ?? 0}% errors`}
          tone={stats.errors > 0 && rows.length > 0 && stats.errors / rows.length > 0.05 ? "warn" : "default"}
          info="Nearest-rank 95th percentile request duration; at least 95% of requests finished at or below it."
        />
      </div>

      <Card>
        <CardHeader title="Request volume" description="Completed and failed requests per period" />
        <CardBody>
          <TimeSeriesChart buckets={stats.buckets} series={[{ label: "Completed", color: CHART_COLORS.primary }, { label: "Failed", color: CHART_COLORS.red }]} />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Tokens" description={`${formatCompact(stats.inputTokens + stats.outputTokens)} total`} />
          <CardBody className="space-y-6">
            <SegmentBar formatValue={formatCompact} segments={[
              { label: "Input", value: stats.inputTokens, color: CHART_COLORS.cyan },
              { label: "Output", value: stats.outputTokens, color: CHART_COLORS.secondary },
            ]} />
            <div>
              <p className="mb-2 text-xs font-medium text-foreground">Input cache coverage</p>
              <SegmentBar formatValue={formatCompact} segments={[
                { label: "Cached", value: Math.min(stats.inputTokens, stats.cachedInputTokens), color: CHART_COLORS.green },
                { label: "Fresh", value: Math.max(0, stats.inputTokens - stats.cachedInputTokens), color: CHART_COLORS.neutral },
              ]} />
              <p className="mt-2 text-[11px] text-muted-foreground">{stats.cacheCreationTokens.toLocaleString()} input tokens written to cache.</p>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Cache hit rate by flow" description="Sorted by input volume" />
          <CardBody>
            <BarList
              limit={8}
              formatValue={value => `${value}%`}
              items={stats.cacheByFlow.map(entry => ({
                key: entry.flow,
                label: <span className="font-mono text-[11.5px]">{entry.flow}</span>,
                value: entry.hitPct,
                color: entry.hitPct >= 50 ? CHART_COLORS.green : entry.hitPct >= 20 ? CHART_COLORS.amber : CHART_COLORS.red,
                detail: `${entry.calls.toLocaleString()} req`,
                onClick: () => onSelectFlow(entry.flow),
              }))}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Requests by flow" description="Click a flow to filter" />
          <CardBody>
            <BarList
              limit={8}
              color={CHART_COLORS.secondary}
              items={stats.byFlow.map(([flow, count]) => ({
                key: flow,
                label: <span className="font-mono text-[11.5px]">{flow}</span>,
                value: count,
                detail: `${percentage(count, rows.length) ?? 0}%`,
                onClick: () => onSelectFlow(flow),
              }))}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Requests by model" />
          <CardBody>
            <BarList
              limit={8}
              items={stats.byModel.map(([model, count]) => ({
                key: model,
                label: <span className="font-mono text-[11.5px]">{model}</span>,
                value: count,
                detail: `${percentage(count, rows.length) ?? 0}%`,
              }))}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Requests declaring each tool" />
          <CardBody>
            <BarList
              limit={8}
              color={CHART_COLORS.orange}
              items={stats.byTool.map(([tool, count]) => ({
                key: tool,
                label: <span className="font-mono text-[11.5px]">{tool}</span>,
                value: count,
                detail: `${percentage(count, rows.length) ?? 0}%`,
              }))}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Latency distribution" description={`${stats.durationSamples.toLocaleString()} samples`} />
          <CardBody>
            <BarList
              color={CHART_COLORS.pink}
              emptyLabel="No duration data"
              items={stats.durationSamples === 0 ? [] : stats.latency.map(band => ({
                key: band.label,
                label: band.label,
                value: band.count,
                detail: `${percentage(band.count, stats.durationSamples) ?? 0}%`,
              }))}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

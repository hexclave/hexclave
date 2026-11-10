"use client";

import { useMemo } from "react";
import { useClockTick } from "../../../hooks/useClockTick";
import { filterMcpCalls, type McpAnalyticsFilters } from "../../../lib/mcp-analytics-filters";
import { rangeStartMillis } from "../../../lib/filter-options";
import { canReportP95, extent, MIN_P95_SAMPLE_COUNT, nearestRankPercentile, percentage } from "../../../lib/stats";
import type { McpCallLogRow, QaEntriesRow } from "../../../types";
import { toDate } from "../../../utils";
import { formatDuration } from "../../lib/format";
import { isCallError, needsHumanReview, qualityFlagTypes } from "../../lib/mcp";
import { bucketize, seriesWindow, trendPercent } from "../../lib/series";
import { KpiCard } from "../../ui/blocks";
import { BarList, CHART_COLORS, TimeSeriesChart } from "../../ui/charts";
import { Card, CardBody, CardHeader } from "../../ui/primitives";

const SCORE_BANDS = [
  { label: "90–100", min: 90, max: 100, color: CHART_COLORS.green },
  { label: "70–89", min: 70, max: 89, color: CHART_COLORS.lime },
  { label: "50–69", min: 50, max: 69, color: CHART_COLORS.amber },
  { label: "30–49", min: 30, max: 49, color: CHART_COLORS.orange },
  { label: "0–29", min: 0, max: 29, color: CHART_COLORS.red },
];

/**
 * MCP analytics over the calls loaded in this browser, narrowed by the same filters as the call
 * list. Everything is computed client-side, so "loaded" is called out wherever it matters.
 */
export function McpAnalytics({ rows: allRows, qaEntries, filters, hasMoreHistory }: {
  rows: readonly McpCallLogRow[],
  qaEntries: readonly QaEntriesRow[],
  filters: McpAnalyticsFilters,
  hasMoreHistory: boolean,
}) {
  const now = useClockTick();
  const rows = useMemo(() => filterMcpCalls(allRows, filters, now), [allRows, filters, now]);

  const stats = useMemo(() => {
    const times = rows.map(row => toDate(row.createdAt).getTime());
    const window = seriesWindow(rangeStartMillis(filters.timeRange, now), extent(times)?.min ?? null, now);
    const buckets = bucketize([
      rows.filter(row => !isCallError(row)).map(row => toDate(row.createdAt).getTime()),
      rows.filter(isCallError).map(row => toDate(row.createdAt).getTime()),
    ], window.start, window.end);
    const scored = rows.flatMap(row => row.qaOverallScore != null && (row.qaErrorMessage ?? "") === "" ? [row.qaOverallScore] : []);
    const avgScore = scored.length === 0 ? null : Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length);
    const durations = rows.map(row => Number(row.durationMs)).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);

    const flagCounts = new Map<string, number>();
    for (const row of rows) {
      for (const type of qualityFlagTypes(row)) flagCounts.set(type, (flagCounts.get(type) ?? 0) + 1);
    }
    const toolCounts = new Map<string, number>();
    for (const row of rows) toolCounts.set(row.toolName, (toolCounts.get(row.toolName) ?? 0) + 1);

    return {
      buckets,
      totals: buckets.map(bucket => bucket.values[0] + bucket.values[1]),
      errors: rows.filter(isCallError).length,
      scoredCount: scored.length,
      avgScore,
      needsReview: rows.filter(needsHumanReview).length,
      humanReviewed: rows.filter(row => row.humanReviewedAt != null).length,
      scoreBands: SCORE_BANDS.map(band => ({ ...band, count: scored.filter(score => score >= band.min && score <= band.max).length })),
      flags: [...flagCounts.entries()].sort((a, b) => b[1] - a[1]),
      tools: [...toolCounts.entries()].sort((a, b) => b[1] - a[1]),
      avgDuration: durations.length === 0 ? null : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      p95Duration: canReportP95(durations.length) ? nearestRankPercentile(durations, 0.95) : null,
      maxDuration: durations.at(-1) ?? null,
      durationSamples: durations.length,
    };
  }, [rows, filters.timeRange, now]);

  const published = qaEntries.filter(entry => entry.published).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard
          label="Calls"
          value={rows.length.toLocaleString()}
          context={hasMoreHistory ? "in loaded history" : "all history"}
          spark={stats.totals}
          trend={trendPercent(stats.totals)}
          trendGoodWhen="neutral"
          info="MCP calls loaded in this browser that match the filters. Load older history from the Calls tab to widen the window."
        />
        <KpiCard
          label="Average QA score"
          value={stats.avgScore == null ? "—" : String(stats.avgScore)}
          tone={stats.avgScore == null ? "muted" : stats.avgScore >= 80 ? "good" : stats.avgScore >= 50 ? "warn" : "bad"}
          context={`${stats.scoredCount.toLocaleString()} scored · ${percentage(stats.scoredCount, rows.length) ?? 0}% coverage`}
          info="Mean automated QA score over calls with a completed review. Errored and pending reviews are excluded."
        />
        <KpiCard
          label="Awaiting human review"
          value={stats.needsReview.toLocaleString()}
          tone={stats.needsReview > 0 ? "warn" : "muted"}
          context={`${stats.humanReviewed.toLocaleString()} reviewed so far`}
          href="/console/mcp?view=needs-review"
          info="Calls the QA reviewer flagged for a human that nobody has marked reviewed yet."
        />
        <KpiCard
          label="Error rate"
          value={rows.length === 0 ? "—" : `${percentage(stats.errors, rows.length)}%`}
          tone={stats.errors > 0 ? "bad" : "muted"}
          context={`${stats.errors.toLocaleString()} failed calls · ${published} Q&A published`}
          info="Share of calls whose MCP tool returned an error."
        />
      </div>

      <Card>
        <CardHeader title="Call volume" description="Successful and failed MCP calls per period" />
        <CardBody>
          <TimeSeriesChart
            buckets={stats.buckets}
            series={[{ label: "Successful", color: CHART_COLORS.primary }, { label: "Errored", color: CHART_COLORS.red }]}
          />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="QA score distribution" description={`${stats.scoredCount.toLocaleString()} scored calls`} />
          <CardBody>
            <BarList
              emptyLabel="No completed QA scores"
              items={stats.scoredCount === 0 ? [] : stats.scoreBands.map(band => ({
                key: band.label,
                label: band.label,
                value: band.count,
                color: band.color,
                detail: `${percentage(band.count, stats.scoredCount) ?? 0}%`,
              }))}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Most common QA flags" description="Share of scored reviews raising each flag" />
          <CardBody>
            <BarList
              color={CHART_COLORS.orange}
              emptyLabel="No flags in completed reviews"
              limit={8}
              items={stats.flags.map(([type, count]) => ({
                key: type,
                label: <span className="font-mono text-[11.5px]">{type}</span>,
                value: count,
                detail: `${percentage(count, stats.scoredCount) ?? 0}%`,
              }))}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Calls by tool" />
          <CardBody>
            <BarList
              color={CHART_COLORS.secondary}
              emptyLabel="No calls"
              limit={8}
              items={stats.tools.map(([tool, count]) => ({
                key: tool,
                label: <span className="font-mono text-[11.5px]">{tool}</span>,
                value: count,
                detail: `${percentage(count, rows.length) ?? 0}%`,
              }))}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Latency" description={`${stats.durationSamples.toLocaleString()} duration samples`} />
          <CardBody>
            <dl className="grid grid-cols-3 gap-4">
              {[
                { label: "Average", value: formatDuration(stats.avgDuration) },
                { label: "p95", value: stats.p95Duration == null ? "—" : formatDuration(stats.p95Duration) },
                { label: "Max", value: formatDuration(stats.maxDuration) },
              ].map(item => (
                <div key={item.label}>
                  <dt className="text-xs text-muted-foreground">{item.label}</dt>
                  <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">{item.value}</dd>
                </div>
              ))}
            </dl>
            {!canReportP95(stats.durationSamples) && (
              <p className="mt-3 text-[11px] text-muted-foreground">p95 needs at least {MIN_P95_SAMPLE_COUNT} samples.</p>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

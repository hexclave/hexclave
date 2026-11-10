"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useClockTick } from "../../../hooks/useClockTick";
import { rangeStartMillis, type TimeRange } from "../../../lib/filter-options";
import { hasMcpContextValue } from "../../../lib/mcp-context";
import { canReportP95, extent, nearestRankPercentile, percentage } from "../../../lib/stats";
import type { AiQueryLogRow, FeedbackLogRow, McpCallLogRow } from "../../../types";
import { toDate } from "../../../utils";
import { useConsoleData } from "../../data/console-data";
import { feedbackTone } from "../../lib/feedback";
import { formatAgo, formatCost, formatDuration } from "../../lib/format";
import { isCallError, needsHumanReview, qaStatus, qaStatusLabel, qaStatusTone } from "../../lib/mcp";
import { bucketize, seriesWindow, trendPercent } from "../../lib/series";
import { latestUserMessage } from "../../lib/transcripts";
import { consoleHref } from "../../lib/url-state";
import { PageBody, PageHeader } from "../../shell/Page";
import { KpiCard, LoadingSkeleton } from "../../ui/blocks";
import { BarList, CHART_COLORS, TimeSeriesChart } from "../../ui/charts";
import { Icon } from "../../ui/icons";
import { Badge, Callout, Card, CardBody, CardHeader, Segmented } from "../../ui/primitives";

const RANGE_OPTIONS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
] as const satisfies ReadonlyArray<{ value: TimeRange, label: string }>;

function timeOf(row: { createdAt: McpCallLogRow["createdAt"] }): number {
  return toDate(row.createdAt).getTime();
}

export function OverviewPage() {
  const { mcp, ai, qa, feedback, connection } = useConsoleData();
  const [range, setRange] = useState<TimeRange>("7d");
  const now = useClockTick();
  const start = rangeStartMillis(range, now);

  const data = useMemo(() => {
    const inRange = <Row extends { createdAt: McpCallLogRow["createdAt"] }>(rows: readonly Row[]) => start == null ? [...rows] : rows.filter(row => timeOf(row) >= start);
    const mcpRows = inRange(mcp.rows);
    const aiRows = inRange(ai.rows);
    const feedbackRows = inRange(feedback.rows);
    const window = seriesWindow(start, extent([...mcpRows, ...aiRows].map(timeOf))?.min ?? null, now);
    const buckets = bucketize([mcpRows.map(timeOf), aiRows.map(timeOf)], window.start, window.end);
    const mcpSeries = buckets.map(bucket => bucket.values[0]);
    const aiSeries = buckets.map(bucket => bucket.values[1]);

    const scored = mcpRows.flatMap(row => row.qaOverallScore != null && (row.qaErrorMessage ?? "") === "" ? [row.qaOverallScore] : []);
    const durations = aiRows.map(row => Number(row.durationMs)).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const countBy = <Row,>(rows: readonly Row[], key: (row: Row) => string) => {
      const counts = new Map<string, number>();
      for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    };

    return {
      mcpRows,
      aiRows,
      feedbackRows,
      buckets,
      mcpSeries,
      aiSeries,
      avgScore: scored.length === 0 ? null : Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length),
      scoredCount: scored.length,
      // The review queue isn't range-bound: a call flagged last month still needs a human.
      reviewQueue: mcp.rows.filter(needsHumanReview),
      aiCost: aiRows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
      pricedCount: aiRows.filter(row => row.costUsd != null).length,
      aiErrors: aiRows.filter(isCallError).length,
      mcpErrors: mcpRows.filter(isCallError).length,
      p95: canReportP95(durations.length) ? nearestRankPercentile(durations, 0.95) : null,
      tools: countBy(mcpRows, row => row.toolName),
      flows: countBy(aiRows, row => row.systemPromptId),
      recentErrors: [
        ...mcpRows.filter(isCallError).map(row => ({ kind: "mcp" as const, row, time: timeOf(row) })),
        ...aiRows.filter(isCallError).map(row => ({ kind: "ai" as const, row, time: timeOf(row) })),
      ].sort((a, b) => b.time - a.time).slice(0, 6),
    };
  }, [mcp.rows, ai.rows, feedback.rows, start, now]);

  const anyLoaded = mcp.rows.length > 0 || ai.rows.length > 0;
  const partialHistory = mcp.hasMoreHistory || ai.hasMoreHistory;
  const publishedCount = qa.rows.filter(row => row.published).length;

  return (
    <>
      <PageHeader
        pageId="overview"
        actions={<Segmented label="Time range" value={range} onChange={setRange} options={RANGE_OPTIONS} />}
      />
      <PageBody>
        {connection.state === "error" && (
          <Callout title="Some data streams can't connect">
            {connection.errors.map(error => `${error.source}: ${error.message}`).join(" · ")}
          </Callout>
        )}
        {!anyLoaded && connection.state === "connecting" ? <LoadingSkeleton /> : (
          <>
            {partialHistory && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon name="clock" size="sm" />
                Figures cover the most recent activity streamed to this browser. Older history loads on demand from MCP Review and AI Usage.
              </p>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard
                label="MCP calls"
                value={data.mcpRows.length.toLocaleString()}
                spark={data.mcpSeries}
                trend={trendPercent(data.mcpSeries)}
                trendGoodWhen="neutral"
                context={`${data.mcpErrors.toLocaleString()} errored`}
                href="/console/mcp?tab=analytics"
              />
              <KpiCard
                label="Average QA score"
                value={data.avgScore == null ? "—" : String(data.avgScore)}
                tone={data.avgScore == null ? "muted" : data.avgScore >= 80 ? "good" : data.avgScore >= 50 ? "warn" : "bad"}
                context={`${data.scoredCount.toLocaleString()} reviewed by QA`}
                info="Mean automated QA score over MCP calls in range with a completed review."
              />
              <KpiCard
                label="AI requests"
                value={data.aiRows.length.toLocaleString()}
                spark={data.aiSeries}
                sparkColor={CHART_COLORS.secondary}
                trend={trendPercent(data.aiSeries)}
                trendGoodWhen="neutral"
                context={`${percentage(data.aiErrors, data.aiRows.length) ?? 0}% failed · p95 ${formatDuration(data.p95)}`}
                href="/console/ai-usage"
              />
              <KpiCard
                label="AI spend"
                value={data.pricedCount === 0 ? "—" : formatCost(data.aiCost)}
                context={`${data.pricedCount.toLocaleString()} priced requests`}
                info="Sum of OpenRouter total_cost for Unified AI requests in range. Requests not yet priced are excluded."
                href="/console/ai-usage"
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-3">
              <Card className="xl:col-span-2">
                <CardHeader title="Activity" description="MCP calls and Unified AI requests over time" />
                <CardBody>
                  <TimeSeriesChart
                    height={208}
                    buckets={data.buckets}
                    series={[{ label: "MCP calls", color: CHART_COLORS.primary }, { label: "AI requests", color: CHART_COLORS.secondary }]}
                  />
                </CardBody>
              </Card>
              <ReviewQueueCard rows={data.reviewQueue} now={now} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              <Card>
                <CardHeader title="MCP tools" description="Calls in range" />
                <CardBody>
                  <BarList
                    limit={6}
                    emptyLabel="No MCP calls in range"
                    items={data.tools.map(([tool, count]) => ({ key: tool, label: <span className="font-mono text-[11.5px]">{tool}</span>, value: count }))}
                  />
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Unified AI flows" description="Requests in range" />
                <CardBody>
                  <BarList
                    limit={6}
                    color={CHART_COLORS.secondary}
                    emptyLabel="No AI requests in range"
                    items={data.flows.map(([flow, count]) => ({ key: flow, label: <span className="font-mono text-[11.5px]">{flow}</span>, value: count }))}
                  />
                </CardBody>
              </Card>
              <RecentErrorsCard errors={data.recentErrors} />
              <RecentFeedbackCard rows={data.feedbackRows.slice().sort((a, b) => timeOf(b) - timeOf(a)).slice(0, 5)} total={data.feedbackRows.length} />
              <Card>
                <CardHeader title="Knowledge base" actions={<CardLink href="/console/knowledge">Manage</CardLink>} />
                <CardBody>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Published</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{publishedCount.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Drafts</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{(qa.rows.length - publishedCount).toLocaleString()}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-xs leading-5 text-muted-foreground">Published entries are served on the public /questions page and to the MCP agent.</p>
                </CardBody>
              </Card>
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}

function CardLink({ href, children }: { href: string, children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground hover:transition-none">
      {children} <Icon name="arrowRight" size="xs" />
    </Link>
  );
}

function ReviewQueueCard({ rows, now }: { rows: readonly McpCallLogRow[], now: number }) {
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={<span className="flex items-center gap-2">Review queue {rows.length > 0 && <Badge tone="amber">{rows.length}</Badge>}</span>}
        description="Flagged by QA, awaiting a human"
        actions={<CardLink href="/console/mcp?view=needs-review">Open</CardLink>}
      />
      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
          <div className="grid size-9 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"><Icon name="check" /></div>
          <p className="mt-3 text-[13px] font-medium text-foreground">All caught up</p>
          <p className="mt-1 text-xs text-muted-foreground">No calls are waiting for review.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.slice(0, 6).map(row => {
            const status = qaStatus(row, now);
            return (
              <li key={String(row.id)}>
                <Link href={consoleHref("/console/mcp", { view: "needs-review", id: String(row.id) })} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60 hover:transition-none">
                  <Badge tone={qaStatusTone(status)} className="font-mono">{qaStatusLabel(status)}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground">{row.question}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{hasMcpContextValue(row.user) ? row.user : row.toolName} · {formatAgo(toDate(row.createdAt))}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function RecentErrorsCard({ errors }: { errors: ReadonlyArray<{ kind: "mcp", row: McpCallLogRow, time: number } | { kind: "ai", row: AiQueryLogRow, time: number }> }) {
  return (
    <Card>
      <CardHeader title="Recent errors" description="Failed MCP calls and AI requests" />
      {errors.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">No errors in range.</p>
      ) : (
        <ul className="divide-y divide-border">
          {errors.map(error => (
            <li key={`${error.kind}-${String(error.row.id)}`}>
              <Link
                href={error.kind === "mcp"
                  ? consoleHref("/console/mcp", { id: String(error.row.id) })
                  : consoleHref("/console/ai-usage", { tab: "requests", id: String(error.row.id) })}
                className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60 hover:transition-none"
              >
                <Badge tone={error.kind === "mcp" ? "violet" : "blue"}>{error.kind === "mcp" ? "MCP" : "AI"}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-foreground">{error.kind === "mcp" ? error.row.question : latestUserMessage(error.row) === "" ? error.row.systemPromptId : latestUserMessage(error.row)}</span>
                  <span className="block truncate font-mono text-[11px] text-red-600 dark:text-red-400">{error.row.errorMessage}</span>
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{formatAgo(new Date(error.time))}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentFeedbackCard({ rows, total }: { rows: readonly FeedbackLogRow[], total: number }) {
  return (
    <Card>
      <CardHeader title="Latest feedback" description={`${total.toLocaleString()} in range`} actions={<CardLink href="/console/feedback">All feedback</CardLink>} />
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">No feedback in range.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map(row => (
            <li key={String(row.id)}>
              <Link href={consoleHref("/console/feedback", { id: String(row.id) })} className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60 hover:transition-none">
                <Badge tone={feedbackTone(row.category)}>{row.category}</Badge>
                <span className="line-clamp-2 min-w-0 flex-1 text-xs leading-5 text-foreground">{row.message}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{formatAgo(toDate(row.createdAt))}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

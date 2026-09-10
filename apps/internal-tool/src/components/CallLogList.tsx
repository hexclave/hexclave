import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useMemo, useState } from "react";
import { useFilteredLogPages } from "../hooks/useFilteredLogPages";
import type { McpReviewTableFilters, PageCursor } from "../hooks/useSpacetimeDB";
import type { McpCallLogRow } from "../types";
import { type HistoryPagingProps } from "./LoadOlderButton";
import { McpCallDataGrid } from "./McpCallDataGrid";
import { Alert, Button, Card, EmptyState, FieldLabel, Select } from "./design";

type TimeRange = "all" | "24h" | "7d" | "30d";
type StatusFilter = "all" | "ok" | "error";
type QaFilter = "all" | "pending" | "review-failed" | "error" | "pass" | "warn" | "fail";
type HumanReviewFilter = "all" | "required" | "reviewed" | "not-reviewed";

function parseTimeRange(value: string): TimeRange {
  if (value === "all" || value === "24h" || value === "7d" || value === "30d") return value;
  throw new Error(`Unexpected MCP time range: ${value}`);
}

function parseStatusFilter(value: string): StatusFilter {
  if (value === "all" || value === "ok" || value === "error") return value;
  throw new Error(`Unexpected MCP status filter: ${value}`);
}

function parseQaFilter(value: string): QaFilter {
  if (value === "all" || value === "pending" || value === "review-failed" || value === "error" || value === "pass" || value === "warn" || value === "fail") return value;
  throw new Error(`Unexpected MCP QA filter: ${value}`);
}

function parseHumanReviewFilter(value: string): HumanReviewFilter {
  if (value === "all" || value === "required" || value === "reviewed" || value === "not-reviewed") return value;
  throw new Error(`Unexpected MCP human review filter: ${value}`);
}

function rangeStartMicros(range: TimeRange): bigint | undefined {
  if (range === "all") return undefined;
  const hours = range === "24h" ? 24 : range === "7d" ? 7 * 24 : 30 * 24;
  return BigInt(new Date().getTime() - hours * 60 * 60 * 1000) * 1000n;
}

function mcpRowId(row: McpCallLogRow): string {
  return String(row.id);
}

export function CallLogList({
  rows,
  connectionState,
  connectionErrorMessage,
  onSelect,
  queryFilteredPage,
  hasMoreHistory,
  isLoadingOlder,
  onLoadOlder,
}: {
  rows: McpCallLogRow[],
  connectionState: string,
  connectionErrorMessage: string | null,
  onSelect: (row: McpCallLogRow) => void,
  queryFilteredPage: (filters: McpReviewTableFilters, cursor: PageCursor | null, limit: number) => Promise<{
    rows: McpCallLogRow[],
    nextBeforeCreatedAtMicros: bigint | undefined,
    nextBeforeId: bigint | undefined,
  }>,
} & HistoryPagingProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [toolName, setToolName] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [qaState, setQaState] = useState<QaFilter>("all");
  const [humanReviewState, setHumanReviewState] = useState<HumanReviewFilter>("all");
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const toolNames = useMemo(() => Array.from(new Set(rows.map(row => row.toolName))).sort(), [rows]);
  const hasFilters = timeRange !== "all" || toolName !== "" || status !== "all" || qaState !== "all" || humanReviewState !== "all";
  const filters = useMemo<McpReviewTableFilters>(() => ({
    createdAtOrAfterMicros: rangeStartMicros(timeRange),
    toolName: toolName === "" ? undefined : toolName,
    hasError: status === "all" ? undefined : status === "error",
    qaState: qaState === "all" ? undefined : qaState,
    humanReviewState: humanReviewState === "all" ? undefined : humanReviewState,
  }), [humanReviewState, qaState, snapshotVersion, status, timeRange, toolName]);
  const queryKey = [timeRange, toolName, status, qaState, humanReviewState, snapshotVersion].join("\u0000");
  const filteredPages = useFilteredLogPages({
    enabled: hasFilters,
    queryKey,
    filters,
    fetchPage: queryFilteredPage,
    getRowId: mcpRowId,
  });

  if (connectionState === "connecting") {
    return <div className="p-4 text-sm text-muted-foreground">Connecting to SpacetimeDB...</div>;
  }

  if (connectionState === "error") {
    return (
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
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-black/[0.06] bg-card p-3 shadow-sm ring-1 ring-black/[0.04] dark:border-white/[0.06] dark:ring-white/[0.04]">
        <label className="grid grid-cols-[auto_6rem] items-center gap-1.5">
          <FieldLabel>Range</FieldLabel>
          <Select value={timeRange} onChange={event => setTimeRange(parseTimeRange(event.target.value))}>
            <option value="all">All time</option>
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
          </Select>
        </label>
        {toolNames.length > 0 && <label className="grid min-w-48 flex-1 grid-cols-[auto_1fr] items-center gap-1.5">
          <FieldLabel>Tool</FieldLabel>
          <Select value={toolName} onChange={event => setToolName(event.target.value)}>
            <option value="">All tools</option>
            {toolNames.map(name => <option key={name} value={name}>{name}</option>)}
          </Select>
        </label>}
        <label className="grid grid-cols-[auto_7rem] items-center gap-1.5">
          <FieldLabel>Status</FieldLabel>
          <Select value={status} onChange={event => setStatus(parseStatusFilter(event.target.value))}>
            <option value="all">All calls</option>
            <option value="ok">OK</option>
            <option value="error">Error</option>
          </Select>
        </label>
        <label className="grid grid-cols-[auto_8rem] items-center gap-1.5">
          <FieldLabel>AI review</FieldLabel>
          <Select value={qaState} onChange={event => setQaState(parseQaFilter(event.target.value))}>
            <option value="all">All reviews</option>
            <option value="pending">Pending</option>
            <option value="review-failed">Failed</option>
            <option value="error">Error</option>
            <option value="pass">Pass (80+)</option>
            <option value="warn">Warning</option>
            <option value="fail">Fail (&lt;50)</option>
          </Select>
        </label>
        <label className="grid grid-cols-[auto_9rem] items-center gap-1.5">
          <FieldLabel>Human review</FieldLabel>
          <Select value={humanReviewState} onChange={event => setHumanReviewState(parseHumanReviewFilter(event.target.value))}>
            <option value="all">All</option>
            <option value="required">Required</option>
            <option value="reviewed">Reviewed</option>
            <option value="not-reviewed">Not reviewed</option>
          </Select>
        </label>
        {hasFilters && <Button variant="ghost" onClick={() => {
          setTimeRange("all");
          setToolName("");
          setStatus("all");
          setQaState("all");
          setHumanReviewState("all");
        }}>Clear filters</Button>}
        {hasFilters && <Button onClick={() => setSnapshotVersion(version => version + 1)} disabled={filteredPages.isLoading}>Refresh results</Button>}
        {/* Only worth saying when it is true and surprising: a filtered list is
            a point-in-time snapshot, so new calls do not stream into it. The
            unfiltered list is live, which is what people already expect. */}
        {hasFilters && <span className="ml-auto text-[10px] text-muted-foreground">Snapshot results</span>}
      </div>

      {filteredPages.error != null && (
        <Alert>
          <div className="flex items-center justify-between gap-3">
            <span>{filteredPages.error}</span>
            <Button onClick={() => runAsynchronously(filteredPages.refresh)}>Retry query</Button>
          </div>
        </Alert>
      )}

      {(hasFilters ? filteredPages.rows : rows).length === 0 && !filteredPages.isLoading ? (
        <Card>
          <EmptyState className="py-12">
            <p className="text-lg">{hasFilters ? "No calls match these filters" : "No MCP calls logged yet"}</p>
            {hasFilters && filteredPages.hasMore && <Button className="mt-3" onClick={() => runAsynchronously(filteredPages.loadMore)}>Continue searching</Button>}
          </EmptyState>
        </Card>
      ) : (
        <McpCallDataGrid
          rows={hasFilters ? filteredPages.rows : rows}
          onSelect={onSelect}
          resetKey={hasFilters ? queryKey : "live"}
          hasMoreHistory={hasFilters ? filteredPages.hasMore : hasMoreHistory}
          isLoadingOlder={hasFilters ? filteredPages.isLoadingMore : isLoadingOlder}
          onLoadOlder={hasFilters ? filteredPages.loadMore : onLoadOlder}
          isLoading={hasFilters && filteredPages.isLoading}
        />
      )}
    </div>
  );
}

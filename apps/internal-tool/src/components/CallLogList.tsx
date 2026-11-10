import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useMemo, useState } from "react";
import { useFilteredLogPages } from "../hooks/useFilteredLogPages";
import type { McpReviewTableFilters, PageCursor } from "../hooks/useSpacetimeDB";
import { CALL_STATUS_OPTIONS, hasErrorFilter, HUMAN_REVIEW_OPTIONS, QA_STATE_OPTIONS, rangeStartMillis, stringOptions, type TimeRange } from "../lib/filter-options";
import { countActiveMcpFilters, DEFAULT_MCP_ANALYTICS_FILTERS, type McpAnalyticsFilters } from "../lib/mcp-analytics-filters";
import type { McpCallLogRow } from "../types";
import { type HistoryPagingProps } from "./LoadOlderButton";
import { McpCallDataGrid } from "./McpCallDataGrid";
import { Alert, Button, Card, EmptyState, Input, Panel, PanelRow } from "./design";
import { MultiFilter, TimeRangeFilter } from "./FilterFields";

function rangeStartMicros(range: TimeRange): bigint | undefined {
  const startMillis = rangeStartMillis(range, Date.now());
  return startMillis == null ? undefined : BigInt(startMillis) * 1000n;
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
  // Same filter model as the Overview's MCP analytics, so both views mean the same thing by each filter.
  const [mcpFilters, setMcpFilters] = useState<McpAnalyticsFilters>(DEFAULT_MCP_ANALYTICS_FILTERS);
  const setFilter = <Key extends keyof McpAnalyticsFilters>(key: Key, value: McpAnalyticsFilters[Key]) => {
    setMcpFilters(current => ({ ...current, [key]: value }));
  };
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  // Free-text search is client-side over whatever rows are on screen (the live list, or the
  // loaded pages of a filtered snapshot); the server-side filters above are the categorical ones.
  const [search, setSearch] = useState("");
  const toolOptions = useMemo(() => stringOptions(Array.from(new Set(rows.map(row => row.toolName))).sort()), [rows]);
  const hasFilters = countActiveMcpFilters(mcpFilters) > 0;
  const filters = useMemo<McpReviewTableFilters>(() => ({
    createdAtOrAfterMicros: rangeStartMicros(mcpFilters.timeRange),
    toolNames: [...mcpFilters.toolNames].sort(),
    hasError: hasErrorFilter(mcpFilters.statuses),
    qaStates: [...mcpFilters.qaStates].sort(),
    humanReviewStates: [...mcpFilters.humanReviewStates].sort(),
    // snapshotVersion is a dependency on purpose: bumping it recomputes the range start ("now").
  }), [mcpFilters, snapshotVersion]);
  const queryKey = JSON.stringify([
    mcpFilters.timeRange, filters.toolNames, filters.hasError ?? null, filters.qaStates, filters.humanReviewStates, snapshotVersion,
  ]);
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
      <Panel>
        <PanelRow className="gap-x-2">
          <Input
            type="search"
            aria-label="Search loaded MCP calls"
            className="min-w-64 flex-1"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search question, reason, response, user… (loaded rows)"
          />
          {hasFilters && <Button variant="ghost" onClick={() => setMcpFilters(DEFAULT_MCP_ANALYTICS_FILTERS)}>Clear filters</Button>}
        </PanelRow>
        <PanelRow>
          <TimeRangeFilter value={mcpFilters.timeRange} onChange={range => setFilter("timeRange", range)} />
          {toolOptions.length > 0 && <MultiFilter label="Tool" mono controlClassName="w-44" options={toolOptions} selected={mcpFilters.toolNames} onChange={selected => setFilter("toolNames", selected)} />}
          <MultiFilter label="Status" controlClassName="w-28" options={CALL_STATUS_OPTIONS} selected={mcpFilters.statuses} onChange={selected => setFilter("statuses", selected)} />
          <MultiFilter label="AI review" options={QA_STATE_OPTIONS} selected={mcpFilters.qaStates} onChange={selected => setFilter("qaStates", selected)} />
          <MultiFilter label="Human review" options={HUMAN_REVIEW_OPTIONS} selected={mcpFilters.humanReviewStates} onChange={selected => setFilter("humanReviewStates", selected)} />
          {/* Only worth saying when it is true and surprising: a filtered list is
              a point-in-time snapshot, so new calls do not stream into it. The
              unfiltered list is live, which is what people already expect. */}
          {hasFilters && <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">Snapshot results</span>
            <Button onClick={() => setSnapshotVersion(version => version + 1)} disabled={filteredPages.isLoading}>Refresh</Button>
          </div>}
        </PanelRow>
      </Panel>

      {filteredPages.error != null && (
        <Alert>
          <div className="flex items-center justify-between gap-3">
            <span>{filteredPages.error}</span>
            <Button onClick={() => runAsynchronously(filteredPages.refresh)}>Retry query</Button>
          </div>
        </Alert>
      )}

      {/* A failed first page also has zero rows; only the retry alert above should speak for it,
          not a "nothing matched" card that reads like a genuine empty result. */}
      {(hasFilters ? filteredPages.rows : rows).length === 0 && !filteredPages.isLoading ? (
        filteredPages.error != null ? null : (
          <Card>
            <EmptyState className="py-12">
              <p className="text-lg">{hasFilters ? "No calls match these filters" : "No MCP calls logged yet"}</p>
              {hasFilters && filteredPages.hasMore && <Button className="mt-3" onClick={() => runAsynchronously(filteredPages.loadMore)}>Continue searching</Button>}
            </EmptyState>
          </Card>
        )
      ) : (
        <McpCallDataGrid
          rows={hasFilters ? filteredPages.rows : rows}
          quickSearch={search}
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

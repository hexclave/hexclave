"use client";

import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import type { DataGridColumnDef, DataGridState } from "@hexclave/dashboard-ui-components";
import { useId, useMemo, useState, type ReactNode } from "react";
import { useClockTick } from "../../../hooks/useClockTick";
import { useFilteredLogPages } from "../../../hooks/useFilteredLogPages";
import type { McpReviewTableFilters } from "../../../hooks/useSpacetimeDB";
import { hasErrorFilter, rangeStartMillis } from "../../../lib/filter-options";
import { countActiveMcpFilters, type McpAnalyticsFilters } from "../../../lib/mcp-analytics-filters";
import { reviewVisible } from "../../../lib/mcp-review-api";
import type { McpCallLogRow } from "../../../types";
import { useConsoleData } from "../../data/console-data";
import { isAiReviewRetryable, needsHumanReview } from "../../lib/mcp";
import { useQueryParam } from "../../lib/url-state";
import { DetailPanel, PageHeader, SplitView, useListNavigation } from "../../shell/Page";
import { ConnectionGate, FilterBar } from "../../ui/blocks";
import { Badge, Button, Callout, Card, EmptyState, Segmented, StatusDot, TabPanel, Tabs } from "../../ui/primitives";
import { ConsoleTable, type HistoryPaging, rowIdOf, useConsoleTableState } from "../../ui/table";
import { McpAnalytics } from "./McpAnalytics";
import { McpCallDetail } from "./McpCallDetail";
import { buildMcpColumns, matchesMcpSearch, MCP_COLUMN_ORDER, MCP_DEFAULT_VISIBLE } from "./mcp-columns";
import { matchingMcpView, McpFilterControls, mcpViewFilters, MCP_VIEWS } from "./mcp-filters";

const MAX_REVIEW_BATCH = 50;
type PageTab = "calls" | "analytics";

export function McpReviewPage() {
  const { mcp, qa, feedback } = useConsoleData();
  const tabsId = useId();
  const [tabParam, setTabParam] = useQueryParam("tab");
  const tab: PageTab = tabParam === "analytics" ? "analytics" : "calls";
  const [viewParam, setViewParam] = useQueryParam("view");
  const [selectedId, setSelectedId] = useQueryParam("id");
  // Filters start from the view in the URL (eg. the overview's "awaiting review" tile links to
  // ?view=needs-review); afterwards they're local state shared by the Calls and Analytics tabs.
  const [filters, setFiltersState] = useState<McpAnalyticsFilters>(() => mcpViewFilters(viewParam));
  const activeView = matchingMcpView(filters);
  const setFilters = (next: McpAnalyticsFilters) => {
    setFiltersState(next);
    const view = matchingMcpView(next);
    setViewParam(view == null || view === "all" ? null : view);
  };

  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const hasFilters = countActiveMcpFilters(filters) > 0;
  const serverFilters = useMemo<McpReviewTableFilters>(() => {
    const start = rangeStartMillis(filters.timeRange, Date.now());
    return {
      createdAtOrAfterMicros: start == null ? undefined : BigInt(start) * 1000n,
      // Sorted so equal selections produce equal args (and equal query keys) regardless of click order.
      toolNames: [...filters.toolNames].sort(),
      hasError: hasErrorFilter(filters.statuses),
      qaStates: [...filters.qaStates].sort(),
      humanReviewStates: [...filters.humanReviewStates].sort(),
    };
    // snapshotVersion is a dependency on purpose: a refresh recomputes the range start ("now").
  }, [filters, snapshotVersion]);
  const queryKey = JSON.stringify([filters.timeRange, serverFilters.toolNames, serverFilters.hasError ?? null, serverFilters.qaStates, serverFilters.humanReviewStates, snapshotVersion]);
  // With filters active the list is a server-side snapshot (paged through the module's filter
  // procedure, so it reaches past the live window); without filters it's the live subscription.
  const snapshot = useFilteredLogPages({
    enabled: hasFilters && tab === "calls",
    queryKey,
    filters: serverFilters,
    fetchPage: mcp.queryFilteredPage,
    getRowId: rowIdOf,
  });
  const listRows = hasFilters ? snapshot.rows : mcp.rows;

  const now = useClockTick();
  const columns = useMemo(() => buildMcpColumns(now), [now]);
  const [tableState, setTableState] = useConsoleTableState(columns, { visible: MCP_DEFAULT_VISIBLE, order: MCP_COLUMN_ORDER, resetKey: hasFilters ? queryKey : "live" });

  // The open row is looked up in the snapshot first, then in everything loaded, so a link to a call
  // outside the current filter still opens it.
  const selectedRow = selectedId == null ? null : listRows.find(row => rowIdOf(row) === selectedId) ?? mcp.rows.find(row => rowIdOf(row) === selectedId) ?? null;
  const navigation = useListNavigation(listRows, selectedId, rowIdOf, setSelectedId);
  const relatedFeedback = selectedRow?.conversationId == null
    ? []
    : feedback.rows.filter(entry => entry.conversationId === selectedRow.conversationId);

  const needsReviewCount = useMemo(() => mcp.rows.filter(needsHumanReview).length, [mcp.rows]);
  const viewCounts = new Map<string, number>([["needs-review", needsReviewCount]]);

  return (
    <>
      <PageHeader
        pageId="mcp"
        meta={hasFilters && tab === "calls"
          ? <Badge tone="neutral">Snapshot</Badge>
          : <Badge tone="green"><StatusDot tone="green" pulse className="mr-0.5 scale-75" />Live</Badge>}
      >
        <Tabs
          id={tabsId}
          label="MCP review sections"
          value={tab}
          onChange={value => setTabParam(value === "calls" ? null : value)}
          items={[{ value: "calls", label: "Calls" }, { value: "analytics", label: "Analytics" }]}
          bordered={false}
        />
      </PageHeader>

      <SplitView
        detail={selectedId != null && tab === "calls" && (
          <DetailPanel label="MCP call" onClose={() => setSelectedId(null)} {...navigation}>
            {selectedRow == null ? (
              <EmptyState
                icon="search"
                title="This call isn't loaded"
                description="It may be older than the history loaded in this browser. Load older history, or clear the filters."
                action={mcp.hasMoreHistory ? <Button onClick={() => mcp.loadOlder()}>Load older history</Button> : undefined}
              />
            ) : (
              <McpCallDetail
                key={selectedId}
                row={selectedRow}
                allRows={mcp.rows}
                qaEntries={qa.rows}
                relatedFeedback={relatedFeedback}
                onAdvance={navigation.onNext}
              />
            )}
          </DetailPanel>
        )}
      >
        <ConnectionGate state={mcp.connectionState} errorMessage={mcp.connectionErrorMessage} hasRows={mcp.rows.length > 0} source="MCP calls">
          <div className="space-y-3">
            <Segmented
              label="Saved views"
              value={activeView ?? "custom"}
              onChange={value => setFilters(mcpViewFilters(value))}
              options={MCP_VIEWS.map(view => ({ value: view.value, label: view.label, count: viewCounts.get(view.value) }))}
            />
            <FilterBar
              summary={tab === "calls" && hasFilters
                ? snapshot.isLoading ? "Querying…" : `${snapshot.rows.length.toLocaleString()}${snapshot.hasMore ? "+" : ""} matches`
                : undefined}
              actions={tab === "calls" && hasFilters && (
                <Button size="xs" icon="refresh" disabled={snapshot.isLoading} onClick={() => setSnapshotVersion(version => version + 1)}>Refresh</Button>
              )}
            >
              <McpFilterControls rows={mcp.rows} filters={filters} onChange={setFilters} />
            </FilterBar>
          </div>

          <TabPanel id={tabsId} value="analytics" hidden={tab !== "analytics"}>
            {tab === "analytics" && <McpAnalytics rows={mcp.rows} qaEntries={qa.rows} filters={filters} hasMoreHistory={mcp.hasMoreHistory} />}
          </TabPanel>

          {tab === "calls" && (
            <TabPanel id={tabsId} value="calls" className="space-y-3">
              {snapshot.error != null && (
                <Callout title="The filtered query failed" actions={<Button size="xs" onClick={snapshot.refresh}>Retry</Button>}>{snapshot.error}</Callout>
              )}
              <CallsTable
                rows={listRows}
                columns={columns}
                tableState={tableState}
                setTableState={setTableState}
                activeRowId={selectedId}
                onOpen={row => setSelectedId(rowIdOf(row))}
                isLoading={hasFilters && snapshot.isLoading}
                history={hasFilters
                  ? { hasMoreHistory: snapshot.hasMore, isLoadingOlder: snapshot.isLoadingMore, onLoadOlder: snapshot.loadMore }
                  : { hasMoreHistory: mcp.hasMoreHistory, isLoadingOlder: mcp.isLoadingOlder, onLoadOlder: mcp.loadOlder }}
                emptyTitle={hasFilters ? "No calls match these filters" : "No MCP calls logged yet"}
                emptyAction={hasFilters && snapshot.hasMore
                  ? <Button onClick={() => runAsynchronously(snapshot.loadMore)}>Search older history</Button>
                  : undefined}
              />
            </TabPanel>
          )}
        </ConnectionGate>
      </SplitView>
    </>
  );
}

function CallsTable({ rows, columns, tableState, setTableState, activeRowId, onOpen, isLoading, history, emptyTitle, emptyAction }: {
  rows: readonly McpCallLogRow[],
  columns: readonly DataGridColumnDef<McpCallLogRow>[],
  tableState: DataGridState,
  setTableState: React.Dispatch<React.SetStateAction<DataGridState>>,
  activeRowId: string | null,
  onOpen: (row: McpCallLogRow) => void,
  isLoading: boolean,
  history: HistoryPaging,
  emptyTitle: string,
  emptyAction: ReactNode,
}) {
  const now = useClockTick();
  const [retryState, setRetryState] = useState<{ kind: "queued" } | { kind: "error", message: string } | null>(null);
  const selected = rows.filter(row => tableState.selection.selectedIds.has(rowIdOf(row)));
  const retryable = selected.filter(row => isAiReviewRetryable(row, now)).slice(0, MAX_REVIEW_BATCH);

  return (
    <div className="space-y-3">
      {retryState?.kind === "error" && <Callout title="Couldn't queue the QA retries">{retryState.message}</Callout>}
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[hsl(var(--brand)/0.3)] bg-[hsl(var(--brand)/0.05)] px-3 py-2">
          <span className="mr-auto text-xs font-medium text-foreground">{selected.length.toLocaleString()} selected</span>
          <Button
            size="xs"
            icon="refresh"
            disabled={retryable.length === 0}
            title={selected.length > MAX_REVIEW_BATCH ? `Queues the first ${MAX_REVIEW_BATCH} eligible rows` : "Re-run automated QA for selected calls whose review errored or never finished"}
            onClick={async () => {
              setRetryState(null);
              try {
                await reviewVisible(retryable.map(row => ({ correlationId: row.correlationId, question: row.question, reason: row.reason, response: row.response })));
                setRetryState({ kind: "queued" });
              } catch (error) {
                setRetryState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
                throw error;
              }
            }}
          >
            {retryState?.kind === "queued" ? "QA retries queued" : retryable.length === 0 ? "No failed QA reviews selected" : `Retry QA for ${retryable.length}`}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => {
            setRetryState(null);
            setTableState(current => ({ ...current, selection: { selectedIds: new Set(), anchorId: null } }));
          }}>
            Clear selection
          </Button>
        </div>
      )}
      <Card>
        <ConsoleTable
          columns={columns}
          rows={rows}
          getRowId={rowIdOf}
          state={tableState}
          onStateChange={setTableState}
          onRowClick={onOpen}
          activeRowId={activeRowId}
          matchRow={matchesMcpSearch}
          searchPlaceholder="Search question, response, user, IDs…"
          isLoading={isLoading}
          history={history}
          selectable
          rowHeight={52}
          exportFilename="mcp-calls"
          emptyState={<EmptyState title={emptyTitle} description="Calls stream in live as agents use the MCP server." action={emptyAction} />}
        />
      </Card>
    </div>
  );
}

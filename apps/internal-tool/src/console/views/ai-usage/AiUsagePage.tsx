"use client";

import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useId, useMemo, useState } from "react";
import { useClockTick } from "../../../hooks/useClockTick";
import { useFilteredLogPages } from "../../../hooks/useFilteredLogPages";
import { aiUsageScopeMatcher, type AiUsageScopeFilters, countActiveAiUsageScopeFilters, DEFAULT_AI_USAGE_SCOPE_FILTERS, toAiUsageTableFilters } from "../../../lib/ai-usage-filters";
import { emptyUsageFilters, hasUsageFilters, matchesUsageFilters, usageFilterKey, type UsageFilters } from "../../../lib/usage-filters";
import { useConsoleData } from "../../data/console-data";
import { useQueryParam } from "../../lib/url-state";
import { DetailPanel, PageHeader, SplitView, useListNavigation } from "../../shell/Page";
import { ConnectionGate } from "../../ui/blocks";
import { Badge, Button, Callout, Card, EmptyState, StatusDot, TabPanel, Tabs } from "../../ui/primitives";
import { ConsoleTable, type HistoryPaging, rowIdOf, useConsoleTableState } from "../../ui/table";
import { AI_COLUMNS, AI_DEFAULT_VISIBLE } from "./ai-columns";
import { AiRequestDetail } from "./AiRequestDetail";
import { AiUsageAnalytics } from "./AiUsageAnalytics";
import { AiUsageFilters } from "./AiUsageFilters";

type PageTab = "analytics" | "requests";

export function AiUsagePage() {
  const { ai, mcp } = useConsoleData();
  const tabsId = useId();
  const [tabParam, setTabParam] = useQueryParam("tab");
  const tab: PageTab = tabParam === "requests" ? "requests" : "analytics";
  const [selectedId, setSelectedId] = useQueryParam("id");

  // One filter state for both tabs, so narrowing the analytics and then switching to the request
  // list shows exactly the requests behind the charts.
  const [scope, setScope] = useState<AiUsageScopeFilters>(DEFAULT_AI_USAGE_SCOPE_FILTERS);
  const [investigation, setInvestigation] = useState<UsageFilters>(emptyUsageFilters);
  const investigationActive = hasUsageFilters(investigation);
  const scopeActive = countActiveAiUsageScopeFilters(scope) > 0;

  const now = useClockTick();
  const loadedMatches = useMemo(() => {
    const matchesScope = aiUsageScopeMatcher(scope, now);
    return ai.rows.filter(row => matchesScope(row) && matchesUsageFilters(row, investigation));
  }, [ai.rows, scope, investigation, now]);

  // Request list source, in order of precedence:
  // 1. investigation filters → client-side over loaded rows (the server can't filter on them);
  // 2. scope filters only → server-side snapshot, which reaches beyond the live window;
  // 3. nothing → the live subscription.
  const useSnapshot = scopeActive && !investigationActive;
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  // snapshotVersion is a dependency on purpose: a refresh recomputes the range start ("now").
  const serverFilters = useMemo(() => toAiUsageTableFilters(scope, Date.now()), [scope, snapshotVersion]);
  const snapshotKey = JSON.stringify([scope.timeRange, serverFilters.systemPromptIds, serverFilters.modelIds, serverFilters.mode ?? null, serverFilters.isAuthenticated ?? null, serverFilters.hasError ?? null, snapshotVersion]);
  const snapshot = useFilteredLogPages({
    enabled: tab === "requests" && useSnapshot,
    queryKey: snapshotKey,
    filters: serverFilters,
    fetchPage: ai.queryFilteredPage,
    getRowId: rowIdOf,
  });
  const listRows = investigationActive ? loadedMatches : useSnapshot ? snapshot.rows : ai.rows;
  const history: HistoryPaging = useSnapshot
    ? { hasMoreHistory: snapshot.hasMore, isLoadingOlder: snapshot.isLoadingMore, onLoadOlder: snapshot.loadMore }
    : { hasMoreHistory: ai.hasMoreHistory, isLoadingOlder: ai.isLoadingOlder, onLoadOlder: ai.loadOlder };

  const [tableState, setTableState] = useConsoleTableState(AI_COLUMNS, {
    visible: AI_DEFAULT_VISIBLE,
    resetKey: JSON.stringify([useSnapshot ? snapshotKey : "live", usageFilterKey(investigation)]),
  });

  const selectedRow = selectedId == null ? null : listRows.find(row => rowIdOf(row) === selectedId) ?? ai.rows.find(row => rowIdOf(row) === selectedId) ?? null;
  const navigation = useListNavigation(listRows, selectedId, rowIdOf, setSelectedId);

  return (
    <>
      <PageHeader
        pageId="ai-usage"
        meta={tab === "requests" && useSnapshot
          ? <Badge>Snapshot</Badge>
          : <Badge tone="green"><StatusDot tone="green" pulse className="mr-0.5 scale-75" />Live</Badge>}
      >
        <Tabs
          id={tabsId}
          label="AI usage sections"
          value={tab}
          onChange={value => setTabParam(value === "analytics" ? null : value)}
          items={[{ value: "analytics", label: "Analytics" }, { value: "requests", label: "Requests" }]}
          bordered={false}
        />
      </PageHeader>

      <SplitView
        detail={selectedId != null && tab === "requests" && (
          <DetailPanel label="AI request" onClose={() => setSelectedId(null)} {...navigation}>
            {selectedRow == null ? (
              <EmptyState icon="search" title="This request isn't loaded" description="It may be older than the history loaded in this browser." />
            ) : (
              <AiRequestDetail key={selectedId} row={selectedRow} mcpRows={mcp.rows} />
            )}
          </DetailPanel>
        )}
      >
        <ConnectionGate state={ai.connectionState} errorMessage={ai.connectionErrorMessage} hasRows={ai.rows.length > 0} source="AI requests">
          <AiUsageFilters
            rows={ai.rows}
            scope={scope}
            onScopeChange={setScope}
            investigation={investigation}
            onInvestigationChange={setInvestigation}
            history={ai}
          />

          {tab === "analytics" && (
            <TabPanel id={tabsId} value="analytics">
              <AiUsageAnalytics
                rows={loadedMatches}
                timeRange={scope.timeRange}
                hasMoreHistory={ai.hasMoreHistory}
                onSelectFlow={flow => setScope({ ...scope, systemPromptIds: new Set([flow]) })}
              />
            </TabPanel>
          )}

          {tab === "requests" && (
            <TabPanel id={tabsId} value="requests" className="space-y-3">
              {useSnapshot && snapshot.error != null && (
                <Callout title="The filtered query failed" actions={<Button size="xs" onClick={snapshot.refresh}>Retry</Button>}>{snapshot.error}</Callout>
              )}
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {investigationActive
                    ? `${loadedMatches.length.toLocaleString()} of ${ai.rows.length.toLocaleString()} loaded requests match${ai.hasMoreHistory ? " · load all history to search everything" : ""}`
                    : useSnapshot
                      ? snapshot.isLoading ? "Querying…" : `${snapshot.rows.length.toLocaleString()}${snapshot.hasMore ? "+" : ""} matching requests (snapshot)`
                      : `${ai.rows.length.toLocaleString()} requests · streaming live`}
                </span>
                {useSnapshot && <Button size="xs" icon="refresh" disabled={snapshot.isLoading} onClick={() => setSnapshotVersion(version => version + 1)}>Refresh</Button>}
              </div>
              <Card>
                <ConsoleTable
                  columns={AI_COLUMNS}
                  rows={listRows}
                  getRowId={rowIdOf}
                  state={tableState}
                  onStateChange={setTableState}
                  onRowClick={row => setSelectedId(rowIdOf(row))}
                  activeRowId={selectedId}
                  searchPlaceholder={null}
                  isLoading={useSnapshot && snapshot.isLoading}
                  history={investigationActive ? null : history}
                  exportFilename="ai-requests"
                  emptyState={(
                    <EmptyState
                      title={scopeActive || investigationActive ? "No requests match these filters" : "No AI requests logged yet"}
                      action={useSnapshot && snapshot.hasMore ? <Button onClick={() => runAsynchronously(snapshot.loadMore)}>Search older history</Button> : undefined}
                    />
                  )}
                />
              </Card>
            </TabPanel>
          )}
        </ConnectionGate>
      </SplitView>
    </>
  );
}

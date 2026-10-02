"use client";

import { DesignAlert, DesignButton, DesignCategoryTabs, DesignDialog, DesignInput, DesignSelectorDropdown } from "@/components/design-components";
import { TooltipProvider, Typography } from "@/components/ui";
import { useRouter } from "@/components/router";
import { ArrowClockwiseIcon, ArrowCounterClockwiseIcon, ArrowsMergeIcon, BellRingingIcon, BugBeetleIcon, CheckCircleIcon, MagnifyingGlassIcon, ProhibitIcon } from "@phosphor-icons/react";
import {
  DataGrid,
  DataGridToolbar,
  useDataGridUrlState,
  useDataSource,
  type DataGridDataSource,
  type DataGridState,
  type DataGridToolbarContext,
} from "@hexclave/dashboard-ui-components";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useDebounce } from "use-debounce";
import { Link } from "@/components/link";
import { AppEnabledGuard } from "../../app-enabled-guard";
import { useAdminApp } from "../../use-admin-app";
import { getErrorMessage } from "../format";
import { getBucketGranularity } from "../bucket-granularity";
import { ObservabilityPageLayout } from "../observability-page-layout";
import { ObservabilityEmptyState, ObservabilityErrorState, ObservabilityToolbar, ObservabilityTimeRangeToggle } from "../page-chrome";
import {
  ALL_SERVICES_SELECT_VALUE,
  readLocationSearch,
  replaceLocationSearch,
} from "../filters";
import {
  serviceIdentityLabel,
  serviceIdentityToSelectValue,
  namespacedSelectValue,
  selectValueToNamespacedValue,
  selectValueToServiceIdentity,
} from "../service-identity";
import {
  buildIssueColumns,
  ISSUE_COLUMN_IDS,
  ISSUE_COLUMNS_HIDDEN_BY_DEFAULT,
  type IssueCellContext,
} from "./issue-columns";
import { issueDetailHref } from "./issue-links";
import {
  ALL_STATUSES_FILTER_VALUE,
  DEFAULT_ISSUE_FILTERS,
  DEFAULT_ISSUE_SORT,
  ISSUE_HANDLED_FILTERS,
  issueFiltersAreDefault,
  parseIssueFilters,
  parseIssueStatusFilter,
  resolveIssueSort,
  serializeIssueFilters,
  type IssueFilters,
} from "./issue-filters";
import {
  adjustIssueStatusCounts,
  applyOptimisticStatus,
  clearOptimisticStatus,
  NO_ISSUE_STATUS_OVERRIDES,
  reconcileIssueStatusOverrides,
  resolveIssueRowStatus,
  type IssueStatusOverrides,
} from "./issue-status";
import {
  fetchIssueList,
  mergeIssues,
  updateIssuesStatusBulk,
  updateIssueStatus,
  type IssueListItem,
  type IssueStatus,
  type IssueStatusCounts,
} from "./issues-data";
import { IssueSavedViews } from "./issue-saved-views";
import { IssueEventSearch } from "./issue-event-search";
import { useIssueFacets, useIssueSparklines } from "./use-issue-data";

const SEARCH_DEBOUNCE_MS = 300;

const IssueAlertsDialog = lazy(async () => {
  const issueAlerts = await import("./alerts/page-client");
  return { default: issueAlerts.IssueAlertsDialog };
});

const ENVIRONMENT_SELECT_VALUE_PREFIX = "env:";

const HANDLED_FILTER_LABELS = new Map([
  ["all", "Handled & unhandled"],
  ["unhandled", "Unhandled only"],
  ["handled", "Handled only"],
]);

function handledFilterLabel(value: string): string {
  const label = HANDLED_FILTER_LABELS.get(value);
  if (label == null) throw new Error(`Missing label for handled filter: ${value}`);
  return label;
}

function readFiltersFromLocation(): IssueFilters {
  return parseIssueFilters(readLocationSearch());
}

const INITIAL_ISSUE_COLUMN_VISIBILITY: Record<string, boolean> = Object.fromEntries(
  ISSUE_COLUMN_IDS.map((id) => [id, !ISSUE_COLUMNS_HIDDEN_BY_DEFAULT.includes(id)]),
);

function IssuesEmptyState({ filtered }: { filtered: boolean }) {
  return (
    <ObservabilityEmptyState
      icon={BugBeetleIcon}
      title={filtered ? "No matching issues" : "No issues yet"}
      description={filtered
        ? "Nothing matches these filters in the selected range. Clear a filter, widen the range, or switch to another status."
        : "Errors are captured automatically once your app uses the SDK — uncaught exceptions, unhandled rejections, and server request errors are grouped here as they arrive."}
    />
  );
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const router = useRouter();
  const projectId = adminApp.projectId;

  const [filters, setFilters] = useState<IssueFilters>(readFiltersFromLocation);
  const [debouncedSearch] = useDebounce(filters.search.trim(), SEARCH_DEBOUNCE_MS);
  const [counts, setCounts] = useState<IssueStatusCounts | null>(null);
  const [approximate, setApproximate] = useState(false);
  const [overrides, setOverrides] = useState<IssueStatusOverrides>(NO_ISSUE_STATUS_OVERRIDES);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [bulkStatusError, setBulkStatusError] = useState<string | null>(null);
  const [bulkStatusBusy, setBulkStatusBusy] = useState<IssueStatus | null>(null);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [alertRulesDialogOpen, setAlertRulesDialogOpen] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  useEffect(() => {
    replaceLocationSearch(serializeIssueFilters(filters, readLocationSearch()));
  }, [filters]);

  const facetsState = useIssueFacets(adminApp, filters.hours);

  const listRequestSeqRef = useRef(0);
  const countsRevisionRef = useRef(0);

  const dataSource = useMemo<DataGridDataSource<IssueListItem>>(() => {
    return async function* (params) {
      const requestId = ++listRequestSeqRef.current;
      const sort = resolveIssueSort(params.sorting);
      const response = await fetchIssueList(adminApp, {
        hours: filters.hours,
        status: filters.status,
        service: filters.service,
        environment: filters.environment,
        handled: filters.handled,
        search: debouncedSearch,
        sort: sort.field,
        sortDir: sort.direction,
        cursor: typeof params.cursor === "string" ? params.cursor : null,
        limit: params.pagination.pageSize,
      });
      if (listRequestSeqRef.current === requestId) {
        countsRevisionRef.current += 1;
        setCounts(response.counts);
        setApproximate(response.approximate);
      }
      yield {
        rows: response.items,
        nextCursor: response.cursor,
        hasMore: response.cursor != null,
      };
    };
  }, [
    adminApp,
    filters.hours,
    filters.status,
    filters.service,
    filters.environment,
    filters.handled,
    debouncedSearch,
  ]);

  const pendingStatusIssueIdsRef = useRef(new Set<string>());
  const pendingStatusCountRevisionsRef = useRef(new Map<string, number>());

  const changeStatus = useCallback(async (issue: IssueListItem, status: IssueStatus) => {
    if (pendingStatusIssueIdsRef.current.has(issue.id)) return;
    pendingStatusIssueIdsRef.current.add(issue.id);
    const countRevisionAtStart = countsRevisionRef.current;
    pendingStatusCountRevisionsRef.current.set(issue.id, countRevisionAtStart);
    setStatusError(null);
    const from = resolveIssueRowStatus(issue, overridesRef.current).status;
    setOverrides(applyOptimisticStatus(overridesRef.current, issue.id, status, issue.updated_at_millis));
    setCounts((current) => adjustIssueStatusCounts(current, from, status));
    try {
      await updateIssueStatus(adminApp, issue.id, status);
    } catch (error) {
      setOverrides(clearOptimisticStatus(overridesRef.current, issue.id));
      if (pendingStatusCountRevisionsRef.current.get(issue.id) === countsRevisionRef.current) {
        setCounts((current) => adjustIssueStatusCounts(current, status, from));
      }
      setStatusError(getErrorMessage(error));
    } finally {
      pendingStatusIssueIdsRef.current.delete(issue.id);
      pendingStatusCountRevisionsRef.current.delete(issue.id);
    }
  }, [adminApp]);

  const bucketLabel = getBucketGranularity(filters.hours).label;

  // Mirror of `gridData.rows`. This is not redundant state: `cellContext`
  // (needed to build the columns that `gridData` itself consumes) requires
  // `sparklines`, while `useIssueSparklines` needs rows. The state+effect pair
  // breaks that hook-ordering cycle; the hook keys its cache by issue-hash
  // strings so the extra render pass stays cheap.
  const [gridRows, setGridRows] = useState<readonly IssueListItem[]>([]);
  const sparklines = useIssueSparklines(adminApp, filters.hours, gridRows);

  const cellContext = useMemo<IssueCellContext>(() => ({
    projectId,
    rangeHours: filters.hours,
    nowMs,
    overrides,
    sparklinesByHash: sparklines.byHash,
    bucketLabel,
    onChangeStatus: changeStatus,
  }), [projectId, filters.hours, nowMs, overrides, sparklines.byHash, bucketLabel, changeStatus]);

  const columns = useMemo(() => buildIssueColumns(cellContext), [cellContext]);

  const [gridState, setGridState] = useDataGridUrlState(columns, {
    paramPrefix: "issues",
    initial: {
      sorting: [{ columnId: "lastSeen", direction: DEFAULT_ISSUE_SORT.direction }],
      columnVisibility: INITIAL_ISSUE_COLUMN_VISIBILITY,
    },
  });

  const handleGridStateChange = useCallback<Dispatch<SetStateAction<DataGridState>>>((action) => {
    setGridState((current) => {
      const next = typeof action === "function" ? action(current) : action;
      return next.sorting.length <= 1 ? next : { ...next, sorting: next.sorting.slice(-1) };
    });
  }, [setGridState]);

  const getRowId = useCallback((row: IssueListItem) => row.id, []);

  const gridData = useDataSource<IssueListItem>({
    dataSource,
    columns,
    getRowId,
    sorting: gridState.sorting,
    quickSearch: "",
    pagination: gridState.pagination,
    paginationMode: "infinite",
  });

  useEffect(() => {
    const reconciled = reconcileIssueStatusOverrides(overridesRef.current, gridData.rows);
    if (reconciled !== overridesRef.current) setOverrides(reconciled);
  }, [gridData.rows]);

  useEffect(() => {
    setGridRows(gridData.rows);
  }, [gridData.rows]);

  const reload = useCallback(() => {
    setNowMs(Date.now());
    gridData.reload();
  }, [gridData]);

  const selectedIssueIds = useMemo(
    () => [...gridState.selection.selectedIds].filter((id): id is string => typeof id === "string"),
    [gridState.selection.selectedIds],
  );

  const clearIssueSelection = useCallback(() => {
    setGridState((current) => ({
      ...current,
      selection: { selectedIds: new Set(), anchorId: null },
    }));
  }, [setGridState]);

  const bulkBusy = bulkStatusBusy != null || mergeBusy;

  const changeBulkStatus = useCallback(async (status: IssueStatus) => {
    if (selectedIssueIds.length === 0 || bulkBusy) return;
    setBulkStatusError(null);
    setBulkStatusBusy(status);
    try {
      const response = await updateIssuesStatusBulk(adminApp, selectedIssueIds, status);
      const notFoundCount = response.results.filter((result) => result.error === "not_found").length;
      if (notFoundCount > 0) {
        setBulkStatusError(`${notFoundCount} selected issue${notFoundCount === 1 ? "" : "s"} no longer exists in this project. The remaining changes were applied.`);
      }
      clearIssueSelection();
      reload();
    } catch (error) {
      setBulkStatusError(getErrorMessage(error));
    } finally {
      setBulkStatusBusy(null);
    }
  }, [adminApp, bulkBusy, clearIssueSelection, reload, selectedIssueIds]);

  const confirmMerge = useCallback(async () => {
    if (selectedIssueIds.length < 2 || bulkBusy) return;
    setMergeError(null);
    setMergeBusy(true);
    try {
      await mergeIssues(adminApp, selectedIssueIds);
      setMergeDialogOpen(false);
      clearIssueSelection();
      reload();
    } catch (error) {
      setMergeError(getErrorMessage(error));
    } finally {
      setMergeBusy(false);
    }
  }, [adminApp, bulkBusy, clearIssueSelection, reload, selectedIssueIds]);

  const statusTabs = useMemo(() => [
    { id: "unresolved", label: "Unresolved", count: counts?.unresolved },
    { id: "resolved", label: "Resolved", count: counts?.resolved },
    { id: "ignored", label: "Ignored", count: counts?.ignored },
    {
      id: ALL_STATUSES_FILTER_VALUE,
      label: "All",
      count: counts == null ? undefined : counts.unresolved + counts.resolved + counts.ignored,
    },
  ], [counts]);

  const renderToolbar = useCallback((ctx: DataGridToolbarContext<IssueListItem>) => (
    <DataGridToolbar
      ctx={ctx}
      hideQuickSearch
      extraLeading={
        <DesignInput
          size="sm"
          leadingIcon={<MagnifyingGlassIcon />}
          value={filters.search}
          onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
          placeholder="Search type, message, culprit…"
          className="w-full sm:w-64"
          aria-label="Search issues"
        />
      }
      extra={
        <>
          <DesignSelectorDropdown
            value={serviceIdentityToSelectValue(filters.service)}
            onValueChange={(value) => setFilters((current) => ({
              ...current,
              service: selectValueToServiceIdentity(value),
            }))}
            options={[
              { value: ALL_SERVICES_SELECT_VALUE, label: "All services" },
              ...facetsState.facets.services.map((identity) => ({
                value: serviceIdentityToSelectValue(identity),
                label: serviceIdentityLabel(identity),
              })),
            ]}
            size="sm"
            disabled={facetsState.loading}
          />
          <DesignSelectorDropdown
            value={namespacedSelectValue(filters.environment, ENVIRONMENT_SELECT_VALUE_PREFIX)}
            onValueChange={(value) => setFilters((current) => ({
              ...current,
              environment: selectValueToNamespacedValue(value, ENVIRONMENT_SELECT_VALUE_PREFIX),
            }))}
            options={[
              { value: "all", label: "All environments" },
              ...facetsState.facets.environments.map((environment) => ({
                value: namespacedSelectValue(environment, ENVIRONMENT_SELECT_VALUE_PREFIX),
                label: environment,
              })),
            ]}
            size="sm"
            disabled={facetsState.loading}
          />
          <DesignSelectorDropdown
            value={filters.handled}
            onValueChange={(value) => {
              const handled = ISSUE_HANDLED_FILTERS.find((candidate) => candidate === value);
              if (handled == null) throw new Error(`Unknown handled filter: ${value}`);
              setFilters((current) => ({ ...current, handled }));
            }}
            options={ISSUE_HANDLED_FILTERS.map((value) => ({ value, label: handledFilterLabel(value) }))}
            size="sm"
          />
        </>
      }
      extraActions={
        <>
          {selectedIssueIds.length > 0 && (
            <div className="flex items-center gap-1.5">
              <Typography variant="secondary" className="px-1 text-xs">
                {selectedIssueIds.length} selected
              </Typography>
              {selectedIssueIds.length >= 2 && (
                <DesignButton
                  variant="secondary"
                  size="sm"
                  disabled={bulkBusy}
                  onClick={() => {
                    setMergeError(null);
                    setMergeDialogOpen(true);
                  }}
                  className="gap-1.5"
                >
                  <ArrowsMergeIcon className="h-3.5 w-3.5" />
                  Merge
                </DesignButton>
              )}
              <DesignButton
                variant="secondary"
                size="sm"
                loading={bulkStatusBusy === "resolved"}
                disabled={bulkBusy}
                onClick={() => changeBulkStatus("resolved")}
                className="gap-1.5"
              >
                <CheckCircleIcon className="h-3.5 w-3.5" />
                Resolve
              </DesignButton>
              <DesignButton
                variant="secondary"
                size="sm"
                loading={bulkStatusBusy === "ignored"}
                disabled={bulkBusy}
                onClick={() => changeBulkStatus("ignored")}
                className="gap-1.5"
              >
                <ProhibitIcon className="h-3.5 w-3.5" />
                Ignore
              </DesignButton>
              <DesignButton
                variant="ghost"
                size="sm"
                loading={bulkStatusBusy === "unresolved"}
                disabled={bulkBusy}
                onClick={() => changeBulkStatus("unresolved")}
                className="gap-1.5"
              >
                <ArrowCounterClockwiseIcon className="h-3.5 w-3.5" />
                Reopen
              </DesignButton>
            </div>
          )}
          <DesignButton
            variant="ghost"
            size="sm"
            loading={gridData.isRefetching}
            onClick={reload}
            className="gap-1.5"
          >
            <ArrowClockwiseIcon className="h-3.5 w-3.5" />
            Refresh
          </DesignButton>
        </>
      }
    />
  ), [bulkBusy, bulkStatusBusy, changeBulkStatus, facetsState.facets, facetsState.loading, filters.environment, filters.handled, filters.search, filters.service, gridData.isRefetching, reload, selectedIssueIds.length]);

  const filtersActive = !issueFiltersAreDefault(filters);

  return (
    <AppEnabledGuard appId="observability">
      <ObservabilityPageLayout
        title="Issues"
        actions={(
          <ObservabilityToolbar
            filters={(
              <IssueSavedViews
                adminApp={adminApp}
                filters={filters}
                onApply={setFilters}
              />
            )}
            range={(
              <ObservabilityTimeRangeToggle
                hours={filters.hours}
                onChange={(hours) => setFilters((current) => ({ ...current, hours }))}
              />
            )}
            actions={(
              <DesignButton
                variant="secondary"
                size="sm"
                className="shrink-0 gap-1.5"
                onClick={() => setAlertRulesDialogOpen(true)}
              >
                <BellRingingIcon className="h-3.5 w-3.5" />
                Alert rules
              </DesignButton>
            )}
          />
        )}
      >
        <TooltipProvider>
          <div className="flex min-w-0 flex-col gap-[var(--page-content-gap)]">
            <div className="shrink-0">
              <DesignCategoryTabs
                categories={statusTabs}
                selectedCategory={filters.status}
                onSelect={(id) => setFilters((current) => ({ ...current, status: parseIssueStatusFilter(id) }))}
                size="sm"
                glassmorphic={false}
              />
            </div>

            {statusError != null && (
              <div className="shrink-0">
                <DesignAlert
                  variant="error"
                  title="Couldn't update that issue"
                  description={statusError}
                />
              </div>
            )}

            {bulkStatusError != null && (
              <div className="shrink-0">
                <DesignAlert
                  variant="error"
                  title="Couldn't update all selected issues"
                  description={bulkStatusError}
                />
              </div>
            )}

            {gridData.error != null && (
              <div className="shrink-0">
                <ObservabilityErrorState
                  title="Couldn't load issues"
                  description={gridData.error.message}
                  onRetry={reload}
                />
              </div>
            )}

            {facetsState.error != null && (
              <div className="shrink-0">
                <DesignAlert
                  variant="warning"
                  title="Filter options couldn't be loaded"
                  description="The service and environment dropdowns are empty. The issue list itself is unaffected."
                />
              </div>
            )}

            {sparklines.error != null && (
              <div className="shrink-0">
                <DesignAlert variant="warning" title="Occurrence graphs couldn't be loaded" description={sparklines.error.message}>
                  <DesignButton variant="secondary" size="sm" className="mt-3" onClick={sparklines.retry}>
                    Retry graphs
                  </DesignButton>
                </DesignAlert>
              </div>
            )}

            {approximate && (
              <div className="shrink-0">
                <DesignAlert
                  variant="info"
                  title="Ranking is approximate"
                  description="There are more matching issues than can be ranked by window activity at once, so this ordering covers a capped candidate set. Narrow the filters for an exact ranking."
                />
              </div>
            )}

            <div className="shrink-0">
              <IssueEventSearch adminApp={adminApp} projectId={projectId} filters={filters} />
            </div>

            <div className="flex min-w-0 flex-col">
              <DataGrid<IssueListItem>
                columns={columns}
                rows={gridData.rows}
                getRowId={getRowId}
                isLoading={gridData.isLoading}
                isRefetching={gridData.isRefetching}
                isLoadingMore={gridData.isLoadingMore}
                hasMore={gridData.hasMore}
                onLoadMore={gridData.loadMore}
                state={gridState}
                onChange={handleGridStateChange}
                paginationMode="infinite"
                selectionMode="multiple"
                rowHeight={56}
                fillHeight={false}
                horizontalScrollbarPosition="top"
                toolbar={renderToolbar}
                footer={false}
                exportFilename="issues-export"
                onRowClick={(row) => router.push(issueDetailHref(projectId, row.id, { rangeHours: filters.hours }))}
                emptyState={<IssuesEmptyState filtered={filtersActive} />}
              />
            </div>
          </div>
          <DesignDialog
            open={mergeDialogOpen}
            onOpenChange={(nextOpen) => {
              if (mergeBusy) return;
              setMergeDialogOpen(nextOpen);
              if (!nextOpen) setMergeError(null);
            }}
            size="sm"
            variant="plain"
            icon={ArrowsMergeIcon}
            title={`Merge ${selectedIssueIds.length} issues?`}
            description="They become one issue. The oldest (earliest first seen) survives; the others keep working as links to it. A merge does not change status."
            footer={(
              <div className="flex w-full justify-end gap-2">
                <DesignButton
                  variant="secondary"
                  disabled={mergeBusy}
                  onClick={() => setMergeDialogOpen(false)}
                >
                  Cancel
                </DesignButton>
                <DesignButton
                  variant="default"
                  loading={mergeBusy}
                  disabled={mergeBusy || selectedIssueIds.length < 2}
                  onClick={confirmMerge}
                >
                  Merge
                </DesignButton>
              </div>
            )}
          >
            {mergeError != null && (
              <DesignAlert variant="error" title="Couldn't merge issues" description={mergeError} />
            )}
          </DesignDialog>
          {alertRulesDialogOpen && (
            <Suspense
              fallback={(
                <DesignDialog
                  open
                  onOpenChange={setAlertRulesDialogOpen}
                  size="7xl"
                  icon={BellRingingIcon}
                  title="Alert rules"
                  description="Loading alert rules…"
                />
              )}
            >
              <IssueAlertsDialog
                open={alertRulesDialogOpen}
                onOpenChange={setAlertRulesDialogOpen}
              />
            </Suspense>
          )}
        </TooltipProvider>
      </ObservabilityPageLayout>
    </AppEnabledGuard>
  );
}

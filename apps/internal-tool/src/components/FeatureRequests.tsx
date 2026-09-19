"use client";

import {
  createDefaultDataGridState,
  DataGrid,
  type DataGridColumnDef,
  type DataGridState,
  isDataGridInteractiveRowClickTarget,
  useDataSource,
} from "@hexclave/dashboard-ui-components";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useMemo, useState } from "react";
import { useFilteredLogPages } from "../hooks/useFilteredLogPages";
import type { McpReviewTableFilters, PageCursor } from "../hooks/useSpacetimeDB";
import { featureRequestFromFlagsJson } from "../lib/feature-request-flag";
import { hasMcpContextValue } from "../lib/mcp-context";
import { formatPacificTableTime, formatPacificTimestamp } from "../lib/pacific-time";
import type { McpCallLogRow } from "../types";
import { toDate } from "../utils";
import { InternalDataGridFooter } from "./InternalDataGridFooter";
import { Alert, Badge, Button, EmptyState } from "./design";

const featureRequestFilters: McpReviewTableFilters = {
  createdAtOrAfterMicros: undefined,
  toolName: undefined,
  hasError: undefined,
  qaState: "feature-request",
  humanReviewState: undefined,
};

function getRowId(row: McpCallLogRow): string {
  return String(row.id);
}

function createInitialState(columns: readonly DataGridColumnDef<McpCallLogRow>[]): DataGridState {
  const initial = createDefaultDataGridState(columns);
  return {
    ...initial,
    sorting: [],
    pagination: { pageIndex: 0, pageSize: 25 },
  };
}

export function FeatureRequests({
  connectionState,
  connectionErrorMessage,
  queryFilteredPage,
  onOpenConversation,
}: {
  connectionState: string,
  connectionErrorMessage: string | null,
  queryFilteredPage: (filters: McpReviewTableFilters, cursor: PageCursor | null, limit: number) => Promise<{
    rows: McpCallLogRow[],
    nextBeforeCreatedAtMicros: bigint | undefined,
    nextBeforeId: bigint | undefined,
  }>,
  onOpenConversation: (row: McpCallLogRow) => void,
}) {
  const columns = useMemo<readonly DataGridColumnDef<McpCallLogRow>[]>(() => [
    {
      id: "time",
      header: "Time",
      accessor: row => toDate(row.createdAt).getTime(),
      width: 172,
      minWidth: 156,
      sortable: false,
      renderCell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground" title={formatPacificTimestamp(toDate(row.createdAt))}>
          {formatPacificTableTime(toDate(row.createdAt))}
        </span>
      ),
      formatValue: value => formatPacificTimestamp(new Date(Number(value))),
    },
    {
      id: "featureRequest",
      header: "Feature request",
      accessor: row => featureRequestFromFlagsJson(row.qaFlagsJson)?.summary ?? row.question,
      width: 330,
      minWidth: 240,
      flex: 1,
      cellOverflow: "wrap",
      sortable: false,
      renderCell: ({ row }) => {
        const flag = featureRequestFromFlagsJson(row.qaFlagsJson);
        return (
          <div className="min-w-0 py-1">
            <p className="line-clamp-1 font-medium text-foreground">{flag?.summary ?? row.question}</p>
            {flag != null && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{flag.explanation}</p>}
          </div>
        );
      },
    },
    {
      id: "question",
      header: "User request",
      accessor: row => row.question,
      width: 340,
      minWidth: 220,
      flex: 1,
      cellOverflow: "wrap",
      sortable: false,
      renderCell: ({ row }) => <span className="line-clamp-2 whitespace-normal leading-5">{row.question}</span>,
    },
    {
      id: "user",
      header: "User",
      accessor: row => row.user,
      width: 180,
      minWidth: 132,
      sortable: false,
      renderCell: ({ row }) => hasMcpContextValue(row.user)
        ? <span className="line-clamp-2 whitespace-normal text-xs leading-4">{row.user}</span>
        : <span className="text-muted-foreground">Unknown</span>,
    },
    {
      id: "source",
      header: "Source",
      accessor: row => row.toolName,
      width: 280,
      minWidth: 220,
      sortable: false,
      renderCell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Badge color="purple" mono>{row.toolName}</Badge>
          <Button size="xs" onClick={() => onOpenConversation(row)}>
            Open conversation
          </Button>
        </div>
      ),
    },
  ], [onOpenConversation]);
  const [state, setState] = useState<DataGridState>(() => createInitialState(columns));
  // Reconnecting is the only thing that re-runs this query on its own. The
  // list is a snapshot — a QA review that flags a new request while this tab
  // is open does not stream in — so the header offers an explicit refresh
  // (and the error banner's "Retry query") through pages.refresh instead.
  const queryKey = connectionState;
  const pages = useFilteredLogPages({
    enabled: connectionState === "connected",
    queryKey,
    filters: featureRequestFilters,
    fetchPage: queryFilteredPage,
    getRowId,
  });
  const data = useDataSource({
    data: pages.rows,
    columns,
    getRowId,
    sorting: state.sorting,
    quickSearch: state.quickSearch,
    pagination: state.pagination,
    paginationMode: "client",
  });

  if (connectionState === "connecting") {
    return <div className="p-4 text-sm text-muted-foreground">Connecting to SpacetimeDB...</div>;
  }
  if (connectionState === "error") {
    return <Alert>{connectionErrorMessage ?? "Failed to connect to SpacetimeDB."}</Alert>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/[0.06] bg-card px-4 py-3 shadow-sm ring-1 ring-black/[0.04] dark:border-white/[0.06] dark:ring-white/[0.04]">
        <div>
          <p className="text-sm font-medium text-foreground">AI-scanned capability gaps</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Snapshot results from completed MCP QA reviews.</p>
        </div>
        <Button onClick={() => runAsynchronously(pages.refresh)} disabled={pages.isLoading || connectionState !== "connected"}>
          Refresh results
        </Button>
      </div>

      {pages.error != null && (
        <Alert>
          <div className="flex items-center justify-between gap-3">
            <span>{pages.error}</span>
            <Button onClick={() => runAsynchronously(pages.refresh)}>Retry query</Button>
          </div>
        </Alert>
      )}

      {pages.error == null && pages.rows.length === 0 && !pages.isLoading ? (
        <div className="rounded-xl border border-black/[0.06] bg-card dark:border-white/[0.06]">
          <EmptyState className="py-14">
            <p className="font-medium text-foreground">No feature requests detected</p>
            <p className="mt-1">Requests appear here after MCP QA verifies an unsupported capability.</p>
          </EmptyState>
        </div>
      ) : pages.rows.length > 0 || pages.isLoading ? (
        <DataGrid
          columns={columns}
          rows={data.rows}
          getRowId={getRowId}
          totalRowCount={data.totalRowCount}
          isLoading={pages.isLoading || data.isLoading}
          state={state}
          onChange={setState}
          onRowClick={(row, _rowId, event) => {
            if (!isDataGridInteractiveRowClickTarget(event.target)) onOpenConversation(row);
          }}
          selectionMode="none"
          toolbar={false}
          className="internal-data-grid"
          footer={context => (
            <InternalDataGridFooter
              context={context}
              onChange={setState}
              historyPaging={{
                hasMoreHistory: pages.hasMore,
                isLoadingOlder: pages.isLoadingMore,
                onLoadOlder: pages.loadMore,
              }}
            />
          )}
          fillHeight={false}
          maxHeight={680}
          rowHeight={60}
          headerHeight={36}
          horizontalScrollbarPosition="top"
        />
      ) : null}
    </div>
  );
}

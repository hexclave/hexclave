"use client";

import {
  createDefaultDataGridState,
  DataGrid,
  type DataGridColumnDef,
  type DataGridState,
  isDataGridInteractiveRowClickTarget,
  useDataSource,
} from "@hexclave/dashboard-ui-components";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { format, formatDistanceToNow } from "date-fns";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { McpCallLogRow } from "../types";
import { QA_REVIEW_FAILED_THRESHOLD_MS, qaReviewStartedAt, toDate } from "../utils";
import { reviewVisible } from "../lib/mcp-review-api";
import type { HistoryPagingProps } from "./LoadOlderButton";
import { InternalDataGridFooter } from "./InternalDataGridFooter";
import { Badge, Button, SelectionToolbar } from "./design";
import { hasMcpContextValue } from "../lib/mcp-context";
import { formatPacificTableTime, formatPacificTimestamp } from "../lib/pacific-time";

const MAX_REVIEW_BATCH = 50;
const defaultVisibleColumnIds = new Set(["time", "question", "user", "qa", "duration", "reviewed"]);

function isQaReviewFailed(row: McpCallLogRow): boolean {
  if (row.qaOverallScore != null || row.qaErrorMessage) return false;
  return Date.now() - qaReviewStartedAt(row).getTime() > QA_REVIEW_FAILED_THRESHOLD_MS;
}

function isAiReviewRetryable(row: McpCallLogRow): boolean {
  const hasQaError = row.qaErrorMessage != null && row.qaErrorMessage !== "";
  return row.qaReviewedAt == null && (hasQaError || isQaReviewFailed(row));
}

const columns: readonly DataGridColumnDef<McpCallLogRow>[] = [
  {
    id: "time",
    header: "Time",
    accessor: row => Number(row.id),
    width: 172,
    minWidth: 156,
    sortable: false,
    renderCell: ({ row }) => (
      <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground" title={formatPacificTimestamp(toDate(row.createdAt))}>
        {formatPacificTableTime(toDate(row.createdAt))}
      </span>
    ),
  },
  {
    id: "tool",
    header: "Tool",
    accessor: row => row.toolName,
    width: 150,
    minWidth: 120,
    sortable: false,
    renderCell: ({ row }) => <Badge color="purple" mono>{row.toolName}</Badge>,
  },
  {
    id: "reason",
    header: "Reason",
    accessor: row => row.reason,
    width: 260,
    minWidth: 160,
    flex: 1,
    sortable: false,
  },
  {
    id: "question",
    header: "Question",
    accessor: row => row.question,
    width: 320,
    minWidth: 180,
    flex: 1,
    sortable: false,
  },
  {
    id: "steps",
    header: "Steps",
    accessor: row => row.stepCount,
    width: 72,
    minWidth: 64,
    align: "right",
    type: "number",
    sortable: false,
  },
  {
    id: "duration",
    header: "Duration",
    accessor: row => Number(row.durationMs),
    width: 104,
    minWidth: 92,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => <span className="font-mono tabular-nums">{Number(row.durationMs).toLocaleString()}ms</span>,
    formatValue: value => `${Number(value).toLocaleString()}ms`,
  },
  {
    id: "qa",
    header: "QA",
    accessor: row => row.qaOverallScore ?? -1,
    width: 112,
    minWidth: 96,
    sortable: false,
    renderCell: ({ row }) => {
      if (row.qaErrorMessage) return <Badge color="red">err</Badge>;
      if (row.qaOverallScore != null) {
        return (
          <Badge color={row.qaOverallScore >= 80 ? "green" : row.qaOverallScore >= 50 ? "orange" : "red"}>
            {row.qaOverallScore}{row.qaNeedsHumanReview && row.humanReviewedAt == null ? " !" : ""}
          </Badge>
        );
      }
      if (isQaReviewFailed(row)) return <Badge color="orange">review failed</Badge>;
      return <span className="text-muted-foreground" title="Review in progress">…</span>;
    },
  },
  {
    id: "reviewed",
    header: "Human reviewed",
    accessor: row => row.humanReviewedAt == null ? 0 : toDate(row.humanReviewedAt).getTime(),
    width: 156,
    minWidth: 132,
    sortable: false,
    renderCell: ({ row }) => row.humanReviewedAt == null ? (
      <span className="text-muted-foreground/60">--</span>
    ) : (
      <Badge
        color="green"
        title={`Reviewed ${format(toDate(row.humanReviewedAt), "PPpp")}${row.humanReviewedBy ? ` by ${row.humanReviewedBy}` : ""}`}
      >
        &#10003; {formatDistanceToNow(toDate(row.humanReviewedAt), { addSuffix: true })}
      </Badge>
    ),
  },
  {
    id: "user",
    header: "User",
    accessor: row => row.user,
    width: 180,
    minWidth: 132,
    sortable: false,
    renderCell: ({ row }) => !hasMcpContextValue(row.user)
      ? <span className="text-muted-foreground">Unknown</span>
      : <span className="line-clamp-2 whitespace-normal text-xs leading-4">{row.user}</span>,
  },
  {
    id: "status",
    header: "Status",
    accessor: row => row.errorMessage == null || row.errorMessage === "" ? 0 : 1,
    width: 88,
    minWidth: 76,
    sortable: false,
    renderCell: ({ row }) => {
      const isError = row.errorMessage != null && row.errorMessage !== "";
      return <Badge color={isError ? "red" : "green"}>{isError ? "error" : "ok"}</Badge>;
    },
  },
];

function createInitialState(): DataGridState {
  const initial = createDefaultDataGridState(columns);
  const columnVisibility: Record<string, boolean> = {};
  for (const column of columns) columnVisibility[column.id] = defaultVisibleColumnIds.has(column.id);
  return {
    ...initial,
    sorting: [],
    columnVisibility,
    columnOrder: ["time", "question", "user", "qa", "duration", "reviewed", "tool", "reason", "steps", "status"],
    pagination: { ...initial.pagination, pageSize: 25 },
  };
}

function getRowId(row: McpCallLogRow): string {
  return String(row.id);
}

export function McpCallDataGrid({
  rows,
  onSelect,
  resetKey,
  hasMoreHistory,
  isLoadingOlder,
  onLoadOlder,
  isLoading = false,
}: {
  rows: readonly McpCallLogRow[],
  onSelect: (row: McpCallLogRow) => void,
  resetKey: string,
  isLoading?: boolean,
} & HistoryPagingProps) {
  const [state, setState] = useState<DataGridState>(createInitialState);
  const [reviewing, setReviewing] = useState(false);
  const [justQueued, setJustQueued] = useState(false);
  const selectedRows = useMemo(
    () => rows.filter(row => state.selection.selectedIds.has(getRowId(row))),
    [rows, state.selection.selectedIds],
  );
  const retryableSelectedRows = selectedRows.filter(isAiReviewRetryable).slice(0, MAX_REVIEW_BATCH);
  const gridData = useDataSource({
    data: rows,
    columns,
    getRowId,
    sorting: state.sorting,
    quickSearch: state.quickSearch,
    pagination: state.pagination,
    paginationMode: "client",
  });

  useEffect(() => {
    setState(current => ({
      ...current,
      pagination: { ...current.pagination, pageIndex: 0 },
      selection: { selectedIds: new Set(), anchorId: null },
    }));
  }, [resetKey]);

  const clearSelection = useCallback(() => {
    setState(current => ({
      ...current,
      selection: { selectedIds: new Set(), anchorId: null },
    }));
  }, []);

  const handleReviewSelected = async () => {
    if (retryableSelectedRows.length === 0 || reviewing) return;
    setReviewing(true);
    try {
      await reviewVisible(retryableSelectedRows.map(row => ({
        correlationId: row.correlationId,
        question: row.question,
        reason: row.reason,
        response: row.response,
      })));
      setJustQueued(true);
      setTimeout(() => setJustQueued(false), 3000);
    } catch (error) {
      captureError("internal-tool-review-selected", error);
    } finally {
      setReviewing(false);
    }
  };

  return (
    <div>
      <SelectionToolbar count={selectedRows.length} onClear={clearSelection}>
        <Button
          size="sm"
          onClick={() => runAsynchronously(handleReviewSelected)}
          disabled={retryableSelectedRows.length === 0 || reviewing}
          title={selectedRows.length > MAX_REVIEW_BATCH ? `Reviews the first ${MAX_REVIEW_BATCH} eligible selected rows` : "Run automated QA for eligible selected rows"}
        >
          {reviewing
            ? "Retrying AI review…"
            : justQueued
              ? "AI review queued ✓"
              : retryableSelectedRows.length === 0
                ? "No failed reviews selected"
                : `Retry AI review for ${retryableSelectedRows.length} failed ${retryableSelectedRows.length === 1 ? "call" : "calls"}`}
        </Button>
      </SelectionToolbar>
      <DataGrid
        columns={columns}
        rows={gridData.rows}
        getRowId={getRowId}
        totalRowCount={gridData.totalRowCount}
        isLoading={isLoading || gridData.isLoading}
        state={state}
        onChange={setState}
        onRowClick={(row, _rowId, event) => {
          if (!isDataGridInteractiveRowClickTarget(event.target)) onSelect(row);
        }}
        selectionMode="multiple"
        toolbar={false}
        className="internal-data-grid"
        footer={context => (
          <InternalDataGridFooter
            context={context}
            onChange={setState}
            historyPaging={{ hasMoreHistory, isLoadingOlder, onLoadOlder }}
          />
        )}
        fillHeight={false}
        maxHeight={620}
        rowHeight={44}
        headerHeight={36}
        horizontalScrollbarPosition="top"
        exportFilename="mcp-call-review"
      />
    </div>
  );
}

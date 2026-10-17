"use client";

import {
  createDefaultDataGridState,
  DataGrid,
  type DataGridColumnDef,
  type DataGridState,
  isDataGridInteractiveRowClickTarget,
  useDataSource,
} from "@hexclave/dashboard-ui-components";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AiQueryLogRow } from "../types";
import { toDate } from "../utils";
import type { HistoryPagingProps } from "./LoadOlderButton";
import { InternalDataGridFooter } from "./InternalDataGridFooter";
import { Badge, SelectionToolbar } from "./design";
import { formatSignedUsd, formatUsd } from "../lib/format-usd";
import { formatPacificTableTime, formatPacificTimestamp } from "../lib/pacific-time";

function columnHeader(label: string, title: string): () => ReactNode {
  return () => <span title={title}>{label}</span>;
}

/**
 * Nullable numeric columns use a sentinel in `accessor` so the grid can sort them, and `formatValue`
 * turns the sentinel back into the same placeholder `renderCell` shows — otherwise a CSV export
 * would contain `-1` or `-Infinity` where the grid shows "—".
 */
const MISSING_PLACEHOLDER = "—";

function formatOptionalCount(value: unknown): string {
  return Number(value) < 0 ? MISSING_PLACEHOLDER : Number(value).toLocaleString();
}

function formatOptionalUsd(value: unknown): string {
  return Number.isFinite(Number(value)) ? formatUsd(Number(value)) : MISSING_PLACEHOLDER;
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(messageContentToText).join("");
  if (content != null && typeof content === "object" && "text" in content) {
    return messageContentToText(content.text);
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

export function getInputMessagePreview(messagesJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(messagesJson);
  } catch (error) {
    if (error instanceof SyntaxError) return "";
    throw error;
  }
  if (!Array.isArray(parsed)) return "";

  // The latest user turn is the request this row answers; earlier turns remain available in details.
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const message = parsed[index];
    if (message == null || typeof message !== "object" || !("role" in message) || message.role !== "user" || !("content" in message)) continue;
    const text = messageContentToText(message.content).trim();
    if (text !== "") return text;
  }
  return "";
}

const defaultVisibleColumnIds = new Set(["createdAt", "inputMessage", "systemPromptId", "inputTokens", "outputTokens", "cachedInputTokens"]);

function createInitialState(): DataGridState {
  const initial = createDefaultDataGridState(columns);
  const columnVisibility: Record<string, boolean> = {};
  for (const column of columns) columnVisibility[column.id] = defaultVisibleColumnIds.has(column.id);
  return {
    ...initial,
    sorting: [],
    columnVisibility,
    pagination: { ...initial.pagination, pageSize: 25 },
  };
}

const columns: readonly DataGridColumnDef<AiQueryLogRow>[] = [
  {
    id: "createdAt",
    header: columnHeader("Time", "When the request was logged."),
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
    id: "inputMessage",
    header: columnHeader("Input message", "The latest user-authored message sent with the request."),
    accessor: row => getInputMessagePreview(row.messagesJson),
    width: 320,
    minWidth: 220,
    flex: 1,
    cellOverflow: "wrap",
    sortable: false,
    renderCell: ({ row }) => {
      const message = getInputMessagePreview(row.messagesJson);
      return message === ""
        ? <span className="text-muted-foreground">No input message</span>
        : <span className="line-clamp-2 whitespace-normal break-words leading-5">{message}</span>;
    },
  },
  {
    id: "systemPromptId",
    header: columnHeader("System Prompt", "The application flow that triggered the AI request."),
    accessor: row => row.systemPromptId,
    width: 220,
    minWidth: 170,
    sortable: false,
    renderCell: ({ row }) => (
      <span className="flex items-center gap-1">
        <Badge color="purple" mono>{row.systemPromptId}</Badge>
        {row.conversationId != null && <Badge color="orange" size="xs">MCP</Badge>}
        {!row.isAuthenticated && <Badge size="xs">anon</Badge>}
      </span>
    ),
  },
  {
    id: "modelId",
    header: columnHeader("Model", "The model that processed the request."),
    accessor: row => row.modelId,
    width: 220,
    minWidth: 160,
    sortable: false,
    renderCell: ({ row }) => <span className="font-mono">{row.modelId}</span>,
  },
  { id: "mode", header: columnHeader("Mode", "Stream returns tokens as generated; generate returns one response after completion."), accessor: row => row.mode, width: 92, minWidth: 80, sortable: false },
  {
    id: "inputTokens",
    header: columnHeader("In tok", "Total prompt tokens sent to the model."),
    accessor: row => row.inputTokens ?? -1,
    width: 96,
    minWidth: 82,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => <span className="font-mono tabular-nums">{row.inputTokens == null ? MISSING_PLACEHOLDER : row.inputTokens.toLocaleString()}</span>,
    formatValue: formatOptionalCount,
  },
  {
    id: "outputTokens",
    header: columnHeader("Out tok", "Tokens generated in the response."),
    accessor: row => row.outputTokens ?? -1,
    width: 96,
    minWidth: 82,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => <span className="font-mono tabular-nums">{row.outputTokens == null ? MISSING_PLACEHOLDER : row.outputTokens.toLocaleString()}</span>,
    formatValue: formatOptionalCount,
  },
  {
    id: "cachedInputTokens",
    header: columnHeader("Cache Read", "Prompt tokens read from the provider cache."),
    accessor: row => row.cachedInputTokens ?? -1,
    width: 112,
    minWidth: 96,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => row.cachedInputTokens != null && row.cachedInputTokens > 0
      ? <span className="font-mono text-emerald-600 dark:text-emerald-400">{row.cachedInputTokens.toLocaleString()}</span>
      : <span className="text-muted-foreground">{MISSING_PLACEHOLDER}</span>,
    formatValue: formatOptionalCount,
  },
  {
    id: "cacheCreationTokens",
    header: columnHeader("Cache W", "Prompt tokens written to cache on this request."),
    accessor: row => row.cacheCreationTokens ?? -1,
    width: 104,
    minWidth: 88,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => row.cacheCreationTokens != null && row.cacheCreationTokens > 0
      ? <span className="font-mono text-orange-600 dark:text-orange-400">{row.cacheCreationTokens.toLocaleString()}</span>
      : <span className="text-muted-foreground">{MISSING_PLACEHOLDER}</span>,
    formatValue: formatOptionalCount,
  },
  {
    id: "cacheSavingsUsd",
    header: columnHeader("Cache $", "Dollar savings attributed to caching on this request."),
    accessor: row => row.cacheDiscountUsd ?? Number.NEGATIVE_INFINITY,
    width: 104,
    minWidth: 88,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => {
      const savings = row.cacheDiscountUsd;
      if (savings == null) return <span className="text-muted-foreground">{MISSING_PLACEHOLDER}</span>;
      const color = savings >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
      return <span className={`font-mono ${color}`}>{formatSignedUsd(savings)}</span>;
    },
    formatValue: value => Number.isFinite(Number(value)) ? formatSignedUsd(Number(value)) : MISSING_PLACEHOLDER,
  },
  {
    id: "costUsd",
    header: columnHeader("Cost", "Total provider-reported cost for this request."),
    accessor: row => row.costUsd ?? Number.NEGATIVE_INFINITY,
    width: 96,
    minWidth: 82,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => <span className="font-mono">{row.costUsd == null ? MISSING_PLACEHOLDER : formatUsd(row.costUsd)}</span>,
    formatValue: formatOptionalUsd,
  },
  {
    id: "durationMs",
    header: columnHeader("Duration", "Wall-clock request duration in milliseconds."),
    accessor: row => Number(row.durationMs),
    width: 112,
    minWidth: 96,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => <span className="font-mono tabular-nums">{Number(row.durationMs).toLocaleString()}ms</span>,
    formatValue: value => `${Number(value).toLocaleString()}ms`,
  },
  {
    id: "status",
    header: columnHeader("Status", "Whether the request completed successfully or recorded an error."),
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

function getRowId(row: AiQueryLogRow): string {
  return String(row.id);
}

export function UsageDataGrid({
  rows,
  onSelect,
  resetKey,
  hasMoreHistory,
  isLoadingOlder,
  onLoadOlder,
  isLoading = false,
}: {
  rows: readonly AiQueryLogRow[],
  onSelect: (row: AiQueryLogRow) => void,
  resetKey: string,
  isLoading?: boolean,
} & HistoryPagingProps) {
  const [state, setState] = useState<DataGridState>(createInitialState);
  const selectedRows = useMemo(
    () => rows.filter(row => state.selection.selectedIds.has(getRowId(row))),
    [rows, state.selection.selectedIds],
  );
  const gridData = useDataSource({
    data: rows,
    columns,
    getRowId,
    sorting: state.sorting,
    quickSearch: state.quickSearch,
    pagination: state.pagination,
    paginationMode: "client",
  });
  const clearSelection = useCallback(() => {
    setState(current => ({
      ...current,
      selection: { selectedIds: new Set(), anchorId: null },
    }));
  }, []);

  useEffect(() => {
    setState(current => ({
      ...current,
      pagination: { ...current.pagination, pageIndex: 0 },
      selection: { selectedIds: new Set(), anchorId: null },
    }));
  }, [resetKey]);

  return (
    <div>
      <SelectionToolbar count={selectedRows.length} onClear={clearSelection}>
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
        rowHeight={64}
        headerHeight={36}
        horizontalScrollbarPosition="top"
        exportFilename="unified-ai-usage"
      />
    </div>
  );
}

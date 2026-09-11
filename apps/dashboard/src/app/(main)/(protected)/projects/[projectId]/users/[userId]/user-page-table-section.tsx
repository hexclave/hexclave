"use client";

import { createDefaultDataGridState, DataGrid, type DataGridColumnDef, type DataGridSortModel, type DataGridState, useDataGridUrlState, useDataSource } from "@hexclave/dashboard-ui-components";
import { useMemo, useState, type ReactNode } from "react";

type UserPageTableSectionProps<TRow> = {
  title: string,
  actions?: ReactNode,
  columns: readonly DataGridColumnDef<TRow>[],
  rows: readonly TRow[],
  getRowId: (row: TRow) => string,
  emptyLabel: string,
  onRowClick?: (row: TRow, rowId: string, event: React.MouseEvent) => void,
  /** Highlights a row (no checkboxes) — used by the transaction inspector. */
  highlightedRowId?: string | null,
  hasMore?: boolean,
  isLoadingMore?: boolean,
  onLoadMore?: () => void,
  onSortChange?: (model: DataGridSortModel) => void,
  paginated?: boolean,
  /** True until the first request settles. When true and rows is empty, show a loading state instead of "empty". */
  isInitialLoading?: boolean,
  /** Non-null when the latest fetch failed. Rendered in place of empty/loading state. */
  error?: ReactNode | null,
  urlStateKey?: string,
};

function withHighlightedRow(state: DataGridState, rowId: string | null | undefined): DataGridState {
  if (rowId == null) {
    return state;
  }
  if (state.selection.selectedIds.size === 1 && state.selection.selectedIds.has(rowId)) {
    return state;
  }
  return {
    ...state,
    selection: { selectedIds: new Set([rowId]), anchorId: rowId },
  };
}

function useGridState<TRow>(columns: readonly DataGridColumnDef<TRow>[], urlStateKey?: string) {
  // Always call both hooks for rules-of-hooks; return whichever the caller opted into.
  const urlBacked = useDataGridUrlState(columns, urlStateKey ? { paramPrefix: urlStateKey } : undefined);
  const localBacked = useState(() => createDefaultDataGridState(columns));
  return urlStateKey ? urlBacked : localBacked;
}

export function UserPageTableSection<TRow,>({
  title,
  actions,
  columns,
  rows,
  getRowId,
  emptyLabel,
  onRowClick,
  highlightedRowId,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onSortChange,
  paginated,
  isInitialLoading,
  error,
  urlStateKey,
}: UserPageTableSectionProps<TRow>) {
  const [gridState, setGridState] = useGridState(columns, urlStateKey);
  const gridData = useDataSource({
    data: paginated ? rows : [],
    columns,
    getRowId,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    paginationMode: "client",
  });

  const visibleColumns = columns.filter((column) => gridState.columnVisibility[column.id] !== false);
  const displayState = useMemo(
    () => withHighlightedRow(gridState, highlightedRowId),
    [gridState, highlightedRowId],
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {actions}
      </div>
      {rows.length === 0 ? (
        <div
          className="w-full min-w-0 overflow-hidden rounded-[calc(var(--radius)*2)] bg-transparent"
          role="grid"
          aria-rowcount={0}
          aria-colcount={visibleColumns.length}
        >
          <div className="flex border-b border-foreground/[0.06]" role="row">
            {visibleColumns.map((column) => (
              <div
                key={column.id}
                className="flex h-11 items-center border-r border-foreground/[0.04] px-3 last:border-r-0"
                style={{
                  width: column.width,
                  minWidth: column.minWidth,
                  maxWidth: column.maxWidth,
                  flex: column.flex,
                  justifyContent: column.align === "right" ? "flex-end" : column.align === "center" ? "center" : "flex-start",
                }}
                role="columnheader"
              >
                <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {typeof column.header === "string" ? column.header : column.id}
                </span>
              </div>
            ))}
          </div>
          <div className="flex min-h-16 items-center justify-center py-4 text-sm font-medium text-muted-foreground">
            {error
              ? error
              : isInitialLoading
                ? "Loading…"
                : emptyLabel}
          </div>
        </div>
      ) : (
        <DataGrid
          columns={columns}
          rows={paginated ? gridData.rows : rows}
          getRowId={getRowId}
          onRowClick={onRowClick}
          state={displayState}
          onChange={setGridState}
          onSortChange={onSortChange}
          toolbar={false}
          footer={paginated ? undefined : false}
          fillHeight={false}
          rowHeight="auto"
          estimatedRowHeight={44}
          paginationMode={paginated ? "paginated" : (onLoadMore ? "infinite" : undefined)}
          totalRowCount={paginated ? gridData.totalRowCount : undefined}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadMore={onLoadMore}
          emptyState={
            <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-8">
              <div className="text-sm font-medium text-muted-foreground">{emptyLabel}</div>
            </div>
          }
        />
      )}
    </section>
  );
}

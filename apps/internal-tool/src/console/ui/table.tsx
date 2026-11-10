"use client";

import {
  createDefaultDataGridState,
  DataGrid,
  type DataGridColumnDef,
  DataGridToolbar,
  type DataGridState,
  isDataGridInteractiveRowClickTarget,
  useDataSource,
} from "@hexclave/dashboard-ui-components";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { HistoryLoadOptions } from "../../lib/load-history";
import { Button, Select } from "./primitives";

export type HistoryPaging = {
  hasMoreHistory: boolean,
  isLoadingOlder: boolean,
  onLoadOlder: (options?: HistoryLoadOptions) => Promise<void>,
};

const PAGE_SIZES = [25, 50, 100, 250] as const;

function parsePageSize(value: string): number {
  const parsed = PAGE_SIZES.find(size => String(size) === value);
  if (parsed == null) throw new Error(`Unexpected page size: ${value}`);
  return parsed;
}

/**
 * Grid state for a console table: default column visibility/order, 25 rows per page, and a reset
 * of page + selection whenever `resetKey` changes (a new filter snapshot is a different list, so
 * staying on page 4 of the old one would be meaningless).
 */
export function useConsoleTableState<Row>(columns: readonly DataGridColumnDef<Row>[], options: {
  visible?: ReadonlySet<string>,
  order?: readonly string[],
  resetKey: string,
}) {
  const [state, setState] = useState<DataGridState>(() => {
    const initial = createDefaultDataGridState(columns);
    const columnVisibility: Record<string, boolean> = {};
    for (const column of columns) columnVisibility[column.id] = options.visible == null || options.visible.has(column.id);
    return {
      ...initial,
      sorting: [],
      columnVisibility,
      columnOrder: options.order == null ? initial.columnOrder : [...options.order],
      pagination: { pageIndex: 0, pageSize: 25 },
    };
  });
  useEffect(() => {
    setState(current => ({
      ...current,
      pagination: { ...current.pagination, pageIndex: 0 },
      selection: { selectedIds: new Set(), anchorId: null },
    }));
  }, [options.resetKey]);
  return [state, setState] as const;
}

/**
 * The dashboard DataGrid (column manager, CSV export, virtualised rows) inside console chrome:
 * a built-in toolbar for columns/export, our pagination footer with "load older history" semantics,
 * and a highlight for the row whose detail panel is open.
 */
export function ConsoleTable<Row>({
  columns,
  rows,
  getRowId,
  state,
  onStateChange,
  onRowClick,
  activeRowId,
  matchRow,
  searchPlaceholder,
  isLoading = false,
  history,
  selectable = false,
  rowHeight = 48,
  exportFilename,
  emptyState,
  toolbarExtra,
}: {
  columns: readonly DataGridColumnDef<Row>[],
  rows: readonly Row[],
  getRowId: (row: Row) => string,
  state: DataGridState,
  onStateChange: React.Dispatch<React.SetStateAction<DataGridState>>,
  onRowClick?: (row: Row) => void,
  /** Row whose detail panel is open; highlighted in the grid. */
  activeRowId?: string | null,
  /**
   * Toolbar search matcher; the query arrives trimmed and lowercased. Defaults to the grid's own
   * matcher over column values, which misses fields that aren't columns (eg. a call's response).
   */
  matchRow?: (row: Row, query: string) => boolean,
  /**
   * Placeholder of the toolbar's search box, or null to hide it when the page filters rows with
   * its own search (so there is never a second search box stacked above the grid).
   */
  searchPlaceholder: string | null,
  isLoading?: boolean,
  history: HistoryPaging | null,
  selectable?: boolean,
  rowHeight?: number,
  exportFilename: string,
  emptyState?: ReactNode,
  toolbarExtra?: ReactNode,
}) {
  const scopeId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const data = useDataSource({
    data: rows,
    columns,
    getRowId,
    sorting: state.sorting,
    quickSearch: searchPlaceholder == null ? "" : state.quickSearch,
    matchRow: matchRow == null ? undefined : (row, query) => matchRow(row, query),
    pagination: state.pagination,
    paginationMode: "client",
  });

  return (
    <div data-console-table={scopeId}>
      {activeRowId != null && (
        // The grid has no per-row className hook, but every row carries `data-row-id`; a scoped
        // attribute selector is the least invasive way to mark the open row without forking it.
        <style>{`[data-console-table="${scopeId}"] [data-row-id="${CSS.escape(activeRowId)}"]{background-color:hsl(var(--brand) / 0.07);box-shadow:inset 2px 0 0 hsl(var(--brand));}`}</style>
      )}
      <DataGrid
        columns={columns}
        rows={data.rows}
        getRowId={getRowId}
        totalRowCount={data.totalRowCount}
        isLoading={isLoading || data.isLoading}
        state={state}
        onChange={onStateChange}
        onRowClick={onRowClick == null ? undefined : (row, _rowId, event) => {
          if (!isDataGridInteractiveRowClickTarget(event.target)) onRowClick(row);
        }}
        selectionMode={selectable ? "multiple" : "none"}
        toolbar={ctx => <DataGridToolbar ctx={ctx} hideQuickSearch={searchPlaceholder == null} extra={toolbarExtra} />}
        strings={searchPlaceholder == null ? undefined : { searchPlaceholder }}
        className="hx-grid"
        footer={context => (
          <TableFooter
            pageIndex={context.state.pagination.pageIndex}
            pageSize={context.state.pagination.pageSize}
            totalRowCount={context.totalRowCount ?? context.visibleRowCount}
            onPageChange={pageIndex => onStateChange(current => ({ ...current, pagination: { ...current.pagination, pageIndex } }))}
            onPageSizeChange={pageSize => onStateChange(current => ({ ...current, pagination: { pageIndex: 0, pageSize } }))}
            history={history}
          />
        )}
        emptyState={emptyState}
        fillHeight={false}
        maxHeight="calc(100dvh - 18rem)"
        rowHeight={rowHeight}
        headerHeight={36}
        horizontalScrollbarPosition="top"
        exportFilename={exportFilename}
      />
    </div>
  );
}

/**
 * Pagination over loaded rows, extended past the last loaded page: when more history exists on the
 * server, "Next" on the last page fetches it first and only then advances, so the page index never
 * points at rows that don't exist yet.
 */
export function TableFooter({ pageIndex, pageSize, totalRowCount, onPageChange, onPageSizeChange, history }: {
  pageIndex: number,
  pageSize: number,
  totalRowCount: number,
  onPageChange: (pageIndex: number) => void,
  onPageSizeChange: (pageSize: number) => void,
  history: HistoryPaging | null,
}) {
  const pageCount = Math.max(1, Math.ceil(totalRowCount / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const firstRow = totalRowCount === 0 ? 0 : currentPage * pageSize + 1;
  const lastRow = Math.min((currentPage + 1) * pageSize, totalRowCount);
  const atLastLoadedPage = currentPage >= pageCount - 1;
  const canLoadMore = history?.hasMoreHistory === true;

  useEffect(() => {
    if (pageIndex > pageCount - 1) onPageChange(Math.max(0, pageCount - 1));
  }, [onPageChange, pageCount, pageIndex]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="tabular-nums">
          {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of {totalRowCount.toLocaleString()}{canLoadMore ? "+" : ""}
        </span>
        {history != null && (
          <span className="hidden text-muted-foreground/80 sm:inline">
            {canLoadMore ? "More history on server" : "Full history loaded"}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5">
          <span>Rows</span>
          <Select aria-label="Rows per page" value={pageSize} onChange={event => onPageSizeChange(parsePageSize(event.target.value))} fullWidth={false} className="w-[4.5rem]">
            {PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
          </Select>
        </label>
        <Button size="xs" icon="chevronLeft" disabled={currentPage === 0} onClick={() => onPageChange(currentPage - 1)}>Prev</Button>
        <span className="min-w-12 text-center font-mono tabular-nums">{currentPage + 1} / {pageCount}</span>
        <Button
          size="xs"
          trailingIcon="chevronRight"
          disabled={atLastLoadedPage && !canLoadMore}
          loading={history?.isLoadingOlder === true}
          title={atLastLoadedPage && canLoadMore ? "Fetch older rows from the server" : undefined}
          onClick={async () => {
            if (!atLastLoadedPage) {
              onPageChange(currentPage + 1);
              return;
            }
            if (history == null) return;
            await history.onLoadOlder();
            onPageChange(currentPage + 1);
          }}
        >
          {atLastLoadedPage && canLoadMore ? "Load older" : "Next"}
        </Button>
      </div>
    </div>
  );
}

/** Stable id helper for grids keyed by SpacetimeDB u64 ids. */
export function rowIdOf(row: { id: bigint }): string {
  return String(row.id);
}

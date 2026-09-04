"use client";

import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  CaretUp,
  CheckSquare,
  MinusSquare,
  Square,
} from "@phosphor-icons/react";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { cn } from "@hexclave/ui";
import {
  type ColumnDef,
  type ColumnOrderState,
  type ColumnPinningState,
  type ColumnSizingState,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  type Header,
  type Updater,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import React, {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DesignSkeleton } from "../skeleton";
import { DEFAULT_COL_WIDTH, clampColumnWidth, getEffectiveMaxWidth, getEffectiveMinWidth } from "./data-grid-sizing";
import { DataGridExportDialog } from "./data-grid-export-dialog";
import { DataGridToolbar } from "./data-grid-toolbar";
import { formatGridDate, resolveColumnValue } from "./state";
import { resolveDataGridStrings } from "./strings";
import type {
  DataGridCellContext,
  DataGridColumnDef,
  DataGridCellValue,
  DataGridDateDisplay,
  DataGridFooterContext,
  DataGridHeaderContext,
  DataGridPaginationMode,
  DataGridProps,
  DataGridSelectionModel,
  DataGridSortItem,
  DataGridSortModel,
  DataGridState,
  DataGridStrings,
  DataGridToolbarContext,
  RowId,
} from "./types";

// Viewport-relative fallback height for infinite-scroll grids that the caller left unbounded
// (no `fillHeight`, no `maxHeight`). Leaves ~16rem of room for the top bar, page header, and grid
// toolbar. See the `effectiveMaxHeight` comment in DataGrid for why an infinite grid must be bounded.
const DEFAULT_INFINITE_MAX_HEIGHT = "calc(100dvh - 16rem)";
const DATA_GRID_SCROLLBAR_CLASS_NAME = cn(
  "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:h-1.5",
  "[&::-webkit-scrollbar-track]:bg-transparent",
  "[&::-webkit-scrollbar-thumb]:bg-foreground/[0.08] [&::-webkit-scrollbar-thumb]:rounded-full",
  "[&::-webkit-scrollbar-thumb]:hover:bg-foreground/[0.15]",
);

// ─── Row click target ────────────────────────────────────────────────

function getEventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

export function isDataGridInteractiveRowClickTarget(target: EventTarget | null): boolean {
  const el = getEventTargetElement(target);
  return el?.closest([
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "[role=\"button\"]",
    "[role=\"menuitem\"]",
    "[contenteditable]:not([contenteditable=\"false\"])",
    "[data-no-row-click]",
  ].join(",")) != null;
}

function shouldIgnoreRowClick(event: React.MouseEvent): boolean {
  return event.defaultPrevented || isDataGridInteractiveRowClickTarget(event.target);
}

// ─── State translators (DataGridState ⇄ TanStack) ────────────────────

function toTanstackSorting(sorting: DataGridSortModel): SortingState {
  return sorting.map((s) => ({ id: s.columnId, desc: s.direction === "desc" }));
}

function fromTanstackSorting(sorting: SortingState): DataGridSortModel {
  return sorting.map((s) => ({ columnId: s.id, direction: s.desc ? "desc" : "asc" }));
}

function toTanstackRowSelection(ids: ReadonlySet<RowId>): RowSelectionState {
  const out: RowSelectionState = {};
  for (const id of ids) out[id] = true;
  return out;
}

function resolveUpdater<T>(updater: Updater<T>, current: T): T {
  return typeof updater === "function" ? (updater as (old: T) => T)(current) : updater;
}

// ─── Flex column width distribution ──────────────────────────────────

function distributeFlexWidths<TRow>(
  sizes: Record<string, number>,
  visibleColumns: readonly DataGridColumnDef<TRow>[],
  available: number,
): void {
  const flexCols = visibleColumns.filter((c) => c.flex != null && c.flex > 0);
  if (flexCols.length === 0 || available <= 0) return;
  const totalFlex = flexCols.reduce((acc, c) => acc + (c.flex ?? 0), 0);
  let remaining = available;
  flexCols.forEach((col, i) => {
    const isLast = i === flexCols.length - 1;
    const share = isLast
      ? remaining
      : Math.floor(available * ((col.flex ?? 0) / totalFlex));
    const max = col.maxWidth ?? Infinity;
    const add = Math.max(0, Math.min(share, max - sizes[col.id]));
    sizes[col.id] += add;
    remaining -= add;
  });
}

// ─── Selection logic (with shift-range anchor) ───────────────────────

type SelectionInput = {
  current: DataGridSelectionModel;
  rowId: RowId;
  mode: "single" | "multiple";
  modifiers: { shift: boolean; ctrl: boolean };
  allRowIds: readonly RowId[];
};

function selectSingle(current: DataGridSelectionModel, rowId: RowId): DataGridSelectionModel {
  const isSelected = current.selectedIds.has(rowId);
  return {
    selectedIds: isSelected ? new Set() : new Set([rowId]),
    anchorId: isSelected ? null : rowId,
  };
}

function selectRange(
  current: DataGridSelectionModel,
  rowId: RowId,
  allRowIds: readonly RowId[],
  additive: boolean,
): DataGridSelectionModel | null {
  if (current.anchorId == null) return null;
  const anchorIdx = allRowIds.indexOf(current.anchorId);
  const currentIdx = allRowIds.indexOf(rowId);
  if (anchorIdx < 0 || currentIdx < 0) return null;
  const start = Math.min(anchorIdx, currentIdx);
  const end = Math.max(anchorIdx, currentIdx);
  const next = additive ? new Set(current.selectedIds) : new Set<RowId>();
  for (let i = start; i <= end; i++) next.add(allRowIds[i]!);
  return { selectedIds: next, anchorId: current.anchorId };
}

function selectToggle(current: DataGridSelectionModel, rowId: RowId): DataGridSelectionModel {
  const next = new Set(current.selectedIds);
  if (next.has(rowId)) next.delete(rowId);
  else next.add(rowId);
  return { selectedIds: next, anchorId: rowId };
}

function nextSelection(input: SelectionInput): DataGridSelectionModel {
  const { current, rowId, mode, modifiers, allRowIds } = input;
  if (mode === "single") return selectSingle(current, rowId);
  if (modifiers.shift) {
    const range = selectRange(current, rowId, allRowIds, modifiers.ctrl);
    if (range != null) return range;
  }
  if (modifiers.ctrl) return selectToggle(current, rowId);
  return { selectedIds: new Set([rowId]), anchorId: rowId };
}

// ─── Header cell ─────────────────────────────────────────────────────

function HeaderCell<TRow>({
  header,
  col,
  resizable,
}: {
  header: Header<TRow, unknown>;
  col: DataGridColumnDef<TRow>;
  resizable: boolean;
}) {
  const sorted = header.column.getIsSorted(); // false | "asc" | "desc"
  const sortIndex = header.column.getSortIndex();
  const totalSorts = header.column.getCanMultiSort()
    ? header.getContext().table.getState().sorting.length
    : 0;
  const ctx: DataGridHeaderContext<TRow> = {
    columnId: col.id,
    columnDef: col,
    isSorted: sorted === false ? false : sorted,
    sortIndex: totalSorts > 1 && sortIndex >= 0 ? sortIndex + 1 : null,
  };
  const label = typeof col.header === "function" ? col.header(ctx) : col.header;
  const sortable = header.column.getCanSort();
  const canResize = resizable && header.column.getCanResize();
  const isResizing = header.column.getIsResizing();

  return (
    <div
      className={cn(
        "group/header relative flex items-center gap-1.5 px-3 select-none bg-transparent overflow-hidden",
        "border-r border-black/[0.04] dark:border-white/[0.04] last:border-r-0",
        sortable && "cursor-pointer",
      )}
      style={{ width: `calc(var(--col-${col.id}-size) * 1px)` }}
      data-col-id={col.id}
      onClick={sortable ? header.column.getToggleSortingHandler() : undefined}
      role="columnheader"
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
    >
      <span
        className={cn(
          "flex-1 min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground",
          col.align === "center" && "text-center",
          col.align === "right" && "text-right",
        )}
      >
        {label}
      </span>

      {sorted && (
        <span className="flex items-center gap-0.5 text-foreground/60">
          {sorted === "asc"
            ? <ArrowUp className="h-3 w-3" weight="bold" />
            : <ArrowDown className="h-3 w-3" weight="bold" />}
          {ctx.sortIndex != null && (
            <span className="text-[10px] font-medium tabular-nums">{ctx.sortIndex}</span>
          )}
        </span>
      )}

      {!sorted && sortable && (
        <span className="hidden group-hover/header:flex items-center text-foreground/20">
          <CaretUp className="h-2.5 w-2.5 -mb-[1px]" weight="bold" />
          <CaretDown className="h-2.5 w-2.5 -mt-[1px]" weight="bold" />
        </span>
      )}

      {canResize && (
        <div
          onMouseDown={header.getResizeHandler()}
          onTouchStart={header.getResizeHandler()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className={cn(
            "absolute right-0 top-0 bottom-0 z-10 w-[5px] cursor-col-resize touch-none",
            "group-hover/header:bg-foreground/[0.06] hover:!bg-blue-500/30",
            "transition-colors duration-100",
            isResizing && "bg-blue-500/40",
          )}
        />
      )}
    </div>
  );
}

// ─── Data cell ───────────────────────────────────────────────────────

function DataCell<TRow>({
  col,
  row,
  rowId,
  rowIndex,
  isSelected,
  dateDisplay,
}: {
  col: DataGridColumnDef<TRow>;
  row: TRow;
  rowId: RowId;
  rowIndex: number;
  isSelected: boolean;
  dateDisplay: DataGridDateDisplay;
}) {
  const value = resolveColumnValue(col, row);
  const ctx: DataGridCellContext<TRow> = { row, rowId, rowIndex, value, columnId: col.id, isSelected, dateDisplay };

  const isDateCol = col.type === "date" || col.type === "dateTime";
  let content: React.ReactNode;
  if (col.renderCell) content = col.renderCell(ctx);
  else if (isDateCol) content = renderDateCell(value, dateDisplay, col);
  else content = formatCellValue(value);

  const hasCellClick = col.onCellClick || col.onCellDoubleClick;
  const isWrap = col.cellOverflow === "wrap";

  return (
    <div
      className={cn(
        "flex px-3 bg-transparent overflow-hidden",
        "border-r border-black/[0.04] dark:border-white/[0.04] last:border-r-0",
        "text-sm text-foreground",
        isWrap ? "items-start py-2" : "items-center",
        col.align === "center" && "justify-center",
        col.align === "right" && "justify-end",
        hasCellClick && "cursor-pointer",
      )}
      style={{ width: `calc(var(--col-${col.id}-size) * 1px)` }}
      data-col-id={col.id}
      role="gridcell"
      onClick={col.onCellClick ? (e) => {
        e.stopPropagation();
        col.onCellClick!(ctx, e);
      } : undefined}
      onDoubleClick={col.onCellDoubleClick ? (e) => {
        e.stopPropagation();
        col.onCellDoubleClick!(ctx, e);
      } : undefined}
    >
      <div className={cn("min-w-0", isWrap ? "flex-1" : "truncate")}>{content}</div>
    </div>
  );
}

function formatCellValue(value: unknown): React.ReactNode {
  if (value == null) return <span className="text-muted-foreground/40">-</span>;
  if (typeof value === "boolean") {
    return (
      <span className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded-md text-xs font-medium",
        value
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-foreground/[0.04] text-muted-foreground",
      )}>
        {value ? "Yes" : "No"}
      </span>
    );
  }
  if (value instanceof Date) {
    return <span className="tabular-nums text-muted-foreground">{value.toLocaleDateString()}</span>;
  }
  return <span className="truncate">{String(value)}</span>;
}

function renderDateCell<TRow>(
  value: DataGridCellValue,
  dateDisplay: DataGridDateDisplay,
  col: DataGridColumnDef<TRow>,
): React.ReactNode {
  const { display, tooltip } = formatGridDate(value, dateDisplay, {
    parseValue: col.parseValue,
    dateFormat: col.dateFormat,
  });
  if (display == null) return <span className="text-muted-foreground/40">-</span>;
  return (
    <span className="tabular-nums text-muted-foreground truncate cursor-help" title={tooltip ?? undefined}>
      {display}
    </span>
  );
}

// ─── Skeleton row ────────────────────────────────────────────────────

function hashStringToInt(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/**
 * Column flex fractions used when the grid is loading before any schema is
 * known (e.g. QueryDataGrid discovers columns from the first result page).
 * Without these, `SkeletonRow` would render zero cells and the body looks
 * like an empty black void instead of a shimmer.
 */
const SCHEMA_PENDING_COL_FRACTIONS = [0.18, 0.16, 0.34, 0.2, 0.12] as const;
const SCHEMA_PENDING_SKELETON_ROWS = 10;

function SkeletonRow({
  columns,
  height,
  showCheckbox,
}: {
  columns: readonly DataGridColumnDef<any>[];
  height: number;
  showCheckbox?: boolean;
}) {
  return (
    <div className="flex" style={{ height }} role="row">
      {showCheckbox && (
        <div className="flex items-center justify-center border-r border-black/[0.04] dark:border-white/[0.04]" style={{ width: 44 }}>
          <DesignSkeleton className="h-4 w-4 rounded" />
        </div>
      )}
      {columns.map((col) => (
        <div
          key={col.id}
          className="flex items-center px-3 border-r border-black/[0.04] dark:border-white/[0.04] last:border-r-0"
          style={{ width: `calc(var(--col-${col.id}-size) * 1px)` }}
        >
          <DesignSkeleton className="h-3.5 rounded-md" style={{ width: `${40 + (hashStringToInt(col.id) % 40)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Sticky header shimmer when columns haven't been discovered yet. */
function SchemaPendingHeaderCells({ showCheckbox }: { showCheckbox?: boolean }) {
  return (
    <>
      {showCheckbox && (
        <div
          className="flex shrink-0 items-center justify-center border-r border-foreground/[0.04]"
          style={{ width: 44 }}
        />
      )}
      {SCHEMA_PENDING_COL_FRACTIONS.map((frac, colIdx) => (
        <div
          key={colIdx}
          className="flex items-center px-3 border-r border-black/[0.04] dark:border-white/[0.04] last:border-r-0"
          style={{ width: `${frac * 100}%` }}
        >
          <DesignSkeleton
            className="h-3 rounded-md"
            style={{ width: `${45 + (colIdx * 13) % 30}%` }}
          />
        </div>
      ))}
    </>
  );
}

/** Full-width body shimmer when columns haven't been discovered yet. */
function SchemaPendingSkeleton({
  rowHeight,
  showCheckbox,
}: {
  rowHeight: number,
  showCheckbox?: boolean,
}) {
  return (
    <div className="w-full" data-data-grid-schema-pending-skeleton="" role="status" aria-label="Loading">
      {Array.from({ length: SCHEMA_PENDING_SKELETON_ROWS }).map((_, rowIdx) => (
        <div
          key={rowIdx}
          className="flex w-full border-b border-black/[0.04] dark:border-white/[0.04]"
          style={{ height: rowHeight }}
          role="row"
        >
          {showCheckbox && (
            <div className="flex shrink-0 items-center justify-center border-r border-black/[0.04] dark:border-white/[0.04]" style={{ width: 44 }}>
              <DesignSkeleton className="h-4 w-4 rounded" />
            </div>
          )}
          {SCHEMA_PENDING_COL_FRACTIONS.map((frac, colIdx) => (
            <div
              key={colIdx}
              className="flex items-center px-3 border-r border-black/[0.04] dark:border-white/[0.04] last:border-r-0"
              style={{ width: `${frac * 100}%` }}
            >
              <DesignSkeleton
                className="h-3.5 rounded-md"
                style={{ width: `${50 + ((rowIdx * 7 + colIdx * 19) % 40)}%` }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Selection checkbox ──────────────────────────────────────────────

function SelectionCheckbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
  title,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (event: React.MouseEvent<HTMLButtonElement>) => void;
  ariaLabel: string;
  title?: string;
}) {
  const Icon = indeterminate ? MinusSquare : checked ? CheckSquare : Square;
  return (
    <button
      className={cn(
        "flex items-center justify-center w-full h-full",
        "hover:bg-foreground/[0.04] transition-colors duration-75",
        checked || indeterminate
          ? "text-blue-600 dark:text-blue-400"
          : "text-muted-foreground/40 hover:text-muted-foreground/60",
      )}
      onClick={(e) => {
        e.stopPropagation();
        onChange(e);
      }}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
    >
      <Icon className="h-4 w-4" weight={checked || indeterminate ? "fill" : "regular"} />
    </button>
  );
}

// ─── Infinite scroll sentinel ────────────────────────────────────────

const NOOP = () => {};

function InfiniteScrollSentinel({
  onIntersect,
  isLoading,
  rootRef,
  strings,
}: {
  onIntersect: () => void;
  isLoading: boolean;
  rootRef?: React.RefObject<Element | null>;
  strings: DataGridStrings;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Read `onIntersect` through a ref so the observer never has to be
  // re-created when the callback identity changes. `onLoadMore` (and thus
  // `onIntersect`) changes on every `isLoadingMore`/`hasMore` toggle; if the
  // observer were re-created each time, a freshly-created observer re-reports
  // the sentinel's *current* intersection state, so a sentinel that stays in
  // view keeps firing `onIntersect` after every page. That auto-loads the
  // entire dataset back-to-back (defeating "load on scroll") and OOM-crashes
  // the tab on long transaction/customer histories. A single stable observer
  // only fires on genuine intersection *changes* (real user scrolls).
  const onIntersectRef = useRef(onIntersect);
  onIntersectRef.current = onIntersect;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onIntersectRef.current();
      },
      { root: rootRef?.current ?? null, rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootRef]);
  return (
    <div ref={ref} className="flex items-center justify-center py-4">
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
          {strings.loadingMore}
        </div>
      )}
    </div>
  );
}

// ─── Footer ──────────────────────────────────────────────────────────

function DefaultFooter<TRow>({
  ctx,
  pagination,
  onChange,
}: {
  ctx: DataGridFooterContext<TRow>;
  pagination: DataGridPaginationMode;
  onChange: React.Dispatch<React.SetStateAction<DataGridState>>;
}) {
  const { state, totalRowCount, visibleRowCount, selectedRowCount, strings } = ctx;
  const totalPages = totalRowCount != null
    ? Math.max(1, Math.ceil(totalRowCount / state.pagination.pageSize))
    : undefined;

  const setPage = (pageIndex: number) =>
    onChange((s) => ({ ...s, pagination: { ...s.pagination, pageIndex } }));
  const setPageSize = (pageSize: number) =>
    onChange((s) => ({ ...s, pagination: { ...s.pagination, pageSize, pageIndex: 0 } }));

  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-t border-foreground/[0.06] text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        {selectedRowCount > 0 && (
          <span className="font-medium text-foreground">{strings.rowsSelected(selectedRowCount)}</span>
        )}
        {totalRowCount != null && <span>{visibleRowCount} of {totalRowCount} rows</span>}
      </div>

      {pagination !== "infinite" && totalPages != null && (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span>{strings.rowsPerPage}</span>
            <select
              className={cn(
                "h-7 rounded-lg border border-black/[0.08] dark:border-white/[0.06] px-1.5",
                "bg-white dark:bg-background shadow-sm ring-1 ring-black/[0.08] dark:ring-white/[0.06]",
                "text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/[0.1]",
                "cursor-pointer transition-all duration-150 hover:transition-none hover:ring-black/[0.12] dark:hover:ring-white/[0.1]",
              )}
              value={state.pagination.pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
            >
              {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <button
              className={cn(
                "h-7 w-7 flex items-center justify-center rounded-lg",
                "hover:bg-foreground/[0.04] disabled:opacity-30 disabled:cursor-not-allowed",
                "transition-colors duration-75",
              )}
              onClick={() => setPage(state.pagination.pageIndex - 1)}
              disabled={state.pagination.pageIndex === 0}
              aria-label="Previous page"
            >
              <CaretUp className="h-3.5 w-3.5 -rotate-90" weight="bold" />
            </button>
            <span className="px-2 tabular-nums font-medium">
              {strings.pageOf(state.pagination.pageIndex + 1, totalPages)}
            </span>
            <button
              className={cn(
                "h-7 w-7 flex items-center justify-center rounded-lg",
                "hover:bg-foreground/[0.04] disabled:opacity-30 disabled:cursor-not-allowed",
                "transition-colors duration-75",
              )}
              onClick={() => setPage(state.pagination.pageIndex + 1)}
              disabled={state.pagination.pageIndex >= totalPages - 1}
              aria-label="Next page"
            >
              <CaretDown className="h-3.5 w-3.5 -rotate-90" weight="bold" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main DataGrid ───────────────────────────────────────────────────

/**
 * Interactive table built on TanStack Table v8. Sorting, column sizing,
 * visibility, ordering, and pinning are owned by the table instance; we
 * layer virtualization, sticky toolbar/header/footer, infinite scroll,
 * quick search, CSV export, and date-format toggling on top.
 *
 * The grid is display-only — it does not fetch or page data itself. Pair
 * with `useDataSource` for client- or server-side data and pass the
 * already-processed slice through `rows`.
 *
 * ```tsx
 * const columns = useMemo(() => [...], []);
 * const [gridState, setGridState] = useState(() => createDefaultDataGridState(columns));
 * const gridData = useDataSource({
 *   data: users, columns, getRowId: (r) => r.id,
 *   sorting: gridState.sorting,
 *   quickSearch: gridState.quickSearch,
 *   pagination: gridState.pagination,
 *   paginationMode: "client",
 * });
 *
 * <DataGrid
 *   columns={columns}
 *   rows={gridData.rows}
 *   getRowId={(r) => r.id}
 *   totalRowCount={gridData.totalRowCount}
 *   isLoading={gridData.isLoading}
 *   state={gridState}
 *   onChange={setGridState}
 * />
 * ```
 *
 * Iron rules:
 * - `rows` is always `gridData.rows`, never your raw array.
 * - Columns must be stable (define outside the component or wrap in `useMemo`).
 * - Initialize state with `createDefaultDataGridState(columns)`.
 * - `renderCell` must be a pure function — no React hooks inside.
 */
export function DataGrid<TRow>(props: DataGridProps<TRow>) {
  const {
    columns: allColumns,
    rows,
    getRowId,
    totalRowCount,
    isLoading = false,
    isRefetching = false,
    hasMore = false,
    isLoadingMore = false,
    onLoadMore,
    state,
    onChange,
    paginationMode = "paginated",
    selectionMode = "none",
    resizable = true,
    rowHeight: rowHeightProp = 44,
    estimatedRowHeight: estimatedRowHeightProp,
    headerHeight = 44,
    overscan = 5,
    maxHeight,
    fillHeight = true,
    stickyTop,
    horizontalScrollbarPosition = "bottom",
    toolbar,
    toolbarExtra,
    emptyState,
    loadingState,
    footer,
    footerExtra,
    exportFilename = "export",
    exportOptions,
    strings: stringsOverride,
    className,
    onRowClick,
    onRowDoubleClick,
    onSelectionChange,
    onSortChange,
    onColumnResize,
    onColumnVisibilityChange,
  } = props;

  const isDynamicRowHeight = rowHeightProp === "auto";
  const fixedRowHeight = isDynamicRowHeight ? undefined : rowHeightProp;
  const estimatedRowHeight = estimatedRowHeightProp ?? (fixedRowHeight ?? 44);

  const strings = useMemo(() => resolveDataGridStrings(stringsOverride), [stringsOverride]);

  // ── Build TanStack column defs from our column defs ──────────
  const tableColumns = useMemo<ColumnDef<TRow>[]>(
    () =>
      allColumns.map((col) => ({
        id: col.id,
        accessorFn: (row) => resolveColumnValue(col, row),
        header: typeof col.header === "string" ? col.header : col.id,
        size: col.width ?? DEFAULT_COL_WIDTH,
        minSize: getEffectiveMinWidth(col),
        maxSize: getEffectiveMaxWidth(col),
        enableSorting: col.sortable !== false,
        enableHiding: col.hideable !== false,
        enableResizing: col.resizable !== false,
        enableMultiSort: true,
      })),
    [allColumns],
  );

  // ── Translate our state ⇄ TanStack state via change handlers ───
  const tanstackSorting = useMemo(() => toTanstackSorting(state.sorting), [state.sorting]);
  const tanstackRowSelection = useMemo(
    () => toTanstackRowSelection(state.selection.selectedIds),
    [state.selection.selectedIds],
  );
  // ColumnSizing/Visibility/Order/Pinning share the same shape with TanStack.
  const tanstackColumnPinning = useMemo<ColumnPinningState>(
    () => ({ left: [...state.columnPinning.left], right: [...state.columnPinning.right] }),
    [state.columnPinning],
  );
  const tanstackColumnOrder = useMemo<ColumnOrderState>(
    () => [...state.columnOrder],
    [state.columnOrder],
  );

  const allColumnsRef = useRef(allColumns);
  allColumnsRef.current = allColumns;

  const handleSortingChange = useCallback(
    (updater: Updater<SortingState>) => {
      const next = resolveUpdater(updater, toTanstackSorting(state.sorting));
      const ours: DataGridSortItem[] = fromTanstackSorting(next).map((s) => ({ ...s }));
      // Reset to page 0 — page N of the new sort order is meaningless when
      // the order itself changed, and would silently scroll past relevant
      // rows.
      onChange((s) => ({
        ...s,
        sorting: ours,
        pagination: { ...s.pagination, pageIndex: 0 },
      }));
      onSortChange?.(ours);
    },
    [onChange, onSortChange, state.sorting],
  );

  const handleColumnSizingChange = useCallback(
    (updater: Updater<ColumnSizingState>) => {
      const next = resolveUpdater(updater, state.columnWidths);
      // Clamp each new width to our canvas-measured min and explicit max.
      const clamped: Record<string, number> = {};
      for (const [id, w] of Object.entries(next)) {
        const col = allColumnsRef.current.find((c) => c.id === id);
        clamped[id] = col ? clampColumnWidth(col, w) : w;
      }
      onChange((s) => ({ ...s, columnWidths: clamped }));
      // Fire onColumnResize for any column whose width changed.
      if (onColumnResize) {
        for (const [id, w] of Object.entries(clamped)) {
          if (state.columnWidths[id] !== w) onColumnResize(id, w);
        }
      }
    },
    [onChange, onColumnResize, state.columnWidths],
  );

  const handleVisibilityChange = useCallback(
    (updater: Updater<VisibilityState>) => {
      const next = resolveUpdater(updater, state.columnVisibility);
      onChange((s) => ({ ...s, columnVisibility: next }));
      onColumnVisibilityChange?.(next);
    },
    [onChange, onColumnVisibilityChange, state.columnVisibility],
  );

  const handleColumnOrderChange = useCallback(
    (updater: Updater<ColumnOrderState>) => {
      const next = resolveUpdater(updater, [...state.columnOrder]);
      onChange((s) => ({ ...s, columnOrder: next }));
    },
    [onChange, state.columnOrder],
  );

  const handleColumnPinningChange = useCallback(
    (updater: Updater<ColumnPinningState>) => {
      const current: ColumnPinningState = {
        left: [...state.columnPinning.left],
        right: [...state.columnPinning.right],
      };
      const next = resolveUpdater(updater, current);
      onChange((s) => ({
        ...s,
        columnPinning: { left: next.left ?? [], right: next.right ?? [] },
      }));
    },
    [onChange, state.columnPinning],
  );

  // ── TanStack Table instance ──────────────────────────────────
  const table = useReactTable<TRow>({
    data: rows as TRow[],
    columns: tableColumns,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    state: {
      sorting: tanstackSorting,
      columnVisibility: state.columnVisibility,
      columnSizing: state.columnWidths,
      columnOrder: tanstackColumnOrder,
      columnPinning: tanstackColumnPinning,
      rowSelection: tanstackRowSelection,
    },
    onSortingChange: handleSortingChange,
    onColumnSizingChange: handleColumnSizingChange,
    onColumnVisibilityChange: handleVisibilityChange,
    onColumnOrderChange: handleColumnOrderChange,
    onColumnPinningChange: handleColumnPinningChange,
    columnResizeMode: "onEnd",
    enableRowSelection: selectionMode !== "none",
    enableMultiRowSelection: selectionMode === "multiple",
    enableColumnResizing: resizable,
    manualSorting: true,
    manualPagination: true,
    manualFiltering: true,
  });

  // ── Visible columns (in TanStack-resolved order, after visibility) ──
  const visibleColumns = useMemo(() => {
    const colMap = new Map(allColumns.map((c) => [c.id, c]));
    return table
      .getVisibleLeafColumns()
      .map((c) => colMap.get(c.id))
      .filter(Boolean) as DataGridColumnDef<TRow>[];
  }, [allColumns, table, state.columnOrder, state.columnVisibility]);

  // ── Row IDs (stable across this render) ──────────────────────
  const rowIds = useMemo(() => rows.map(getRowId), [rows, getRowId]);

  // ── Container width tracking (for `flex` column distribution) ─
  // Measure the scroll container's clientWidth, which excludes the vertical
  // scrollbar — using the outer grid would leave a few pixels of phantom
  // horizontal scroll when rows overflow.
  const [containerWidth, setContainerWidth] = useState(0);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const scroller = scrollContainerRef.current;
    if (!grid) return;
    const update = (entries?: ResizeObserverEntry[]) => {
      let measured = 0;
      if (entries != null) {
        for (const entry of entries) {
          measured = Math.max(measured, entry.contentRect.width);
        }
      }
      if (measured <= 0) {
        const scrollerWidth = scroller?.clientWidth ?? 0;
        const gridWidth = grid.clientWidth;
        measured = scrollerWidth > 0 ? scrollerWidth : gridWidth;
      }
      if (measured > 0) setContainerWidth(measured);
    };
    update();
    const observer = new ResizeObserver((entries) => update(entries));
    observer.observe(grid);
    if (scroller) observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // ── Column width CSS variables (TanStack pattern) ────────────
  // With `columnResizeMode: "onEnd"`, live drag width comes from deltaOffset; committed sizes update on pointer-up.
  const columnSizingInfo = table.getState().columnSizingInfo;
  const columnSizes = useMemo<Record<string, number>>(() => {
    const sizes: Record<string, number> = {};
    let baseTotal = selectionMode !== "none" ? 44 : 0;
    const resizingId = columnSizingInfo.isResizingColumn || null;
    const deltaOffset = columnSizingInfo.deltaOffset ?? 0;
    for (const col of visibleColumns) {
      const tsCol = table.getColumn(col.id);
      const baseSize = tsCol?.getSize() ?? col.width ?? DEFAULT_COL_WIDTH;
      const liveSize = resizingId === col.id
        ? clampColumnWidth(col, baseSize + deltaOffset)
        : baseSize;
      sizes[col.id] = liveSize;
      baseTotal += liveSize;
    }
    distributeFlexWidths(sizes, visibleColumns, containerWidth - baseTotal);
    return sizes;
  }, [visibleColumns, table, columnSizingInfo, state.columnWidths, containerWidth, selectionMode]);

  const totalContentWidth = useMemo(() => {
    let total = selectionMode !== "none" ? 44 : 0;
    for (const col of visibleColumns) total += columnSizes[col.id] ?? 0;
    return total;
  }, [visibleColumns, columnSizes, selectionMode]);

  const cssVars = useMemo<CSSProperties>(() => {
    const vars: Record<string, string | number> = { "--grid-total-w": `${totalContentWidth}px` };
    if (stickyTop != null) {
      vars["--data-grid-sticky-top"] = typeof stickyTop === "number" ? `${stickyTop}px` : stickyTop;
    }
    for (const col of visibleColumns) {
      vars[`--col-${col.id}-size`] = columnSizes[col.id];
    }
    return vars as CSSProperties;
  }, [stickyTop, visibleColumns, columnSizes, totalContentWidth]);

  // ── Selection handlers ───────────────────────────────────────
  const fireSelection = useCallback(
    (next: DataGridSelectionModel) => {
      onChange((s) => ({ ...s, selection: next }));
      if (onSelectionChange) {
        const idSet = next.selectedIds;
        const selectedRows = rows.filter((r) => idSet.has(getRowId(r)));
        onSelectionChange(idSet, selectedRows);
      }
    },
    [onChange, onSelectionChange, rows, getRowId],
  );

  const handleRowClick = useCallback(
    (row: TRow, rowId: RowId, event: React.MouseEvent) => {
      if (selectionMode !== "none") {
        const next = nextSelection({
          current: state.selection,
          rowId,
          mode: selectionMode,
          modifiers: { shift: event.shiftKey, ctrl: event.metaKey || event.ctrlKey },
          allRowIds: rowIds,
        });
        fireSelection(next);
      }
      onRowClick?.(row, rowId, event);
    },
    [selectionMode, state.selection, rowIds, fireSelection, onRowClick],
  );

  const handleSelectAll = useCallback(() => {
    const allSelectedNow = rowIds.length > 0 && rowIds.every((id) => state.selection.selectedIds.has(id));
    fireSelection(
      allSelectedNow
        ? { selectedIds: new Set(), anchorId: null }
        : { selectedIds: new Set(rowIds), anchorId: null },
    );
  }, [rowIds, state.selection.selectedIds, fireSelection]);

  // ── Export ───────────────────────────────────────────────────
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const handleExportCsv = useCallback(() => {
    setExportDialogOpen(true);
  }, []);

  // ── Virtualizer ──────────────────────────────────────────────
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const stickyChromeRef = useRef<HTMLDivElement>(null);
  const rowsClipRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const measureElementFn = useCallback((el: Element) => el.getBoundingClientRect().height, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan,
    getItemKey: (index) => {
      const row = rows[index];
      return row != null ? String(getRowId(row)) : index;
    },
    ...(isDynamicRowHeight ? { measureElement: measureElementFn } : {}),
  });

  // ── Sticky chrome clipping ───────────────────────────────────
  useLayoutEffect(() => {
    const gridEl = gridRef.current;
    const stickyEl = stickyChromeRef.current;
    const bodyEl = scrollContainerRef.current;
    const clipEl = rowsClipRef.current;
    if (!gridEl || !stickyEl || !bodyEl || !clipEl) return;

    const updateClip = () => {
      const stickyRect = stickyEl.getBoundingClientRect();
      const clipRect = clipEl.getBoundingClientRect();
      const overlap = Math.max(0, stickyRect.bottom - clipRect.top);
      clipEl.style.setProperty("--data-grid-sticky-overlap", `${overlap}px`);
    };
    updateClip();
    const frame = requestAnimationFrame(updateClip);
    bodyEl.addEventListener("scroll", updateClip);
    window.addEventListener("scroll", updateClip, true);
    window.addEventListener("resize", updateClip);
    const observer = new ResizeObserver(updateClip);
    observer.observe(gridEl);
    observer.observe(stickyEl);
    observer.observe(bodyEl);
    return () => {
      bodyEl.removeEventListener("scroll", updateClip);
      window.removeEventListener("scroll", updateClip, true);
      window.removeEventListener("resize", updateClip);
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [isLoading, rows.length, totalRowCount, visibleColumns.length]);

  // Keep header + body horizontal offsets locked. When the scrollbar lives under
  // the column headers (`horizontalScrollbarPosition="top"`), the header is the
  // scroll owner and the body mirrors it (and vice versa for the default bottom bar).
  const isSyncingHorizontalScrollRef = useRef(false);
  const syncHorizontalScroll = useCallback((source: "header" | "body") => {
    const body = scrollContainerRef.current;
    const header = headerScrollRef.current;
    if (body == null || header == null || isSyncingHorizontalScrollRef.current) return;
    const from = source === "header" ? header : body;
    const to = source === "header" ? body : header;
    if (to.scrollLeft === from.scrollLeft) return;
    isSyncingHorizontalScrollRef.current = true;
    to.scrollLeft = from.scrollLeft;
    isSyncingHorizontalScrollRef.current = false;
  }, []);

  const handleBodyScroll = useCallback(() => {
    syncHorizontalScroll("body");
  }, [syncHorizontalScroll]);

  const handleHeaderScroll = useCallback(() => {
    syncHorizontalScroll("header");
  }, [syncHorizontalScroll]);

  const horizontalScrollbarAtTop = horizontalScrollbarPosition === "top";
  // Shared thin thumb styling. When the bar is on top, the header scrollport shows
  // it; the body keeps overflow-x hidden so a second thumb doesn't appear at the bottom.
  // Trackpad / shift-wheel horizontal gestures land on the body; with the top
  // scrollbar the body has overflow-x:hidden, so forward deltaX to the header.
  const handleBodyWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!horizontalScrollbarAtTop || event.deltaX === 0) return;
    const header = headerScrollRef.current;
    if (header == null) return;
    header.scrollLeft += event.deltaX;
  }, [horizontalScrollbarAtTop]);

  // ── Toolbar / Footer context ─────────────────────────────────
  const toolbarCtx: DataGridToolbarContext<TRow> = useMemo(
    () => ({
      state,
      onChange,
      columns: allColumns,
      visibleColumns,
      totalRowCount,
      selectedRowCount: state.selection.selectedIds.size,
      strings,
      exportCsv: handleExportCsv,
    }),
    [state, onChange, allColumns, visibleColumns, totalRowCount, strings, handleExportCsv],
  );
  const footerCtx: DataGridFooterContext<TRow> = useMemo(
    () => ({
      state,
      totalRowCount,
      visibleRowCount: rows.length,
      selectedRowCount: state.selection.selectedIds.size,
      paginationMode,
      strings,
    }),
    [state, totalRowCount, rows.length, paginationMode, strings],
  );

  const allSelected = rowIds.length > 0 && rowIds.every((id) => state.selection.selectedIds.has(id));
  const someSelected = !allSelected && rowIds.some((id) => state.selection.selectedIds.has(id));

  // An infinite-scroll grid MUST have a height-bounded scroll container, otherwise the container
  // grows to fit every loaded row, the virtualizer measures it as fully visible, and it renders
  // all rows into the DOM — unbounded memory growth that eventually OOMs the tab (rows never stop
  // accumulating as the user scrolls). When the caller didn't bound it (no fillHeight, no maxHeight),
  // fall back to a viewport-relative cap so virtualization can actually window. Only applied to
  // infinite mode; paginated grids cap rows at the page size and are safe to render unbounded.
  const effectiveMaxHeight =
    maxHeight ?? (paginationMode === "infinite" && !fillHeight ? DEFAULT_INFINITE_MAX_HEIGHT : undefined);

  const infiniteScrollRootRef =
    paginationMode === "infinite" && (fillHeight || effectiveMaxHeight != null)
      ? scrollContainerRef
      : undefined;

  // ── Header rendering helper (TanStack header objects, in order) ──
  const headers: Header<TRow, unknown>[] = useMemo(
    () =>
      table
        .getHeaderGroups()[0]?.headers
        .filter((h) => visibleColumns.some((c) => c.id === h.column.id)) ?? [],
    [table, visibleColumns],
  );
  const headerByColId = useMemo(() => {
    const m = new Map<string, Header<TRow, unknown>>();
    for (const h of headers) m.set(h.column.id, h);
    return m;
  }, [headers]);

  const isBounded = fillHeight || effectiveMaxHeight != null;

  return (
    <>
      <DataGridExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        rows={rows}
        columns={visibleColumns}
        exportFilename={exportFilename}
        exportOptions={exportOptions}
      />
      <div
        ref={gridRef}
        className={cn(
          "isolate flex w-full min-w-0 max-w-full flex-col bg-transparent rounded-[calc(var(--radius)*2)]",
          fillHeight ? "min-h-0 h-full" : "min-h-0 h-auto",
          isBounded && "overflow-hidden",
          className,
        )}
        style={effectiveMaxHeight != null ? { ...cssVars, maxHeight: effectiveMaxHeight } : cssVars}
        role="grid"
        aria-rowcount={totalRowCount ?? rows.length}
        aria-colcount={visibleColumns.length}
      >
        <div
          ref={stickyChromeRef}
          className="sticky z-30 w-full min-w-0 shrink-0 overflow-visible rounded-t-[calc(var(--radius)*2)] bg-white/90 dark:bg-background backdrop-blur-xl"
          style={{ top: stickyTop ?? (effectiveMaxHeight != null ? 0 : "var(--data-grid-sticky-top, 0px)") }}
        >
          {toolbar !== false && (
            <div className="relative bg-transparent">
              {toolbar
                ? toolbar(toolbarCtx)
                : (
                  <DataGridToolbar
                    ctx={toolbarCtx}
                    extra={typeof toolbarExtra === "function" ? toolbarExtra(toolbarCtx) : toolbarExtra}
                  />
                )}
            </div>
          )}

          <div className="relative">
            {isRefetching && (
              <div className="absolute top-0 left-0 right-0 h-0.5 z-30 bg-foreground/[0.04] overflow-hidden">
                <div className="h-full w-1/3 bg-blue-500/60 rounded-full animate-pulse" />
              </div>
            )}
            <div
              ref={headerScrollRef}
              className={cn(
                "w-full min-w-0 shrink-0 border-b border-foreground/[0.06]",
                horizontalScrollbarAtTop
                  ? cn("overflow-x-auto overflow-y-hidden", DATA_GRID_SCROLLBAR_CLASS_NAME)
                  : "overflow-hidden",
              )}
              onScroll={horizontalScrollbarAtTop ? handleHeaderScroll : undefined}
            >
              <div
                className="flex"
                style={{ height: headerHeight, minWidth: totalContentWidth || undefined, width: visibleColumns.length === 0 ? "100%" : undefined }}
                role="row"
              >
                {isLoading && visibleColumns.length === 0 ? (
                  <SchemaPendingHeaderCells showCheckbox={selectionMode !== "none"} />
                ) : (
                  <>
                    {selectionMode !== "none" && (
                      <div
                        className="flex items-center justify-center border-r border-foreground/[0.04]"
                        style={{ width: 44 }}
                      >
                        {selectionMode === "multiple" && (
                          <SelectionCheckbox
                            checked={allSelected}
                            indeterminate={someSelected}
                            onChange={handleSelectAll}
                            ariaLabel="Select all rows on this page"
                            title="Select all rows on this page"
                          />
                        )}
                      </div>
                    )}
                    {visibleColumns.map((col) => {
                      const header = headerByColId.get(col.id);
                      if (!header) return null;
                      return <HeaderCell key={col.id} header={header} col={col} resizable={resizable} />;
                    })}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div
          ref={scrollContainerRef}
          className={cn(
          "relative z-0 w-full min-w-0 bg-transparent",
          // Top scrollbar: body is y-only so the horizontal thumb isn't duplicated
          // under the rows. scrollLeft is still set programmatically from the header.
          horizontalScrollbarAtTop ? "overflow-y-auto overflow-x-hidden" : "overflow-auto",
          isBounded ? "min-h-0 flex-1" : "flex-none",
          DATA_GRID_SCROLLBAR_CLASS_NAME,
        )}
          onScroll={handleBodyScroll}
          onWheel={horizontalScrollbarAtTop ? handleBodyWheel : undefined}
        >
          <div
            ref={rowsClipRef}
            data-data-grid-rows-clip=""
            className="relative z-0"
            style={{
              minWidth: totalContentWidth,
              clipPath: "inset(var(--data-grid-sticky-overlap, 0px) 0 0 0)",
            }}
          >
            {isLoading && (
              <div style={{ minWidth: totalContentWidth || undefined, width: visibleColumns.length === 0 ? "100%" : undefined }}>
                {loadingState ?? (
                  visibleColumns.length === 0 ? (
                    // Schema not known yet (common for query grids that discover
                    // columns from the first page) — fall back to a full-width
                    // shimmer so loading never looks like an empty black pane.
                    <SchemaPendingSkeleton
                      rowHeight={estimatedRowHeight}
                      showCheckbox={selectionMode !== "none"}
                    />
                  ) : (
                    Array.from({ length: 8 }).map((_, i) => (
                      <SkeletonRow
                        key={i}
                        columns={visibleColumns}
                        height={estimatedRowHeight}
                        showCheckbox={selectionMode !== "none"}
                      />
                    ))
                  )
                )}
              </div>
            )}

            {!isLoading && rows.length === 0 && (
              <div
                className="flex items-center justify-center py-16 text-sm text-muted-foreground"
                style={{ minWidth: totalContentWidth }}
              >
                {emptyState ?? strings.noData}
              </div>
            )}

            {!isLoading && rows.length > 0 && (
              <div
                style={{
                  height: rowVirtualizer.getTotalSize(),
                  width: "100%",
                  minWidth: totalContentWidth,
                  position: "relative",
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow: VirtualItem) => {
                  const row = rows[virtualRow.index] ?? throwErr(
                  `DataGrid: virtualized row index ${virtualRow.index} out of range (rows.length=${rows.length})`,
                );
                  const rowId = getRowId(row);
                  const isSelected = state.selection.selectedIds.has(rowId);
                  const isOddRow = virtualRow.index % 2 === 1;
                  return (
                    <div
                      key={rowId}
                      ref={isDynamicRowHeight ? rowVirtualizer.measureElement : undefined}
                      data-index={virtualRow.index}
                      className={cn(
                      "absolute left-0 w-full flex",
                      "border-b border-black/[0.03] dark:border-white/[0.03]",
                      "transition-colors duration-75",
                      isSelected
                        ? "bg-blue-500/[0.06] dark:bg-blue-400/[0.08] hover:bg-blue-500/[0.08] dark:hover:bg-blue-400/[0.1]"
                        : isOddRow
                          ? "bg-foreground/[0.02] dark:bg-foreground/[0.03] hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06]"
                          : "hover:bg-foreground/[0.025] dark:hover:bg-foreground/[0.04]",
                      (selectionMode !== "none" || onRowClick) && "cursor-pointer",
                    )}
                      style={{
                        ...(isDynamicRowHeight
                          ? { minHeight: estimatedRowHeight }
                          : { height: fixedRowHeight }),
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      onClick={(e) => { if (!shouldIgnoreRowClick(e)) handleRowClick(row, rowId, e); }}
                      onDoubleClick={(e) => { if (!shouldIgnoreRowClick(e)) onRowDoubleClick?.(row, rowId, e); }}
                      role="row"
                      aria-rowindex={virtualRow.index + 2}
                      aria-selected={isSelected}
                      data-row-id={rowId}
                      data-state={isSelected ? "selected" : undefined}
                    >
                      {selectionMode !== "none" && (
                        <div
                          className="flex items-center justify-center border-r border-black/[0.04] dark:border-white/[0.04]"
                          style={{ width: 44 }}
                        >
                          <SelectionCheckbox
                            checked={isSelected}
                            onChange={(event) => handleRowClick(row, rowId, event)}
                            ariaLabel={`Select row ${rowId}`}
                          />
                        </div>
                      )}
                      {visibleColumns.map((col) => (
                        <DataCell
                          key={col.id}
                          col={col}
                          row={row}
                          rowId={rowId}
                          rowIndex={virtualRow.index}
                          isSelected={isSelected}
                          dateDisplay={state.dateDisplay}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            )}

            {paginationMode === "infinite" && hasMore && !isLoading && (
              <InfiniteScrollSentinel
                onIntersect={onLoadMore ?? NOOP}
                isLoading={isLoadingMore}
                rootRef={infiniteScrollRootRef}
                strings={strings}
              />
            )}
          </div>
        </div>

        {footer !== false && (
          <div className="sticky bottom-0 z-30 shrink-0 overflow-hidden rounded-b-[calc(var(--radius)*2)] bg-white/90 dark:bg-background backdrop-blur-xl">
            {footer ? footer(footerCtx) : <DefaultFooter ctx={footerCtx} pagination={paginationMode} onChange={onChange} />}
            {footerExtra && (typeof footerExtra === "function" ? footerExtra(footerCtx) : footerExtra)}
          </div>
        )}
      </div>
    </>
  );
}

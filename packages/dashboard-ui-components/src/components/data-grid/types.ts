import type { ReactNode } from "react";
import type { Json } from "@hexclave/shared/dist/utils/json";

/** Values the grid can render and serialize without an opaque escape hatch. */
export type DataGridCellValue = Json | Date;

// ─── Row identity ────────────────────────────────────────────────────
/** Every row must be uniquely identifiable. The grid resolves identity
 * through the top-level `getRowId` prop. */
export type RowId = string;

// ─── Column definition ──────────────────────────────────────────────
export type DataGridColumnType =
  | "string"
  | "number"
  | "date"
  | "dateTime"
  | "boolean"
  | "singleSelect"
  | "custom";

export type DataGridColumnAlign = "left" | "center" | "right";

export type DataGridColumnPin = "left" | "right" | false;

/** How `date` / `dateTime` cells render their value. `"relative"` shows
 * "1 day ago"–style text with the full datetime in a tooltip; `"absolute"`
 * shows the full datetime inline. */
export type DataGridDateDisplay = "relative" | "absolute";

/** Per-column overrides for how a `date` / `dateTime` cell is formatted.
 * If either function is omitted the grid falls back to its default
 * (Intl.RelativeTimeFormat + `toLocaleString()`). */
export type DataGridDateFormat = {
  relative?: (date: Date) => string;
  absolute?: (date: Date) => string;
};

/** Context passed to `renderCell`. */
export type DataGridCellContext<TRow, TValue extends DataGridCellValue = DataGridCellValue> = {
  row: TRow;
  rowId: RowId;
  rowIndex: number;
  value: TValue;
  columnId: string;
  isSelected: boolean;
  /** Current date display mode — consumers writing custom `renderCell`
   * for `date` / `dateTime` columns should branch on this to match the
   * grid's built-in behaviour. */
  dateDisplay: DataGridDateDisplay;
};

/** Context passed to `renderHeader`. */
export type DataGridHeaderContext<TRow> = {
  columnId: string;
  columnDef: DataGridColumnDef<TRow>;
  isSorted: false | "asc" | "desc";
  sortIndex: number | null;
};

/** A single column's full configuration. Generic over the row type. */
export type DataGridColumnDef<TRow, TValue extends DataGridCellValue = DataGridCellValue> = {
  /** Unique identifier for this column. */
  id: string;

  /** Display label. If a function is given it receives the header context. */
  header: string | ((ctx: DataGridHeaderContext<TRow>) => ReactNode);

  /** Accessor — either a key of TRow or a function. If omitted, `id` is
   * used as the key. */
  accessor?: keyof TRow | ((row: TRow) => TValue);

  /** Custom cell renderer. Falls back to plain text of the resolved value. */
  renderCell?: (ctx: DataGridCellContext<TRow, TValue>) => ReactNode;

  // ── Sizing ──────────────────────────────────────────────────
  /** Initial width in pixels. Defaults to 150. */
  width?: number;
  /** Minimum width during resize. Defaults to 50. */
  minWidth?: number;
  /** Maximum width during resize. Defaults to 800. */
  maxWidth?: number;
  /** Flex grow factor. When set, remaining space is distributed among flex
   * columns proportionally. */
  flex?: number;

  // ── Feature flags ──────────────────────────────────────────
  sortable?: boolean;
  resizable?: boolean;
  hideable?: boolean;
  /** Pin position. Defaults to `false` (unpinned). */
  pin?: DataGridColumnPin;

  // ── Display ──────────────────────────────────────────────────
  align?: DataGridColumnAlign;
  /** Column type affects default sorting. */
  type?: DataGridColumnType;
  /** For `singleSelect` type — available value options. */
  valueOptions?: readonly DataGridSelectOption[];

  // ── Cell overflow ──────────────────────────────────────────
  /** How cell content handles overflow.
   * - `"truncate"` (default): single-line with text-overflow ellipsis.
   * - `"wrap"`: content wraps naturally. When combined with
   *   `rowHeight="auto"` on the grid, the row grows to fit. With a
   *   fixed `rowHeight`, wrapped content is clipped at the row boundary. */
  cellOverflow?: "truncate" | "wrap";

  // ── Overrides ──────────────────────────────────────────────
  /** Custom sort comparator. Receives two resolved cell values.
   * Return negative if a < b, positive if a > b, 0 if equal. */
  sortComparator?: (a: TValue, b: TValue) => number;
  /** Format a cell value to a plain string — used for export and
   * clipboard copy. Defaults to `String(value)`. */
  formatValue?: (value: TValue, row: TRow) => string;

  // ── Date / dateTime ─────────────────────────────────────────
  /** Parse a raw cell value into a `Date`. Only consulted when `type` is
   * `"date"` or `"dateTime"`. Defaults to `new Date(value)` with graceful
   * handling of `null` / `undefined` / invalid dates. Override for
   * non-standard formats (e.g. ClickHouse's space-separated UTC strings). */
  parseValue?: (value: TValue) => Date | null;
  /** Per-column override for the relative / absolute date formatters. */
  dateFormat?: DataGridDateFormat;

  // ── Cell-level callbacks ──────────────────────────────────────
  /** Fired when a cell in this column is clicked. */
  onCellClick?: (ctx: DataGridCellContext<TRow, TValue>, event: React.MouseEvent) => void;
  /** Fired when a cell in this column is double-clicked. */
  onCellDoubleClick?: (ctx: DataGridCellContext<TRow, TValue>, event: React.MouseEvent) => void;
};

export type DataGridSelectOption = {
  value: string;
  label: string;
};

// ─── Sorting ─────────────────────────────────────────────────────────
export type DataGridSortItem = {
  columnId: string;
  direction: "asc" | "desc";
};
export type DataGridSortModel = readonly DataGridSortItem[];

// ─── Selection ───────────────────────────────────────────────────────
export type DataGridSelectionMode = "none" | "single" | "multiple";

export type DataGridSelectionModel = {
  selectedIds: ReadonlySet<RowId>;
  /** Tracks the last-clicked row for shift-range selection. */
  anchorId: RowId | null;
};

// ─── Column visibility / pinning ─────────────────────────────────────
export type DataGridColumnVisibility = Record<string, boolean>;

export type DataGridColumnPinning = {
  left: readonly string[];
  right: readonly string[];
};

// ─── Pagination ──────────────────────────────────────────────────────
/** UI display mode — "paginated" shows page controls, "infinite" shows scroll sentinel. */
export type DataGridPaginationMode = "paginated" | "infinite";

/** Data-fetching strategy used by `useDataSource`. */
export type DataGridDataPaginationMode = "client" | "server" | "infinite";

export type DataGridPaginationModel = {
  pageIndex: number;
  pageSize: number;
};

// ─── Combined grid state ─────────────────────────────────────────────
export type DataGridState = {
  sorting: DataGridSortModel;
  columnVisibility: DataGridColumnVisibility;
  columnWidths: Record<string, number>;
  columnPinning: DataGridColumnPinning;
  columnOrder: readonly string[];
  pagination: DataGridPaginationModel;
  selection: DataGridSelectionModel;
  /** How `date` / `dateTime` columns render. Defaults to `"relative"`
   * via `createDefaultDataGridState`. Toggled from the Columns popover
   * whenever the grid has at least one date column. */
  dateDisplay: DataGridDateDisplay;
  /** Current quick-search text. Written by the built-in search input in
   * the toolbar. `useDataSource` in client mode auto-filters by this
   * value (via `applyQuickSearch`); in async mode it's passed through
   * to the generator as `params.quickSearch`, where the consumer owns
   * the "how do I match?" decision (typically by modifying the backend
   * query). Defaults to `""`. */
  quickSearch: string;
};

// ─── Data source ─────────────────────────────────────────────────────
/** Params sent to the async data source on each fetch. */
export type DataGridFetchParams = {
  sorting: DataGridSortModel;
  pagination: DataGridPaginationModel;
  /** Current quick-search text. Passed through from `state.quickSearch`
   * so the async generator can fold it into its query (e.g. a SQL WHERE
   * clause). Empty string when the search box is empty. A change in
   * this value triggers a refetch, same mechanism as sorting. */
  quickSearch: string;
  /** For cursor-based: the last row of the previous page. */
  cursor: unknown;
};

/** Return type from a data source fetch. */
export type DataGridFetchResult<TRow> = {
  rows: TRow[];
  /** Total row count if known. `-1` or `undefined` for unknown (infinite). */
  totalRowCount?: number;
  /** Cursor for the next page (for cursor-based pagination). */
  nextCursor?: unknown;
  /** If `false`, there are no more pages. */
  hasMore?: boolean;
};

/** An async-generator data source yields pages of rows. The generator
 * receives fetch params as its argument and yields pages. Yielding
 * allows the grid to display partial results during loading. */
export type DataGridDataSource<TRow> = (
  params: DataGridFetchParams,
) => AsyncGenerator<DataGridFetchResult<TRow>, void, undefined>;

// ─── Export ─────────────────────────────────────────────────────────
export type DataGridExportFormat = "csv" | "json";

export type DataGridExportScope = "all" | "filtered";

export type DataGridExportField<TRow, TValue extends DataGridCellValue = DataGridCellValue> = {
  key: string;
  label: string;
  enabled: boolean;
  getValue: (row: TRow) => TValue;
};

export type DataGridExportRowsOptions = {
  scope: DataGridExportScope;
  onProgress: (fetched: number) => void;
};

export type DataGridExportOptions<TRow> = {
  title?: string;
  description?: ReactNode;
  entityName?: string;
  entityNamePlural?: string;
  filenamePrefix?: string;
  fields?: readonly DataGridExportField<TRow>[];
  fetchRows?: (options: DataGridExportRowsOptions) => Promise<readonly TRow[]>;
  emptyExportTitle?: string;
  emptyExportDescription?: string;
  allScopeLabel?: ReactNode;
  filteredScopeLabel?: ReactNode;
  progressSubjectLabel?: string;
  /** Which export scope is selected by default when the dialog opens. Defaults to `"all"`. */
  defaultScope?: DataGridExportScope;
};

// ─── Callbacks ───────────────────────────────────────────────────────
export type DataGridCallbacks<TRow> = {
  onRowClick?: (row: TRow, rowId: RowId, event: React.MouseEvent) => void;
  onRowDoubleClick?: (row: TRow, rowId: RowId, event: React.MouseEvent) => void;
  onCellClick?: (row: TRow, columnId: string, value: DataGridCellValue, event: React.MouseEvent) => void;
  /**
   * Fires when the selection set changes. **Page-scoped:** the header "select
   * all" checkbox and `selectedRows` only cover the rows currently rendered
   * (the visible page in paginated mode, or the loaded prefix in infinite
   * mode). The grid does not load other pages to satisfy the selection — if
   * you need cross-page selection, drive `selectedIds` from your own state
   * and load all rows you care about up-front.
   */
  onSelectionChange?: (selectedIds: ReadonlySet<RowId>, selectedRows: TRow[]) => void;
  onSortChange?: (model: DataGridSortModel) => void;
  onColumnResize?: (columnId: string, width: number) => void;
  onColumnVisibilityChange?: (model: DataGridColumnVisibility) => void;
};

// ─── Main props ──────────────────────────────────────────────────────
export type DataGridProps<TRow> = {
  /** Column definitions. */
  columns: readonly DataGridColumnDef<TRow>[];

  // ── Data (pre-resolved by the consumer) ────────────────────────
  /** The rows to display. The consumer is responsible for sorting
   *  and paginating before passing them in. */
  rows: readonly TRow[];
  /** Extract a unique identifier from each row. */
  getRowId: (row: TRow) => RowId;
  /** Total row count across all pages (used for pagination UI). */
  totalRowCount?: number;
  /** True while the initial data load is in progress (shows skeleton). */
  isLoading?: boolean;
  /** True during a background refetch (shows subtle indicator, keeps rows). */
  isRefetching?: boolean;

  // ── Infinite scroll ────────────────────────────────────────────
  /** Whether more rows can be loaded (shows infinite scroll sentinel). */
  hasMore?: boolean;
  /** True while loading the next page of infinite scroll. */
  isLoadingMore?: boolean;
  /** Called when the infinite scroll sentinel becomes visible. */
  onLoadMore?: () => void;

  // ── State (fully controlled) ───────────────────────────────────
  state: DataGridState;
  onChange: React.Dispatch<React.SetStateAction<DataGridState>>;

  // ── Modes ──────────────────────────────────────────────────────
  /** UI mode for pagination. "paginated" shows page controls in the
   *  footer. "infinite" shows a scroll sentinel instead. Defaults to
   *  "paginated". */
  paginationMode?: "paginated" | "infinite";
  /** Selection behaviour. Defaults to "none". */
  selectionMode?: DataGridSelectionMode;
  /** Whether columns can be resized by dragging. Defaults to true. */
  resizable?: boolean;

  // ── Layout ─────────────────────────────────────────────────────
  /** Row height in pixels, or `"auto"` for dynamic measurement.
   *
   * - **number** (default `44`): every row is exactly this tall.
   *   Fast and predictable; content that overflows is clipped.
   * - **`"auto"`**: each row is measured by the browser after render
   *   and the virtualizer adjusts positions accordingly. Columns
   *   with `cellOverflow: "wrap"` will push the row taller; columns
   *   with `cellOverflow: "truncate"` (or the default) stay
   *   single-line. Use `estimatedRowHeight` to reduce scroll-jank
   *   when rows haven't been measured yet. */
  rowHeight?: number | "auto";
  /** Estimated row height used by the virtualizer when
   *  `rowHeight="auto"`. Better estimates = less scroll-position
   *  jank before rows are measured. Defaults to 44. Ignored when
   *  `rowHeight` is a number. */
  estimatedRowHeight?: number;
  /** Header row height in pixels. Defaults to 44. */
  headerHeight?: number;
  /** Number of rows to render outside the visible area. Defaults to 5. */
  overscan?: number;
  /** Grid max height. If omitted, grid takes available space (when `fillHeight`). */
  maxHeight?: number | string;
  /**
   * When `true` (default), the grid uses `h-full` and the row area scrolls inside the grid.
   * When `false`, the grid is only as tall as toolbar + header + rows (`h-auto`), so sibling
   * content (e.g. metadata) sits directly under the table without a large empty gap.
   */
  fillHeight?: boolean;
  /** Top offset for the sticky toolbar + header (px or CSS string). */
  stickyTop?: number | string;
  /**
   * Where the horizontal scrollbar is shown when columns overflow.
   * - `"bottom"` (default): on the row scrollport, under the last visible rows.
   * - `"top"`: under the column headers (top of the table body), so wide
   *   tables stay reachable without scrolling to the bottom first.
   */
  horizontalScrollbarPosition?: "top" | "bottom";

  // ── Callbacks ──────────────────────────────────────────────────
} & DataGridCallbacks<TRow> & {
  // ── Customisation ──────────────────────────────────────────────
  /** Custom toolbar renderer. When `false`, toolbar is hidden entirely. */
  toolbar?: false | ((ctx: DataGridToolbarContext<TRow>) => ReactNode);
  /** Extra content rendered inside the default toolbar row, to the left of
   *  the built-in columns / export actions. Use this to slot in
   *  refresh buttons, custom toggles, row counts, etc. without giving up
   *  the built-in actions. Ignored if a custom `toolbar` render function
   *  is provided — that function owns the entire row. */
  toolbarExtra?: ReactNode | ((ctx: DataGridToolbarContext<TRow>) => ReactNode);
  /** Custom empty state. Defaults to a centered "No data" message. */
  emptyState?: ReactNode;
  /** Custom loading state. Defaults to skeleton rows. */
  loadingState?: ReactNode;
  /** Custom footer. When `false`, footer is hidden. */
  footer?: false | ((ctx: DataGridFooterContext<TRow>) => ReactNode);
  /** Extra content rendered to the right of the default footer info. */
  footerExtra?: ReactNode | ((ctx: DataGridFooterContext<TRow>) => ReactNode);

  /** Filename stem for CSV export (without extension). */
  exportFilename?: string;
  /** Full export dialog configuration. If omitted, the dialog exports the
   * currently loaded rows using the grid's visible columns. */
  exportOptions?: DataGridExportOptions<TRow>;
  /** i18n overrides. */
  strings?: Partial<DataGridStrings>;

  className?: string;
};

// ─── Toolbar / footer context ────────────────────────────────────────
export type DataGridToolbarContext<TRow> = {
  state: DataGridState;
  onChange: React.Dispatch<React.SetStateAction<DataGridState>>;
  columns: readonly DataGridColumnDef<TRow>[];
  visibleColumns: readonly DataGridColumnDef<TRow>[];
  totalRowCount: number | undefined;
  selectedRowCount: number;
  strings: DataGridStrings;
  /** Trigger a CSV export. */
  exportCsv: () => void;
};

export type DataGridFooterContext<TRow> = {
  state: DataGridState;
  totalRowCount: number | undefined;
  visibleRowCount: number;
  selectedRowCount: number;
  paginationMode: DataGridPaginationMode;
  strings: DataGridStrings;
};

// ─── Strings ─────────────────────────────────────────────────────────
export type DataGridStrings = {
  // toolbar
  searchPlaceholder: string;
  columns: string;
  export: string;
  density: string;
  // column manager
  showAll: string;
  hideAll: string;
  resetColumns: string;
  // date display
  dateFormat: string;
  dateFormatRelative: string;
  dateFormatAbsolute: string;
  // selection
  rowsSelected: (count: number) => string;
  // pagination
  rowsPerPage: string;
  pageOf: (page: number, total: number) => string;
  // empty / loading
  noData: string;
  loading: string;
  loadingMore: string;
  // export
  exportCsv: string;
  exportCopied: string;
  // sort
  sortAsc: string;
  sortDesc: string;
  unsort: string;
  // misc
  pinLeft: string;
  pinRight: string;
  unpin: string;
  hideColumn: string;
};

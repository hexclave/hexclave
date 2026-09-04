import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { clampColumnWidth, DEFAULT_COL_WIDTH } from "./data-grid-sizing";
import type {
  DataGridColumnDef,
  DataGridCellValue,
  DataGridDateDisplay,
  DataGridDateFormat,
  DataGridPaginationModel,
  DataGridSortModel,
  DataGridState,
} from "./types";

/**
 * Build the initial `DataGridState` for a set of columns. Pass this as the
 * lazy initializer to `useState` — never hand-assemble the state object.
 *
 * ```tsx
 * const [gridState, setGridState] = React.useState(() =>
 *   createDefaultDataGridState(columns)
 * );
 * ```
 */
export function createDefaultDataGridState(
  columns: readonly DataGridColumnDef<any>[],
): DataGridState {
  const columnWidths: Record<string, number> = {};
  const columnOrder: string[] = [];

  for (const col of columns) {
    columnWidths[col.id] = clampColumnWidth(col, col.width ?? DEFAULT_COL_WIDTH);
    columnOrder.push(col.id);
  }

  return {
    sorting: [],
    columnVisibility: {},
    columnWidths,
    columnPinning: { left: [], right: [] },
    columnOrder,
    pagination: { pageIndex: 0, pageSize: 50 },
    selection: { selectedIds: new Set(), anchorId: null },
    dateDisplay: "relative",
    quickSearch: "",
  };
}

// ─── Column value resolution ─────────────────────────────────────────

export function resolveColumnValue<TRow, TValue extends DataGridCellValue = DataGridCellValue>(
  col: DataGridColumnDef<TRow, TValue>,
  row: TRow,
): TValue {
  if (typeof col.accessor === "function") return col.accessor(row);
  const key = col.accessor ?? col.id;
  return row[key as keyof TRow] as TValue;
}

// ─── Default sort comparator (used by client-mode useDataSource) ────

function defaultComparator(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return stringCompare(String(a), String(b));
}

export function buildRowComparator<TRow>(
  sortModel: DataGridSortModel,
  columns: readonly DataGridColumnDef<TRow>[],
): ((a: TRow, b: TRow) => number) | null {
  if (sortModel.length === 0) return null;
  const colMap = new Map(columns.map((c) => [c.id, c]));
  return (a, b) => {
    for (const { columnId, direction } of sortModel) {
      const col = colMap.get(columnId);
      if (!col) continue;
      const va = resolveColumnValue(col, a);
      const vb = resolveColumnValue(col, b);
      const cmp = col.sortComparator ? col.sortComparator(va, vb) : defaultComparator(va, vb);
      if (cmp !== 0) return direction === "asc" ? cmp : -cmp;
    }
    return 0;
  };
}

// ─── Pagination ──────────────────────────────────────────────────────

export function paginateRows<TRow>(
  rows: readonly TRow[],
  pagination: DataGridPaginationModel,
): TRow[] {
  const start = pagination.pageIndex * pagination.pageSize;
  return rows.slice(start, start + pagination.pageSize) as TRow[];
}

// ─── Quick search ────────────────────────────────────────────────────

/** Default row matcher: case-insensitive substring across every column. */
export function defaultMatchRow<TRow>(
  row: TRow,
  query: string,
  columns: readonly DataGridColumnDef<TRow>[],
): boolean {
  for (const col of columns) {
    const v = resolveColumnValue(col, row);
    if (v == null) continue;
    if (String(v).toLowerCase().includes(query)) return true;
  }
  return false;
}

export function applyQuickSearch<TRow>(
  rows: readonly TRow[],
  query: string,
  columns: readonly DataGridColumnDef<TRow>[],
  matchRow: (
    row: TRow,
    query: string,
    columns: readonly DataGridColumnDef<TRow>[],
  ) => boolean = defaultMatchRow,
): readonly TRow[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return rows;
  return rows.filter((r) => matchRow(r, trimmed, columns));
}

// ─── Date helpers ────────────────────────────────────────────────────

export function defaultParseDate(value: DataGridCellValue): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" || typeof value === "string") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

const relativeTimeFormatterCache = new Map<string, Intl.RelativeTimeFormat>();
function getRelativeTimeFormatter(locale?: string): Intl.RelativeTimeFormat {
  const key = locale ?? "__default__";
  let cached = relativeTimeFormatterCache.get(key);
  if (cached == null) {
    cached = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeTimeFormatterCache.set(key, cached);
  }
  return cached;
}

export function defaultFormatRelative(date: Date): string {
  const rtf = getRelativeTimeFormatter();
  // Wall-clock comparison to "now" (e.g. "5 minutes ago"). performance.now()
  // would be wrong here — it's a monotonic timer, not a wall-clock instant.
  let duration = (date.getTime() - Date.now()) / 1000;
  for (const div of DIVISIONS) {
    if (Math.abs(duration) < div.amount) return rtf.format(Math.round(duration), div.unit);
    duration /= div.amount;
  }
  return rtf.format(Math.round(duration), "year");
}

export function defaultFormatAbsolute(date: Date): string {
  return date.toLocaleString();
}

export function formatGridDate<TValue extends DataGridCellValue>(
  value: TValue,
  mode: DataGridDateDisplay,
  opts?: {
    parseValue?: (value: TValue) => Date | null;
    dateFormat?: DataGridDateFormat;
  },
): { display: string | null; tooltip: string | null } {
  const parse = opts?.parseValue ?? defaultParseDate;
  const date = parse(value);
  if (!date) return { display: null, tooltip: null };
  const relative = opts?.dateFormat?.relative ?? defaultFormatRelative;
  const absolute = opts?.dateFormat?.absolute ?? defaultFormatAbsolute;
  const tooltip = absolute(date);
  const display = mode === "relative" ? relative(date) : tooltip;
  return { display, tooltip };
}

// ─── CSV Export ──────────────────────────────────────────────────────

export function exportToCsv<TRow>(
  rows: readonly TRow[],
  columns: readonly DataGridColumnDef<TRow>[],
  filename: string,
): void {
  const header = columns.map((col) =>
    typeof col.header === "string" ? col.header : col.id,
  );
  const csvRows = rows.map((row) =>
    columns.map((col) => {
      const val = resolveColumnValue(col, row);
      const formatted = col.formatValue
        ? String((col.formatValue(val, row) as string | null | undefined) ?? "")
        : String(val ?? "");
      if (formatted.includes(",") || formatted.includes('"') || formatted.includes("\n")) {
        return `"${formatted.replace(/"/g, '""')}"`;
      }
      return formatted;
    }),
  );
  // UTF-8 BOM so Excel opens the CSV as UTF-8.
  const csvContent = "\uFEFF" + [
    header.join(","),
    ...csvRows.map((row) => row.join(",")),
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.csv`;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { clsx } from "clsx";
import type { FeedbackLogRow } from "../types";
import { toDate } from "../utils";
import { feedbackCategoryColor } from "../lib/feedback-category";
import { Alert, Badge, Button, EmptyState, FieldLabel, Input, SelectionCheckbox, SelectionToolbar, Select } from "./design";
import { InternalPaginationFooter } from "./InternalDataGridFooter";
import { type HistoryPagingProps } from "./LoadOlderButton";

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

const ALL_CATEGORIES = "all";

export function FeedbackList({
  rows,
  connectionState,
  connectionErrorMessage,
  onSelect,
  selectedId,
  hasMoreHistory,
  isLoadingOlder,
  onLoadOlder,
}: {
  rows: FeedbackLogRow[],
  connectionState: string,
  connectionErrorMessage: string | null,
  onSelect: (row: FeedbackLogRow) => void,
  selectedId?: bigint,
} & HistoryPagingProps) {
  const [textFilter, setTextFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL_CATEGORIES);
  const [selectedRows, setSelectedRows] = useState<Set<bigint>>(new Set());
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  // Derived from the rows rather than a hardcoded list, the same way
  // CallLogList builds its tool-name filter. The vocabulary lives in the MCP
  // tool; this way the filter can never be missing a category that exists in
  // the data, and never offers one that has never been used.
  const categories = useMemo(() => {
    return Array.from(new Set(rows.map(row => row.category))).sort();
  }, [rows]);

  const visibleRows = useMemo(() => {
    const needle = textFilter.trim().toLowerCase();
    return rows
      .filter(row => categoryFilter === ALL_CATEGORIES || row.category === categoryFilter)
      .filter(row => needle === "" || row.message.toLowerCase().includes(needle))
      // Newest first. Sorting by id rather than createdAt because id is a
      // monotonic autoInc — two rows written in the same microsecond still get
      // a stable, insertion-ordered position.
      .slice()
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }, [rows, textFilter, categoryFilter]);
  const selectedVisibleRows = visibleRows.filter(row => selectedRows.has(row.id));
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const pageRows = visibleRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const allVisibleRowsSelected = pageRows.length > 0 && pageRows.every(row => selectedRows.has(row.id));
  const someVisibleRowsSelected = pageRows.some(row => selectedRows.has(row.id));

  useEffect(() => {
    setSelectedRows(new Set());
    setPageIndex(0);
  }, [textFilter, categoryFilter]);

  if (connectionState === "connecting") {
    return <div className="p-4 text-sm text-muted-foreground">Connecting to SpacetimeDB...</div>;
  }

  if (connectionState === "error") {
    return (
      <Alert>
        <p>
          Failed to connect to SpacetimeDB. Check the browser session response below, then verify the{" "}
          <code>hexclave-ai-analytics</code> module is published and the local SpacetimeDB container is reachable.
        </p>
        {connectionErrorMessage != null && connectionErrorMessage !== "" && (
          <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-red-500/10 p-3 font-mono text-xs">
            {connectionErrorMessage}
          </pre>
        )}
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)_12rem_auto] items-end gap-3 rounded-xl border border-black/[0.06] bg-card p-3 shadow-sm ring-1 ring-black/[0.04] dark:border-white/[0.06] dark:ring-white/[0.04]">
        <label className="min-w-0 space-y-1">
          <FieldLabel>Search</FieldLabel>
          <Input
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            placeholder="Search feedback messages"
          />
        </label>
        <label className="space-y-1">
          <FieldLabel>Category</FieldLabel>
          <Select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value={ALL_CATEGORIES}>All categories</option>
            {categories.map(category => (
              <option key={category} value={category}>{category}</option>
            ))}
          </Select>
        </label>
        <span className="pb-1 text-right text-[10px] tabular-nums text-muted-foreground">
          {visibleRows.length} of {rows.length}
        </span>
      </div>

      {visibleRows.length === 0 ? (
        <EmptyState className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-12">
          <p className="font-medium text-foreground">{rows.length === 0 ? "No feedback yet" : "No matching feedback"}</p>
          <p className="mt-1 text-xs">{rows.length === 0 ? "New reports will appear here as they arrive." : "Try a different message or category filter."}</p>
        </EmptyState>
      ) : (
        <div>
          <SelectionToolbar count={selectedVisibleRows.length} noun="feedback item" onClear={() => setSelectedRows(new Set())}>
            <Button
              size="sm"
              onClick={() => {
                const selectedRow = selectedVisibleRows.at(0);
                if (selectedRow == null) throw new Error("Inspect selected requires one selected feedback row");
                onSelect(selectedRow);
              }}
              disabled={selectedVisibleRows.length !== 1}
              title={selectedVisibleRows.length === 1 ? "Open the selected feedback item" : "Select exactly one item to inspect it"}
            >
              Inspect selected
            </Button>
          </SelectionToolbar>
          <div className="overflow-hidden rounded-xl border border-black/[0.06] bg-card ring-1 ring-black/[0.04] backdrop-blur-xl dark:border-white/[0.06] dark:ring-white/[0.04]">
            <div className="flex h-9 items-center gap-3 border-b border-black/[0.06] bg-foreground/[0.03] px-3 dark:border-white/[0.06]">
              <SelectionCheckbox
                checked={allVisibleRowsSelected}
                indeterminate={someVisibleRowsSelected && !allVisibleRowsSelected}
                label={allVisibleRowsSelected ? "Deselect all visible feedback" : "Select all visible feedback"}
                onChange={checked => {
                  setSelectedRows(previous => {
                    const next = new Set(previous);
                    for (const row of pageRows) {
                      if (checked) next.add(row.id);
                      else next.delete(row.id);
                    }
                    return next;
                  });
                }}
              />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Feedback</span>
            </div>
            <div className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
              {pageRows.map(row => (
                <div
                  key={String(row.id)}
                  className={clsx(
                    "flex items-start gap-3 pl-3 transition-colors hover:transition-none",
                    row.id === selectedId || selectedRows.has(row.id) ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.04]",
                  )}
                >
                  <span className="flex h-11 items-center">
                    <SelectionCheckbox
                      checked={selectedRows.has(row.id)}
                      label={`Select feedback ${row.id}`}
                      onChange={checked => {
                        setSelectedRows(previous => {
                          const next = new Set(previous);
                          if (checked) next.add(row.id);
                          else next.delete(row.id);
                          return next;
                        });
                      }}
                    />
                  </span>
                  <button
                    type="button"
                    onClick={() => onSelect(row)}
                    className="flex min-w-0 flex-1 items-start gap-3 py-2 pr-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <Badge color={feedbackCategoryColor(row.category)} size="xs" className="mt-0.5 w-20 shrink-0 justify-center">
                      {row.category}
                    </Badge>
                    <span className="min-w-0 flex-1 text-xs leading-5 text-foreground">
                      {truncate(row.message, 160)}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {formatDistanceToNow(toDate(row.createdAt), { addSuffix: true })}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <InternalPaginationFooter
        pageIndex={currentPage}
        pageSize={pageSize}
        totalRowCount={visibleRows.length}
        visibleRowCount={pageRows.length}
        onPageChange={setPageIndex}
        onPageSizeChange={nextPageSize => {
          setPageSize(nextPageSize);
          setPageIndex(0);
        }}
        historyPaging={{ hasMoreHistory, isLoadingOlder, onLoadOlder }}
      />
    </div>
  );
}

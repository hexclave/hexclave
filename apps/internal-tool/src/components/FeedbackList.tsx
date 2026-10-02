import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { clsx } from "clsx";
import type { FeedbackLogRow } from "../types";
import { toDate } from "../utils";
import { LoadOlderButton, type HistoryPagingProps } from "./LoadOlderButton";

const CATEGORY_STYLES: Record<string, string> = {
  "bug": "bg-red-50 text-red-700 border-red-200",
  "docs-gap": "bg-amber-50 text-amber-700 border-amber-200",
  "suggestion": "bg-blue-50 text-blue-700 border-blue-200",
  "praise": "bg-green-50 text-green-700 border-green-200",
  "other": "bg-gray-50 text-gray-600 border-gray-200",
};

function categoryClass(category: string): string {
  return CATEGORY_STYLES[category] ?? CATEGORY_STYLES["other"];
}

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

  const categories = useMemo(() => {
    return Array.from(new Set(rows.map(row => row.category))).sort();
  }, [rows]);

  const visibleRows = useMemo(() => {
    const needle = textFilter.trim().toLowerCase();
    return rows
      .filter(row => categoryFilter === ALL_CATEGORIES || row.category === categoryFilter)
      .filter(row => needle === "" || row.message.toLowerCase().includes(needle))
      .slice()
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }, [rows, textFilter, categoryFilter]);

  if (connectionState === "connecting") {
    return <div className="text-gray-500 text-sm p-4">Connecting to SpacetimeDB...</div>;
  }

  if (connectionState === "error") {
    return (
      <div className="text-red-600 text-sm p-4">
        <p>
          Failed to connect to SpacetimeDB. Check the browser session response below, then verify the{" "}
          <code>hexclave-ai-analytics</code> module is published and the local SpacetimeDB container is reachable.
        </p>
        {connectionErrorMessage != null && connectionErrorMessage !== "" && (
          <pre className="mt-3 whitespace-pre-wrap rounded border border-red-200 bg-red-50 p-3 font-mono text-xs text-red-800">
            {connectionErrorMessage}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          placeholder="Filter feedback..."
          className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-gray-300"
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="px-2 py-1 text-xs border border-gray-200 rounded bg-white"
        >
          <option value={ALL_CATEGORIES}>All categories</option>
          {categories.map(category => (
            <option key={category} value={category}>{category}</option>
          ))}
        </select>
        <span className="text-xs text-gray-400 tabular-nums">
          {visibleRows.length}/{rows.length}
        </span>
      </div>

      {visibleRows.length === 0 ? (
        <div className="text-gray-400 text-xs p-4 text-center border border-dashed border-gray-200 rounded">
          {rows.length === 0 ? "No feedback yet." : "No feedback matches this filter."}
        </div>
      ) : (
        <div className="border border-gray-200 rounded overflow-hidden divide-y divide-gray-100">
          {visibleRows.map(row => (
            <button
              key={String(row.id)}
              onClick={() => onSelect(row)}
              className={clsx(
                "w-full text-left px-3 py-2 flex items-start gap-3 transition-colors hover:transition-none",
                row.id === selectedId ? "bg-gray-100" : "hover:bg-gray-50",
              )}
            >
              <span
                className={clsx(
                  "shrink-0 mt-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded border",
                  categoryClass(row.category),
                )}
              >
                {row.category}
              </span>
              <span className="flex-1 min-w-0 text-xs text-gray-800">
                {truncate(row.message, 160)}
              </span>
              <span className="shrink-0 text-[10px] text-gray-400 tabular-nums">
                {formatDistanceToNow(toDate(row.createdAt), { addSuffix: true })}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pt-2 text-xs">
        <LoadOlderButton
          hasMoreHistory={hasMoreHistory}
          isLoadingOlder={isLoadingOlder}
          onLoadOlder={onLoadOlder}
          hasRows={rows.length > 0}
        />
      </div>
    </div>
  );
}

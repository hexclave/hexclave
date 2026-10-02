"use client";

import { cn } from "@hexclave/ui";
import {
  Check,
  DownloadSimple,
  Eye,
  EyeSlash,
  MagnifyingGlass,
  X,
} from "@phosphor-icons/react";
import React, { useCallback, useMemo, useRef, useState } from "react";
import type {
  DataGridColumnDef,
  DataGridDateDisplay,
  DataGridStrings,
  DataGridToolbarContext,
} from "./types";

// ─── Popover primitive ───────────────────────────────────────────────

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return { open, setOpen, ref };
}

function PopoverPanel({
  children,
  className,
  popoverRef,
}: {
  children: React.ReactNode;
  className?: string;
  popoverRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={popoverRef}
      className={cn(
        "absolute top-full left-0 mt-1 z-50",
        "bg-white text-popover-foreground rounded-xl shadow-lg dark:bg-popover",
        "ring-1 ring-black/[0.08] dark:ring-white/[0.1]",
        "backdrop-blur-xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ─── Quick search ────────────────────────────────────────────────────

function QuickSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative flex min-w-0 flex-1 items-center sm:flex-initial">
      <MagnifyingGlass className="absolute left-2.5 h-3.5 w-3.5 text-muted-foreground/60 pointer-events-none" />
      <input
        type="text"
        className={cn(
          "h-8 w-full sm:w-52 pl-8 pr-7 rounded-xl text-xs",
          "border border-black/[0.08] dark:border-white/[0.06]",
          "bg-white dark:bg-background shadow-sm ring-1 ring-black/[0.08] dark:ring-white/[0.06]",
          "placeholder:text-muted-foreground/50",
          "focus:outline-none focus:ring-1 focus:ring-foreground/[0.1]",
          "transition-all duration-150 hover:transition-none hover:ring-black/[0.12] dark:hover:ring-white/[0.1]",
        )}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          className="absolute right-2 text-muted-foreground/40 hover:text-muted-foreground"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// ─── Toolbar button ──────────────────────────────────────────────────

function ToolbarButton({
  children,
  onClick,
  active,
  title,
  className: extraClassName,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      className={cn(
        "relative flex items-center justify-center rounded-lg text-xs font-medium",
        "h-7 w-7",
        "transition-colors duration-75",
        active
          ? "bg-foreground/[0.06] text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]",
        extraClassName,
      )}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

// ─── Column manager ──────────────────────────────────────────────────

function ColumnManager<TRow>({
  columns,
  visibility,
  onChange,
  strings,
  dateDisplay,
  onDateDisplayChange,
  hasDateColumns,
}: {
  columns: readonly DataGridColumnDef<TRow>[];
  visibility: Record<string, boolean>;
  onChange: (visibility: Record<string, boolean>) => void;
  strings: DataGridStrings;
  dateDisplay: DataGridDateDisplay;
  onDateDisplayChange: (mode: DataGridDateDisplay) => void;
  hasDateColumns: boolean;
}) {
  const hideableColumns = useMemo(
    () => columns.filter((c) => c.hideable !== false),
    [columns],
  );

  const toggleColumn = (id: string) => {
    const current = visibility[id] !== false;
    onChange({ ...visibility, [id]: !current });
  };

  const showAll = () => {
    const next = { ...visibility };
    for (const col of hideableColumns) next[col.id] = true;
    onChange(next);
  };

  const hideAll = () => {
    const next = { ...visibility };
    for (const col of hideableColumns) next[col.id] = false;
    onChange(next);
  };

  return (
    <div className="p-2 min-w-[240px] max-w-[300px]">
      <div className="max-h-[280px] overflow-y-auto space-y-0.5">
        {hideableColumns.map((col) => {
          const visible = visibility[col.id] !== false;
          return (
            <button
              key={col.id}
              className={cn(
                "flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg text-xs",
                "hover:bg-foreground/[0.06] transition-colors duration-75",
                visible ? "text-foreground" : "text-muted-foreground/50",
              )}
              onClick={() => toggleColumn(col.id)}
            >
              {visible ? (
                <Eye className="h-3.5 w-3.5 flex-shrink-0 text-blue-500" />
              ) : (
                <EyeSlash className="h-3.5 w-3.5 flex-shrink-0" />
              )}
              <span className="truncate text-left">
                {typeof col.header === "string" ? col.header : col.id}
              </span>
              {visible && <Check className="h-3 w-3 ml-auto flex-shrink-0 text-blue-500" />}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-foreground/[0.06]">
        <button className="text-[10px] text-muted-foreground hover:text-foreground font-medium uppercase tracking-wider transition-colors duration-75" onClick={showAll}>
          {strings.showAll}
        </button>
        <span className="text-muted-foreground/20">|</span>
        <button className="text-[10px] text-muted-foreground hover:text-foreground font-medium uppercase tracking-wider transition-colors duration-75" onClick={hideAll}>
          {strings.hideAll}
        </button>
      </div>

      {/* Date format toggle — only rendered when at least one column
          uses `type: "date"` or `"dateTime"`. Toggling writes to
          `state.dateDisplay` and the grid re-renders every date cell. */}
      {hasDateColumns && (
        <div className="mt-2 pt-2 border-t border-foreground/[0.06]">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {strings.dateFormat}
            </span>
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-zinc-100/90 p-0.5 ring-1 ring-black/[0.06] dark:bg-foreground/[0.04] dark:ring-white/[0.06]">
              <button
                className={cn(
                  "px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors duration-150 hover:transition-none",
                  dateDisplay === "relative"
                    ? "bg-white text-foreground shadow-sm ring-1 ring-black/[0.12] dark:bg-background dark:ring-white/[0.06]"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/50 dark:hover:bg-white/[0.06]",
                )}
                onClick={() => onDateDisplayChange("relative")}
              >
                {strings.dateFormatRelative}
              </button>
              <button
                className={cn(
                  "px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors duration-150 hover:transition-none",
                  dateDisplay === "absolute"
                    ? "bg-white text-foreground shadow-sm ring-1 ring-black/[0.12] dark:bg-background dark:ring-white/[0.06]"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/50 dark:hover:bg-white/[0.06]",
                )}
                onClick={() => onDateDisplayChange("absolute")}
              >
                {strings.dateFormatAbsolute}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main toolbar ────────────────────────────────────────────────────

export function DataGridToolbar<TRow>({
  ctx,
  extra,
  extraLeading,
  extraActions,
  hideQuickSearch,
}: {
  ctx: DataGridToolbarContext<TRow>;
  /** Extra content in the leading cluster, after search / `extraLeading`
   *  (filters, status badges, row counts). Stays with the search side so
   *  it doesn't compete with the trailing icon actions. */
  extra?: React.ReactNode;
  /** Extra content rendered at the START of the toolbar row — occupies
   *  the same position as the built-in quick search (after it, if the
   *  quick search is visible). Use this together with `hideQuickSearch`
   *  to fully replace the quick search with a custom input, e.g. an
   *  AI-powered search bar. */
  extraLeading?: React.ReactNode;
  /** Extra content in the trailing action cluster, immediately before
   *  the built-in columns / export buttons (e.g. a labeled Refresh).
   *  When present, a hairline divider separates it from those icons. */
  extraActions?: React.ReactNode;
  /** Whether to hide the built-in quick-search input. When `true`,
   *  callers are expected to provide their own search UI via
   *  `extraLeading`. */
  hideQuickSearch?: boolean;
}) {
  const { state, onChange, columns, strings, exportCsv } = ctx;

  const columnPopover = usePopover();

  const updateVisibility = useCallback(
    (visibility: Record<string, boolean>) => {
      onChange((s) => ({ ...s, columnVisibility: visibility }));
    },
    [onChange],
  );

  const updateDateDisplay = useCallback(
    (mode: DataGridDateDisplay) => {
      onChange((s) => ({ ...s, dateDisplay: mode }));
    },
    [onChange],
  );

  const updateQuickSearch = useCallback(
    (value: string) => {
      onChange((s) => ({
        ...s,
        quickSearch: value,
        // Reset to first page whenever the search text changes,
        // otherwise you can end up on a page index that no longer
        // exists in the filtered / refetched result set.
        pagination: { ...s.pagination, pageIndex: 0 },
      }));
    },
    [onChange],
  );

  const hasDateColumns = useMemo(
    () => columns.some((c) => c.type === "date" || c.type === "dateTime"),
    [columns],
  );
  const hasExtraActions = React.Children.toArray(extraActions).length > 0;

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 px-3 py-2.5 border-b border-foreground/[0.06] sm:flex-row sm:items-center sm:gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {!hideQuickSearch && (
          <QuickSearch
            value={state.quickSearch}
            onChange={updateQuickSearch}
            placeholder={strings.searchPlaceholder}
          />
        )}
        {extraLeading}
        {extra}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        {hasExtraActions && (
          <>
            {extraActions}
            <div
              className="mx-0.5 hidden h-4 w-px bg-foreground/[0.1] sm:block"
              aria-hidden
            />
          </>
        )}
        <div className="relative shrink-0" ref={columnPopover.ref}>
          <ToolbarButton
            onClick={() => columnPopover.setOpen(!columnPopover.open)}
            active={columnPopover.open}
            title={strings.columns}
          >
            <Eye className="h-3.5 w-3.5" />
          </ToolbarButton>
          {columnPopover.open && (
            <PopoverPanel popoverRef={columnPopover.ref} className="right-0 left-auto">
              <ColumnManager
                columns={columns}
                visibility={state.columnVisibility}
                onChange={updateVisibility}
                strings={strings}
                dateDisplay={state.dateDisplay}
                onDateDisplayChange={updateDateDisplay}
                hasDateColumns={hasDateColumns}
              />
            </PopoverPanel>
          )}
        </div>

        <ToolbarButton onClick={exportCsv} title={strings.export}>
          <DownloadSimple className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>
    </div>
  );
}

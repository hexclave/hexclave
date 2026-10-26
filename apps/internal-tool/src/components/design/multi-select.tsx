"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "./cn";

export type MultiSelectOption<Value extends string> = {
  value: Value,
  label: string,
  /** Render the label in monospace (IDs, tool names, model slugs). */
  mono?: boolean,
};

/** Above this many options the popover gets a filter box; short lists don't need one. */
const SEARCH_THRESHOLD = 8;

function summarize<Value extends string>(options: ReadonlyArray<MultiSelectOption<Value>>, selected: ReadonlySet<Value>, allLabel: string): string {
  if (selected.size === 0) return allLabel;
  if (selected.size === 1) {
    const [only] = selected;
    // A selected value can be missing from `options` when the option list is derived from loaded
    // rows and the row that introduced it has since paged out; show the raw value rather than lie.
    return options.find(option => option.value === only)?.label ?? String(only);
  }
  return `${selected.size} selected`;
}

/**
 * Dropdown filter that allows any subset of its options. An empty selection means "no filter",
 * which is why the trigger reads `allLabel` rather than "None" — every filter in the internal tool
 * follows that convention so clearing a filter and selecting nothing are the same state.
 *
 * Options are `role="option"` buttons in a multiselectable listbox (not checkbox inputs) so the
 * control can sit inside a FilterField's <label> without nesting labels.
 */
export function MultiSelect<Value extends string>({
  label,
  options,
  selected,
  onChange,
  allLabel = "All",
  disabled = false,
}: {
  /** Accessible name; FilterField's visible label is not associated with a button trigger. */
  label: string,
  options: ReadonlyArray<MultiSelectOption<Value>>,
  selected: ReadonlySet<Value>,
  onChange: (selected: Set<Value>) => void,
  allLabel?: string,
  disabled?: boolean,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const visibleOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === "" ? options : options.filter(option => option.label.toLowerCase().includes(needle));
  }, [options, query]);

  function toggle(value: Value) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  }

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => {
          setOpen(previous => !previous);
          setQuery("");
        }}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 rounded-lg border border-black/[0.08] bg-card px-2 text-left text-xs shadow-sm ring-1 ring-black/[0.04]",
          "transition-colors hover:bg-foreground/[0.03] hover:transition-none focus:outline-none focus:ring-1 focus:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:ring-white/[0.04]",
          selected.size === 0 ? "text-foreground" : "font-medium text-foreground",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{summarize(options, selected, allLabel)}</span>
        {selected.size > 0 && (
          <span className="rounded bg-primary px-1 text-[10px] font-semibold tabular-nums leading-4 text-primary-foreground">{selected.size}</span>
        )}
        <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 shrink-0 fill-none stroke-current text-muted-foreground [stroke-width:1.5]">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-max min-w-full max-w-80 rounded-lg border border-black/[0.08] bg-popover text-popover-foreground shadow-lg dark:border-white/[0.08]">
          {options.length > SEARCH_THRESHOLD && (
            <div className="border-b border-black/[0.06] p-1.5 dark:border-white/[0.06]">
              <input
                autoFocus
                aria-label={`Filter ${label} options`}
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Filter…"
                className="h-6 w-full rounded-md bg-foreground/[0.04] px-2 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}
          <div id={listboxId} role="listbox" aria-multiselectable="true" aria-label={label} className="max-h-72 overflow-y-auto p-1">
            {visibleOptions.length === 0 && <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No options</p>}
            {visibleOptions.map(option => {
              const isSelected = selected.has(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => toggle(option.value)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-foreground/[0.06] hover:transition-none focus-visible:bg-foreground/[0.06] focus-visible:outline-none"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-3.5 shrink-0 place-items-center rounded border text-[9px] leading-none",
                      isSelected ? "border-primary bg-primary text-primary-foreground" : "border-border",
                    )}
                  >
                    {isSelected ? "✓" : ""}
                  </span>
                  <span className={cn("min-w-0 truncate", option.mono === true && "font-mono text-[11px]")}>{option.label}</span>
                </button>
              );
            })}
          </div>
          {selected.size > 0 && (
            <div className="border-t border-black/[0.06] p-1 dark:border-white/[0.06]">
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground hover:transition-none"
              >
                Clear selection
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

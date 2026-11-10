"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../components/design/cn";
import { Icon } from "./icons";
import { Button, type ButtonVariant } from "./primitives";

/**
 * Closes a popover on outside pointer-down and on Escape (returning focus to the trigger). Shared by
 * every popover in the console so they all dismiss the same way.
 */
export function useDismiss(open: boolean, close: () => void, rootRef: React.RefObject<HTMLElement | null>, triggerRef?: React.RefObject<HTMLElement | null>) {
  // Callers pass inline closures; reading them through a ref keeps the listeners from being
  // re-registered on every render while the popover is open.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
      closeRef.current();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // Captured and stopped here so a containing detail panel doesn't also close on the same press.
      event.stopPropagation();
      closeRef.current();
      triggerRef?.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, rootRef, triggerRef]);
}

export type FilterOption<Value extends string> = { value: Value, label: string, count?: number };

/** Above this many options the menu gets a search box; short lists don't need one. */
const FILTER_SEARCH_THRESHOLD = 7;

function summarizeSelection<Value extends string>(options: ReadonlyArray<FilterOption<Value>>, selected: ReadonlySet<Value>): string | null {
  if (selected.size === 0) return null;
  if (selected.size === 1) {
    const [only] = selected;
    // A selected value can be missing from `options` when options derive from loaded rows and the
    // row that introduced it has since paged out; show the raw value rather than hide the filter.
    return options.find(option => option.value === only)?.label ?? only;
  }
  return `${selected.size} selected`;
}

/**
 * Multi-select filter rendered as a chip. Empty selection means "no filter" (the chip is dashed and
 * reads just the field name); once something is selected the chip turns solid and shows the value,
 * so the active filters of a view can be read at a glance without opening anything.
 */
export function FilterMenu<Value extends string>({ label, options, selected, onChange, mono = false, align = "left" }: {
  label: string,
  options: ReadonlyArray<FilterOption<Value>>,
  selected: ReadonlySet<Value>,
  onChange: (selected: Set<Value>) => void,
  mono?: boolean,
  align?: "left" | "right",
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  useDismiss(open, () => setOpen(false), rootRef, triggerRef);

  const visibleOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === "" ? options : options.filter(option => option.label.toLowerCase().includes(needle));
  }, [options, query]);
  const summary = summarizeSelection(options, selected);

  function toggle(value: Value) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={summary == null ? `Filter by ${label}` : `${label}: ${summary}`}
        onClick={() => {
          setOpen(previous => !previous);
          setQuery("");
        }}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors hover:transition-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          summary == null
            ? "border-dashed border-input text-muted-foreground hover:border-solid hover:bg-muted hover:text-foreground"
            : "border-border bg-card text-foreground shadow-sm hover:bg-muted",
          open && "bg-muted",
        )}
      >
        <span className={cn(summary != null && "text-muted-foreground")}>{label}</span>
        {summary != null && (
          <>
            <span className="h-3 w-px bg-border" />
            <span className={cn("max-w-40 truncate font-medium", mono && "font-mono text-[11px]")}>{summary}</span>
          </>
        )}
        <Icon name="chevronDown" size="xs" className="text-muted-foreground" />
      </button>
      {open && (
        <div className={cn(
          "absolute top-full z-50 mt-1.5 w-max min-w-52 max-w-80 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg",
          align === "right" ? "right-0" : "left-0",
        )}>
          {options.length > FILTER_SEARCH_THRESHOLD && (
            <div className="border-b border-border p-1.5">
              <input
                autoFocus
                aria-label={`Search ${label} options`}
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                className="h-7 w-full rounded-md bg-muted px-2 text-xs placeholder:text-muted-foreground/70 focus:outline-none"
              />
            </div>
          )}
          <div id={listboxId} role="listbox" aria-multiselectable="true" aria-label={label} className="hx-scroll max-h-72 overflow-y-auto p-1">
            {visibleOptions.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No matches</p>}
            {visibleOptions.map(option => {
              const isSelected = selected.has(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => toggle(option.value)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted hover:transition-none focus-visible:bg-muted focus-visible:outline-none"
                >
                  <span aria-hidden="true" className={cn(
                    "grid size-3.5 shrink-0 place-items-center rounded-[4px] border",
                    isSelected ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card",
                  )}>
                    {isSelected && <Icon name="check" size="xs" strokeWidth={2.4} />}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono text-[11px]")}>{option.label}</span>
                  {option.count != null && <span className="tabular-nums text-muted-foreground">{option.count.toLocaleString()}</span>}
                </button>
              );
            })}
          </div>
          {selected.size > 0 && (
            <div className="border-t border-border p-1">
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground hover:transition-none"
              >
                Clear {label.toLowerCase()} filter
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Single-choice dropdown with the same chip look as FilterMenu (eg. the time range). */
export function ChoiceMenu<Value extends string>({ label, value, options, onChange, defaultValue }: {
  label: string,
  value: Value,
  options: ReadonlyArray<{ value: Value, label: string }>,
  onChange: (value: Value) => void,
  /** The value that means "unfiltered"; the chip renders dashed while it is selected. */
  defaultValue: Value,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), rootRef, triggerRef);
  const current = options.find(option => option.value === value);
  const isDefault = value === defaultValue;
  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? value}`}
        onClick={() => setOpen(previous => !previous)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors hover:transition-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          isDefault
            ? "border-dashed border-input text-muted-foreground hover:border-solid hover:bg-muted hover:text-foreground"
            : "border-border bg-card text-foreground shadow-sm hover:bg-muted",
        )}
      >
        <Icon name="clock" size="sm" className="text-muted-foreground" />
        <span className={cn(!isDefault && "font-medium")}>{current?.label ?? value}</span>
        <Icon name="chevronDown" size="xs" className="text-muted-foreground" />
      </button>
      {open && (
        <div role="listbox" aria-label={label} className="absolute left-0 top-full z-50 mt-1.5 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
          {options.map(option => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted hover:transition-none"
            >
              {option.label}
              {option.value === value && <Icon name="check" size="sm" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Modal on the native `<dialog>` (opened with `showModal()`), which provides real focus trapping,
 * Escape handling and focus restoration. Callers conditionally render it: mounted means open.
 */
export function Dialog({ title, description, onClose, children, footer, width = "md" }: {
  title: ReactNode,
  description?: ReactNode,
  onClose: () => void,
  children?: ReactNode,
  footer?: ReactNode,
  width?: "sm" | "md" | "lg",
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog == null) return;
    dialog.showModal();
    // Closing before React removes the node is what restores focus to the opener.
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description != null ? descriptionId : undefined}
      // `cancel` fires on Escape; prevented so the caller's state stays the source of truth.
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-2xl",
        "backdrop:bg-black/40 backdrop:backdrop-blur-[2px]",
        width === "sm" ? "max-w-sm" : width === "md" ? "max-w-lg" : "max-w-2xl",
      )}
    >
      <div className="flex items-start justify-between gap-4 px-5 pb-1 pt-4">
        <div>
          <h2 id={titleId} className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
          {description != null && <p id={descriptionId} className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>}
        </div>
      </div>
      {children != null && <div className="px-5 py-3">{children}</div>}
      {footer != null && <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/40 px-5 py-3">{footer}</div>}
    </dialog>
  );
}

export function ConfirmDialog({ title, description, confirmLabel, confirmVariant = "primary", onConfirm, onCancel }: {
  title: string,
  description: string,
  confirmLabel: string,
  confirmVariant?: ButtonVariant,
  onConfirm: () => void,
  onCancel: () => void,
}) {
  return (
    <Dialog
      width="sm"
      title={title}
      description={description}
      onClose={onCancel}
      footer={(
        <>
          <Button autoFocus onClick={onCancel}>Cancel</Button>
          <Button variant={confirmVariant} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    />
  );
}

/**
 * Hover/focus explainer anchored under a `group`-classed, relatively positioned parent. Pointer
 * events are off so it never eats clicks on the element it describes.
 */
export function HoverCard({ children, align = "left", className }: { children: ReactNode, align?: "left" | "right", className?: string }) {
  return (
    <div
      role="tooltip"
      className={cn(
        "pointer-events-none invisible absolute top-full z-50 mt-1.5 w-64 rounded-lg border border-border bg-popover px-3 py-2 text-[11.5px] font-normal leading-5 text-popover-foreground shadow-lg",
        "group-hover:visible group-focus-within:visible",
        align === "right" ? "right-0" : "left-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

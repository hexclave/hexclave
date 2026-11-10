"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../../components/design/cn";
import { Resizer, useResizableWidth } from "../../components/design/resize";
import { DEFAULT_DETAIL_SIDEBAR_WIDTH, MAX_DETAIL_SIDEBAR_WIDTH, MIN_DETAIL_SIDEBAR_WIDTH, normalizeDetailSidebarWidth } from "../../lib/sidebar-size";
import { IconButton, Kbd } from "../ui/primitives";
import { consolePage, type ConsolePageId } from "./nav";

/**
 * Sticky page header: section breadcrumb, title and description come from the nav registry so a
 * page can't drift from how the sidebar and palette name it. `actions` sit on the right; `children`
 * render below the title row (tabs, filter bars) and stay pinned with it.
 */
export function PageHeader({ pageId, actions, children, meta }: {
  pageId: ConsolePageId,
  actions?: ReactNode,
  /** Small status read-out next to the title (eg. "Live · 200 rows"). */
  meta?: ReactNode,
  children?: ReactNode,
}) {
  const page = consolePage(pageId);
  return (
    <header className="shrink-0 border-b border-border bg-card/80 backdrop-blur-md">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 pb-3 pt-4">
        <div className="min-w-0">
          <p className="mb-0.5 text-[11px] font-medium text-muted-foreground">
            AI Operations{page.section != null && <> <span className="text-muted-foreground/50">/</span> {page.section}</>}
          </p>
          <div className="flex items-center gap-3">
            <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">{page.label}</h1>
            {meta}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{page.description}</p>
        </div>
        {actions != null && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children != null && <div className="px-6">{children}</div>}
    </header>
  );
}

/** Scrolling content region of a page. */
export function PageBody({ children, className }: { children: ReactNode, className?: string }) {
  return (
    <main className="hx-scroll min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto w-full max-w-[1600px] space-y-5 px-6 py-5", className)}>{children}</div>
    </main>
  );
}

/** Content + optional docked detail panel; the content scrolls independently of the panel. */
export function SplitView({ children, detail }: { children: ReactNode, detail: ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <main className="hx-scroll min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1600px] space-y-4 px-6 py-5">{children}</div>
      </main>
      {detail}
    </div>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/**
 * Right-docked, resizable detail panel shared by every list page. It shares one persisted width
 * with the legacy UI's detail pane (same storage key via sidebar-size), since both show the same
 * content in the same place.
 *
 * Keyboard: Esc closes; J/K (or ↓/↑ while the panel has focus) step through the list the panel was
 * opened from, which is what makes working a review queue fast.
 */
export function DetailPanel({ label, onClose, onPrevious, onNext, position, children }: {
  label: string,
  onClose: () => void,
  onPrevious: (() => void) | null,
  onNext: (() => void) | null,
  /** "3 of 25" read-out; null when the open row isn't in the current list. */
  position: { index: number, total: number } | null,
  children: ReactNode,
}) {
  const { width, isResizing, resizerProps } = useResizableWidth({
    label,
    storageKey: "internal-tool-detail-sidebar-width",
    defaultWidth: DEFAULT_DETAIL_SIDEBAR_WIDTH,
    minWidth: MIN_DETAIL_SIDEBAR_WIDTH,
    maxWidth: MAX_DETAIL_SIDEBAR_WIDTH,
    normalize: normalizeDetailSidebarWidth,
    edge: "left",
  });
  const handlers = useRef({ onClose, onPrevious, onNext });
  handlers.current = { onClose, onPrevious, onNext };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector("dialog[open]") != null) return;
      if (event.key === "Escape") {
        if (isTypingTarget(event.target)) return;
        handlers.current.onClose();
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (event.key === "j") handlers.current.onNext?.();
      else if (event.key === "k") handlers.current.onPrevious?.();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <button type="button" aria-label={`Close ${label}`} onClick={onClose} className="absolute inset-0 z-20 bg-black/30 lg:hidden" />
      <aside
        aria-label={label}
        style={{ width }}
        className={cn(
          "absolute inset-y-0 right-0 z-30 flex shrink-0 flex-col border-l border-border bg-card shadow-2xl lg:relative lg:max-w-[calc(100vw-30rem)] lg:shadow-none",
          "max-lg:!w-[min(40rem,calc(100%_-_1.5rem))]",
          isResizing && "select-none",
        )}
      >
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
          <IconButton icon="chevronUp" label="Previous (K)" disabled={onPrevious == null} onClick={() => onPrevious?.()} />
          <IconButton icon="chevronDown" label="Next (J)" disabled={onNext == null} onClick={() => onNext?.()} />
          <span className="ml-1 text-[11px] tabular-nums text-muted-foreground">
            {position == null ? "Not in current list" : `${(position.index + 1).toLocaleString()} of ${position.total.toLocaleString()}`}
          </span>
          <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground xl:flex">
            <Kbd>J</Kbd><Kbd>K</Kbd> to step
          </span>
          <IconButton icon="close" label="Close (Esc)" onClick={onClose} className="ml-2" />
        </div>
        <div className="hx-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
        <Resizer {...resizerProps} />
      </aside>
    </>
  );
}

/**
 * Prev/next navigation for a detail panel over an ordered list. `rows` is the list as currently
 * displayed (after filters), so stepping follows what the reviewer sees.
 */
export function useListNavigation<Row>(rows: readonly Row[], selectedKey: string | null, getKey: (row: Row) => string, select: (key: string) => void) {
  const index = selectedKey == null ? -1 : rows.findIndex(row => getKey(row) === selectedKey);
  const previous = index > 0 ? rows[index - 1] : null;
  const next = index >= 0 && index < rows.length - 1 ? rows[index + 1] : null;
  return {
    position: index < 0 ? null : { index, total: rows.length },
    onPrevious: previous == null ? null : () => select(getKey(previous)),
    onNext: next == null ? null : () => select(getKey(next)),
  };
}

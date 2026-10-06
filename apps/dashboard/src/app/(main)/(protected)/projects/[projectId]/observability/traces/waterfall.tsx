"use client";

import { DesignBadge, DesignPillToggle } from "@/components/design-components";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ArrowRightIcon, CaretRightIcon, ChartLineIcon, ClockIcon, KeyboardIcon, LinkSimpleIcon, StackIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AiSpanChip, tryAiSpanSummaryFromRaw } from "./ai-span";
import {
  eventMatchesHighlight,
  formatDuration,
  getTraceScaleEnd,
  isSystemSpanType,
  panViewWindow,
  spanHasError,
  spanIdsToExpandForHighlight,
  traceErrorCount,
  traceSignalSpanIds,
  traceSpanDisplayName,
  zoomViewWindow,
  type EventInput,
  type SpanInput,
  type Trace,
  type TraceEventHighlight,
  type TraceNode,
  type ViewWindow,
  type WaterfallRow,
} from "./trace-utils";
import {
  conciseServiceIdentitySummary,
  serviceIdentityLabel,
  type ServiceIdentity,
} from "../service-identity";

const SPAN_COLOR_CLASSES = [
  "bg-blue-500",
  "bg-cyan-500",
  "bg-violet-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-sky-500",
  "bg-fuchsia-500",
];

export function spanColorClass(spanType: string): string {
  if (isSystemSpanType(spanType)) return "bg-slate-400/80 dark:bg-slate-500/80";
  let hash = 0;
  for (let i = 0; i < spanType.length; i++) {
    hash = (hash * 31 + spanType.charCodeAt(i)) | 0;
  }
  return SPAN_COLOR_CLASSES[Math.abs(hash) % SPAN_COLOR_CLASSES.length];
}

const NAME_COLUMN = "minmax(200px, 260px)";
const DURATION_COLUMN = "76px";
const FULL_VIEW: ViewWindow = { start: 0, end: 1 };

export const SPAN_ROW_HEIGHT_PX = 32;
export const EVENT_ROW_HEIGHT_PX = 28;
export const LINK_ROW_HEIGHT_PX = 28;
const ROW_OVERSCAN = 20;
const INITIAL_VIEWPORT_GUESS_PX = 1200;

export type TraceWaterfallLink = {
  ownerSpanId: string,
  linkedTraceId: string,
  linkedSpanId: string,
  linkedProjectId: string,
  linkedBranchId: string,
  targetIsSameScope: boolean,
};

export type TraceWaterfallRow = WaterfallRow | {
  kind: "link",
  link: TraceWaterfallLink,
  depth: number,
};

export function computeRowOffsets(rows: readonly TraceWaterfallRow[]): number[] {
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < rows.length; i++) {
    offsets[i + 1] = offsets[i] + (
      rows[i].kind === "span"
        ? SPAN_ROW_HEIGHT_PX
        : rows[i].kind === "link" ? LINK_ROW_HEIGHT_PX : EVENT_ROW_HEIGHT_PX
    );
  }
  return offsets;
}

export type RowWindow = {
  startIndex: number,
  endIndex: number,
};

function countOffsetsAtOrBelow(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= y) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function computeRowWindow(offsets: number[], viewTopPx: number, viewBottomPx: number, overscan: number): RowWindow {
  const rowCount = offsets.length - 1;
  if (rowCount === 0) return { startIndex: 0, endIndex: 0 };
  const firstVisible = Math.min(Math.max(countOffsetsAtOrBelow(offsets, viewTopPx) - 1, 0), rowCount);
  const endVisible = Math.min(Math.max(countOffsetsAtOrBelow(offsets, Math.max(viewBottomPx, viewTopPx)), firstVisible), rowCount);
  return {
    startIndex: Math.max(firstVisible - overscan, 0),
    endIndex: Math.min(endVisible + overscan, rowCount),
  };
}

function findScrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent != null; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  return null;
}

type DragSelection = {
  anchor: number,
  current: number,
};

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function timelineFraction(clientX: number, rect: { left: number, width: number }): number {
  if (rect.width <= 0) return 0;
  return clampUnit((clientX - rect.left) / rect.width);
}

function collectSubtreeSpanIds(node: TraceNode): string[] {
  return [
    node.span.id,
    ...node.children.flatMap(collectSubtreeSpanIds),
  ];
}

function flattenVisibleTrace(
  trace: Trace,
  collapsedSpanIds: Set<string>,
  linksByOwnerSpanId: ReadonlyMap<string, readonly TraceWaterfallLink[]>,
): TraceWaterfallRow[] {
  const rows: TraceWaterfallRow[] = [];
  const walk = (node: TraceNode) => {
    rows.push({ kind: "span", node });
    for (const link of linksByOwnerSpanId.get(node.span.id) ?? []) {
      rows.push({ kind: "link", link, depth: node.depth + 1 });
    }
    if (collapsedSpanIds.has(node.span.id)) return;
    const items: { atMs: number, row: () => void }[] = [
      ...node.events.map((event) => ({ atMs: event.atMs, row: () => rows.push({ kind: "event", event, depth: node.depth + 1 }) })),
      ...node.children.map((child) => ({ atMs: child.span.startMs, row: () => walk(child) })),
    ];
    items.sort((a, b) => a.atMs - b.atMs);
    for (const item of items) item.row();
  };
  walk(trace.root);
  return rows;
}

function flattenSignalTrace(
  trace: Trace,
  needle: string,
  linksByOwnerSpanId: ReadonlyMap<string, readonly TraceWaterfallLink[]>,
): TraceWaterfallRow[] {
  const signalIds = traceSignalSpanIds(trace, 20, needle);
  const ancestry: TraceNode[] = [];
  const promoteLinkedOwners = (node: TraceNode) => {
    if (linksByOwnerSpanId.has(node.span.id)) {
      signalIds.add(node.span.id);
      for (const ancestor of ancestry) signalIds.add(ancestor.span.id);
    }
    ancestry.push(node);
    for (const child of node.children) promoteLinkedOwners(child);
    ancestry.pop();
  };
  promoteLinkedOwners(trace.root);

  const rows: TraceWaterfallRow[] = [];
  const walk = (node: TraceNode, visibleDepth: number) => {
    if (!signalIds.has(node.span.id)) return;
    rows.push({ kind: "span", node: { ...node, depth: visibleDepth } });
    for (const link of linksByOwnerSpanId.get(node.span.id) ?? []) {
      rows.push({ kind: "link", link, depth: visibleDepth + 1 });
    }
    for (const event of node.events) {
      rows.push({ kind: "event", event, depth: visibleDepth + 1 });
    }
    for (const child of node.children) walk(child, visibleDepth + 1);
  };
  walk(trace.root, 0);
  return rows;
}

function defaultCollapsedSpanIds(root: TraceNode): Set<string> {
  const collapsed = new Set<string>();
  const walk = (node: TraceNode) => {
    if (node.depth >= 1 && (node.children.length > 0 || node.events.length > 0)) {
      collapsed.add(node.span.id);
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return collapsed;
}

export function shouldShowCollapseControl(mode: "signal" | "all", hasChildren: boolean): boolean {
  return mode === "all" && hasChildren;
}

export function waterfallRowMatchesHighlight(row: TraceWaterfallRow, highlight: TraceEventHighlight): boolean {
  if (row.kind === "span") {
    return highlight.eventType == null
      && highlight.eventAtMs == null
      && highlight.spanId != null
      && row.node.span.id === highlight.spanId;
  }
  if (row.kind === "event") {
    return eventMatchesHighlight(row.event, highlight);
  }
  return false;
}

export function findHighlightedRowIndex(
  rows: readonly TraceWaterfallRow[],
  highlight: TraceEventHighlight,
): number | null {
  const index = rows.findIndex((row) => waterfallRowMatchesHighlight(row, highlight));
  return index < 0 ? null : index;
}

const HIGHLIGHT_ROW_CLASSES = "bg-cyan-500/10 ring-1 ring-inset ring-cyan-500/35";

function TimelineGridlines() {
  return (
    <>
      {[25, 50, 75].map((pct) => (
        <span key={pct} className="absolute inset-y-0 w-px bg-border/40" style={{ left: `${pct}%` }} />
      ))}
    </>
  );
}

function DragSelectionOverlay({ selection }: { selection: DragSelection | null }) {
  if (selection == null) return null;
  const left = Math.min(selection.anchor, selection.current) * 100;
  const width = Math.abs(selection.current - selection.anchor) * 100;
  return (
    <span
      className="pointer-events-none absolute inset-y-0 rounded-sm border border-blue-500/70 bg-blue-500/15"
      style={{ left: `${left}%`, width: `${width}%` }}
    />
  );
}

function TraceHeaderStat({ icon, value, label }: { icon: React.ReactNode, value: number | string, label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground">
          {icon}
          <span className="font-mono text-[11px]">{value}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function TraceWaterfall({
  trace,
  services,
  nowMs,
  needle,
  unattachedEventCount,
  links,
  highlight = null,
  onSelectSpan,
  onSelectEvent,
  onOpenLink,
}: {
  trace: Trace,
  services: ServiceIdentity[],
  nowMs: number,
  needle: string,
  unattachedEventCount: number,
  links: readonly TraceWaterfallLink[],
  highlight?: TraceEventHighlight | null,
  onSelectSpan: (span: SpanInput) => void,
  onSelectEvent: (event: EventInput) => void,
  onOpenLink: (link: TraceWaterfallLink) => void,
}) {
  const [mode, setMode] = useState<"signal" | "all">("signal");
  const [collapsedSpanIds, setCollapsedSpanIds] = useState<Set<string>>(() => defaultCollapsedSpanIds(trace.root));
  const linksByOwnerSpanId = useMemo(() => {
    const result = new Map<string, TraceWaterfallLink[]>();
    for (const link of links) {
      const ownerLinks = result.get(link.ownerSpanId);
      if (ownerLinks === undefined) result.set(link.ownerSpanId, [link]);
      else ownerLinks.push(link);
    }
    return result;
  }, [links]);
  const signalRows = useMemo(
    () => flattenSignalTrace(trace, needle, linksByOwnerSpanId),
    [linksByOwnerSpanId, needle, trace],
  );
  const allRows = useMemo(
    () => flattenVisibleTrace(trace, collapsedSpanIds, linksByOwnerSpanId),
    [collapsedSpanIds, linksByOwnerSpanId, trace],
  );
  const rows = mode === "signal" ? signalRows : allRows;
  const signalSpanCount = signalRows.filter((row) => row.kind === "span").length;
  const hiddenSignalSpanCount = trace.spanCount - signalSpanCount;
  const errorCount = useMemo(() => traceErrorCount(trace), [trace]);
  const unplacedLinkCount = useMemo(() => {
    const spanIds = new Set<string>();
    const walk = (node: TraceNode) => {
      spanIds.add(node.span.id);
      for (const child of node.children) walk(child);
    };
    walk(trace.root);
    return links.filter((link) => !spanIds.has(link.ownerSpanId)).length;
  }, [links, trace.root]);

  // Hand-rolled windowing instead of @tanstack/react-virtual: all row heights
  // are fixed constants, so `computeRowOffsets`/`computeRowWindow` give exact
  // geometry with no DOM measurement, which keeps highlight-scrolling
  // (`rowOffsets[highlightedRowIndex]`) synchronous and unit-testable without
  // a dedicated scroll container — the list scrolls with the surrounding page.
  const rowOffsets = useMemo(() => computeRowOffsets(rows), [rows]);
  const listRef = useRef<HTMLDivElement>(null);
  const [rowWindow, setRowWindow] = useState<RowWindow>(
    () => computeRowWindow(rowOffsets, 0, INITIAL_VIEWPORT_GUESS_PX, ROW_OVERSCAN),
  );
  useEffect(() => {
    const list = listRef.current;
    if (list == null) return;
    const scroller = findScrollParent(list);
    const measure = () => {
      const listTop = list.getBoundingClientRect().top;
      const viewTop = scroller != null ? scroller.getBoundingClientRect().top : 0;
      const viewHeight = scroller != null ? scroller.clientHeight : window.innerHeight;
      const topPx = viewTop - listTop;
      setRowWindow((prev) => {
        const next = computeRowWindow(rowOffsets, topPx, topPx + viewHeight, ROW_OVERSCAN);
        return next.startIndex === prev.startIndex && next.endIndex === prev.endIndex ? prev : next;
      });
    };
    measure();
    const scrollTarget: EventTarget = scroller ?? window;
    scrollTarget.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      scrollTarget.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [rowOffsets]);
  const windowStart = Math.min(rowWindow.startIndex, rows.length);
  const windowEnd = Math.max(Math.min(rowWindow.endIndex, rows.length), windowStart);
  const topSpacerPx = rowOffsets[windowStart];
  const bottomSpacerPx = rowOffsets[rows.length] - rowOffsets[windowEnd];
  const visibleRows = rows.slice(windowStart, windowEnd);

  const [view, setView] = useState<ViewWindow>(FULL_VIEW);
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const rootSpanId = trace.root.span.id;
  useEffect(() => {
    setView(FULL_VIEW);
    setMode("signal");
    setCollapsedSpanIds(defaultCollapsedSpanIds(trace.root));
  }, [rootSpanId, trace.root]);

  const highlightSpanId = highlight?.spanId ?? null;
  const highlightEventType = highlight?.eventType ?? null;
  const highlightEventAtMs = highlight?.eventAtMs ?? null;
  const activeHighlight = useMemo((): TraceEventHighlight | null => {
    if (highlightSpanId == null && highlightEventType == null && highlightEventAtMs == null) return null;
    return { spanId: highlightSpanId, eventType: highlightEventType, eventAtMs: highlightEventAtMs };
  }, [highlightEventAtMs, highlightEventType, highlightSpanId]);
  const highlightedRowIndex = activeHighlight == null ? null : findHighlightedRowIndex(rows, activeHighlight);

  useEffect(() => {
    if (activeHighlight == null) return;
    const idsToExpand = spanIdsToExpandForHighlight(trace.root, activeHighlight);
    if (idsToExpand.length > 0) {
      setCollapsedSpanIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const id of idsToExpand) {
          if (next.delete(id)) changed = true;
        }
        return changed ? next : prev;
      });
    }
    if (findHighlightedRowIndex(signalRows, activeHighlight) == null) {
      setMode("all");
    }
  }, [activeHighlight, signalRows, trace.root]);

  useEffect(() => {
    if (highlightedRowIndex == null) return;
    const list = listRef.current;
    if (list == null) return;
    const rowTop = rowOffsets[highlightedRowIndex];
    const scroller = findScrollParent(list);
    const listRect = list.getBoundingClientRect();
    if (scroller == null) {
      const target = window.scrollY + listRect.top + rowTop - window.innerHeight * 0.3;
      window.scrollTo({ top: Math.max(target, 0) });
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const target = scroller.scrollTop + (listRect.top - scrollerRect.top) + rowTop - scroller.clientHeight * 0.3;
    scroller.scrollTo({ top: Math.max(target, 0) });
  }, [highlightedRowIndex, rootSpanId, rowOffsets]);

  const scaleStart = trace.startMs;
  const scaleEnd = getTraceScaleEnd(trace, nowMs);
  const totalSpanMs = scaleEnd - scaleStart;
  const viewStartMs = scaleStart + view.start * totalSpanMs;
  const viewSpanMs = Math.max((view.end - view.start) * totalSpanMs, 1e-9);
  const toPct = (ms: number) => ((ms - viewStartMs) / viewSpanMs) * 100;
  const isZoomed = view.start > 0 || view.end < 1;

  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container == null) return;
    const handleWheel = (e: WheelEvent) => {
      const track = trackRef.current;
      if (track == null) return;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      const current = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const anchorFrac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
        setView((prev) => zoomViewWindow(prev, anchorFrac, Math.exp(e.deltaY * 0.01)));
      } else if ((current.start > 0 || current.end < 1) && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        setView((prev) => panViewWindow(prev, e.deltaX / rect.width));
      }
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => () => {
    dragCleanupRef.current?.();
  }, []);

  const startTimelineDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = timelineFraction(event.clientX, rect);
    setDragSelection({ anchor, current: anchor });
    dragCleanupRef.current?.();

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setDragSelection({ anchor, current: timelineFraction(moveEvent.clientX, rect) });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      dragCleanupRef.current = null;
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      cleanup();
      const current = timelineFraction(upEvent.clientX, rect);
      setDragSelection(null);
      const start = Math.min(anchor, current);
      const end = Math.max(anchor, current);
      if (end - start < 0.015) return;
      setView((prev) => {
        const span = prev.end - prev.start;
        return {
          start: prev.start + start * span,
          end: prev.start + end * span,
        };
      });
    };
    const handlePointerCancel = () => {
      cleanup();
      setDragSelection(null);
    };
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  };

  const toggleCollapsed = (node: TraceNode, recursive: boolean) => {
    setCollapsedSpanIds((prev) => {
      const next = new Set(prev);
      const shouldCollapse = !next.has(node.span.id);
      const ids = recursive ? collectSubtreeSpanIds(node) : [node.span.id];
      for (const id of ids) {
        if (shouldCollapse) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }
      return next;
    });
  };

  const gridTemplateColumns = `${NAME_COLUMN} 1fr ${DURATION_COLUMN}`;

  return (
    <TooltipProvider>
      <div ref={containerRef} className="flex flex-col flex-1">
        <div>
          <div className="border-b border-border/50 px-4 py-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-sm font-semibold">{traceSpanDisplayName(trace.root.span)}</span>
              {trace.endMs == null ? (
                <DesignBadge label="Open" color="green" size="sm" />
              ) : trace.endMs > nowMs ? (
                <span className="font-mono text-xs text-muted-foreground" title={`Ends ${new Date(trace.endMs).toLocaleString()}`}>
                  {formatDuration(nowMs - trace.startMs)} →
                </span>
              ) : (
                <span className="font-mono text-xs text-muted-foreground">{formatDuration(trace.endMs - trace.startMs)}</span>
              )}
              {errorCount > 0 && (
                <DesignBadge label={`${errorCount} ${errorCount === 1 ? "error" : "errors"}`} color="red" size="sm" icon={WarningCircleIcon} />
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1 text-xs">
                <TraceHeaderStat icon={<StackIcon className="h-3.5 w-3.5" />} value={trace.spanCount.toLocaleString()} label={`${trace.spanCount.toLocaleString()} ${trace.spanCount === 1 ? "span" : "spans"}`} />
                <TraceHeaderStat icon={<ChartLineIcon className="h-3.5 w-3.5" />} value={trace.eventCount} label={`${trace.eventCount} ${trace.eventCount === 1 ? "event" : "events"}`} />
                <TraceHeaderStat icon={<ClockIcon className="h-3.5 w-3.5" />} value={new Date(trace.startMs).toLocaleTimeString()} label={`Started ${new Date(trace.startMs).toLocaleString()}`} />
                {unattachedEventCount > 0 && (
                  <TraceHeaderStat
                    icon={<ChartLineIcon className="h-3.5 w-3.5" />}
                    value={`+${unattachedEventCount}`}
                    label={`${unattachedEventCount} ${unattachedEventCount === 1 ? "event has" : "events have"} no enclosing span in this trace, so ${unattachedEventCount === 1 ? "it is" : "they are"} not placed in the waterfall`}
                  />
                )}
                {unplacedLinkCount > 0 && (
                  <TraceHeaderStat
                    icon={<LinkSimpleIcon className="h-3.5 w-3.5" />}
                    value={`+${unplacedLinkCount}`}
                    label={`${unplacedLinkCount} span ${unplacedLinkCount === 1 ? "link's owner span is" : "links' owner spans are"} not in the loaded waterfall (for example beyond the 10,000-span cap), so ${unplacedLinkCount === 1 ? "that link is" : "those links are"} not shown as rows`}
                  />
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center rounded p-1 text-muted-foreground">
                      <KeyboardIcon className="h-3.5 w-3.5" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="font-mono leading-relaxed">
                    <div>Drag timeline: zoom to range</div>
                    <div>Cmd/Ctrl + scroll: zoom</div>
                    <div>Horizontal scroll: pan</div>
                    <div>Option/Alt + caret: collapse subtree</div>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
            <div
              className="mt-1 truncate text-xs text-muted-foreground"
              title={services.map(serviceIdentityLabel).join(", ")}
            >
              {conciseServiceIdentitySummary(services)}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <DesignPillToggle
                options={[
                  { id: "signal", label: `Signal (${signalSpanCount})` },
                  { id: "all", label: `All spans (${trace.spanCount.toLocaleString()})` },
                ]}
                selected={mode}
                onSelect={(id) => setMode(id === "signal" ? "signal" : "all")}
                size="sm"
                gradient="cyan"
                glassmorphic={false}
              />
              {mode === "signal" && hiddenSignalSpanCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {hiddenSignalSpanCount.toLocaleString()} routine {hiddenSignalSpanCount === 1 ? "span" : "spans"} collapsed
                </span>
              )}
            </div>
          </div>

          <div className="grid gap-3 px-4 py-1.5 border-b border-border/30 shrink-0" style={{ gridTemplateColumns }}>
            <span className="font-mono text-[10px] text-muted-foreground">name</span>
            <div
              ref={trackRef}
              className="relative h-4 cursor-ew-resize"
              onPointerDown={startTimelineDrag}
              onClick={(e) => e.stopPropagation()}
            >
              <DragSelectionOverlay selection={dragSelection} />
              {[0, 25, 50, 75, 100].map((pct) => (
                <span
                  key={pct}
                  className={cn(
                "absolute top-0 font-mono text-[10px] text-muted-foreground/70 whitespace-nowrap",
                pct === 100 ? "-translate-x-full" : pct === 0 ? "" : "-translate-x-1/2",
              )}
                  style={{ left: `${pct}%` }}
                >
                  {formatDuration((viewStartMs - scaleStart) + (viewSpanMs * pct) / 100)}
                </span>
              ))}
            </div>
            <span className="font-mono text-[10px] text-muted-foreground text-right">
              {isZoomed ? (
                <button
                  className="rounded px-1 text-foreground/80 hover:text-foreground hover:bg-foreground/[0.08]"
                  onClick={() => setView(FULL_VIEW)}
                  title="Reset zoom"
                >
                  reset
                </button>
              ) : (
                "duration"
              )}
            </span>
          </div>
        </div>

        <div ref={listRef}>
          <div style={{ height: `${topSpacerPx}px` }} aria-hidden />
          {visibleRows.map((row, sliceIndex) => {
            const rowIndex = windowStart + sliceIndex;
            if (row.kind === "span") {
              const { span } = row.node;
              const hasChildren = row.node.children.length > 0 || row.node.events.length > 0;
              const collapsed = collapsedSpanIds.has(span.id);
              const endMs = span.endMs;
              const spanTiming = endMs == null
                ? { kind: "open" as const }
                : endMs > nowMs
                  ? { kind: "future" as const, endMs }
                  : { kind: "closed" as const, endMs };
              const open = spanTiming.kind === "open";
              const futureEndLabel = spanTiming.kind === "future"
                ? `Ends ${new Date(spanTiming.endMs).toLocaleString()}`
                : undefined;
              const barEndMs = spanTiming.kind === "closed" ? spanTiming.endMs : Math.min(nowMs, scaleEnd + viewSpanMs);
              const rawLeftPct = toPct(span.startMs);
              const rawRightPct = toPct(barEndMs);
              const barVisible = rawRightPct > 0 && rawLeftPct < 100;
              const leftPct = Math.max(rawLeftPct, 0);
              const rightPct = Math.min(rawRightPct, 100);
              const widthPct = Math.max(rightPct - leftPct, 0.4);
              const fades = open || futureEndLabel !== undefined;
              const hasError = spanHasError(span);
              const aiSummary = tryAiSpanSummaryFromRaw(span.raw);
              const isHighlighted = highlightedRowIndex === rowIndex;
              return (
                <div
                  key={`span-${span.id}`}
                  aria-current={isHighlighted ? "true" : undefined}
                  className={cn(
                    "group w-full grid gap-3 px-4 items-center h-8 border-b border-border/20 hover:bg-muted/30 transition-colors hover:transition-none text-left cursor-pointer",
                    isHighlighted && HIGHLIGHT_ROW_CLASSES,
                  )}
                  style={{ gridTemplateColumns }}
                  onClick={() => onSelectSpan(span)}
                >
                  <div className="flex items-center gap-1.5 min-w-0" style={{ paddingLeft: `${row.node.depth * 14}px` }}>
                    {shouldShowCollapseControl(mode, hasChildren) ? (
                      <button
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
                        title={collapsed ? "Expand" : "Collapse"}
                        aria-expanded={!collapsed}
                        onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapsed(row.node, e.altKey);
                        }}
                      >
                        <CaretRightIcon className={cn("h-3 w-3 transition-transform", !collapsed && "rotate-90")} />
                      </button>
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    <span className={cn("h-2 w-2 shrink-0 rounded-[3px]", hasError ? "bg-red-500" : spanColorClass(span.spanType))} />
                    <span className={cn("font-mono text-[11px] truncate", isSystemSpanType(span.spanType) ? "text-muted-foreground" : "font-medium")}>
                      {traceSpanDisplayName(span)}
                    </span>
                    {aiSummary != null && <AiSpanChip summary={aiSummary} />}
                    {hasError && <WarningCircleIcon className="h-3.5 w-3.5 shrink-0 text-red-500" weight="fill" />}
                  </div>
                  <div className="relative h-4 cursor-ew-resize" onPointerDown={startTimelineDrag} onClick={(e) => e.stopPropagation()}>
                    <TimelineGridlines />
                    <DragSelectionOverlay selection={dragSelection} />
                    {barVisible && (
                      <span
                        className={cn(
                        "absolute inset-y-0.5 rounded-sm",
                        hasError ? "bg-red-500" : spanColorClass(span.spanType),
                        fades && "[mask-image:linear-gradient(to_right,black_60%,transparent_100%)]",
                      )}
                        style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: "3px" }}
                        title={futureEndLabel}
                      />
                    )}
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground text-right">
                    {spanTiming.kind === "open"
                      ? "open"
                      : spanTiming.kind === "future"
                        ? <span title={futureEndLabel}>{formatDuration(nowMs - span.startMs)} →</span>
                        : formatDuration(spanTiming.endMs - span.startMs)}
                  </span>
                </div>
              );
            } else if (row.kind === "event") {
              const { event } = row;
              const leftPct = toPct(event.atMs);
              const isHighlighted = highlightedRowIndex === rowIndex;
              return (
                <div
                  key={`event-${rowIndex}`}
                  aria-current={isHighlighted ? "true" : undefined}
                  className={cn(
                    "w-full grid gap-3 px-4 items-center h-7 border-b border-border/20 hover:bg-muted/30 transition-colors hover:transition-none text-left cursor-pointer",
                    isHighlighted && HIGHLIGHT_ROW_CLASSES,
                  )}
                  style={{ gridTemplateColumns }}
                  onClick={() => onSelectEvent(event)}
                >
                  <div className="flex items-center gap-1.5 min-w-0" style={{ paddingLeft: `${row.depth * 14}px` }}>
                    <span className={cn("h-1.5 w-1.5 rotate-45 shrink-0", isHighlighted ? "bg-cyan-600 dark:bg-cyan-400" : "bg-foreground/50")} />
                    <span className={cn("font-mono text-[11px] truncate", isHighlighted ? "font-medium text-foreground" : "text-muted-foreground")}>{event.eventType}</span>
                  </div>
                  <div className="relative h-4 cursor-ew-resize" onPointerDown={startTimelineDrag} onClick={(e) => e.stopPropagation()}>
                    <TimelineGridlines />
                    <DragSelectionOverlay selection={dragSelection} />
                    {leftPct >= 0 && leftPct <= 100 && (
                      <span
                        className="absolute top-1/2 h-2 w-2 -translate-y-1/2 -translate-x-1/2 rotate-45 rounded-[2px] bg-foreground/60"
                        style={{ left: `${leftPct}%` }}
                      />
                    )}
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground/70 text-right">
                    +{formatDuration(event.atMs - scaleStart)}
                  </span>
                </div>
              );
            } else {
              const { link } = row;
              const targetLabel = `${link.linkedTraceId.slice(0, 8)}/${link.linkedSpanId.slice(0, 6)}`;
              const title = link.targetIsSameScope
                ? `Open linked span ${link.linkedSpanId} in trace ${link.linkedTraceId}`
                : `Linked span belongs to ${link.linkedProjectId}/${link.linkedBranchId}`;
              return (
                <button
                  key={`link-${link.ownerSpanId}-${link.linkedTraceId}-${link.linkedSpanId}`}
                  type="button"
                  disabled={!link.targetIsSameScope}
                  aria-label={title}
                  title={title}
                  className="group grid h-7 w-full items-center gap-3 border-b border-cyan-500/10 bg-cyan-500/[0.025] px-4 text-left outline-none transition-colors duration-150 enabled:cursor-pointer enabled:hover:bg-cyan-500/[0.07] enabled:hover:transition-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-cyan-500/40 disabled:cursor-default"
                  style={{ gridTemplateColumns }}
                  onClick={() => onOpenLink(link)}
                >
                  <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${row.depth * 14}px` }}>
                    <LinkSimpleIcon className="h-3.5 w-3.5 shrink-0 text-cyan-600 dark:text-cyan-400" />
                    <span className="shrink-0 font-mono text-[10px] font-medium uppercase tracking-wider text-cyan-700 dark:text-cyan-300">link</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">{targetLabel}</span>
                  </span>
                  <span className="relative flex h-4 items-center" aria-hidden>
                    <span className="w-full border-t border-dashed border-cyan-500/40" />
                    <ArrowRightIcon className="-ml-1 h-3 w-3 shrink-0 text-cyan-600 dark:text-cyan-400" />
                  </span>
                  <span className="truncate text-right font-mono text-[10px] text-muted-foreground">
                    {link.targetIsSameScope ? "same scope" : "external"}
                  </span>
                </button>
              );
            }
          })}
          <div style={{ height: `${bottomSpacerPx}px` }} aria-hidden />
        </div>
      </div>
    </TooltipProvider>
  );
}

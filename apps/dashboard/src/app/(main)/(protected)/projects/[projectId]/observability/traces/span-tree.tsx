"use client";

import { DesignBadge, DesignButton } from "@/components/design-components";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { cn } from "@/lib/utils";
import { CaretDownIcon, CaretRightIcon, SpinnerGapIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";
import { formatDuration, traceErrorCount, traceSpanDisplayName, type Trace, type TraceNode } from "./trace-utils";
import {
  conciseServiceIdentitySummary,
  serviceIdentitiesFromTraceRow,
  serviceIdentityLabel,
} from "../service-identity";

const ESTIMATED_TRACE_ROW_HEIGHT = 76;

function DurationLabel({ startMs, endMs, nowMs }: { startMs: number, endMs: number | null, nowMs: number }) {
  if (endMs == null) {
    return <DesignBadge label="Open" color="green" size="sm" />;
  }
  if (endMs > nowMs) {
    return (
      <span
        className="font-mono text-[11px] text-muted-foreground"
        title={`Ends ${new Date(endMs).toLocaleString()}`}
      >
        {formatDuration(nowMs - startMs)} →
      </span>
    );
  }
  return <span className="font-mono text-[11px] text-muted-foreground">{formatDuration(endMs - startMs)}</span>;
}

function stringValue(value: Json | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function userProfileLabel(node: TraceNode): string | null {
  return stringValue(node.span.raw.user_display_name)
    ?? stringValue(node.span.raw.user_primary_email);
}

function userProfileInitials(label: string): string {
  return label.trim().slice(0, 2).toUpperCase();
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function initialsAvatarDataUrl(initials: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="#e5e7eb"/><text x="20" y="24" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" font-weight="700" fill="#6b7280">${escapeSvgText(initials)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function TraceAvatar({ imageUrl, label }: { imageUrl: string | null, label: string | null }) {
  const avatarSrc = imageUrl ?? (label != null ? initialsAvatarDataUrl(userProfileInitials(label)) : undefined);
  return (
    <Avatar className="h-5 w-5 border border-border/60 bg-muted text-muted-foreground">
      <AvatarImage src={avatarSrc} alt={label ?? "User profile picture"} />
      <AvatarFallback className="bg-muted" title={label ?? "User profile"} />
    </Avatar>
  );
}

function TraceRow({
  trace,
  nowMs,
  active,
  onSelectSpan,
  nested = false,
  expander,
}: {
  trace: Trace,
  nowMs: number,
  active: boolean,
  onSelectSpan: (rootId: string) => void,
  nested?: boolean,
  expander?: { expanded: boolean, childCount: number, loading: boolean, onToggle: () => void },
}) {
  const root = trace.root;
  const userProfileImageUrl = stringValue(root.span.raw.user_profile_image_url);
  const userProfile = userProfileLabel(root);
  const errorCount = traceErrorCount(trace);
  const services = serviceIdentitiesFromTraceRow(root.span.raw);
  const serviceSummary = conciseServiceIdentitySummary(services);

  return (
    <div className={cn("relative flex h-full w-full", nested && "pl-5")}>
      {nested && (
        <span aria-hidden className="absolute bottom-0 left-2 top-0 w-px bg-border/50" />
      )}
      {expander != null && (
        <button
          type="button"
          aria-expanded={expander.expanded}
          aria-label={expander.expanded ? "Hide activity on this page view" : `Show ${expander.childCount} ${expander.childCount === 1 ? "activity" : "activities"} on this page view`}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            expander.onToggle();
          }}
          className="absolute left-0 top-3 z-10 flex h-5 w-5 items-center justify-center rounded text-muted-foreground outline-none transition-colors duration-150 hover:bg-foreground/[0.08] hover:text-foreground hover:transition-none focus-visible:ring-1 focus-visible:ring-foreground/20"
        >
          {expander.loading
            ? <SpinnerGapIcon className="h-3.5 w-3.5 animate-spin" />
            : expander.expanded ? <CaretDownIcon className="h-3.5 w-3.5" /> : <CaretRightIcon className="h-3.5 w-3.5" />}
        </button>
      )}
      <button
        type="button"
        className={cn(
        "grid h-full w-full grid-cols-[24px_minmax(0,1fr)] gap-2 border-b border-border/30 px-3 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-foreground/[0.04] hover:transition-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-foreground/20",
        expander != null && "pl-6",
        active && "bg-foreground/[0.06] hover:bg-foreground/[0.06]",
      )}
        onClick={() => onSelectSpan(root.span.id)}
      >
        <TraceAvatar imageUrl={userProfileImageUrl} label={userProfile} />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-foreground">
              {traceSpanDisplayName(root.span)}
            </span>
            <DurationLabel startMs={trace.startMs} endMs={trace.endMs} nowMs={nowMs} />
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <span
              className="min-w-0 flex-1 truncate"
              title={services.map(serviceIdentityLabel).join(", ")}
            >
              {serviceSummary}
            </span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{new Date(trace.startMs).toLocaleString()}</span>
            {errorCount > 0 && (
              <span className="inline-flex shrink-0 items-center gap-1 font-medium text-red-600 dark:text-red-400">
                <WarningCircleIcon className="h-3 w-3" />
                {errorCount}
              </span>
            )}
          </span>
        </span>
      </button>
    </div>
  );
}

export function pageViewChildCount(trace: Trace): number {
  const raw = trace.root.span.raw.child_count;
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new Error(`page view child_count must be a finite number, received ${String(raw)}`);
    }
    return raw;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`page view child_count must be a finite number, received ${JSON.stringify(raw)}`);
}

type ListRow =
  | { kind: "trace", key: string, trace: Trace, nested: boolean }
  | { kind: "loader", key: string };

export function SpanTreeList({
  traces,
  nowMs,
  activeSpanId,
  onSelectSpan,
  expandedPageViewIds,
  childrenByPageViewId,
  loadingPageViewIds,
  onTogglePageView,
  hasMore,
  loadingMore,
  loadMoreError,
  onLoadMore,
}: {
  traces: Trace[],
  nowMs: number,
  activeSpanId: string | null,
  onSelectSpan: (rootId: string) => void,
  expandedPageViewIds: ReadonlySet<string>,
  childrenByPageViewId: ReadonlyMap<string, Trace[]>,
  loadingPageViewIds: ReadonlySet<string>,
  onTogglePageView: (pageViewSpanId: string) => void,
  hasMore: boolean,
  loadingMore: boolean,
  loadMoreError: string | null,
  onLoadMore: () => void,
}) {
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const loaderRowVisible = hasMore || loadingMore || loadMoreError != null;

  const rows = useMemo<ListRow[]>(() => {
    const flattened: ListRow[] = [];
    for (const trace of traces) {
      const rootId = trace.root.span.id;
      flattened.push({ kind: "trace", key: rootId, trace, nested: false });
      if (!expandedPageViewIds.has(rootId)) continue;
      for (const child of childrenByPageViewId.get(rootId) ?? []) {
        flattened.push({ kind: "trace", key: `${rootId}>${child.root.span.id}`, trace: child, nested: true });
      }
    }
    if (loaderRowVisible) flattened.push({ kind: "loader", key: "trace-list-loader" });
    return flattened;
  }, [childrenByPageViewId, expandedPageViewIds, loaderRowVisible, traces]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => ESTIMATED_TRACE_ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => rows[index]?.key ?? "trace-list-loader",
  });
  const virtualRows = virtualizer.getVirtualItems();
  const lastVirtualRowIndex = virtualRows.at(-1)?.index ?? -1;

  useEffect(() => {
    if (lastVirtualRowIndex >= rows.length - 8 && hasMore && !loadingMore && loadMoreError == null) {
      onLoadMore();
    }
  }, [hasMore, lastVirtualRowIndex, loadMoreError, loadingMore, onLoadMore, rows.length]);

  return (
    <div ref={scrollElementRef} className="h-full overflow-y-auto overscroll-contain">
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualRows.map((virtualRow) => {
          const row = rows.at(virtualRow.index);
          if (row == null) return null;
          if (row.kind === "loader") {
            return (
              <div
                key={virtualRow.key}
                className="absolute left-0 top-0 flex w-full items-center justify-center border-t border-border/30 px-3 text-xs text-muted-foreground"
                style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}
              >
                {loadMoreError != null ? (
                  <DesignButton variant="plain" size="sm" onClick={onLoadMore}>
                    Retry loading older traces
                  </DesignButton>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <SpinnerGapIcon className="h-3.5 w-3.5 animate-spin" />
                    Loading older traces…
                  </span>
                )}
              </div>
            );
          }
          const trace = row.trace;
          const rootId = trace.root.span.id;
          const childCount = row.nested ? 0 : pageViewChildCount(trace);
          return (
            <div
              key={virtualRow.key}
              className="absolute left-0 top-0 w-full"
              style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}
            >
              <TraceRow
                trace={trace}
                nowMs={nowMs}
                active={rootId === activeSpanId}
                onSelectSpan={onSelectSpan}
                nested={row.nested}
                expander={childCount === 0 ? undefined : {
                  expanded: expandedPageViewIds.has(rootId),
                  childCount,
                  loading: loadingPageViewIds.has(rootId),
                  onToggle: () => onTogglePageView(rootId),
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}


import type { Json } from "@hexclave/shared/dist/utils/json";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import type { RowData } from "../../analytics/shared";

export type SpanInput = {
  traceId: string,
  id: string,
  spanType: string,
  startMs: number,
  endMs: number | null,
  parentSpanId: string | null,
  raw: RowData,
};

export type EventInput = {
  traceId: string | null,
  eventType: string,
  atMs: number,
  spanId: string | null,
  raw: RowData,
};

export type TraceNode = {
  span: SpanInput,
  depth: number,
  children: TraceNode[],
  events: EventInput[],
};

export type Trace = {
  root: TraceNode,
  spanCount: number,
  eventCount: number,
  startMs: number,
  endMs: number | null,
  latestMs: number,
};

export type WaterfallRow =
  | { kind: "span", node: TraceNode }
  | { kind: "event", event: EventInput, depth: number };

const GENERIC_HTTP_METHOD_SPAN = /^(?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/;
const INTERNAL_SDK_SPAN_TYPES = new Set(["hexclave.api.request"]);

function objectStringProperty(value: Json | undefined, property: string): string | null {
  if (!isRecord(value)) return null;
  const propertyValue = value[property];
  return typeof propertyValue === "string" && propertyValue !== "" ? propertyValue : null;
}

export function traceSpanDisplayName(span: SpanInput): string {
  if (span.raw.scope_name != null) {
    return objectStringProperty(span.raw.data, "name") ?? span.spanType;
  }
  if (!GENERIC_HTTP_METHOD_SPAN.test(span.spanType)) return span.spanType;
  const target = objectStringProperty(span.raw.data, "http.route")
    ?? objectStringProperty(span.raw.data, "http.target")
    ?? objectStringProperty(span.raw.data, "url.path");
  if (target == null) return span.spanType;
  const safePath = target.replace(/[?#].*$/, "");
  return safePath === "" ? span.spanType : `${span.spanType} ${safePath}`;
}

export function spanHasError(span: SpanInput): boolean {
  return span.raw.status_code === "error";
}

export function traceErrorCount(trace: Trace): number {
  let count = 0;
  const stack = [trace.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node == null) break;
    if (spanHasError(node.span)) count += 1;
    stack.push(...node.children);
  }
  return count;
}

export type TraceEventHighlight = {
  spanId: string | null,
  eventType: string | null,
  eventAtMs: number | null,
};

export function eventMatchesHighlight(event: EventInput, highlight: TraceEventHighlight): boolean {
  if (highlight.eventType == null && highlight.eventAtMs == null) return false;
  if (highlight.spanId != null && event.spanId !== highlight.spanId) return false;
  if (highlight.eventType != null && event.eventType !== highlight.eventType) return false;
  if (highlight.eventAtMs != null && event.atMs !== highlight.eventAtMs) return false;
  return true;
}

export function spanAncestorIds(root: TraceNode, spanId: string): string[] | null {
  const walk = (node: TraceNode, ancestors: string[]): string[] | null => {
    if (node.span.id === spanId) return ancestors;
    for (const child of node.children) {
      const found = walk(child, [...ancestors, node.span.id]);
      if (found != null) return found;
    }
    return null;
  };
  return walk(root, []);
}

function findSpanIdOwningHighlightedEvent(root: TraceNode, highlight: TraceEventHighlight): string | null {
  const walk = (node: TraceNode): string | null => {
    if (node.events.some((event) => eventMatchesHighlight(event, highlight))) return node.span.id;
    for (const child of node.children) {
      const found = walk(child);
      if (found != null) return found;
    }
    return null;
  };
  return walk(root);
}

export function spanIdsToExpandForHighlight(root: TraceNode, highlight: TraceEventHighlight): string[] {
  const spanId = highlight.spanId ?? findSpanIdOwningHighlightedEvent(root, highlight);
  if (spanId == null) return [];
  const ancestors = spanAncestorIds(root, spanId);
  if (ancestors == null) return [];
  return [...ancestors, spanId];
}

export function traceContainsSpanId(trace: Trace, spanId: string): boolean {
  const stack = [trace.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node == null) break;
    if (node.span.id === spanId) return true;
    stack.push(...node.children);
  }
  return false;
}

export function traceSignalSpanIds(trace: Trace, slowSpanLimit = 20, needle = ""): Set<string> {
  const selected = new Set<string>([trace.root.span.id]);
  const candidates: TraceNode[] = [];

  const selectWithAncestors = (node: TraceNode, ancestors: TraceNode[]) => {
    selected.add(node.span.id);
    for (const ancestor of ancestors) selected.add(ancestor.span.id);
  };

  const visit = (node: TraceNode, ancestors: TraceNode[]) => {
    const matchesSearch = needle !== "" && (
      traceSpanDisplayName(node.span).toLowerCase().includes(needle)
      || node.events.some((event) => event.eventType.toLowerCase().includes(needle))
    );
    const hasAutomaticSignal = spanHasError(node.span)
      || isCustomerAuthoredSpan(node.span)
      || node.events.length > 0;

    if (matchesSearch) {
      selectWithAncestors(node, ancestors);
    } else if (hasAutomaticSignal) {
      selectWithAncestors(node, ancestors);
    }
    if (node.span.id !== trace.root.span.id) {
      candidates.push(node);
    }

    for (const child of node.children) visit(child, [...ancestors, node]);
  };
  visit(trace.root, []);

  candidates.sort((left, right) => {
    const leftDuration = left.span.endMs == null ? Infinity : left.span.endMs - left.span.startMs;
    const rightDuration = right.span.endMs == null ? Infinity : right.span.endMs - right.span.startMs;
    return rightDuration - leftDuration || left.span.startMs - right.span.startMs;
  });
  const candidateIds = new Set(candidates.slice(0, slowSpanLimit).map((node) => node.span.id));

  const restoreSelectedPaths = (node: TraceNode, ancestors: TraceNode[]) => {
    if (candidateIds.has(node.span.id)) {
      selected.add(node.span.id);
      for (const ancestor of ancestors) selected.add(ancestor.span.id);
    }
    for (const child of node.children) restoreSelectedPaths(child, [...ancestors, node]);
  };
  restoreSelectedPaths(trace.root, []);
  return selected;
}

export function isSystemSpanType(spanType: string): boolean {
  return spanType.startsWith("$");
}

export function isCustomerAuthoredSpan(span: SpanInput): boolean {
  return !isSystemSpanType(span.spanType)
    && !INTERNAL_SDK_SPAN_TYPES.has(span.spanType)
    && span.raw.producer === "sdk"
    && span.raw.scope_name == null;
}

export type ViewWindow = { start: number, end: number };

const MIN_VIEW_SPAN = 1e-8;

export function zoomViewWindow(view: ViewWindow, anchorFrac: number, factor: number): ViewWindow {
  const span = view.end - view.start;
  const newSpan = Math.min(Math.max(span * factor, MIN_VIEW_SPAN), 1);
  const anchorAbs = view.start + anchorFrac * span;
  const start = Math.min(Math.max(anchorAbs - anchorFrac * newSpan, 0), 1 - newSpan);
  return { start, end: start + newSpan };
}

export function panViewWindow(view: ViewWindow, deltaFrac: number): ViewWindow {
  const span = view.end - view.start;
  const start = Math.min(Math.max(view.start + deltaFrac * span, 0), 1 - span);
  return { start, end: start + span };
}

export function getTraceScaleEnd(trace: Pick<Trace, "startMs" | "endMs" | "latestMs">, nowMs: number): number {
  const observedEnd = trace.endMs == null ? nowMs : Math.max(trace.endMs, trace.latestMs);
  return Math.max(Math.min(observedEnd, nowMs), trace.startMs + 1);
}

function spanTreeKey(traceId: string, spanId: string): string {
  return `${traceId}:${spanId}`;
}

export function buildTraces(spans: SpanInput[], events: EventInput[]): { traces: Trace[], unattachedEvents: EventInput[] } {
  const byKey = new Map<string, SpanInput>();
  for (const span of spans) {
    const key = spanTreeKey(span.traceId, span.id);
    if (!byKey.has(key)) byKey.set(key, span);
  }

  const parentOf = new Map<string, string | null>();
  for (const [key, span] of byKey) {
    const parentKey = span.parentSpanId == null || span.parentSpanId === span.id
      ? null
      : spanTreeKey(span.traceId, span.parentSpanId);
    parentOf.set(key, parentKey != null && byKey.has(parentKey) ? parentKey : null);
  }
  const resolved = new Set<string>();
  for (const key of byKey.keys()) {
    if (resolved.has(key)) continue;
    const path: string[] = [];
    const indexInPath = new Map<string, number>();
    let currentKey: string | null = key;
    while (currentKey != null && !resolved.has(currentKey)) {
      const cycleStart = indexInPath.get(currentKey);
      if (cycleStart !== undefined) {
        const cycleKeys = path.slice(cycleStart);
        cycleKeys.sort((leftKey, rightKey) => {
          const left = byKey.get(leftKey);
          const right = byKey.get(rightKey);
          if (left == null || right == null) {
            throw new Error("Cycle detection referenced a span outside the fetched span map");
          }
          return left.startMs - right.startMs || stringCompare(left.id, right.id);
        });
        const cycleRootKey = cycleKeys.at(0);
        if (cycleRootKey == null) {
          throw new Error("Cycle detection found an empty cycle");
        }
        parentOf.set(cycleRootKey, null);
        break;
      }
      indexInPath.set(currentKey, path.length);
      path.push(currentKey);
      currentKey = parentOf.get(currentKey) ?? null;
    }
    for (const pathKey of path) resolved.add(pathKey);
  }

  const childrenOf = new Map<string, SpanInput[]>();
  const roots: SpanInput[] = [];
  for (const [key, span] of byKey) {
    const parentKey = parentOf.get(key) ?? null;
    if (parentKey == null) {
      roots.push(span);
    } else {
      const siblings = childrenOf.get(parentKey) ?? [];
      siblings.push(span);
      childrenOf.set(parentKey, siblings);
    }
  }

  const eventsOf = new Map<string, EventInput[]>();
  const unattachedEvents: EventInput[] = [];
  for (const event of events) {
    const ownerKey = event.traceId == null || event.spanId == null
      ? null
      : spanTreeKey(event.traceId, event.spanId);
    if (ownerKey == null || !byKey.has(ownerKey)) {
      unattachedEvents.push(event);
    } else {
      const attached = eventsOf.get(ownerKey) ?? [];
      attached.push(event);
      eventsOf.set(ownerKey, attached);
    }
  }

  const traces = roots.map((rootSpan) => {
    const visited = new Set<string>();

    const buildNode = (span: SpanInput, depth: number): TraceNode => {
      const key = spanTreeKey(span.traceId, span.id);
      visited.add(key);
      const ownEvents = [...(eventsOf.get(key) ?? [])].sort((a, b) => a.atMs - b.atMs);
      const childSpans = [...(childrenOf.get(key) ?? [])]
        .filter((child) => !visited.has(spanTreeKey(child.traceId, child.id)))
        .sort((a, b) => a.startMs - b.startMs);
      return {
        span,
        depth,
        events: ownEvents,
        children: childSpans.map((child) => buildNode(child, depth + 1)),
      };
    };

    const root = buildNode(rootSpan, 0);
    return { root, ...computeTraceAggregates(root) } satisfies Trace;
  });

  traces.sort((a, b) => b.startMs - a.startMs);
  return { traces, unattachedEvents };
}

export function selectPrimaryTrace(traces: Trace[], traceId: string): Trace | null {
  return traces
    .filter((trace) => trace.root.span.traceId === traceId)
    .sort((a, b) =>
      Number(b.root.span.parentSpanId == null) - Number(a.root.span.parentSpanId == null)
      || a.startMs - b.startMs
      || b.spanCount - a.spanCount,
    )[0] ?? null;
}

function computeTraceAggregates(root: TraceNode): Omit<Trace, "root"> {
  let spanCount = 0;
  let eventCount = 0;
  let startMs = Infinity;
  let latestMs = -Infinity;
  let hasOpenSpan = false;
  let maxEndMs: number | null = null;
  const stack: TraceNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node == null) break;
    spanCount++;
    startMs = Math.min(startMs, node.span.startMs);
    latestMs = Math.max(latestMs, node.span.startMs);
    if (node.span.endMs == null) {
      hasOpenSpan = true;
    } else {
      maxEndMs = maxEndMs == null ? node.span.endMs : Math.max(maxEndMs, node.span.endMs);
      latestMs = Math.max(latestMs, node.span.endMs);
    }
    eventCount += node.events.length;
    for (const event of node.events) {
      startMs = Math.min(startMs, event.atMs);
      latestMs = Math.max(latestMs, event.atMs);
    }
    stack.push(...node.children);
  }
  return {
    spanCount,
    eventCount,
    startMs,
    endMs: hasOpenSpan ? null : maxEndMs,
    latestMs,
  };
}

export function flattenTrace(trace: Trace): WaterfallRow[] {
  const rows: WaterfallRow[] = [];
  const walk = (node: TraceNode) => {
    rows.push({ kind: "span", node });
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

export { formatDuration } from "../format";

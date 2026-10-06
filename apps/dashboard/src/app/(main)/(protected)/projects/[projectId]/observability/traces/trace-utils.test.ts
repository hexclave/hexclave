import { describe, expect, it } from "vitest";
import { buildTraces, eventMatchesHighlight, flattenTrace, formatDuration, getTraceScaleEnd, isSystemSpanType, panViewWindow, selectPrimaryTrace, spanAncestorIds, spanIdsToExpandForHighlight, traceContainsSpanId, traceErrorCount, traceSignalSpanIds, traceSpanDisplayName, zoomViewWindow, type EventInput, type SpanInput } from "./trace-utils";

function span(id: string, opts: Partial<SpanInput> = {}): SpanInput {
  return {
    traceId: opts.traceId ?? "test-trace",
    id,
    spanType: opts.spanType ?? id,
    startMs: opts.startMs ?? 1000,
    endMs: opts.endMs === undefined ? 2000 : opts.endMs,
    parentSpanId: opts.parentSpanId ?? null,
    raw: opts.raw ?? { producer: "sdk" },
  };
}

function event(eventType: string, opts: Partial<EventInput> = {}): EventInput {
  return {
    traceId: opts.traceId === undefined ? "test-trace" : opts.traceId,
    eventType,
    atMs: opts.atMs ?? 1500,
    spanId: opts.spanId ?? null,
    raw: opts.raw ?? {},
  };
}

describe("traceSpanDisplayName", () => {
  it("shows the recorded library operation when the span has an instrumentation scope", () => {
    expect(traceSpanDisplayName(span("normalized-library", {
      spanType: "STACK:-external-db-sync.poller.iteration",
      raw: {
        scope_name: "stack-backend",
        data: { name: "STACK: external-db-sync.poller.iteration" },
      },
    }))).toBe("STACK: external-db-sync.poller.iteration");
    expect(traceSpanDisplayName(span("unnamed-library", {
      spanType: "prisma:client:db_query",
      raw: { scope_name: "prisma", data: {} },
    }))).toBe("prisma:client:db_query");
  });

  it("adds a safe route to generic HTTP root names", () => {
    expect(traceSpanDisplayName(span("root", {
      spanType: "POST",
      raw: { data: { "http.target": "/api/v1/analytics/events/batch?token=secret#fragment" } },
    }))).toBe("POST /api/v1/analytics/events/batch");
    expect(traceSpanDisplayName(span("root", { spanType: "checkout" }))).toBe("checkout");
    expect(traceSpanDisplayName(span("root", { spanType: "GET", raw: { data: {} } }))).toBe("GET");
  });
});

describe("buildTraces", () => {
  it("builds a tree from scalar parents and attaches events to their enclosing span", () => {
    const spans = [
      span("root", { startMs: 1000, endMs: 5000 }),
      span("child", { startMs: 2000, endMs: 4000, parentSpanId: "root" }),
      span("grandchild", { startMs: 2500, endMs: 3000, parentSpanId: "child" }),
    ];
    const events = [
      event("added", { atMs: 2600, spanId: "grandchild" }),
      event("started", { atMs: 1100, spanId: "root" }),
    ];

    const { traces, unattachedEvents } = buildTraces(spans, events);
    expect(traces).toHaveLength(1);
    expect(unattachedEvents).toHaveLength(0);

    const trace = traces[0];
    expect(trace.root.span.id).toBe("root");
    expect(trace.root.children.map((c) => c.span.id)).toEqual(["child"]);
    expect(trace.root.children[0].children.map((c) => c.span.id)).toEqual(["grandchild"]);
    expect(trace.root.events.map((e) => e.eventType)).toEqual(["started"]);
    expect(trace.root.children[0].children[0].events.map((e) => e.eventType)).toEqual(["added"]);
    expect(trace.spanCount).toBe(3);
    expect(trace.eventCount).toBe(2);
    expect(trace.startMs).toBe(1000);
    expect(trace.endMs).toBe(5000);
    expect(traceContainsSpanId(trace, "root")).toBe(true);
    expect(traceContainsSpanId(trace, "grandchild")).toBe(true);
    expect(traceContainsSpanId(trace, "missing")).toBe(false);
  });

  it("keeps one trace per trace id, newest first", () => {
    const { traces } = buildTraces([
      span("older-root", { traceId: "older", startMs: 1000 }),
      span("newer-root", { traceId: "newer", startMs: 9000 }),
      span("newer-child", { traceId: "newer", startMs: 9100, parentSpanId: "newer-root" }),
    ], []);

    expect(traces.map((trace) => trace.root.span.id)).toEqual(["newer-root", "older-root"]);
    expect(traces[0].spanCount).toBe(2);
  });

  it("does not resolve a parent id that only exists in a different trace", () => {
    const { traces } = buildTraces([
      span("shared-id", { traceId: "other-trace", startMs: 1000 }),
      span("root", { traceId: "trace", startMs: 2000 }),
      span("child", { traceId: "trace", startMs: 2100, parentSpanId: "shared-id" }),
    ], []);

    expect(traces
      .filter((trace) => trace.root.span.traceId === "trace")
      .map((trace) => trace.root.span.id)).toEqual(["child", "root"]);
  });

  it("keeps identical span ids from different W3C traces distinct", () => {
    const { traces } = buildTraces([
      span("shared-id", { traceId: "older", startMs: 1000 }),
      span("shared-id", { traceId: "newer", startMs: 2000 }),
    ], [
      event("older-event", { traceId: "older", spanId: "shared-id" }),
      event("newer-event", { traceId: "newer", spanId: "shared-id" }),
    ]);

    expect(traces.map((trace) => `${trace.root.span.traceId}:${trace.root.span.id}`)).toEqual([
      "newer:shared-id",
      "older:shared-id",
    ]);
    expect(traces[0].root.events.map((item) => item.eventType)).toEqual(["newer-event"]);
    expect(traces[1].root.events.map((item) => item.eventType)).toEqual(["older-event"]);
  });

  it("marks a trace open (endMs null) when any span is open and tracks latestMs", () => {
    const spans = [
      span("root", { startMs: 1000, endMs: 8000 }),
      span("open-child", { startMs: 2000, endMs: null, parentSpanId: "root" }),
    ];
    const events = [event("late", { atMs: 9500, spanId: "root" })];
    const { traces } = buildTraces(spans, events);
    expect(traces[0].endMs).toBeNull();
    expect(traces[0].latestMs).toBe(9500);
  });

  it("widens startMs to include events that precede their span's start", () => {
    const { traces } = buildTraces(
      [span("root", { startMs: 5000, endMs: 9000 })],
      [event("early", { atMs: 3000, spanId: "root" })],
    );
    expect(traces[0].startMs).toBe(3000);
  });

  it("returns events with an unknown or absent enclosing span as unattached", () => {
    const { traces, unattachedEvents } = buildTraces(
      [span("root")],
      [event("orphan", { spanId: "not-fetched" }), event("bare", { spanId: null })],
    );
    expect(traces[0].eventCount).toBe(0);
    expect(unattachedEvents.map((e) => e.eventType)).toEqual(["orphan", "bare"]);
  });

  it("survives hand-crafted parent cycles without infinite recursion", () => {
    const spans = [
      span("x", { parentSpanId: "y" }),
      span("y", { parentSpanId: "x" }),
    ];
    const { traces } = buildTraces(spans, []);
    const seen = new Set<string>();
    for (const trace of traces) {
      for (const row of flattenTrace(trace)) {
        if (row.kind === "span") {
          expect(seen.has(row.node.span.id)).toBe(false);
          seen.add(row.node.span.id);
        }
      }
    }
    expect(traces).toHaveLength(1);
    expect(seen).toEqual(new Set(["x", "y"]));
  });

  it("treats a self-parenting span as a root rather than looping", () => {
    const { traces } = buildTraces([
      span("root", { startMs: 1000 }),
      span("self", { startMs: 1100, parentSpanId: "self" }),
    ], []);

    expect(traces.map((trace) => trace.root.span.id)).toEqual(["self", "root"]);
  });

  it("dedupes duplicate span ids, keeping the first occurrence", () => {
    const spans = [
      span("dup", { spanType: "kept", startMs: 1000 }),
      span("dup", { spanType: "dropped", startMs: 2000 }),
    ];
    const { traces } = buildTraces(spans, []);
    expect(traces).toHaveLength(1);
    expect(traces[0].root.span.spanType).toBe("kept");
  });
});

describe("buildTraces missing-parent tolerance", () => {
  it("restores the old behavior by rendering a span with an unfetched parent as a real root", () => {
    const { traces } = buildTraces([
      span("root", { startMs: 1000, endMs: 9000 }),
      span("leaf", { startMs: 1200, endMs: 1800, parentSpanId: "not-fetched" }),
      span("leaf-child", { startMs: 1300, endMs: 1700, parentSpanId: "leaf" }),
    ], []);

    expect(traces.map((trace) => trace.root.span.id)).toEqual(["leaf", "root"]);
    expect(traces[0].root.children.map((node) => node.span.id)).toEqual(["leaf-child"]);
    expect(traces[0].spanCount).toBe(2);
    expect(traces[1].spanCount).toBe(1);
  });

  it("selectPrimaryTrace prefers the true root over newer fragments of the same trace", () => {
    const { traces } = buildTraces([
      span("session-root", { spanType: "$refresh-token", startMs: 1000, endMs: null }),
      span("old-page-view", { spanType: "$page-view", startMs: 1100, endMs: 1900, parentSpanId: "session-root" }),
      span("fragment-request", { spanType: "GET /api/users", startMs: 5000, endMs: 5100, parentSpanId: "unexported-page-view" }),
      span("fragment-child", { spanType: "resolve page components", startMs: 5010, endMs: 5020, parentSpanId: "fragment-request" }),
      span("other-trace-root", { traceId: "other-trace", startMs: 9000 }),
    ], []);

    const primary = selectPrimaryTrace(traces, "test-trace");
    expect(primary?.root.span.id).toBe("session-root");
    expect(traces.some((trace) => trace.root.span.id === "fragment-request")).toBe(true);
    expect(selectPrimaryTrace(traces, "other-trace")?.root.span.id).toBe("other-trace-root");
    expect(selectPrimaryTrace(traces, "missing-trace")).toBeNull();
  });
});

describe("getTraceScaleEnd", () => {
  it("extends an open trace through now even when its latest observation is at the start", () => {
    expect(getTraceScaleEnd({ startMs: 1000, endMs: null, latestMs: 1000 }, 10_000)).toBe(10_000);
  });

  it("includes late observations, clamps future ends to now, and preserves a non-zero scale", () => {
    expect(getTraceScaleEnd({ startMs: 1000, endMs: 5000, latestMs: 7000 }, 10_000)).toBe(7000);
    expect(getTraceScaleEnd({ startMs: 1000, endMs: 50_000, latestMs: 5000 }, 10_000)).toBe(10_000);
    expect(getTraceScaleEnd({ startMs: 1000, endMs: 1000, latestMs: 1000 }, 10_000)).toBe(1001);
  });
});

describe("flattenTrace", () => {
  it("interleaves a span's events and child spans chronologically at depth+1", () => {
    const spans = [
      span("root", { startMs: 1000, endMs: 9000 }),
      span("child-early", { startMs: 2000, endMs: 3000, parentSpanId: "root" }),
      span("child-late", { startMs: 6000, endMs: 7000, parentSpanId: "root" }),
    ];
    const events = [event("between", { atMs: 4000, spanId: "root" })];
    const { traces } = buildTraces(spans, events);
    const rows = flattenTrace(traces[0]);
    expect(rows.map((r) => (r.kind === "span" ? r.node.span.id : r.event.eventType))).toEqual([
      "root",
      "child-early",
      "between",
      "child-late",
    ]);
    expect(rows.map((r) => (r.kind === "span" ? r.node.depth : r.depth))).toEqual([0, 1, 1, 1]);
  });
});

describe("zoomViewWindow / panViewWindow", () => {
  it("zooms in around the anchor point and keeps it fixed", () => {
    const zoomed = zoomViewWindow({ start: 0, end: 1 }, 0.5, 0.5);
    expect(zoomed.start).toBeCloseTo(0.25);
    expect(zoomed.end).toBeCloseTo(0.75);
    const anchorAbsBefore = 0 + 0.5 * 1;
    const anchorAbsAfter = zoomed.start + 0.5 * (zoomed.end - zoomed.start);
    expect(anchorAbsAfter).toBeCloseTo(anchorAbsBefore);
  });

  it("clamps zoom-out to the full timeline and zoom position to [0, 1]", () => {
    expect(zoomViewWindow({ start: 0.25, end: 0.75 }, 0.5, 10)).toEqual({ start: 0, end: 1 });
    const nearEdge = zoomViewWindow({ start: 0, end: 1 }, 0, 0.5);
    expect(nearEdge.start).toBe(0);
    expect(nearEdge.end).toBeCloseTo(0.5);
  });

  it("pans by a fraction of the view width and clamps at the edges", () => {
    const panned = panViewWindow({ start: 0.2, end: 0.4 }, 0.5);
    expect(panned.start).toBeCloseTo(0.3);
    expect(panned.end).toBeCloseTo(0.5);
    expect(panViewWindow({ start: 0.8, end: 1 }, 5)).toEqual({ start: 0.8, end: 1 });
    expect(panViewWindow({ start: 0, end: 0.2 }, -5)).toEqual({ start: 0, end: 0.2 });
  });
});


describe("trace signal selection", () => {
  it("keeps causal paths to errors, events, custom spans, and slow system spans", () => {
    const spans = [
      span("root", { spanType: "$page-view", startMs: 0, endMs: 1000 }),
      span("fast", { spanType: "$render", startMs: 10, endMs: 11, parentSpanId: "root" }),
      span("client", { spanType: "HTTP GET", startMs: 20, endMs: 900, parentSpanId: "fast", raw: { kind: "client", scope_name: "@opentelemetry/instrumentation-fetch" } }),
      span("error-parent", { spanType: "$middleware", startMs: 30, endMs: 40, parentSpanId: "root" }),
      span("error", {
        spanType: "$db-query",
        startMs: 31,
        endMs: 32,
        parentSpanId: "error-parent",
        raw: { status_code: "error", producer: "sdk" },
      }),
      span("checkout", { spanType: "checkout", startMs: 50, endMs: 60, parentSpanId: "root" }),
      span("event-owner", { spanType: "$render", startMs: 70, endMs: 80, parentSpanId: "root" }),
      span("noise", { spanType: "$noise", startMs: 90, endMs: 91, parentSpanId: "root" }),
    ];
    const events = [event("cart.updated", { atMs: 75, spanId: "event-owner" })];
    const { traces } = buildTraces(spans, events);

    expect([...traceSignalSpanIds(traces[0], 1)]).toMatchInlineSnapshot(`
      [
        "root",
        "error",
        "error-parent",
        "checkout",
        "event-owner",
        "client",
        "fast",
      ]
    `);
    expect(traceErrorCount(traces[0])).toBe(1);
    expect([...traceSignalSpanIds(traces[0], 0, "noise")]).toEqual([
      "root",
      "error",
      "error-parent",
      "checkout",
      "event-owner",
      "noise",
    ]);
  });

  it("reduces a 3,000-span system instrumentation fan-out to the root and 20 slow spans", () => {
    const spans = [
      span("root", { spanType: "$page-view", startMs: 0, endMs: 10_000 }),
      ...Array.from({ length: 2999 }, (_, index) => span(`noise-${index}`, {
        spanType: "$db-query",
        startMs: index + 1,
        endMs: index + 2,
        parentSpanId: "root",
      })),
    ];
    const { traces } = buildTraces(spans, []);

    expect(traces[0].spanCount).toBe(3000);
    expect([...traceSignalSpanIds(traces[0])]).toEqual([
      "root",
      ...Array.from({ length: 20 }, (_, index) => `noise-${index}`),
    ]);
  });

  it("thins out an auto-instrumented fan-out but always keeps customer-authored spans", () => {
    const spans = [
      span("root", { spanType: "$page-view", startMs: 0, endMs: 1000 }),
      span("checkout", { spanType: "checkout", startMs: 1, endMs: 2, parentSpanId: "root" }),
      ...Array.from({ length: 50 }, (_, index) => span(`orm-${index}`, {
        spanType: "prisma:query",
        startMs: index + 1,
        endMs: index + 2,
        parentSpanId: "root",
        raw: { producer: "sdk", scope_name: "prisma" },
      })),
    ];
    const { traces } = buildTraces(spans, []);
    expect([...traceSignalSpanIds(traces[0], 0)]).toEqual(["root", "checkout"]);
  });

  it("keeps internal API request fan-out compact without hiding customer spans", () => {
    const spans = [
      span("root", { spanType: "$page-view", startMs: 0, endMs: 10_000 }),
      span("checkout", { spanType: "checkout", startMs: 1, endMs: 2, parentSpanId: "root" }),
      ...Array.from({ length: 100 }, (_, index) => span(`request-${index}`, {
        spanType: "hexclave.api.request",
        startMs: index + 10,
        endMs: index + 11,
        parentSpanId: "root",
        raw: { producer: "sdk", scope_name: null },
      })),
    ];
    const { traces } = buildTraces(spans, []);

    expect(traces[0].spanCount).toBe(102);
    expect([...traceSignalSpanIds(traces[0])]).toEqual([
      "root",
      "checkout",
      ...Array.from({ length: 19 }, (_, index) => `request-${index}`),
    ]);
    expect([...traceSignalSpanIds(traces[0], 0)]).toEqual(["root", "checkout"]);
  });

  it("keeps the causal path through a standard OTel HTTP client span", () => {
    const spans = [
      span("refresh", { spanType: "$refresh-token", startMs: 0, endMs: 10_000 }),
      span("replay", { spanType: "$session-replay", startMs: 10, endMs: 9000, parentSpanId: "refresh" }),
      span("segment", { spanType: "$session-replay-segment", startMs: 20, endMs: 8000, parentSpanId: "replay" }),
      span("page", { spanType: "$page-view", startMs: 30, endMs: 7000, parentSpanId: "segment" }),
      span("client", { spanType: "HTTP GET", startMs: 40, endMs: 6000, parentSpanId: "page", raw: { kind: "client", scope_name: "@opentelemetry/instrumentation-fetch" } }),
      span("middleware", {
        spanType: "middleware-GET",
        startMs: 50,
        endMs: 5900,
        parentSpanId: "client",
        raw: { producer: "sdk", scope_name: "next", status_code: "error" },
      }),
      span("get", {
        spanType: "GET",
        startMs: 60,
        endMs: 5800,
        parentSpanId: "middleware",
        raw: { producer: "sdk", scope_name: "next" },
      }),
      span("route", {
        spanType: "executing-api-route-app-page",
        startMs: 70,
        endMs: 5700,
        parentSpanId: "get",
        raw: { producer: "sdk", scope_name: "next" },
      }),
      span("api", {
        spanType: "hexclave.api.request",
        startMs: 80,
        endMs: 5600,
        parentSpanId: "route",
        raw: { producer: "sdk", scope_name: null },
      }),
      span("stack", {
        spanType: "STACK:-handling-API-request",
        startMs: 90,
        endMs: 5500,
        parentSpanId: "api",
        raw: { producer: "sdk", scope_name: "stack-backend" },
      }),
      span("response", {
        spanType: "STACK:-creating-HTTP-response-from-smart-response",
        startMs: 100,
        endMs: 5400,
        parentSpanId: "stack",
        raw: { producer: "sdk", scope_name: "stack-backend" },
      }),
    ];
    const events = [event("internal.diagnostic", { atMs: 110, spanId: "response" })];
    const { traces } = buildTraces(spans, events);

    expect(flattenTrace(traces[0]).filter((row) => row.kind === "span")).toHaveLength(spans.length);
    expect(traceSignalSpanIds(traces[0], 0)).toEqual(new Set(spans.map((item) => item.id)));
  });
});

describe("formatDuration", () => {
  it("formats across magnitudes", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(0.5)).toBe("500µs");
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(2500)).toBe("2.5s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(90_000_000)).toBe("1d 1h");
    expect(formatDuration(NaN)).toBe("—");
  });
});

describe("isSystemSpanType", () => {
  it("flags $-prefixed types as system", () => {
    expect(isSystemSpanType("$page-view")).toBe(true);
    expect(isSystemSpanType("checkout")).toBe(false);
  });
});

describe("event highlight identity", () => {
  it("matches a custom event by enclosing span, type, and epoch-ms", () => {
    const checkout = event("checkout_completed", { spanId: "page-view", atMs: 1_720_000_000_000 });
    expect(eventMatchesHighlight(checkout, {
      spanId: "page-view",
      eventType: "checkout_completed",
      eventAtMs: 1_720_000_000_000,
    })).toBe(true);
    expect(eventMatchesHighlight(checkout, {
      spanId: "other-span",
      eventType: "checkout_completed",
      eventAtMs: 1_720_000_000_000,
    })).toBe(false);
    expect(eventMatchesHighlight(checkout, {
      spanId: "page-view",
      eventType: "checkout_completed",
      eventAtMs: 1_720_000_000_001,
    })).toBe(false);
  });

  it("does not treat a span-only highlight as an event match", () => {
    expect(eventMatchesHighlight(event("checkout_completed", { spanId: "page-view" }), {
      spanId: "page-view",
      eventType: null,
      eventAtMs: null,
    })).toBe(false);
  });
});

describe("spanIdsToExpandForHighlight", () => {
  it("expands the owning span and its ancestors so a nested event is visible", () => {
    const { traces } = buildTraces([
      span("page-view", { spanType: "$page-view" }),
      span("checkout", { parentSpanId: "page-view", startMs: 1100, endMs: 1800 }),
    ], [
      event("item_added", { spanId: "checkout", atMs: 1200 }),
    ]);
    const root = traces[0].root;
    expect(spanAncestorIds(root, "checkout")).toEqual(["page-view"]);
    expect(spanIdsToExpandForHighlight(root, {
      spanId: "checkout",
      eventType: "item_added",
      eventAtMs: 1200,
    })).toEqual(["page-view", "checkout"]);
  });
});

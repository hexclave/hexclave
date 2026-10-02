// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Trace, WaterfallRow } from "./trace-utils";
import { computeRowOffsets, computeRowWindow, findHighlightedRowIndex, shouldShowCollapseControl, TraceWaterfall, type TraceWaterfallRow } from "./waterfall";

afterEach(cleanup);

beforeEach(() => {
  const scrollToMock = vi.fn();
  window.scrollTo = scrollToMock;
});

function spanRow(id: string): WaterfallRow {
  return {
    kind: "span",
    node: {
      span: { traceId: "trace", id, spanType: "op", startMs: 0, endMs: 1, parentSpanId: null, raw: {} },
      depth: 0,
      children: [],
      events: [],
    },
  };
}

function eventRow(): WaterfallRow {
  return {
    kind: "event",
    depth: 1,
    event: { traceId: null, eventType: "checkout", atMs: 0, spanId: null, raw: {} },
  };
}

function linkRow(): TraceWaterfallRow {
  return {
    kind: "link",
    depth: 1,
    link: {
      ownerSpanId: "owner",
      linkedTraceId: "0123456789abcdef0123456789abcdef",
      linkedSpanId: "fedcba9876543210",
      linkedProjectId: "internal",
      linkedBranchId: "main",
      targetIsSameScope: true,
    },
  };
}

function waterfallProps(trace: Trace) {
  return {
    trace,
    services: [],
    nowMs: 1010,
    needle: "",
    unattachedEventCount: 0,
    links: [],
    onSelectSpan: () => {},
    onSelectEvent: () => {},
    onOpenLink: () => {},
  };
}

describe("shouldShowCollapseControl", () => {
  it("only exposes collapse controls when the active mode honors collapsed state", () => {
    expect(shouldShowCollapseControl("signal", true)).toBe(false);
    expect(shouldShowCollapseControl("all", true)).toBe(true);
    expect(shouldShowCollapseControl("all", false)).toBe(false);
  });
});

describe("TraceWaterfall span names", () => {
  it("renders a library operation from the recorded name instead of the indexed span type", () => {
    const librarySpan = {
      traceId: "trace",
      id: "library-root",
      spanType: "prisma:client:db_query",
      startMs: 1000,
      endMs: 1010,
      parentSpanId: null,
      raw: {
        producer: "sdk",
        scope_name: "prisma",
        data: {
          name: "prisma:client:db_query",
          tracer_name: "prisma",
        },
      },
    };
    const trace: Trace = {
      root: {
        span: librarySpan,
        depth: 0,
        children: [],
        events: [],
      },
      spanCount: 1,
      eventCount: 0,
      startMs: 1000,
      endMs: 1010,
      latestMs: 1010,
    };

    render(createElement(TraceWaterfall, waterfallProps(trace)));

    expect(screen.getAllByText("prisma:client:db_query")).toHaveLength(2);
  });

  it("shows a compact AI chip with model and token usage on AI span rows", () => {
    const trace: Trace = {
      root: {
        span: {
          traceId: "trace",
          id: "ai-root",
          spanType: "chat gpt-4o-mini",
          startMs: 1000,
          endMs: 1010,
          parentSpanId: null,
          raw: {
            producer: "sdk",
            gen_ai_operation_name: "chat",
            gen_ai_request_model: "gpt-4o-mini",
            gen_ai_input_tokens: "811",
            gen_ai_output_tokens: "92",
          },
        },
        depth: 0,
        children: [],
        events: [],
      },
      spanCount: 1,
      eventCount: 0,
      startMs: 1000,
      endMs: 1010,
      latestMs: 1010,
    };

    render(createElement(TraceWaterfall, waterfallProps(trace)));

    expect(screen.getByText("gpt-4o-mini · 811→92 tok")).not.toBeNull();
  });

  it("renders no AI chip for a span without gen_ai_operation_name", () => {
    const trace: Trace = {
      root: {
        span: { traceId: "trace", id: "plain", spanType: "checkout", startMs: 1000, endMs: 1010, parentSpanId: null, raw: { producer: "sdk", gen_ai_operation_name: null } },
        depth: 0,
        children: [],
        events: [],
      },
      spanCount: 1,
      eventCount: 0,
      startMs: 1000,
      endMs: 1010,
      latestMs: 1010,
    };

    render(createElement(TraceWaterfall, waterfallProps(trace)));

    expect(screen.queryByText(/tok/)).toBeNull();
  });

  it("shows a linked span directly beneath its owner and opens it", () => {
    const openLink = vi.fn();
    const trace: Trace = {
      root: {
        span: { traceId: "server-trace", id: "server-span", spanType: "request", startMs: 1000, endMs: 1010, parentSpanId: null, raw: {} },
        depth: 0,
        children: [],
        events: [],
      },
      spanCount: 1,
      eventCount: 0,
      startMs: 1000,
      endMs: 1010,
      latestMs: 1010,
    };
    const link = {
      ownerSpanId: "server-span",
      linkedTraceId: "0123456789abcdef0123456789abcdef",
      linkedSpanId: "fedcba9876543210",
      linkedProjectId: "internal",
      linkedBranchId: "main",
      targetIsSameScope: true,
    };

    render(createElement(TraceWaterfall, {
      ...waterfallProps(trace),
      links: [link],
      onOpenLink: openLink,
    }));

    const linkRow = screen.getByRole("button", { name: "Open linked span fedcba9876543210 in trace 0123456789abcdef0123456789abcdef" });
    expect(linkRow.textContent).toContain("01234567/fedcba");
    linkRow.click();
    expect(openLink).toHaveBeenCalledWith(link);
  });

  it("shows a cross-scope link but refuses to navigate to it", () => {
    const openLink = vi.fn();
    const trace: Trace = {
      root: {
        span: { traceId: "server-trace", id: "server-span", spanType: "request", startMs: 1000, endMs: 1010, parentSpanId: null, raw: {} },
        depth: 0,
        children: [],
        events: [],
      },
      spanCount: 1,
      eventCount: 0,
      startMs: 1000,
      endMs: 1010,
      latestMs: 1010,
    };
    const link = {
      ownerSpanId: "server-span",
      linkedTraceId: "0123456789abcdef0123456789abcdef",
      linkedSpanId: "fedcba9876543210",
      linkedProjectId: "other-project",
      linkedBranchId: "main",
      targetIsSameScope: false,
    };

    render(createElement(TraceWaterfall, {
      ...waterfallProps(trace),
      links: [link],
      onOpenLink: openLink,
    }));

    const linkRow = screen.getByRole("button", { name: "Linked span belongs to other-project/main" });
    expect(linkRow.hasAttribute("disabled")).toBe(true);
    linkRow.click();
    expect(openLink).not.toHaveBeenCalled();
  });
});

describe("computeRowOffsets", () => {
  it("accumulates the fixed span/event/link row heights", () => {
    expect(computeRowOffsets([spanRow("a"), eventRow(), linkRow(), eventRow(), spanRow("b")])).toEqual([0, 32, 60, 88, 116, 148]);
  });

  it("returns a single zero offset for an empty row list", () => {
    expect(computeRowOffsets([])).toEqual([0]);
  });

});

describe("computeRowWindow", () => {
  const spanOffsets = computeRowOffsets(Array.from({ length: 10 }, (_, i) => spanRow(`s${i}`)));

  it("windows the rows overlapping the scrollport", () => {
    expect(computeRowWindow(spanOffsets, 0, 100, 0)).toEqual({ startIndex: 0, endIndex: 4 });
  });

  it("extends the window by the overscan on both edges", () => {
    expect(computeRowWindow(spanOffsets, 100, 200, 2)).toEqual({ startIndex: 1, endIndex: 9 });
  });

  it("clamps a scrollport past the end of the list", () => {
    expect(computeRowWindow(spanOffsets, 1000, 1200, 2)).toEqual({ startIndex: 8, endIndex: 10 });
  });

  it("clamps a scrollport above the start of the list", () => {
    expect(computeRowWindow(spanOffsets, -1000, -500, 2)).toEqual({ startIndex: 0, endIndex: 2 });
  });

  it("windows mixed span/event heights at their exact boundaries", () => {
    const offsets = computeRowOffsets([spanRow("a"), eventRow(), eventRow(), spanRow("b")]);
    expect(computeRowWindow(offsets, 59, 61, 0)).toEqual({ startIndex: 1, endIndex: 3 });
  });

  it("never produces an inverted window when the viewport collapses", () => {
    expect(computeRowWindow(spanOffsets, 100, 50, 0)).toEqual({ startIndex: 3, endIndex: 4 });
  });

  it("returns an empty window for an empty row list", () => {
    expect(computeRowWindow(computeRowOffsets([]), 0, 1000, 20)).toEqual({ startIndex: 0, endIndex: 0 });
  });
});

describe("waterfall highlight", () => {
  it("matches a nested custom event by type and epoch-ms, not the enclosing span", () => {
    const rows: TraceWaterfallRow[] = [
      spanRow("page-view"),
      {
        kind: "event",
        depth: 1,
        event: { traceId: "trace", eventType: "checkout", atMs: 0, spanId: "page-view", raw: {} },
      },
    ];
    expect(findHighlightedRowIndex(rows, {
      spanId: "page-view",
      eventType: "checkout",
      eventAtMs: 0,
    })).toBe(1);
    expect(findHighlightedRowIndex(rows, {
      spanId: "page-view",
      eventType: null,
      eventAtMs: null,
    })).toBe(0);
  });

  it("marks the highlighted event as the current row", () => {
    const checkout = {
      traceId: "trace",
      id: "page-view",
      spanType: "$page-view",
      startMs: 1000,
      endMs: 1010,
      parentSpanId: null,
      raw: { producer: "sdk" },
    };
    const trace: Trace = {
      root: {
        span: checkout,
        depth: 0,
        children: [],
        events: [{
          traceId: "trace",
          eventType: "item_added",
          atMs: 1005,
          spanId: "page-view",
          raw: {},
        }],
      },
      spanCount: 1,
      eventCount: 1,
      startMs: 1000,
      endMs: 1010,
      latestMs: 1010,
    };

    render(createElement(TraceWaterfall, {
      ...waterfallProps(trace),
      highlight: { spanId: "page-view", eventType: "item_added", eventAtMs: 1005 },
    }));

    expect(screen.getByText("item_added").closest("[aria-current=true]")).not.toBeNull();
  });
});

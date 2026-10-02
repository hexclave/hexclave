import { describe, expect, it } from "vitest";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { pageViewChildCount } from "./span-tree";
import type { Trace } from "./trace-utils";

function traceWithChildCount(childCount?: Json): Trace {
  return {
    root: {
      span: {
        traceId: "t",
        id: "s",
        spanType: "page-view",
        startMs: 0,
        endMs: 1,
        parentSpanId: null,
        raw: childCount === undefined ? {} : { child_count: childCount },
      },
      depth: 0,
      children: [],
      events: [],
    },
    spanCount: 1,
    eventCount: 0,
    startMs: 0,
    endMs: 1,
    latestMs: 1,
  };
}

describe("pageViewChildCount", () => {
  it("defaults only when the list query omitted the count", () => {
    expect(pageViewChildCount(traceWithChildCount())).toBe(0);
    expect(pageViewChildCount(traceWithChildCount(null))).toBe(0);
    expect(pageViewChildCount(traceWithChildCount(4))).toBe(4);
    expect(pageViewChildCount(traceWithChildCount("3"))).toBe(3);
  });

  it("rejects garbage instead of coercing it to zero", () => {
    expect(() => pageViewChildCount(traceWithChildCount(Number.NaN))).toThrow(/child_count/);
    expect(() => pageViewChildCount(traceWithChildCount("nope"))).toThrow(/child_count/);
  });
});

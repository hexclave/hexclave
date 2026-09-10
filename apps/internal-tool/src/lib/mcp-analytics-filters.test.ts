import { Timestamp } from "spacetimedb";
import { describe, expect, it } from "vitest";
import { QA_REVIEW_FAILED_THRESHOLD_MICROS } from "../../spacetimedb/src/log-filters";
import type { McpCallLogRow } from "../types";
import {
  countActiveMcpFilters,
  DEFAULT_MCP_ANALYTICS_FILTERS,
  filterMcpCalls,
  type McpAnalyticsFilters,
  parseHumanReviewState,
  parseQaState,
  parseStatusFilter,
  parseTimeRange,
  rangeStartMillis,
} from "./mcp-analytics-filters";

const NOW_MILLIS = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR_MILLIS = 60 * 60 * 1000;

function timestamp(millis: number): Timestamp {
  return new Timestamp(BigInt(millis) * 1000n);
}

/**
 * Only the columns `mcpLogMatches` reads are meaningful here; the rest exist to
 * satisfy the row type. Cast because McpCallLogRow is generated from the module
 * schema and carries ~30 columns irrelevant to filtering.
 */
function row(overrides: Partial<McpCallLogRow> & { createdAtMillis?: number }): McpCallLogRow {
  const { createdAtMillis = NOW_MILLIS, ...rest } = overrides;
  return {
    toolName: "ask_hexclave",
    errorMessage: undefined,
    qaOverallScore: undefined,
    qaErrorMessage: undefined,
    qaNeedsHumanReview: undefined,
    humanReviewedAt: undefined,
    qaFlagsJson: undefined,
    createdAt: timestamp(createdAtMillis),
    qaReviewRequestedAt: timestamp(createdAtMillis),
    ...rest,
  } as McpCallLogRow;
}

function filters(overrides: Partial<McpAnalyticsFilters> = {}): McpAnalyticsFilters {
  return { ...DEFAULT_MCP_ANALYTICS_FILTERS, ...overrides };
}

describe("rangeStartMillis", () => {
  it("returns null for the unbounded range", () => {
    expect(rangeStartMillis("all", NOW_MILLIS)).toBeNull();
  });

  it("subtracts the range width from now", () => {
    expect(rangeStartMillis("24h", NOW_MILLIS)).toBe(NOW_MILLIS - 24 * HOUR_MILLIS);
    expect(rangeStartMillis("7d", NOW_MILLIS)).toBe(NOW_MILLIS - 7 * 24 * HOUR_MILLIS);
    expect(rangeStartMillis("30d", NOW_MILLIS)).toBe(NOW_MILLIS - 30 * 24 * HOUR_MILLIS);
  });
});

describe("parsers", () => {
  it("accept every value the page procedure accepts", () => {
    expect(parseTimeRange("30d")).toBe("30d");
    expect(parseStatusFilter("error")).toBe("error");
    expect(parseQaState("feature-request")).toBe("feature-request");
    expect(parseQaState("all")).toBe("all");
    expect(parseHumanReviewState("not-reviewed")).toBe("not-reviewed");
    expect(parseHumanReviewState("all")).toBe("all");
  });

  // A select rendering an option the filter cannot honour would silently show
  // unfiltered data, so every parser fails loudly instead of falling back.
  it("throw on anything else", () => {
    expect(() => parseTimeRange("90d")).toThrow(/Unexpected time range/);
    expect(() => parseStatusFilter("warn")).toThrow(/Unexpected status filter/);
    expect(() => parseQaState("passed")).toThrow(/Unexpected QA state filter/);
    expect(() => parseHumanReviewState("done")).toThrow(/Unexpected human review state filter/);
  });
});

describe("countActiveMcpFilters", () => {
  it("counts nothing for the defaults", () => {
    expect(countActiveMcpFilters(DEFAULT_MCP_ANALYTICS_FILTERS)).toBe(0);
  });

  it("counts each non-default dimension", () => {
    expect(countActiveMcpFilters(filters({ timeRange: "24h", status: "error", qaState: "fail" }))).toBe(3);
    expect(countActiveMcpFilters(filters({ toolName: "ask_hexclave", humanReviewState: "required" }))).toBe(2);
  });
});

describe("filterMcpCalls", () => {
  it("returns every row under the default filters", () => {
    const rows = [row({}), row({ toolName: "give_feedback" }), row({ errorMessage: "boom" })];
    expect(filterMcpCalls(rows, DEFAULT_MCP_ANALYTICS_FILTERS, NOW_MILLIS)).toHaveLength(3);
  });

  it("excludes rows older than the range, keeping the boundary row", () => {
    const rows = [
      row({ createdAtMillis: NOW_MILLIS - 23 * HOUR_MILLIS, toolName: "inside" }),
      row({ createdAtMillis: NOW_MILLIS - 24 * HOUR_MILLIS, toolName: "boundary" }),
      row({ createdAtMillis: NOW_MILLIS - 25 * HOUR_MILLIS, toolName: "outside" }),
    ];
    const kept = filterMcpCalls(rows, filters({ timeRange: "24h" }), NOW_MILLIS).map(r => r.toolName);
    expect(kept).toEqual(["inside", "boundary"]);
  });

  it("filters by tool name", () => {
    const rows = [row({ toolName: "ask_hexclave" }), row({ toolName: "give_feedback" })];
    const kept = filterMcpCalls(rows, filters({ toolName: "give_feedback" }), NOW_MILLIS);
    expect(kept.map(r => r.toolName)).toEqual(["give_feedback"]);
  });

  it("separates errored calls from healthy ones", () => {
    const rows = [row({ toolName: "ok" }), row({ toolName: "bad", errorMessage: "upstream 504" })];
    expect(filterMcpCalls(rows, filters({ status: "error" }), NOW_MILLIS).map(r => r.toolName)).toEqual(["bad"]);
    expect(filterMcpCalls(rows, filters({ status: "ok" }), NOW_MILLIS).map(r => r.toolName)).toEqual(["ok"]);
  });

  it("buckets QA scores the same way the module does", () => {
    const rows = [
      row({ toolName: "pass", qaOverallScore: 80 }),
      row({ toolName: "warn", qaOverallScore: 79 }),
      row({ toolName: "fail", qaOverallScore: 49 }),
    ];
    expect(filterMcpCalls(rows, filters({ qaState: "pass" }), NOW_MILLIS).map(r => r.toolName)).toEqual(["pass"]);
    expect(filterMcpCalls(rows, filters({ qaState: "warn" }), NOW_MILLIS).map(r => r.toolName)).toEqual(["warn"]);
    expect(filterMcpCalls(rows, filters({ qaState: "fail" }), NOW_MILLIS).map(r => r.toolName)).toEqual(["fail"]);
  });

  it("treats a row with a review error as `error`, not `pending`", () => {
    const rows = [row({ qaErrorMessage: "model timed out" })];
    expect(filterMcpCalls(rows, filters({ qaState: "error" }), NOW_MILLIS)).toHaveLength(1);
    expect(filterMcpCalls(rows, filters({ qaState: "pending" }), NOW_MILLIS)).toHaveLength(0);
  });

  // This is the one bucket that changes with nothing but the passage of time,
  // which is why `now` is an argument rather than read from the clock inside.
  it("ages an unreviewed row out of `pending` into `review-failed`", () => {
    const thresholdMillis = Number(QA_REVIEW_FAILED_THRESHOLD_MICROS / 1000n);
    const rows = [row({ createdAtMillis: NOW_MILLIS - thresholdMillis - 1000 })];

    expect(filterMcpCalls(rows, filters({ qaState: "pending" }), NOW_MILLIS)).toHaveLength(0);
    expect(filterMcpCalls(rows, filters({ qaState: "review-failed" }), NOW_MILLIS)).toHaveLength(1);

    const justAfterInsert = NOW_MILLIS - thresholdMillis;
    expect(filterMcpCalls(rows, filters({ qaState: "pending" }), justAfterInsert)).toHaveLength(1);
    expect(filterMcpCalls(rows, filters({ qaState: "review-failed" }), justAfterInsert)).toHaveLength(0);
  });

  it("finds capability-gap flags", () => {
    const rows = [
      row({ toolName: "gap", qaOverallScore: 74, qaFlagsJson: JSON.stringify([{ type: "unsupported_feature_request" }]) }),
      row({ toolName: "plain", qaOverallScore: 74, qaFlagsJson: JSON.stringify([{ type: "incomplete_answer" }]) }),
    ];
    const kept = filterMcpCalls(rows, filters({ qaState: "feature-request" }), NOW_MILLIS);
    expect(kept.map(r => r.toolName)).toEqual(["gap"]);
  });

  it("distinguishes the three human-review states", () => {
    const rows = [
      row({ toolName: "required", qaNeedsHumanReview: true }),
      row({ toolName: "done", qaNeedsHumanReview: true, humanReviewedAt: timestamp(NOW_MILLIS) }),
      row({ toolName: "untouched" }),
    ];
    expect(filterMcpCalls(rows, filters({ humanReviewState: "required" }), NOW_MILLIS).map(r => r.toolName)).toEqual(["required"]);
    expect(filterMcpCalls(rows, filters({ humanReviewState: "reviewed" }), NOW_MILLIS).map(r => r.toolName)).toEqual(["done"]);
    expect(filterMcpCalls(rows, filters({ humanReviewState: "not-reviewed" }), NOW_MILLIS).map(r => r.toolName)).toEqual(["required", "untouched"]);
  });

  it("applies every dimension together", () => {
    const rows = [
      row({ toolName: "ask_hexclave", qaOverallScore: 30, qaNeedsHumanReview: true }),
      row({ toolName: "ask_hexclave", qaOverallScore: 30, qaNeedsHumanReview: true, humanReviewedAt: timestamp(NOW_MILLIS) }),
      row({ toolName: "give_feedback", qaOverallScore: 30, qaNeedsHumanReview: true }),
      row({ toolName: "ask_hexclave", qaOverallScore: 30, qaNeedsHumanReview: true, createdAtMillis: NOW_MILLIS - 40 * 24 * HOUR_MILLIS }),
    ];
    const kept = filterMcpCalls(
      rows,
      filters({ timeRange: "30d", toolName: "ask_hexclave", qaState: "fail", humanReviewState: "required" }),
      NOW_MILLIS,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].humanReviewedAt).toBeUndefined();
  });
});

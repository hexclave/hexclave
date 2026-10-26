import { Timestamp } from "spacetimedb";
import { describe, expect, it } from "vitest";
import { QA_REVIEW_FAILED_THRESHOLD_MICROS } from "../../spacetimedb/src/log-filters";
import type { McpCallLogRow } from "../types";
import {
  countActiveMcpFilters,
  DEFAULT_MCP_ANALYTICS_FILTERS,
  filterMcpCalls,
  type McpAnalyticsFilters,
} from "./mcp-analytics-filters";
import { rangeStartMillis } from "./filter-options";

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

describe("countActiveMcpFilters", () => {
  it("counts nothing for the defaults", () => {
    expect(countActiveMcpFilters(DEFAULT_MCP_ANALYTICS_FILTERS)).toBe(0);
  });

  it("counts each non-default dimension", () => {
    expect(countActiveMcpFilters(filters({ timeRange: "24h", statuses: new Set(["error"]), qaStates: new Set(["fail"]) }))).toBe(3);
    // Both statuses selected filters nothing, so it must not count as an active filter.
    expect(countActiveMcpFilters(filters({ statuses: new Set(["ok", "error"]) }))).toBe(0);
    expect(countActiveMcpFilters(filters({ toolNames: new Set(["ask_hexclave"]), humanReviewStates: new Set(["required"]) }))).toBe(2);
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
    const kept = filterMcpCalls(rows, filters({ toolNames: new Set(["give_feedback"]) }), NOW_MILLIS);
    expect(kept.map(r => r.toolName)).toEqual(["give_feedback"]);
  });

  it("separates errored calls from healthy ones", () => {
    const rows = [row({ toolName: "ok" }), row({ toolName: "bad", errorMessage: "upstream 504" })];
    expect(filterMcpCalls(rows, filters({ statuses: new Set(["error"]) }), NOW_MILLIS).map(r => r.toolName)).toEqual(["bad"]);
    expect(filterMcpCalls(rows, filters({ statuses: new Set(["ok"]) }), NOW_MILLIS).map(r => r.toolName)).toEqual(["ok"]);
  });

  it("buckets QA scores the same way the module does", () => {
    const rows = [
      row({ toolName: "pass", qaOverallScore: 80 }),
      row({ toolName: "warn", qaOverallScore: 79 }),
      row({ toolName: "fail", qaOverallScore: 49 }),
    ];
    expect(filterMcpCalls(rows, filters({ qaStates: new Set(["pass"]) }), NOW_MILLIS).map(r => r.toolName)).toEqual(["pass"]);
    expect(filterMcpCalls(rows, filters({ qaStates: new Set(["warn"]) }), NOW_MILLIS).map(r => r.toolName)).toEqual(["warn"]);
    expect(filterMcpCalls(rows, filters({ qaStates: new Set(["fail"]) }), NOW_MILLIS).map(r => r.toolName)).toEqual(["fail"]);
  });

  it("treats a row with a review error as `error`, not `pending`", () => {
    const rows = [row({ qaErrorMessage: "model timed out" })];
    expect(filterMcpCalls(rows, filters({ qaStates: new Set(["error"]) }), NOW_MILLIS)).toHaveLength(1);
    expect(filterMcpCalls(rows, filters({ qaStates: new Set(["pending"]) }), NOW_MILLIS)).toHaveLength(0);
  });

  // This is the one bucket that changes with nothing but the passage of time,
  // which is why `now` is an argument rather than read from the clock inside.
  it("ages an unreviewed row out of `pending` into `review-failed`", () => {
    const thresholdMillis = Number(QA_REVIEW_FAILED_THRESHOLD_MICROS / 1000n);
    const rows = [row({ createdAtMillis: NOW_MILLIS - thresholdMillis - 1000 })];

    expect(filterMcpCalls(rows, filters({ qaStates: new Set(["pending"]) }), NOW_MILLIS)).toHaveLength(0);
    expect(filterMcpCalls(rows, filters({ qaStates: new Set(["review-failed"]) }), NOW_MILLIS)).toHaveLength(1);

    const justAfterInsert = NOW_MILLIS - thresholdMillis;
    expect(filterMcpCalls(rows, filters({ qaStates: new Set(["pending"]) }), justAfterInsert)).toHaveLength(1);
    expect(filterMcpCalls(rows, filters({ qaStates: new Set(["review-failed"]) }), justAfterInsert)).toHaveLength(0);
  });

  it("finds capability-gap flags", () => {
    const rows = [
      row({ toolName: "gap", qaOverallScore: 74, qaFlagsJson: JSON.stringify([{ type: "unsupported_feature_request", severity: "low", explanation: "Asked for SAML" }]) }),
      row({ toolName: "plain", qaOverallScore: 74, qaFlagsJson: JSON.stringify([{ type: "incomplete_answer" }]) }),
      // Type alone is not a renderable flag; it must not count as a feature request here either.
      row({ toolName: "type-only", qaOverallScore: 74, qaFlagsJson: JSON.stringify([{ type: "unsupported_feature_request" }]) }),
    ];
    const kept = filterMcpCalls(rows, filters({ qaStates: new Set(["feature-request"]) }), NOW_MILLIS);
    expect(kept.map(r => r.toolName)).toEqual(["gap"]);
  });

  it("distinguishes the three human-review states", () => {
    const rows = [
      row({ toolName: "required", qaNeedsHumanReview: true }),
      row({ toolName: "done", qaNeedsHumanReview: true, humanReviewedAt: timestamp(NOW_MILLIS) }),
      row({ toolName: "untouched" }),
    ];
    expect(filterMcpCalls(rows, filters({ humanReviewStates: new Set(["required"]) }), NOW_MILLIS).map(r => r.toolName)).toEqual(["required"]);
    expect(filterMcpCalls(rows, filters({ humanReviewStates: new Set(["reviewed"]) }), NOW_MILLIS).map(r => r.toolName)).toEqual(["done"]);
    expect(filterMcpCalls(rows, filters({ humanReviewStates: new Set(["not-reviewed"]) }), NOW_MILLIS).map(r => r.toolName)).toEqual(["required", "untouched"]);
  });

  it("matches any selected value within a dimension", () => {
    const rows = [
      row({ toolName: "pass", qaOverallScore: 90 }),
      row({ toolName: "warn", qaOverallScore: 60 }),
      row({ toolName: "fail", qaOverallScore: 10 }),
    ];
    expect(filterMcpCalls(rows, filters({ qaStates: new Set(["pass", "fail"]) }), NOW_MILLIS).map(r => r.toolName)).toEqual(["pass", "fail"]);
    expect(filterMcpCalls(rows, filters({ toolNames: new Set(["warn", "fail"]) }), NOW_MILLIS).map(r => r.toolName)).toEqual(["warn", "fail"]);
    expect(filterMcpCalls(rows, filters({ statuses: new Set(["ok", "error"]) }), NOW_MILLIS)).toHaveLength(3);
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
      filters({ timeRange: "30d", toolNames: new Set(["ask_hexclave"]), qaStates: new Set(["fail"]), humanReviewStates: new Set(["required"]) }),
      NOW_MILLIS,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].humanReviewedAt).toBeUndefined();
  });
});

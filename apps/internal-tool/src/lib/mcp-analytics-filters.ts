
import { mcpLogMatches } from "../../spacetimedb/src/log-filters";
import type { McpCallLogRow } from "../types";

export type McpTimeRange = "24h" | "7d" | "30d" | "all";
export const MCP_TIME_RANGES: readonly McpTimeRange[] = ["24h", "7d", "30d", "all"];

/** Mirrors the `qaState` values `page_mcp_call_log` accepts. */
export const MCP_QA_STATES = ["pending", "review-failed", "error", "pass", "warn", "fail", "feature-request"] as const;
export type McpQaState = typeof MCP_QA_STATES[number];

/** Mirrors the `humanReviewState` values `page_mcp_call_log` accepts. */
export const MCP_HUMAN_REVIEW_STATES = ["required", "reviewed", "not-reviewed"] as const;
export type McpHumanReviewState = typeof MCP_HUMAN_REVIEW_STATES[number];

export const MCP_STATUS_FILTERS = ["all", "ok", "error"] as const;
export type McpStatusFilter = typeof MCP_STATUS_FILTERS[number];

export type McpAnalyticsFilters = {
  timeRange: McpTimeRange,
  /** Empty string means "all tools"; the selects use it as their neutral value. */
  toolName: string,
  status: McpStatusFilter,
  qaState: McpQaState | "all",
  humanReviewState: McpHumanReviewState | "all",
};

export const DEFAULT_MCP_ANALYTICS_FILTERS: McpAnalyticsFilters = {
  timeRange: "all",
  toolName: "",
  status: "all",
  qaState: "all",
  humanReviewState: "all",
};

const RANGE_HOURS = new Map<Exclude<McpTimeRange, "all">, number>([
  ["24h", 24],
  ["7d", 7 * 24],
  ["30d", 30 * 24],
]);

/** Inclusive lower bound for a range, or null when the range is unbounded. */
export function rangeStartMillis(range: McpTimeRange, nowMillis: number): number | null {
  if (range === "all") return null;
  const hours = RANGE_HOURS.get(range) ?? throwUnexpected("time range", range);
  return nowMillis - hours * 60 * 60 * 1000;
}

function throwUnexpected(label: string, value: string): never {
  throw new Error(`Unexpected ${label}: ${value}`);
}

export function parseTimeRange(value: string): McpTimeRange {
  const match = MCP_TIME_RANGES.find(range => range === value);
  return match ?? throwUnexpected("time range", value);
}

export function parseStatusFilter(value: string): McpStatusFilter {
  const match = MCP_STATUS_FILTERS.find(status => status === value);
  return match ?? throwUnexpected("status filter", value);
}

export function parseQaState(value: string): McpQaState | "all" {
  if (value === "all") return "all";
  const match = MCP_QA_STATES.find(state => state === value);
  return match ?? throwUnexpected("QA state filter", value);
}

export function parseHumanReviewState(value: string): McpHumanReviewState | "all" {
  if (value === "all") return "all";
  const match = MCP_HUMAN_REVIEW_STATES.find(state => state === value);
  return match ?? throwUnexpected("human review state filter", value);
}

export function countActiveMcpFilters(filters: McpAnalyticsFilters): number {
  let active = 0;
  if (filters.timeRange !== DEFAULT_MCP_ANALYTICS_FILTERS.timeRange) active++;
  if (filters.toolName !== "") active++;
  if (filters.status !== "all") active++;
  if (filters.qaState !== "all") active++;
  if (filters.humanReviewState !== "all") active++;
  return active;
}

/**
 * `nowMillis` is passed in rather than read from the clock so callers control
 * when the view re-evaluates. It matters: "pending" becomes "review-failed"
 * purely with the passage of time (see QA_REVIEW_FAILED_THRESHOLD_MICROS), so
 * a filtered count is only correct relative to a specific instant.
 */
export function filterMcpCalls(
  rows: readonly McpCallLogRow[],
  filters: McpAnalyticsFilters,
  nowMillis: number,
): McpCallLogRow[] {
  const startMillis = rangeStartMillis(filters.timeRange, nowMillis);
  const nowMicros = BigInt(nowMillis) * 1000n;
  const predicateFilters = {
    toolName: filters.toolName === "" ? undefined : filters.toolName,
    hasError: filters.status === "all" ? undefined : filters.status === "error",
    qaState: filters.qaState === "all" ? undefined : filters.qaState,
    humanReviewState: filters.humanReviewState === "all" ? undefined : filters.humanReviewState,
  };
  return rows.filter((row) => {
    if (startMillis != null && Number(row.createdAt.microsSinceUnixEpoch / 1000n) < startMillis) return false;
    return mcpLogMatches(row, predicateFilters, nowMicros);
  });
}

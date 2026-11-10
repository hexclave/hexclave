
import { mcpLogMatches } from "../../spacetimedb/src/log-filters";
import type { McpCallLogRow } from "../types";
import { type CallStatus, hasErrorFilter, type McpHumanReviewState, type McpQaState, rangeStartMillis, type TimeRange } from "./filter-options";

export type McpAnalyticsFilters = {
  timeRange: TimeRange,
  toolNames: ReadonlySet<string>,
  statuses: ReadonlySet<CallStatus>,
  qaStates: ReadonlySet<McpQaState>,
  humanReviewStates: ReadonlySet<McpHumanReviewState>,
};

// Never mutated (the Sets are read-only), so sharing one default object is safe.
export const DEFAULT_MCP_ANALYTICS_FILTERS: McpAnalyticsFilters = {
  timeRange: "all",
  toolNames: new Set(),
  statuses: new Set(),
  qaStates: new Set(),
  humanReviewStates: new Set(),
};

export function countActiveMcpFilters(filters: McpAnalyticsFilters): number {
  let active = 0;
  if (filters.timeRange !== DEFAULT_MCP_ANALYTICS_FILTERS.timeRange) active++;
  if (filters.toolNames.size > 0) active++;
  if (hasErrorFilter(filters.statuses) != null) active++;
  if (filters.qaStates.size > 0) active++;
  if (filters.humanReviewStates.size > 0) active++;
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
    toolNames: [...filters.toolNames],
    hasError: hasErrorFilter(filters.statuses),
    qaStates: [...filters.qaStates],
    humanReviewStates: [...filters.humanReviewStates],
  };
  return rows.filter((row) => {
    if (startMillis != null && Number(row.createdAt.microsSinceUnixEpoch / 1000n) < startMillis) return false;
    return mcpLogMatches(row, predicateFilters, nowMicros);
  });
}

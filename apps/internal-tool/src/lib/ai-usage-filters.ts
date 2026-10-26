import { aiLogMatches } from "../../spacetimedb/src/log-filters";
import type { AiUsageTableFilters } from "../hooks/useSpacetimeDB";
import type { AiQueryLogRow } from "../types";
import {
  type AuthState,
  type CallStatus,
  hasErrorFilter,
  isAuthenticatedFilter,
  MODE_OPTIONS,
  onlySelected,
  rangeStartMillis,
  type RequestMode,
  type TimeRange,
} from "./filter-options";

/**
 * The categorical "scope" filters of the AI Usage tab (as opposed to the investigation filters in
 * usage-filters.ts). The Overview and the request log each keep their own copy of this state, but
 * share the type, the matching logic and the server translation so the two can't drift apart.
 */
export type AiUsageScopeFilters = {
  timeRange: TimeRange,
  systemPromptIds: ReadonlySet<string>,
  modelIds: ReadonlySet<string>,
  modes: ReadonlySet<RequestMode>,
  auth: ReadonlySet<AuthState>,
  statuses: ReadonlySet<CallStatus>,
};

// Never mutated (the Sets are read-only), so sharing one default object is safe.
export const DEFAULT_AI_USAGE_SCOPE_FILTERS: AiUsageScopeFilters = {
  timeRange: "all",
  systemPromptIds: new Set(),
  modelIds: new Set(),
  modes: new Set(),
  auth: new Set(),
  statuses: new Set(),
};

export function countActiveAiUsageScopeFilters(filters: AiUsageScopeFilters): number {
  let active = 0;
  if (filters.timeRange !== "all") active++;
  if (filters.systemPromptIds.size > 0) active++;
  if (filters.modelIds.size > 0) active++;
  // Selecting both values of a two-valued filter filters nothing, so it isn't "active".
  if (onlySelected(filters.modes, MODE_OPTIONS) != null) active++;
  if (isAuthenticatedFilter(filters.auth) != null) active++;
  if (hasErrorFilter(filters.statuses) != null) active++;
  return active;
}

/** Server paging procedure args for these filters, relative to `nowMillis` for the range start. */
export function toAiUsageTableFilters(filters: AiUsageScopeFilters, nowMillis: number): AiUsageTableFilters {
  const startMillis = rangeStartMillis(filters.timeRange, nowMillis);
  return {
    createdAtOrAfterMicros: startMillis == null ? undefined : BigInt(startMillis) * 1000n,
    // Sorted so equal selections produce equal args (and equal query keys) regardless of click order.
    systemPromptIds: [...filters.systemPromptIds].sort(),
    modelIds: [...filters.modelIds].sort(),
    mode: onlySelected(filters.modes, MODE_OPTIONS),
    isAuthenticated: isAuthenticatedFilter(filters.auth),
    hasError: hasErrorFilter(filters.statuses),
  };
}

/**
 * Client-side equivalent of the server filter, via the same predicate the module runs. Returns a
 * matcher so the filter translation happens once per filter change, not once per row.
 */
export function aiUsageScopeMatcher(filters: AiUsageScopeFilters, nowMillis: number): (row: AiQueryLogRow) => boolean {
  const tableFilters = toAiUsageTableFilters(filters, nowMillis);
  return row => {
    if (tableFilters.createdAtOrAfterMicros != null && row.createdAt.microsSinceUnixEpoch < tableFilters.createdAtOrAfterMicros) return false;
    return aiLogMatches(row, tableFilters);
  };
}

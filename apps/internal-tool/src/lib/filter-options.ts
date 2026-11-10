/**
 * Shared filter vocabularies for every tab of the internal tool. Each list is the single source of
 * the values a filter can take *and* the label it shows, so the same filter reads the same way in
 * Overview, MCP Review and AI Usage.
 *
 * Categorical filters are multi-selects whose state is a Set of these values; an empty Set means
 * "no filter". Time range is the one single-choice filter (ranges nest, so picking two is moot).
 */

export type FilterOption<Value extends string> = { value: Value, label: string };

function throwUnexpected(label: string, value: string): never {
  throw new Error(`Unexpected ${label}: ${value}`);
}

function valuesOf<Value extends string>(options: ReadonlyArray<FilterOption<Value>>): readonly Value[] {
  return options.map(option => option.value);
}

export const TIME_RANGE_OPTIONS = [
  { value: "all", label: "All time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const satisfies ReadonlyArray<FilterOption<string>>;
export type TimeRange = typeof TIME_RANGE_OPTIONS[number]["value"];

export function parseTimeRange(value: string): TimeRange {
  return TIME_RANGE_OPTIONS.find(option => option.value === value)?.value ?? throwUnexpected("time range", value);
}

const RANGE_HOURS = new Map<Exclude<TimeRange, "all">, number>([
  ["24h", 24],
  ["7d", 7 * 24],
  ["30d", 30 * 24],
]);

/** Inclusive lower bound for a range, or null when the range is unbounded. */
export function rangeStartMillis(range: TimeRange, nowMillis: number): number | null {
  if (range === "all") return null;
  const hours = RANGE_HOURS.get(range) ?? throwUnexpected("time range", range);
  return nowMillis - hours * 60 * 60 * 1000;
}

export const CALL_STATUS_OPTIONS = [
  { value: "ok", label: "OK" },
  { value: "error", label: "Error" },
] as const satisfies ReadonlyArray<FilterOption<string>>;
export type CallStatus = typeof CALL_STATUS_OPTIONS[number]["value"];

export const MODE_OPTIONS = [
  { value: "stream", label: "Stream" },
  { value: "generate", label: "Generate" },
] as const satisfies ReadonlyArray<FilterOption<string>>;
export type RequestMode = typeof MODE_OPTIONS[number]["value"];

export const AUTH_OPTIONS = [
  { value: "authed", label: "Authenticated" },
  { value: "anon", label: "Anonymous" },
] as const satisfies ReadonlyArray<FilterOption<string>>;
export type AuthState = typeof AUTH_OPTIONS[number]["value"];

/** Mirrors the `qaStates` values `page_mcp_call_log` accepts. */
export const QA_STATE_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "review-failed", label: "Review failed" },
  { value: "error", label: "Review error" },
  { value: "pass", label: "Pass (80+)" },
  { value: "warn", label: "Warn (50–79)" },
  { value: "fail", label: "Fail (<50)" },
  { value: "feature-request", label: "Feature request" },
] as const satisfies ReadonlyArray<FilterOption<string>>;
export type McpQaState = typeof QA_STATE_OPTIONS[number]["value"];
export const MCP_QA_STATES = valuesOf(QA_STATE_OPTIONS);

/** Mirrors the `humanReviewStates` values `page_mcp_call_log` accepts. */
export const HUMAN_REVIEW_OPTIONS = [
  { value: "required", label: "Required" },
  { value: "reviewed", label: "Reviewed" },
  { value: "not-reviewed", label: "Not reviewed" },
] as const satisfies ReadonlyArray<FilterOption<string>>;
export type McpHumanReviewState = typeof HUMAN_REVIEW_OPTIONS[number]["value"];
export const MCP_HUMAN_REVIEW_STATES = valuesOf(HUMAN_REVIEW_OPTIONS);

/** Options for filters whose values come from loaded data (tool names, models, …). */
export function stringOptions(values: Iterable<string>): Array<FilterOption<string>> {
  return Array.from(values, value => ({ value, label: value }));
}

/**
 * Collapse a multi-select over a two-valued domain (status, mode, auth) to the single optional
 * value the server filters take: nothing or everything selected means no filter.
 */
export function onlySelected<Value extends string>(selected: ReadonlySet<Value>, options: ReadonlyArray<FilterOption<Value>>): Value | undefined {
  if (options.length !== 2) throw new Error(`onlySelected is for two-valued filters; got ${options.length} options`);
  if (selected.size !== 1) return undefined;
  const [only] = selected;
  return only;
}

/** Status filter as the `hasError` flag the log predicates take. */
export function hasErrorFilter(statuses: ReadonlySet<CallStatus>): boolean | undefined {
  const status = onlySelected(statuses, CALL_STATUS_OPTIONS);
  return status == null ? undefined : status === "error";
}

/** Auth filter as the `isAuthenticated` flag the log predicates take. */
export function isAuthenticatedFilter(auth: ReadonlySet<AuthState>): boolean | undefined {
  const state = onlySelected(auth, AUTH_OPTIONS);
  return state == null ? undefined : state === "authed";
}

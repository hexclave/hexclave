import { ClickHouseError, type ClickHouseClient } from "@clickhouse/client";
import { DEV_TOOL_CLASS_PREFIX, DEV_TOOL_LEGACY_CLASS, DEV_TOOL_ROOT_ID } from "@hexclave/shared/dist/utils/dev-tool";
import { HexclaveAssertionError, StatusError, captureError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";

// Canonical owner of the ClickHouse clickmap query: filter/param builders, the
// shared aggregate queries, and result scaling. Both the admin route
// (`internal/analytics/clickmap`) and the origin-token public route
// (`analytics/clickmap`) drive their `session_replay_clicks` results through here
// so the SQL and sampling math live in exactly one place.

const CLICKMAP_TABLE = "analytics_internal.clickmap_events";

// ---------------------------------------------------------------------------
// Date / error helpers
// ---------------------------------------------------------------------------

export function formatClickhouseDateTimeParam(date: Date): string {
  return date.toISOString().slice(0, 19);
}

export function parseBoundedDateTime(value: string, name: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new StatusError(StatusError.BadRequest, `Invalid ${name}`);
  }
  return date;
}

// ClickHouse raises a query-execution error when a user-supplied route regex
// fails to compile. Only those errors should be reported as a 400 "Invalid
// route regex"; unrelated ClickHouse failures must fall through to the generic
// service-unavailable path instead of being misattributed to the regex.
export function isClickhouseRegexpError(error: ClickHouseError): boolean {
  return /regexp|regular expression|cannot compile/i.test(error.message);
}

/**
 * Translate a clickmap query failure into the right StatusError. A failed
 * user-supplied route regex becomes a 400; any other ClickHouse failure is
 * captured and surfaced as a generic 503; non-ClickHouse errors are rethrown
 * untouched. Always throws.
 */
export function throwClickhouseClickmapError(error: unknown, options: {
  captureLabel: string,
  routeRegex?: string,
  context: Record<string, Json>,
}): never {
  if (!(error instanceof ClickHouseError)) {
    throw error;
  }
  if (options.routeRegex != null && options.routeRegex !== "" && isClickhouseRegexpError(error)) {
    throw new StatusError(StatusError.BadRequest, "Invalid route regex");
  }
  captureError(options.captureLabel, new HexclaveAssertionError(
    "Failed to load analytics data due to ClickHouse query failure.",
    { cause: error, ...options.context },
  ));
  throw new StatusError(StatusError.ServiceUnavailable, "Analytics data is temporarily unavailable.");
}

// ---------------------------------------------------------------------------
// Filter / param builders
// ---------------------------------------------------------------------------

// Device class buckets — kept as a back-compat shim for callers that still pass
// `device`. Internally collapsed into viewport_width_min/max so the MV order key
// (which leads with viewport_width) does the work instead of a multiIf scan.
const DEVICE_WIDTH_BUCKETS = new Map<string, { min: number, max: number }>([
  ["tv", { min: 1920, max: 65535 }],
  ["widescreen", { min: 1440, max: 1919 }],
  ["desktop", { min: 1200, max: 1439 }],
  ["laptop", { min: 1024, max: 1199 }],
  ["tablet", { min: 768, max: 1023 }],
  ["mobile", { min: 0, max: 767 }],
]);

export function getDeviceViewportBucket(device: string | undefined): { min: number, max: number } | null {
  if (device == null || device === "") return null;
  return DEVICE_WIDTH_BUCKETS.get(device) ?? null;
}

// Translate a PostHog-style URL pattern with `*` wildcards into a SQL LIKE
// pattern, escaping the underlying `_` / `%` / `\` so they're treated literally.
// Empty string disables the filter.
export function buildClickmapUrlLikePattern(urlPattern: string | undefined): string | null {
  if (urlPattern == null || urlPattern === "") return null;
  const escaped = urlPattern.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return escaped.replace(/\*/g, "%");
}

export function getClickmapRouteFilter(routePath: string | undefined, routeRegex: string | undefined, urlPatternLike: string | null): string {
  if (routeRegex != null && routeRegex !== "") {
    return "AND match(path, {routeRegex:String})";
  }
  if (urlPatternLike != null) {
    return "AND path LIKE {urlPatternLike:String}";
  }
  if (routePath != null && routePath !== "") {
    return "AND path = {routePath:String}";
  }
  return "";
}

export function getClickmapViewportFilter(min: number | undefined, max: number | undefined): string {
  const clauses: string[] = [];
  if (min != null) clauses.push("AND viewport_width >= {viewportWidthMin:UInt32}");
  if (max != null) clauses.push("AND viewport_width <= {viewportWidthMax:UInt32}");
  return clauses.join(" ");
}

export function getClickmapUserAndReplayFilter(userId: string | undefined, replayId: string | undefined): string {
  const clauses: string[] = [];
  if (userId != null && userId !== "") clauses.push("AND user_id = {userId:Nullable(String)}");
  if (replayId != null && replayId !== "") clauses.push("AND session_replay_id = {replayId:Nullable(String)}");
  return clauses.join(" ");
}

export function getClickmapOriginFilter(): string {
  return "AND (url = {origin:String} OR startsWith(url, {originSlashPrefix:String}) OR startsWith(url, {originQueryPrefix:String}) OR startsWith(url, {originHashPrefix:String}))";
}

export function getClickmapOriginParams(origin: string): {
  origin: string,
  originSlashPrefix: string,
  originQueryPrefix: string,
  originHashPrefix: string,
} {
  return {
    origin,
    originSlashPrefix: `${origin}/`,
    originQueryPrefix: `${origin}?`,
    originHashPrefix: `${origin}#`,
  };
}

// Exclude clicks landing on the in-page dev tool / clickmap overlay itself. The
// dev-tool identity comes from shared constants so this SQL can never silently
// drift from the actual DOM markers (see `utils/dev-tool`).
export function getClickmapSystemElementFilter(): string {
  return [
    `AND position(elements_chain, '${DEV_TOOL_ROOT_ID}') = 0`,
    `AND position(elements_chain, '${DEV_TOOL_LEGACY_CLASS}') = 0`,
    `AND position(elements_chain, '${DEV_TOOL_CLASS_PREFIX}') = 0`,
    `AND position(selector, '#${DEV_TOOL_ROOT_ID}') = 0`,
    `AND position(selector, '.${DEV_TOOL_LEGACY_CLASS}') = 0`,
    `AND position(selector, '.${DEV_TOOL_CLASS_PREFIX}') = 0`,
  ].join(" ");
}

export function clampClickmapSampling(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 1;
  if (value <= 0) return 0.01;
  if (value > 1) return 1;
  return value;
}

export function buildHourOfWeekClickmapCells(rows: { weekday: number | string, hour: number | string, value: number | string }[]) {
  const byCell = new Map<string, number>();
  for (const row of rows) {
    const weekday = Number(row.weekday);
    const hour = Number(row.hour);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    byCell.set(`${weekday}:${hour}`, Number(row.value));
  }

  const cells: { weekday: number, hour: number, value: number }[] = [];
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      cells.push({ weekday, hour, value: byCell.get(`${weekday}:${hour}`) ?? 0 });
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Shared clicks query runner
// ---------------------------------------------------------------------------

export type ClickmapClicksQueryInput = {
  projectId: string,
  branchId: string,
  since: Date,
  until: Date,
  routePath?: string,
  routeRegex?: string,
  urlPattern?: string,
  userId?: string,
  replayId?: string,
  device?: string,
  viewportWidthMin?: number,
  viewportWidthMax?: number,
  sampling?: number,
  routeLimit: number,
  elementsChainLimit: number,
  // When set, scope to the exact origin (public origin-token route).
  origin?: string,
  // When set, also fetch per-user and per-replay aggregates (admin route),
  // capped at this limit. Public callers omit it and get neither.
  linkedLimit?: number,
};

type ClickmapRouteRow = { path: string, clicks: number, users: number, replays: number };
type ClickmapRawRouteRow = { path: string, clicks: number | string, users: number | string, replays: number | string };
type ClickmapSelectorRow = { selector: string, clicks: number };
type ClickmapRawSelectorRow = { selector: string, clicks: number | string };
type ClickmapElementRow = { elements_chain: string, elements_text: string, tag_name: string, href: string | null, clicks: number, dead_clicks: number };
type ClickmapRawElementRow = { elements_chain: string, elements_text: string, tag_name: string, href: string | null, clicks: number | string, dead_clicks: number | string };
type ClickmapUserRow = { id: string, clicks: number, replays: number, last_event_at_millis: number };
type ClickmapRawUserRow = { id: string, clicks: number | string, replays: number | string, last_event_at_millis: number | string };
type ClickmapReplayRow = {
  id: string,
  linked_user_id: string | null,
  route_path: string | null,
  viewport_width: number | null,
  viewport_height: number | null,
  clicks: number,
  last_event_at_millis: number,
};
type ClickmapRawReplayRow = {
  id: string,
  linked_user_id: string | null,
  route_path: string | null,
  viewport_width: number | string | null,
  viewport_height: number | string | null,
  clicks: number | string,
  last_event_at_millis: number | string,
};

export type ClickmapClicksQueryResult = {
  samplingPct: number,
  routes: ClickmapRouteRow[],
  selectors: ClickmapSelectorRow[],
  elements: ClickmapElementRow[],
  // Present only when `linkedLimit` was provided.
  users: ClickmapUserRow[],
  replays: ClickmapReplayRow[],
};

export function normalizeClickmapClicksQueryRows(input: {
  samplingPct: number,
  routesRows: ClickmapRawRouteRow[],
  selectorsRows: ClickmapRawSelectorRow[],
  elementsRows: ClickmapRawElementRow[],
  userRows: ClickmapRawUserRow[],
  replayRows: ClickmapRawReplayRow[],
}): ClickmapClicksQueryResult {
  const samplingScale = 100 / input.samplingPct;
  const scaleSampledEventCount = (value: number | string) => Math.round(Number(value) * samplingScale);
  const exactUniqueCount = (value: number | string) => Number(value);

  return {
    samplingPct: input.samplingPct,
    routes: input.routesRows.map((row) => ({
      path: row.path,
      clicks: scaleSampledEventCount(row.clicks),
      users: exactUniqueCount(row.users),
      replays: exactUniqueCount(row.replays),
    })),
    selectors: input.selectorsRows.map((row) => ({ selector: row.selector, clicks: scaleSampledEventCount(row.clicks) })),
    elements: input.elementsRows.map((row) => ({
      elements_chain: row.elements_chain,
      elements_text: row.elements_text,
      tag_name: row.tag_name,
      href: row.href,
      clicks: scaleSampledEventCount(row.clicks),
      dead_clicks: scaleSampledEventCount(row.dead_clicks),
    })),
    users: input.userRows.map((row) => ({
      id: row.id,
      clicks: scaleSampledEventCount(row.clicks),
      replays: exactUniqueCount(row.replays),
      last_event_at_millis: Number(row.last_event_at_millis),
    })),
    replays: input.replayRows.map((row) => ({
      id: row.id,
      linked_user_id: row.linked_user_id,
      route_path: row.route_path,
      viewport_width: row.viewport_width == null ? null : Number(row.viewport_width),
      viewport_height: row.viewport_height == null ? null : Number(row.viewport_height),
      clicks: scaleSampledEventCount(row.clicks),
      last_event_at_millis: Number(row.last_event_at_millis),
    })),
  };
}

/**
 * Build the shared WHERE/params, run the routes/selectors/elements aggregates
 * (plus per-user/per-replay aggregates when `linkedLimit` is set), and return
 * counts already scaled back up by 1/sampling. Throws ClickHouseError on query
 * failure — callers translate that into the appropriate StatusError.
 */
export async function runClickmapClicksQuery(
  client: ClickHouseClient,
  input: ClickmapClicksQueryInput,
): Promise<ClickmapClicksQueryResult> {
  const deviceBucket = getDeviceViewportBucket(input.device);
  // Explicit min/max win over the legacy device bucket so callers can narrow
  // further (e.g. mobile + viewport_width_min=400).
  const viewportMin = input.viewportWidthMin ?? deviceBucket?.min;
  const viewportMax = input.viewportWidthMax ?? deviceBucket?.max;
  const urlPatternLike = buildClickmapUrlLikePattern(input.urlPattern);
  const samplingPct = Math.max(1, Math.round(clampClickmapSampling(input.sampling) * 100));

  const samplingClause = samplingPct < 100
    ? "AND intHash32(toUInt32(toUnixTimestamp(event_at)) + cityHash64(coalesce(toString(user_id), ''))) % 100 < {samplingPct:UInt32}"
    : "";
  const routeFilter = getClickmapRouteFilter(input.routePath, input.routeRegex, urlPatternLike);
  const userAndReplayFilter = getClickmapUserAndReplayFilter(input.userId, input.replayId);
  const viewportFilter = getClickmapViewportFilter(viewportMin, viewportMax);
  const systemElementFilter = getClickmapSystemElementFilter();
  const originFilter = input.origin != null ? getClickmapOriginFilter() : "";

  const params: Record<string, unknown> = {
    projectId: input.projectId,
    branchId: input.branchId,
    since: formatClickhouseDateTimeParam(input.since),
    until: formatClickhouseDateTimeParam(input.until),
    routeLimit: input.routeLimit,
    elementsChainLimit: input.elementsChainLimit,
    samplingPct,
    ...(input.linkedLimit != null ? { linkedLimit: input.linkedLimit } : {}),
    ...(input.origin != null ? getClickmapOriginParams(input.origin) : undefined),
    ...(input.routePath ? { routePath: input.routePath } : {}),
    ...(input.routeRegex ? { routeRegex: input.routeRegex } : {}),
    ...(urlPatternLike != null ? { urlPatternLike } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.replayId ? { replayId: input.replayId } : {}),
    ...(viewportMin != null ? { viewportWidthMin: viewportMin } : {}),
    ...(viewportMax != null ? { viewportWidthMax: viewportMax } : {}),
  };

  const sharedWhere = `
    project_id = {projectId:String}
      AND branch_id = {branchId:String}
      AND event_at >= {since:DateTime}
      AND event_at < {until:DateTime}
      ${originFilter}
      ${routeFilter}
      ${viewportFilter}
      ${systemElementFilter}
      ${samplingClause}
  `;

  const runJson = async <T>(query: string): Promise<T[]> => {
    const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
    return await result.json<T>();
  };

  const routesQuery = runJson<ClickmapRawRouteRow>(`
    SELECT
      path,
      count() AS clicks,
      uniqExactIf(assumeNotNull(user_id), user_id IS NOT NULL) AS users,
      uniqExactIf(assumeNotNull(session_replay_id), session_replay_id IS NOT NULL) AS replays
    FROM ${CLICKMAP_TABLE}
    WHERE ${sharedWhere}
      AND path != ''
      ${userAndReplayFilter}
    GROUP BY path
    ORDER BY clicks DESC
    LIMIT {routeLimit:UInt32}
  `);

  const selectorsQuery = runJson<ClickmapRawSelectorRow>(`
    SELECT
      nullIf(selector, '') AS selector,
      count() AS clicks
    FROM ${CLICKMAP_TABLE}
    WHERE ${sharedWhere}
      AND selector != ''
      ${userAndReplayFilter}
    GROUP BY selector
    ORDER BY clicks DESC
    LIMIT {routeLimit:UInt32}
  `);

  // Dead clicks are flagged rows on the same table (is_dead), so the dead
  // subset rides the click aggregate as a countIf — count() stays the total
  // because each physical click is exactly one row.
  const elementsQuery = runJson<ClickmapRawElementRow>(`
    SELECT
      elements_chain,
      any(elements_text) AS elements_text,
      any(tag_name) AS tag_name,
      any(href) AS href,
      count() AS clicks,
      countIf(is_dead = 1) AS dead_clicks
    FROM ${CLICKMAP_TABLE}
    WHERE ${sharedWhere}
      AND elements_chain != ''
      ${userAndReplayFilter}
    GROUP BY elements_chain
    ORDER BY clicks DESC
    LIMIT {elementsChainLimit:UInt32}
  `);

  const usersQuery = input.linkedLimit == null ? null : runJson<ClickmapRawUserRow>(`
    SELECT
      assumeNotNull(user_id) AS id,
      count() AS clicks,
      uniqExactIf(assumeNotNull(session_replay_id), session_replay_id IS NOT NULL) AS replays,
      toUnixTimestamp64Milli(max(event_at)) AS last_event_at_millis
    FROM ${CLICKMAP_TABLE}
    WHERE ${sharedWhere}
      AND user_id IS NOT NULL
      ${userAndReplayFilter}
    GROUP BY id
    ORDER BY last_event_at_millis DESC, clicks DESC
    LIMIT {linkedLimit:UInt32}
  `);

  const replaysQuery = input.linkedLimit == null ? null : runJson<ClickmapRawReplayRow>(`
    SELECT
      assumeNotNull(session_replay_id) AS id,
      any(user_id) AS linked_user_id,
      nullIf(any(path), '') AS route_path,
      toInt32(any(viewport_width)) AS viewport_width,
      toInt32(any(viewport_height)) AS viewport_height,
      count() AS clicks,
      toUnixTimestamp64Milli(max(event_at)) AS last_event_at_millis
    FROM ${CLICKMAP_TABLE}
    WHERE ${sharedWhere}
      AND session_replay_id IS NOT NULL
      ${userAndReplayFilter}
    GROUP BY id
    ORDER BY clicks DESC
    LIMIT {linkedLimit:UInt32}
  `);

  const [routesRows, selectorsRows, elementsRows, userRows, replayRows] = await Promise.all([
    routesQuery,
    selectorsQuery,
    elementsQuery,
    usersQuery ?? Promise.resolve([]),
    replaysQuery ?? Promise.resolve([]),
  ]);

  return normalizeClickmapClicksQueryRows({
    samplingPct,
    routesRows,
    selectorsRows,
    elementsRows,
    userRows,
    replayRows,
  });
}

"use client";

import { isDateValue, parseClickHouseDate, type RowData } from "../../analytics/shared";
import { tryParseJson } from "../format";
import { type ServiceIdentity } from "../service-identity";
import { type EventInput, type SpanInput } from "./trace-utils";

const TRACE_SPAN_STRUCTURE_SELECT_SQL = `
SELECT
  s.trace_id,
  s.span_id,
  s.span_type,
  s.started_at,
  s.ended_at,
  s.parent_span_id,
  s.status_code,
  s.scope_name,
  -- Needed by traceSignalSpanIds to tell spans the customer's own code authored
  -- from auto-instrumented library/framework noise. Both arrive through the SDK;
  -- scope_name is the instrumentation marker.
  s.producer,
  -- AI-span columns (NULL for non-AI spans); gen_ai_operation_name being
  -- non-null is what marks a span as an AI span. These drive the compact AI
  -- chip on waterfall rows without loading the full span data payload.
  s.gen_ai_operation_name,
  s.gen_ai_request_model,
  s.gen_ai_input_tokens,
  s.gen_ai_output_tokens,
  s.gen_ai_tool_name,
  s.gen_ai_agent_name
FROM default.spans AS s
`;

export const ROOT_PAGE_SIZE = 200;

export const TRACE_SERVICES_QUERY = `
SELECT service_namespace, service_name
FROM default.trace_services
WHERE service_name != ''
GROUP BY service_namespace, service_name
ORDER BY service_namespace ASC, service_name ASC
LIMIT 500
`;

export type TraceRootCursor = {
  activityMs: number,
  id: string,
};

export function getRecentTraceRootsQuery(
  cursor: TraceRootCursor | null,
  service: ServiceIdentity | null = null,
  search = "",
): {
  query: string,
  params: Record<string, string | number>,
} {
  const serviceCondition = service == null ? "" : `
    AND r.trace_id IN (
      SELECT trace_id
      FROM default.trace_services
      WHERE coalesce(service_namespace, '') = {serviceNamespace:String}
        AND service_name = {serviceName:String}
    )`;
  const searchCondition = search === "" ? "" : `
    AND (
      positionCaseInsensitiveUTF8(r.span_type, {search:String}) > 0
      OR positionCaseInsensitiveUTF8(JSONExtractString(r.data, 'name'), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(r.trace_id, {search:String}) > 0
      OR positionCaseInsensitiveUTF8(r.span_id, {search:String}) > 0
      OR arrayExists(service -> positionCaseInsensitiveUTF8(service.1, {search:String}) > 0, ts.services)
      OR arrayExists(service -> positionCaseInsensitiveUTF8(service.2, {search:String}) > 0, ts.services)
      OR positionCaseInsensitiveUTF8(ifNull(r.service_version, ''), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(ifNull(r.deployment_environment_name, ''), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(ifNull(r.user_id, ''), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(ifNull(r.refresh_token_id, ''), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(ifNull(r.session_replay_id, ''), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(ifNull(r.session_replay_segment_id, ''), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(ifNull(u.display_name, ''), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(ifNull(u.primary_email, ''), {search:String}) > 0
    )`;
  const cursorCondition = cursor == null ? "" : `
    AND (
      r.created_at < fromUnixTimestamp64Milli({cursorActivityMs:Int64})
      OR (r.created_at = fromUnixTimestamp64Milli({cursorActivityMs:Int64}) AND r.span_id < {cursorId:String})
    )`;
  const params: Record<string, string | number> = {};
  if (cursor != null) {
    params.cursorActivityMs = cursor.activityMs;
    params.cursorId = cursor.id;
  }
  if (service != null) {
    params.serviceNamespace = service.namespace;
    params.serviceName = service.name;
  }
  if (search !== "") params.search = search;
  return {
    query: `
SELECT
  r.trace_id AS trace_id,
  r.span_id,
  r.span_type,
  r.started_at,
  r.ended_at,
  r.created_at AS root_activity_at,
  r.status_code,
  r.scope_name,
  r.data,
  -- trace_roots only ever holds spans with a NULL parent, so the column is not
  -- stored; synthesizing it keeps these rows parseable by the same row parser
  -- the waterfall's span rows use.
  CAST(NULL, 'Nullable(String)') AS parent_span_id,
  u.display_name AS user_display_name,
  u.primary_email AS user_primary_email,
  u.profile_image_url AS user_profile_image_url,
  -- How many other root activities happened on this page view. Only ever
  -- non-zero for a $page-view row, because a page view is the only root that
  -- other roots point at; drives the expand affordance in the list.
  coalesce(child.child_count, 0) AS child_count,
  arrayMap(service -> service.1, ts.services) AS trace_service_namespaces,
  arrayMap(service -> service.2, ts.services) AS trace_service_names
FROM default.trace_roots AS r
LEFT JOIN default.users AS u ON toString(u.id) = r.user_id
LEFT JOIN (
  SELECT page_view_span_id, count() AS child_count
  FROM default.trace_roots
  WHERE created_at >= now64(3) - INTERVAL {hours:UInt32} HOUR
    AND page_view_span_id IS NOT NULL
  GROUP BY page_view_span_id
) AS child ON child.page_view_span_id = r.span_id
LEFT JOIN (
  SELECT
    trace_id,
    arraySort(groupUniqArray(tuple(coalesce(service_namespace, ''), service_name))) AS services
  FROM default.trace_services
  WHERE service_name != ''
  GROUP BY trace_id
) AS ts ON ts.trace_id = r.trace_id
WHERE r.created_at >= now64(3) - INTERVAL {hours:UInt32} HOUR
  -- Top level only. A root that names a page view is shown nested under it
  -- instead (see getPageViewChildrenQuery); without this the list repeats every
  -- request a page made as its own sibling row, which is ~15 extra rows per
  -- page visit on a browser-heavy project.
  AND r.page_view_span_id IS NULL
  ${serviceCondition}${searchCondition}${cursorCondition}
ORDER BY r.created_at DESC, r.span_id DESC
LIMIT ${ROOT_PAGE_SIZE}
`,
    params,
  };
}

export const PAGE_VIEW_CHILDREN_CAP = 200;

export function getPageViewChildrenQuery(pageViewSpanId: string): {
  query: string,
  params: Record<string, string | number>,
} {
  return {
    query: `
SELECT
  r.trace_id AS trace_id,
  r.span_id,
  r.span_type,
  r.started_at,
  r.ended_at,
  r.status_code,
  r.scope_name,
  r.data,
  CAST(NULL, 'Nullable(String)') AS parent_span_id,
  u.display_name AS user_display_name,
  u.primary_email AS user_primary_email,
  u.profile_image_url AS user_profile_image_url,
  0 AS child_count,
  arrayMap(service -> service.1, ts.services) AS trace_service_namespaces,
  arrayMap(service -> service.2, ts.services) AS trace_service_names
FROM default.trace_roots AS r
LEFT JOIN default.users AS u ON toString(u.id) = r.user_id
LEFT JOIN (
  SELECT
    trace_id,
    arraySort(groupUniqArray(tuple(coalesce(service_namespace, ''), service_name))) AS services
  FROM default.trace_services
  WHERE service_name != ''
  GROUP BY trace_id
) AS ts ON ts.trace_id = r.trace_id
WHERE r.page_view_span_id = {pageViewSpanId:String}
ORDER BY r.started_at ASC, r.span_id ASC
LIMIT ${PAGE_VIEW_CHILDREN_CAP}
`,
    params: { pageViewSpanId },
  };
}

export function getSelectedTraceSpanQuery(traceId: string, focusSpanId: string | null = null): {
  query: string,
  params: Record<string, string | number>,
} {
  return {
    query: `
${TRACE_SPAN_STRUCTURE_SELECT_SQL}
WHERE s.trace_id = {traceId:String}
-- Oldest-first keeps the root and beginning of a pathological trace. When a
-- span-link navigation names a target, rank that exact span first so the
-- 10,000-row safety cap cannot turn a retained target into a false "missing"
-- result. The remaining 9,999 rows still begin at the physical trace root.
ORDER BY ${focusSpanId === null ? "s.started_at ASC" : "s.span_id = {focusSpanId:String} DESC, s.started_at ASC"}
LIMIT 10000
`,
    params: { traceId, ...focusSpanId === null ? {} : { focusSpanId } },
  };
}

export const TRACE_SPANS_CAP = 10000;
export const SPAN_LINKS_CAP = 1000;

export function getSelectedTraceLinksQuery(traceId: string): {
  query: string,
  params: Record<string, string>,
} {
  return {
    query: `
SELECT
  trace_id,
  owner_span_id,
  linked_trace_id,
  linked_span_id,
  linked_project_id,
  linked_branch_id,
  linked_project_id = project_id AND linked_branch_id = branch_id AS target_is_same_scope
FROM default.span_links
WHERE trace_id = {traceId:String}
ORDER BY owner_span_id ASC, linked_trace_id ASC, linked_span_id ASC
LIMIT ${SPAN_LINKS_CAP + 1}
`,
    params: { traceId },
  };
}

export const SPAN_DETAIL_COLUMNS: readonly string[] = [
  "span_type",
  "started_at",
  "ended_at",
  "status_code",
  "status_message",
  "deployment_environment_name",
  "gen_ai_operation_name",
  "gen_ai_provider_name",
  "gen_ai_request_model",
  "gen_ai_response_model",
  "gen_ai_input_tokens",
  "gen_ai_output_tokens",
  "gen_ai_cache_read_input_tokens",
  "gen_ai_reasoning_output_tokens",
  "gen_ai_tool_name",
  "gen_ai_agent_name",
  "gen_ai_conversation_id",
  "data",
  "user_id",
  "team_id",
  "refresh_token_id",
  "session_replay_id",
  "session_replay_segment_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "page_view_span_id",
  "kind",
  "scope_name",
  "scope_version",
  "service_namespace",
  "service_name",
  "service_version",
  "service_instance_id",
  "resource_attributes",
  "producer",
  "created_at",
];

export const SPAN_TECHNICAL_DETAIL_COLUMNS: readonly string[] = [
  "trace_id",
  "span_id",
  "parent_span_id",
  "page_view_span_id",
  "kind",
  "scope_name",
  "scope_version",
  "service_namespace",
  "service_name",
  "service_version",
  "service_instance_id",
  "resource_attributes",
  "producer",
  "created_at",
  // These render curated in the detail dialog's "AI" section, so the raw
  // columns collapse behind the technical-details disclosure instead of
  // adding eleven mostly-NULL rows to every span's main field list.
  "gen_ai_operation_name",
  "gen_ai_provider_name",
  "gen_ai_request_model",
  "gen_ai_response_model",
  "gen_ai_input_tokens",
  "gen_ai_output_tokens",
  "gen_ai_cache_read_input_tokens",
  "gen_ai_reasoning_output_tokens",
  "gen_ai_tool_name",
  "gen_ai_agent_name",
  "gen_ai_conversation_id",
  "user_display_name",
  "user_primary_email",
  "user_profile_image_url",
];

export function getSpanDetailQuery(traceId: string, spanId: string): {
  query: string,
  params: Record<string, string>,
} {
  return {
    query: `
SELECT ${SPAN_DETAIL_COLUMNS.join(", ")}
FROM default.spans
WHERE trace_id = {traceId:String}
  AND span_id = {spanId:String}
LIMIT 1
`,
    params: { traceId, spanId },
  };
}

export const TRACE_EVENT_WINDOW_SLACK_MS = 15 * 60 * 1000;

export function getSelectedTraceEventQuery(
  traceId: string,
  focusEventAtMs: number | null,
  window: { startMs: number, endMs: number },
): {
  query: string,
  params: Record<string, string | number>,
} {
  return {
    query: `
WITH correlated AS (
  SELECT event_type, event_at, data, CAST('' AS String) AS body, level,
         CAST(0 AS UInt8) AS severity_number, CAST('' AS String) AS severity_text,
         user_id, trace_id, span_id, page_view_span_id,
         refresh_token_id, session_replay_id, session_replay_segment_id
  FROM default.events
  UNION ALL
  SELECT event_type, event_at, data, body, level, severity_number, severity_text,
         user_id, trace_id, span_id, page_view_span_id,
         refresh_token_id, session_replay_id, session_replay_segment_id
  FROM default.logs
  UNION ALL
  SELECT event_type, event_at, data, body, level, severity_number, severity_text,
         user_id, trace_id, span_id, page_view_span_id,
         refresh_token_id, session_replay_id, session_replay_segment_id
  FROM default.errors
  UNION ALL
  SELECT event_type, event_at, data, CAST('' AS String) AS body, level,
         CAST(0 AS UInt8) AS severity_number, CAST('' AS String) AS severity_text,
         user_id, trace_id, span_id, page_view_span_id,
         refresh_token_id, session_replay_id, session_replay_segment_id
  FROM default.span_events
)
SELECT event_type, event_at, data, body, level, severity_number, severity_text,
       user_id, trace_id, span_id, page_view_span_id,
       refresh_token_id, session_replay_id, session_replay_segment_id
FROM correlated
WHERE trace_id = {traceId:String}
  AND event_at >= fromUnixTimestamp64Milli({eventWindowStartMs:Int64})
  AND event_at <= fromUnixTimestamp64Milli({eventWindowEndMs:Int64})
ORDER BY ${focusEventAtMs == null ? "event_at ASC" : "abs(toUnixTimestamp64Milli(event_at) - {focusEventAtMs:Int64}) ASC, event_at ASC"}
LIMIT 5000
`,
    params: {
      traceId,
      eventWindowStartMs: window.startMs,
      eventWindowEndMs: window.endMs,
      ...focusEventAtMs == null ? {} : { focusEventAtMs },
    },
  };
}

export function parseSpanRow(row: RowData): SpanInput | null {
  const traceId = row.trace_id;
  const id = row.span_id;
  const spanType = row.span_type;
  const startedAt = row.started_at;
  if (typeof traceId !== "string" || typeof id !== "string" || typeof spanType !== "string" || !isDateValue(startedAt)) return null;
  const endedAt = row.ended_at;
  return {
    traceId,
    id,
    spanType,
    startMs: parseClickHouseDate(startedAt).getTime(),
    endMs: isDateValue(endedAt) ? parseClickHouseDate(endedAt).getTime() : null,
    parentSpanId: typeof row.parent_span_id === "string" && row.parent_span_id !== "" ? row.parent_span_id : null,
    raw: {
      ...row,
      data: tryParseJson(row.data),
      resource_attributes: tryParseJson(row.resource_attributes),
    },
  };
}

export function parseEventRow(row: RowData): EventInput | null {
  const eventType = row.event_type;
  const eventAt = row.event_at;
  if (typeof eventType !== "string" || !isDateValue(eventAt)) return null;
  const traceId = typeof row.trace_id === "string" && row.trace_id !== "" ? row.trace_id : null;
  const spanId = typeof row.span_id === "string" && row.span_id !== "" ? row.span_id : null;
  return {
    traceId: traceId !== null && spanId !== null ? traceId : null,
    eventType,
    atMs: parseClickHouseDate(eventAt).getTime(),
    spanId: traceId !== null && spanId !== null ? spanId : null,
    raw: { ...row, body: tryParseJson(row.body), data: tryParseJson(row.data) },
  };
}

export function parseUniqueSpanRows(rows: RowData[]): SpanInput[] {
  const spansByTraceAndId = new Map<string, SpanInput>();
  for (const row of rows) {
    const span = parseSpanRow(row);
    if (span === null) continue;
    const key = `${span.traceId}:${span.id}`;
    if (!spansByTraceAndId.has(key)) spansByTraceAndId.set(key, span);
  }
  return [...spansByTraceAndId.values()];
}

export type TraceLink = {
  ownerSpanId: string,
  linkedTraceId: string,
  linkedSpanId: string,
  linkedProjectId: string,
  linkedBranchId: string,
  targetIsSameScope: boolean,
};

export function parseTraceLinkRow(row: RowData): TraceLink | null {
  if (
    typeof row.owner_span_id !== "string"
    || typeof row.linked_trace_id !== "string"
    || typeof row.linked_span_id !== "string"
    || typeof row.linked_project_id !== "string"
    || typeof row.linked_branch_id !== "string"
  ) return null;
  return {
    ownerSpanId: row.owner_span_id,
    linkedTraceId: row.linked_trace_id,
    linkedSpanId: row.linked_span_id,
    linkedProjectId: row.linked_project_id,
    linkedBranchId: row.linked_branch_id,
    targetIsSameScope: row.target_is_same_scope === 1 || row.target_is_same_scope === true,
  };
}

export function parseTraceLinkRows(rows: RowData[]): TraceLink[] {
  return rows
    .map(parseTraceLinkRow)
    .filter((link): link is TraceLink => link != null)
    .slice(0, SPAN_LINKS_CAP);
}

export type TraceRootSpan = SpanInput & {
  activityMs: number,
};

export function parseUniqueTraceRootRows(rows: RowData[]): TraceRootSpan[] {
  return parseUniqueSpanRows(rows).map((span) => {
    const activityAt = span.raw.root_activity_at;
    if (!isDateValue(activityAt)) {
      throw new Error("Trace root query returned a row without root_activity_at");
    }
    return {
      ...span,
      activityMs: parseClickHouseDate(activityAt).getTime(),
    };
  });
}

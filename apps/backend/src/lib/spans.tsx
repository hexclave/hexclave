import {
  uuidToW3cSpanId,
  uuidToW3cTraceId,
  type TelemetryResource,
  type TelemetrySpanKind,
  type TelemetrySpanStatusCode,
} from "@hexclave/shared/dist/utils/analytics-wire";
import { type ClickHouseClient } from "./clickhouse";
import { buildTelemetryResourceFields } from "./telemetry/resource";


export type SpanInsertRow = {
  trace_id: string,
  span_id: string,
  span_type: string,
  billing_item: "analytics_spans" | null,
  started_at: Date,
  ended_at: Date | null,
  parent_span_id: string | null,
  trace_state?: string,
  trace_flags?: number,
  start_time_unix_nano?: string,
  end_time_unix_nano?: string,
  data: string,
  kind: TelemetrySpanKind,
  status_code: TelemetrySpanStatusCode,
  status_message: string | null,
  service_namespace: string | null,
  service_name: string | null,
  service_version: string | null,
  service_instance_id: string | null,
  deployment_environment_name: string | null,
  resource_attributes: string,
  resource_dropped_attributes?: number,
  resource_schema_url?: string,
  scope_name?: string | null,
  scope_version?: string | null,
  scope_attributes?: string,
  scope_dropped_attributes?: number,
  scope_schema_url?: string,
  attributes?: string,
  dropped_attributes?: number,
  dropped_events?: number,
  dropped_links?: number,
  producer: "sdk" | "hexclave-backend",
  project_id: string,
  branch_id: string,
  user_id: string | null,
  team_id: string | null,
  refresh_token_id: string | null,
  session_replay_id: string | null,
  session_replay_segment_id: string | null,
  page_view_span_id: string | null,
  // Canonical AI-telemetry projection (see @hexclave/shared gen-ai.tsx).
  // Optional so backend-minted lifecycle spans need not restate a null for
  // every column; the ClickHouse columns are Nullable and default to NULL.
  // Token counts are canonical uint64 strings — ClickHouse coerces the quoted
  // form into UInt64 the same way version/start_time_unix_nano already rely on.
  gen_ai_operation_name?: string | null,
  gen_ai_provider_name?: string | null,
  gen_ai_request_model?: string | null,
  gen_ai_response_model?: string | null,
  gen_ai_input_tokens?: string | null,
  gen_ai_output_tokens?: string | null,
  gen_ai_cache_read_input_tokens?: string | null,
  gen_ai_reasoning_output_tokens?: string | null,
  gen_ai_tool_name?: string | null,
  gen_ai_agent_name?: string | null,
  gen_ai_conversation_id?: string | null,
  version: number | string,
};

export async function insertSpans(
  client: ClickHouseClient,
  rows: SpanInsertRow[],
  options?: { deduplicationToken?: string },
): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({
    table: "analytics_internal.spans",
    values: rows,
    format: "JSONEachRow",
    clickhouse_settings: {
      date_time_input_format: "best_effort",
      wait_for_async_insert: 1,
      ...options?.deduplicationToken == null
        ? { async_insert: 1 }
        : {
          async_insert: 0,
          deduplicate_blocks_in_dependent_materialized_views: 1,
          insert_deduplication_token: options.deduplicationToken,
        },
    },
  });
}

export const SESSION_LIFECYCLE_SPAN_TYPES = {
  replay: "$session-replay",
  segment: "$session-replay-segment",
} as const;

export function monotoneEndSpanVersion(spanEndedAt: Date): number {
  return spanEndedAt.getTime();
}

export type SpanLinkInsertRow = {
  project_id: string,
  branch_id: string,
  trace_id: string,
  owner_span_id: string,
  linked_trace_id: string,
  linked_span_id: string,
  linked_project_id: string,
  linked_branch_id: string,
  linked_trace_state?: string | null,
  linked_trace_flags?: number,
  attributes?: string,
  dropped_attributes?: number,
};

export async function insertSpanLinks(
  client: ClickHouseClient,
  rows: SpanLinkInsertRow[],
  options?: { deduplicationToken?: string },
): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({
    table: "analytics_internal.span_links",
    values: rows,
    format: "JSONEachRow",
    clickhouse_settings: {
      date_time_input_format: "best_effort",
      wait_for_async_insert: 1,
      ...options?.deduplicationToken == null
        ? { async_insert: 1 }
        : {
          async_insert: 0,
          deduplicate_blocks_in_dependent_materialized_views: 1,
          insert_deduplication_token: options.deduplicationToken,
        },
    },
  });
}

export async function insertSessionReplaySpans(
  client: ClickHouseClient,
  opts: {
    projectId: string,
    branchId: string,
    replayId: string,
    sessionReplaySegmentId: string,
    projectUserId: string,
    refreshTokenId: string,
    replayStartedAt: Date,
    replayLastEventAt: Date,
    segmentStartedAt: Date,
    segmentLastEventAt: Date,
    resource: TelemetryResource,
  },
): Promise<void> {
  const traceId = uuidToW3cTraceId(opts.refreshTokenId);
  const base = {
    trace_id: traceId,
    data: "{}",
    kind: "internal" as const,
    status_code: "unset" as const,
    status_message: null,
    scope_name: null,
    scope_version: null,
    ...buildTelemetryResourceFields(opts.resource),
    producer: "sdk" as const,
    billing_item: null,
    project_id: opts.projectId,
    branch_id: opts.branchId,
    user_id: opts.projectUserId,
    team_id: null,
    refresh_token_id: opts.refreshTokenId,
    session_replay_id: opts.replayId,
    page_view_span_id: null,
  } as const;

  const replaySpan: SpanInsertRow = {
    ...base,
    span_id: uuidToW3cSpanId(opts.replayId),
    span_type: SESSION_LIFECYCLE_SPAN_TYPES.replay,
    started_at: opts.replayStartedAt,
    ended_at: opts.replayLastEventAt,
    parent_span_id: uuidToW3cSpanId(opts.refreshTokenId),
    session_replay_segment_id: null,
    version: monotoneEndSpanVersion(opts.replayLastEventAt),
  };

  const segmentSpan: SpanInsertRow = {
    ...base,
    span_id: uuidToW3cSpanId(opts.sessionReplaySegmentId),
    span_type: SESSION_LIFECYCLE_SPAN_TYPES.segment,
    started_at: opts.segmentStartedAt,
    ended_at: opts.segmentLastEventAt,
    parent_span_id: replaySpan.span_id,
    session_replay_segment_id: opts.sessionReplaySegmentId,
    version: monotoneEndSpanVersion(opts.segmentLastEventAt),
  };

  await insertSpans(client, [replaySpan, segmentSpan]);
}

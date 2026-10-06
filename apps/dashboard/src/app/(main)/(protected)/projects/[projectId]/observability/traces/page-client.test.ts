import { describe, expect, it } from "vitest";
import {
  getRecentTraceRootsQuery,
  getSelectedTraceEventQuery,
  getSelectedTraceLinksQuery,
  getSelectedTraceSpanQuery,
  getSpanDetailQuery,
  parseEventRow,
  parseTraceLinkRow,
  parseTraceLinkRows,
  parseUniqueTraceRootRows,
  parseUniqueSpanRows,
  SPAN_DETAIL_COLUMNS,
  SPAN_TECHNICAL_DETAIL_COLUMNS,
  TRACE_SERVICES_QUERY,
} from "./trace-queries";
import {
  selectValueToServiceIdentity,
  serviceIdentityToSelectValue,
} from "../service-identity";

describe("analytics trace row parsing", () => {


  it("normalizes serialized event data for the shared detail dialog", () => {
    expect(parseEventRow({
      event_type: "checkout",
      event_at: "2026-07-21 12:00:00.000",
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      body: '{"type":"string","value":"checkout failed"}',
      data: "{\"step\":2}",
    })).toMatchObject({
      traceId: "0123456789abcdef0123456789abcdef",
      eventType: "checkout",
      spanId: "0123456789abcdef",
      raw: { body: { type: "string", value: "checkout failed" }, data: { step: 2 } },
    });
  });

  it("leaves an event with no enclosing span unattached instead of inventing an owner", () => {
    expect(parseEventRow({
      event_type: "checkout",
      event_at: "2026-07-21 12:00:00.000",
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: null,
      data: "{}",
    })).toMatchObject({ traceId: null, spanId: null });
  });

  it("lists only physical roots and leaves the rest of the trace to the selected waterfall", () => {
    const { query } = getRecentTraceRootsQuery(null);
    expect(query).toContain("FROM default.trace_roots AS r");
    expect(query).not.toContain("$http-client");
    expect(query).toContain("r.status_code");
    expect(query).not.toContain("_next/static");
    expect(query).not.toContain("coalesce(r.scope_name, '')");
    expect(query).toContain("CAST(NULL, 'Nullable(String)') AS parent_span_id");
    expect(query).not.toContain("'bridged-server'");
    expect(query).not.toContain("row_number() OVER");
    expect(query).not.toContain("UNION ALL");
    expect(query).not.toContain("FROM default.refresh_tokens");
    expect(query).toContain("LEFT JOIN default.users AS u");
  });

  it("loads root user profiles in the root query instead of a second request", () => {
    const { query } = getRecentTraceRootsQuery(null);
    expect(query).toContain("u.display_name AS user_display_name");
    expect(query).toContain("u.primary_email AS user_primary_email");
    expect(query).toContain("u.profile_image_url AS user_profile_image_url");
  });

  it("uses root activity rather than interval start for inbox freshness and pagination", () => {
    const { query, params } = getRecentTraceRootsQuery({ activityMs: 1234, id: "otel-root" });
    expect(query).toContain("r.created_at AS root_activity_at");
    expect(query).toContain("WHERE r.created_at >= now64(3) - INTERVAL {hours:UInt32} HOUR");
    expect(query).toContain("r.created_at < fromUnixTimestamp64Milli({cursorActivityMs:Int64})");
    expect(query).toContain("ORDER BY r.created_at DESC, r.span_id DESC");
    expect(query).toContain("span_id < {cursorId:String}");
    expect(query).not.toContain("FROM default.refresh_tokens");
    expect(params).toMatchObject({ cursorActivityMs: 1234, cursorId: "otel-root" });
  });

  it("filters by every service participating in a trace, not only the root service", () => {
    const { query, params } = getRecentTraceRootsQuery(null, {
      namespace: "server",
      name: "stack-backend",
    });
    expect(query).toContain("FROM default.trace_services");
    expect(query).toContain("coalesce(service_namespace, '') = {serviceNamespace:String}");
    expect(query).toContain("service_name = {serviceName:String}");
    expect(query).not.toContain("FROM default.refresh_tokens");
    expect(params).toMatchObject({
      serviceNamespace: "server",
      serviceName: "stack-backend",
    });
  });

  it("searches and paginates trace roots on the server", () => {
    const { query, params } = getRecentTraceRootsQuery(
      { activityMs: 1234, id: "older-root" },
      { namespace: "server", name: "stack-backend" },
      "alice@example.com",
    );

    expect(query).toContain("positionCaseInsensitiveUTF8(r.span_type, {search:String})");
    expect(query).toContain("positionCaseInsensitiveUTF8(JSONExtractString(r.data, 'name'), {search:String})");
    expect(query).toContain("positionCaseInsensitiveUTF8(r.trace_id, {search:String})");
    expect(query).toContain("LEFT JOIN default.users AS u");
    expect(query).toContain("positionCaseInsensitiveUTF8(ifNull(u.primary_email, ''), {search:String})");
    expect(query).toContain("r.created_at < fromUnixTimestamp64Milli({cursorActivityMs:Int64})");
    expect(params).toMatchObject({
      cursorActivityMs: 1234,
      cursorId: "older-root",
      serviceNamespace: "server",
      serviceName: "stack-backend",
      search: "alice@example.com",
    });

    const unfiltered = getRecentTraceRootsQuery(null);
    expect(unfiltered.query).not.toContain("{search:String}");
    expect(unfiltered.params).not.toHaveProperty("search");
  });

  it("lists only named physical service identities and round-trips the filter", () => {
    expect(TRACE_SERVICES_QUERY).toContain("SELECT service_namespace, service_name");
    expect(TRACE_SERVICES_QUERY).toContain("service_name != ''");
    expect(TRACE_SERVICES_QUERY).toContain("GROUP BY service_namespace, service_name");
    expect(TRACE_SERVICES_QUERY).not.toContain("Hexclave");

    const identity = { namespace: "browser", name: "stack-dashboard" };
    expect(selectValueToServiceIdentity(serviceIdentityToSelectValue(identity))).toEqual(identity);
  });

  it("loads physical service sets for every root instead of attributing synthetic roots", () => {
    const { query } = getRecentTraceRootsQuery(null);
    expect(query).toContain("r.trace_id AS trace_id");
    expect(query).toContain("arraySort(groupUniqArray(tuple(coalesce(service_namespace, ''), service_name)))");
    expect(query).toContain("trace_service_namespaces");
    expect(query).toContain("trace_service_names");
    expect(query).toContain("WHERE service_name != ''");
  });

  it("loads the whole distributed trace from its single trace id", () => {
    const spanQuery = getSelectedTraceSpanQuery(
      "0123456789abcdef0123456789abcdef",
    );
    expect(spanQuery).toMatchObject({
      params: { traceId: "0123456789abcdef0123456789abcdef" },
    });
    expect(spanQuery.query).toContain("s.parent_span_id");
    expect(spanQuery.query).toContain("s.status_code");
    expect(spanQuery.query).toContain("s.scope_name");
    expect(spanQuery.query).not.toContain("s.data");
    expect(spanQuery.query).not.toContain("s.resource_attributes");
    expect(spanQuery.query).toContain("WHERE s.trace_id = {traceId:String}");
    expect(spanQuery.query).not.toContain(" OR ");
    expect(spanQuery.query).not.toContain("startsWith(");
    expect(spanQuery.query).toContain("ORDER BY s.started_at ASC");
  });

  it("loads the compact AI columns for the waterfall without the span data payload", () => {
    const spanQuery = getSelectedTraceSpanQuery("0123456789abcdef0123456789abcdef");
    for (const column of [
      "s.gen_ai_operation_name",
      "s.gen_ai_request_model",
      "s.gen_ai_input_tokens",
      "s.gen_ai_output_tokens",
      "s.gen_ai_tool_name",
      "s.gen_ai_agent_name",
    ]) {
      expect(spanQuery.query).toContain(column);
    }
    // Provider, response model, subset token counts, and conversation id are
    // detail-pane-only; the waterfall chip never shows them.
    expect(spanQuery.query).not.toContain("s.gen_ai_provider_name");
    expect(spanQuery.query).not.toContain("s.gen_ai_response_model");
    expect(spanQuery.query).not.toContain("s.gen_ai_cache_read_input_tokens");
    expect(spanQuery.query).not.toContain("s.gen_ai_reasoning_output_tokens");
    expect(spanQuery.query).not.toContain("s.gen_ai_conversation_id");
  });

  it("keeps a directly linked target inside the large-trace safety cap", () => {
    const spanQuery = getSelectedTraceSpanQuery(
      "0123456789abcdef0123456789abcdef",
      "fedcba9876543210",
    );

    expect(spanQuery.params).toEqual({
      traceId: "0123456789abcdef0123456789abcdef",
      focusSpanId: "fedcba9876543210",
    });
    expect(spanQuery.query).toContain("s.span_id = {focusSpanId:String} DESC, s.started_at ASC");
    expect(spanQuery.query).toContain("LIMIT 10000");
  });

  it("loads and parses span links separately without merging them into the tree", () => {
    const linkQuery = getSelectedTraceLinksQuery("0123456789abcdef0123456789abcdef");
    expect(linkQuery.params).toEqual({ traceId: "0123456789abcdef0123456789abcdef" });
    expect(linkQuery.query).toContain("FROM default.span_links");
    expect(linkQuery.query).toContain("target_is_same_scope");
    expect(linkQuery.query).toContain("LIMIT 1001");
    expect(linkQuery.query).not.toContain("JOIN default.spans");
    expect(parseTraceLinkRow({
      owner_span_id: "1111111111111111",
      linked_trace_id: "22222222222222222222222222222222",
      linked_span_id: "3333333333333333",
      linked_project_id: "internal",
      linked_branch_id: "main",
      target_is_same_scope: 1,
    })).toEqual({
      ownerSpanId: "1111111111111111",
      linkedTraceId: "22222222222222222222222222222222",
      linkedSpanId: "3333333333333333",
      linkedProjectId: "internal",
      linkedBranchId: "main",
      targetIsSameScope: true,
    });
  });

  it("filters malformed links before applying the display cap", () => {
    expect(parseTraceLinkRows([
      {},
      {
        owner_span_id: "1111111111111111",
        linked_trace_id: "22222222222222222222222222222222",
        linked_span_id: "3333333333333333",
        linked_project_id: "internal",
        linked_branch_id: "main",
      },
    ])).toHaveLength(1);
  });

  it("selects the enclosing span and page-view correlation on events, not an ancestry array", () => {
    const { query } = getSelectedTraceEventQuery("0123456789abcdef0123456789abcdef", null, { startMs: 1_720_000_000_000, endMs: 1_720_000_100_000 });
    expect(query).toContain("trace_id, span_id, page_view_span_id");
    expect(query).toContain("CAST('' AS String) AS body");
    expect(query).not.toContain("message AS body");
    expect(query).toContain("severity_number");
    expect(query).toContain("severity_text");
    expect(query).toContain("WHERE trace_id = {traceId:String}");
    expect(query).not.toContain("parent_span_ids");
    expect(query).not.toContain("w3c_trace_id");
  });

  it("bounds the event scan to the selected trace's interval, not the inbox window", () => {
    const { query, params } = getSelectedTraceEventQuery("0123456789abcdef0123456789abcdef", null, { startMs: 1_720_000_000_000, endMs: 1_720_000_100_000 });
    expect(query).toContain("event_at >= fromUnixTimestamp64Milli({eventWindowStartMs:Int64})");
    expect(query).toContain("event_at <= fromUnixTimestamp64Milli({eventWindowEndMs:Int64})");
    expect(query).not.toContain("INTERVAL {hours:UInt32}");
    expect(params).toEqual({
      traceId: "0123456789abcdef0123456789abcdef",
      eventWindowStartMs: 1_720_000_000_000,
      eventWindowEndMs: 1_720_000_100_000,
    });
  });

  it("ranks a deep-linked event first so the 5000-row cap cannot hide it", () => {
    const focused = getSelectedTraceEventQuery("0123456789abcdef0123456789abcdef", 1_720_000_000_000, { startMs: 1_719_999_000_000, endMs: 1_720_000_100_000 });
    expect(focused.query).toContain("abs(toUnixTimestamp64Milli(event_at) - {focusEventAtMs:Int64})");
    expect(focused.params).toEqual({
      traceId: "0123456789abcdef0123456789abcdef",
      eventWindowStartMs: 1_719_999_000_000,
      eventWindowEndMs: 1_720_000_100_000,
      focusEventAtMs: 1_720_000_000_000,
    });
  });

  it("loads only the detail dialog's columns when a span detail opens", () => {
    const detailQuery = getSpanDetailQuery("trace-123", "span-456");
    expect(detailQuery.query).not.toContain("*");
    expect(detailQuery.query).toContain(`SELECT ${SPAN_DETAIL_COLUMNS.join(", ")}`);
    expect(detailQuery.query).toContain("trace_id = {traceId:String}");
    expect(detailQuery.query).toContain("span_id = {spanId:String}");
    expect(detailQuery.query).toContain("LIMIT 1");
    expect(detailQuery.params).toEqual({ traceId: "trace-123", spanId: "span-456" });

    for (const column of ["trace_id", "span_id", "span_type", "started_at", "ended_at", "parent_span_id", "status_code", "data", "resource_attributes"]) {
      expect(SPAN_DETAIL_COLUMNS).toContain(column);
    }
    expect(SPAN_DETAIL_COLUMNS).not.toContain("project_id");
    expect(SPAN_DETAIL_COLUMNS).not.toContain("branch_id");
    expect(SPAN_DETAIL_COLUMNS).not.toContain("version");
    for (const column of ["trace_state", "trace_flags", "resource_schema_url", "scope_attributes", "scope_schema_url", "dropped_resource_attributes", "dropped_scope_attributes", "dropped_attributes", "dropped_events", "dropped_links"]) {
      expect(SPAN_DETAIL_COLUMNS).not.toContain(column);
    }
    expect(SPAN_DETAIL_COLUMNS).toMatchInlineSnapshot(`
      [
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
      ]
    `);
  });

  it("collapses raw identifiers behind the technical-details disclosure", () => {
    const queriedTechnicalColumns = SPAN_TECHNICAL_DETAIL_COLUMNS.filter((column) => SPAN_DETAIL_COLUMNS.includes(column));
    expect(queriedTechnicalColumns).toEqual([
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
    ]);
    for (const nativeColumn of ["span_type", "started_at", "ended_at", "status_code", "status_message", "data", "user_id", "deployment_environment_name"]) {
      expect(SPAN_TECHNICAL_DETAIL_COLUMNS).not.toContain(nativeColumn);
    }
  });

  it("loads the complete distributed trace after filtering the inbox by service", () => {
    const spans = getSelectedTraceSpanQuery("0123456789abcdef0123456789abcdef");
    const events = getSelectedTraceEventQuery("0123456789abcdef0123456789abcdef", null, { startMs: 1_720_000_000_000, endMs: 1_720_000_100_000 });

    expect(spans.query).not.toContain("{serviceName:String}");
    expect(events.query).not.toContain("{serviceName:String}");
    expect(spans.params).toEqual({
      traceId: "0123456789abcdef0123456789abcdef",
    });
    expect(events.params).toEqual({
      traceId: "0123456789abcdef0123456789abcdef",
      eventWindowStartMs: 1_720_000_000_000,
      eventWindowEndMs: 1_720_000_100_000,
    });
    expect(events.query).not.toContain("INTERVAL");
  });

  it("deduplicates a span row returned more than once", () => {
    const row = {
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      span_type: "$page-view",
      started_at: "2026-07-21 12:00:00.000",
      ended_at: null,
      parent_span_id: null,
      data: "{}",
    };
    expect(parseUniqueSpanRows([row, row])).toHaveLength(1);
  });

  it("keeps trace interval time separate from inbox activity time", () => {
    const [root] = parseUniqueTraceRootRows([{
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      span_type: "$refresh-token",
      started_at: "2026-07-21 12:00:00.000",
      ended_at: "2026-07-28 12:00:00.000",
      root_activity_at: "2026-07-21 12:30:00.000",
      parent_span_id: null,
      data: "{}",
    }]);

    expect(root.startMs).toBe(Date.parse("2026-07-21T12:00:00.000Z"));
    expect(root.activityMs).toBe(Date.parse("2026-07-21T12:30:00.000Z"));
  });

  it("rejects a root row without the inbox activity clock", () => {
    expect(() => parseUniqueTraceRootRows([{
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      span_type: "$refresh-token",
      started_at: "2026-07-21 12:00:00.000",
      ended_at: null,
      parent_span_id: null,
      data: "{}",
    }])).toThrowError("Trace root query returned a row without root_activity_at");
  });

  it("reads the scalar parent as a root when ClickHouse sends it as NULL", () => {
    const [parsed] = parseUniqueSpanRows([{
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      span_type: "$page-view",
      started_at: "2026-07-21 12:00:00.000",
      ended_at: null,
      parent_span_id: null,
      data: "{}",
    }]);
    expect(parsed.parentSpanId).toBeNull();

    const [child] = parseUniqueSpanRows([{
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "fedcba9876543210",
      span_type: "GET /api/thing",
      started_at: "2026-07-21 12:00:00.000",
      ended_at: "2026-07-21 12:00:01.000",
      parent_span_id: "0123456789abcdef",
      data: "{}",
    }]);
    expect(child.parentSpanId).toBe("0123456789abcdef");
  });
});

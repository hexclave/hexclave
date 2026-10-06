import { describe, expect, it } from "vitest";
import { buildOtlpTraceRows, getOtlpTraceDeduplicationToken } from "./trace-writer";
import { normalizeOtlpJsonTraceRequest } from "./traces";

describe("OTLP trace storage mapping", () => {
  it("preserves canonical fields and stamps authenticated tenancy", () => {
    const canonical = normalizeOtlpJsonTraceRequest({
      resourceSpans: [{
        schemaUrl: "resource-schema",
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "checkout" } },
            { key: "service.instance.id", value: { stringValue: "instance-1" } },
          ],
          droppedAttributesCount: 1,
        },
        scopeSpans: [{
          schemaUrl: "scope-schema",
          scope: { name: "instrumentation", version: "1.0.0", droppedAttributesCount: 2 },
          spans: [{
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
            traceState: "vendor=value",
            flags: 257,
            name: "request",
            kind: 2,
            startTimeUnixNano: "1785888000000000001",
            endTimeUnixNano: "1785888000001000002",
            attributes: [
              { key: "hexclave.session_replay.id", value: { stringValue: "11111111-1111-4111-8111-111111111111" } },
              { key: "large", value: { intValue: "9223372036854775807" } },
            ],
            droppedAttributesCount: 3,
            events: [{
              name: "exception",
              timeUnixNano: "1785888000000500003",
              attributes: [{ key: "exception.message", value: { stringValue: "boom" } }],
              droppedAttributesCount: 4,
            }],
            droppedEventsCount: 5,
            links: [{
              traceId: "33333333333333333333333333333333",
              spanId: "4444444444444444",
              traceState: "linked=value",
              flags: 1,
              attributes: [{ key: "reason", value: { bytesValue: "AAE=" } }],
              droppedAttributesCount: 6,
            }],
            droppedLinksCount: 7,
            status: { code: 2, message: "failed" },
          }],
        }],
      }],
    });
    const rows = buildOtlpTraceRows(canonical, {
      projectId: "authenticated-project",
      branchId: "authenticated-branch",
      userId: null,
      refreshTokenId: null,
    });

    expect(rows.spans).toMatchInlineSnapshot(`
      [
        {
          "attributes": "{"hexclave.session_replay.id":{"type":"string","value":"11111111-1111-4111-8111-111111111111"},"large":{"type":"int","value":"9223372036854775807"}}",
          "billing_item": null,
          "branch_id": "authenticated-branch",
          "data": "{"hexclave.session_replay.id":"11111111-1111-4111-8111-111111111111","large":"9223372036854775807"}",
          "deployment_environment_name": null,
          "dropped_attributes": 3,
          "dropped_events": 5,
          "dropped_links": 7,
          "end_time_unix_nano": "1785888000001000002",
          "ended_at": 2026-08-05T00:00:00.001Z,
          "gen_ai_agent_name": null,
          "gen_ai_cache_read_input_tokens": null,
          "gen_ai_conversation_id": null,
          "gen_ai_input_tokens": null,
          "gen_ai_operation_name": null,
          "gen_ai_output_tokens": null,
          "gen_ai_provider_name": null,
          "gen_ai_reasoning_output_tokens": null,
          "gen_ai_request_model": null,
          "gen_ai_response_model": null,
          "gen_ai_tool_name": null,
          "kind": "server",
          "page_view_span_id": null,
          "parent_span_id": null,
          "producer": "sdk",
          "project_id": "authenticated-project",
          "refresh_token_id": null,
          "resource_attributes": "{"service.instance.id":{"type":"string","value":"instance-1"},"service.name":{"type":"string","value":"checkout"}}",
          "resource_dropped_attributes": 1,
          "resource_schema_url": "resource-schema",
          "scope_attributes": "{}",
          "scope_dropped_attributes": 2,
          "scope_name": "instrumentation",
          "scope_schema_url": "scope-schema",
          "scope_version": "1.0.0",
          "service_instance_id": "instance-1",
          "service_name": "checkout",
          "service_namespace": null,
          "service_version": null,
          "session_replay_id": "11111111-1111-4111-8111-111111111111",
          "session_replay_segment_id": null,
          "span_id": "2222222222222222",
          "span_type": "request",
          "start_time_unix_nano": "1785888000000000001",
          "started_at": 2026-08-05T00:00:00.000Z,
          "status_code": "error",
          "status_message": "failed",
          "team_id": null,
          "trace_flags": 257,
          "trace_id": "11111111111111111111111111111111",
          "trace_state": "vendor=value",
          "user_id": null,
          "version": "1785888000001000002",
        },
      ]
    `);
    expect(rows.events[0]).toMatchObject({ event_type: "exception", time_unix_nano: "1785888000000500003", dropped_attributes: 4 });
    expect(rows.links[0]).toMatchObject({ linked_trace_state: "linked=value", linked_trace_flags: 1, dropped_attributes: 6 });
    const tenant = {
      projectId: "authenticated-project",
      branchId: "authenticated-branch",
      userId: null,
      refreshTokenId: null,
    };
    expect(getOtlpTraceDeduplicationToken(canonical, tenant)).toMatch(/^[0-9a-f]{64}$/);
    expect(getOtlpTraceDeduplicationToken(canonical, tenant)).toBe(getOtlpTraceDeduplicationToken(canonical, tenant));
    expect(getOtlpTraceDeduplicationToken(canonical, { ...tenant, projectId: "other-project" }))
      .not.toBe(getOtlpTraceDeduplicationToken(canonical, tenant));
    expect(getOtlpTraceDeduplicationToken(canonical, {
      ...tenant,
      groupingConfig: { activeConfigId: "hexclave-js:2026-08-01" },
    })).toBe(getOtlpTraceDeduplicationToken(canonical, tenant));
    // A scrub-policy rollout between an insert and its exporter retry must not
    // mint a fresh ClickHouse retry token: the token hashes the spans WITHOUT
    // their server-side policy projection.
    expect(getOtlpTraceDeduplicationToken(
      canonical.map((span) => ({ ...span, policyScrubbedData: { scrubbed: true } })),
      tenant,
    )).toBe(getOtlpTraceDeduplicationToken(canonical, tenant));
  });

  it("stamps span-event runtime from the authenticated tenant, not a hardcoded server", () => {
    const canonicalWithEvent = (traceId: string) => normalizeOtlpJsonTraceRequest({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId,
            spanId: "2222222222222222",
            name: "request",
            startTimeUnixNano: "1785888000000000001",
            endTimeUnixNano: "1785888000001000002",
            events: [{ name: "exception", timeUnixNano: "1785888000000500003" }],
          }],
        }],
      }],
    });
    const tenantBase = { projectId: "p", branchId: "b", refreshTokenId: null };
    // Browser exports authenticate with a client session (user present).
    const [browserEvent] = buildOtlpTraceRows(canonicalWithEvent("11111111111111111111111111111111"), {
      ...tenantBase,
      userId: "11111111-1111-4111-8111-111111111111",
      refreshTokenId: "22222222-2222-4222-8222-222222222222",
    }).events;
    expect(browserEvent.runtime).toBe("browser");
    const [serverEvent] = buildOtlpTraceRows(canonicalWithEvent("33333333333333333333333333333333"), {
      ...tenantBase,
      userId: null,
    }).events;
    expect(serverEvent.runtime).toBe("server");
  });

  it("derives billing only from the Hexclave custom-span marker", () => {
    const canonical = normalizeOtlpJsonTraceRequest({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
            name: "arbitrary-operation-name",
            startTimeUnixNano: "1785888000000000001",
            endTimeUnixNano: "1785888000001000002",
            attributes: [{ key: "hexclave.signal.type", value: { stringValue: "custom_span" } }],
          }],
        }],
      }],
    });
    const [row] = buildOtlpTraceRows(canonical, {
      projectId: "authenticated-project",
      branchId: "authenticated-branch",
      userId: null,
      refreshTokenId: null,
    }).spans;

    expect(row.billing_item).toBe("analytics_spans");
  });

  it("writes open-span snapshots (endTimeUnixNano 0) with NULL ended_at and version 0", () => {
    const canonical = normalizeOtlpJsonTraceRequest({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
            name: "$page-view",
            startTimeUnixNano: "1785888000000000001",
            endTimeUnixNano: "0",
            attributes: [{ key: "hexclave.signal.type", value: { stringValue: "system_span" } }],
          }],
        }],
      }],
    });
    const [row] = buildOtlpTraceRows(canonical, {
      projectId: "authenticated-project",
      branchId: "authenticated-branch",
      userId: "user",
      refreshTokenId: "rt",
    }).spans;

    expect(row.ended_at).toBeNull();
    // ReplacingMergeTree versions rows by end time, so the snapshot (version 0)
    // is superseded by the span's eventual end-write.
    expect(row.version).toBe("0");
    expect(row.end_time_unix_nano).toBe("0");
  });

  it("preserves standard OTel HTTP attributes without a custom product schema", () => {
    const canonical = normalizeOtlpJsonTraceRequest({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
            name: "GET",
            startTimeUnixNano: "1785888000000000001",
            endTimeUnixNano: "1785888000001000002",
            attributes: [
              { key: "http.request.method", value: { stringValue: "POST" } },
              { key: "url.full", value: { stringValue: "https://api.example.com/orders" } },
              { key: "hexclave.network.transport", value: { stringValue: "fetch" } },
              { key: "http.response.status_code", value: { intValue: 503 } },
              { key: "error.type", value: { stringValue: "network_error" } },
              { key: "hexclave.http.propagated", value: { boolValue: true } },
            ],
          }],
        }],
      }],
    });
    const [row] = buildOtlpTraceRows(canonical, {
      projectId: "authenticated-project",
      branchId: "authenticated-branch",
      userId: null,
      refreshTokenId: null,
    }).spans;

    expect(JSON.parse(row.data)).toEqual({
      "http.request.method": "POST",
      "url.full": "https://api.example.com/orders",
      "hexclave.network.transport": "fetch",
      "http.response.status_code": 503,
      "error.type": "network_error",
      "hexclave.http.propagated": true,
    });
    expect(row.billing_item).toBeNull();
  });

  it("normalizes current OTel gen_ai spans into the canonical AI columns", () => {
    const canonical = normalizeOtlpJsonTraceRequest({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
            name: "chat gpt-4.1",
            startTimeUnixNano: "1785888000000000001",
            endTimeUnixNano: "1785888000001000002",
            attributes: [
              { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
              { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
              { key: "gen_ai.request.model", value: { stringValue: "gpt-4.1" } },
              { key: "gen_ai.response.model", value: { stringValue: "gpt-4.1-2026-04-14" } },
              { key: "gen_ai.usage.input_tokens", value: { intValue: 811 } },
              { key: "gen_ai.usage.output_tokens", value: { intValue: "92" } },
              { key: "gen_ai.usage.cache_read.input_tokens", value: { intValue: 640 } },
              { key: "gen_ai.conversation.id", value: { stringValue: "conv_0123" } },
            ],
          }],
        }],
      }],
    });
    const [row] = buildOtlpTraceRows(canonical, {
      projectId: "authenticated-project",
      branchId: "authenticated-branch",
      userId: null,
      refreshTokenId: null,
    }).spans;

    expect(row).toMatchObject({
      gen_ai_operation_name: "chat",
      gen_ai_provider_name: "openai",
      gen_ai_request_model: "gpt-4.1",
      gen_ai_response_model: "gpt-4.1-2026-04-14",
      gen_ai_input_tokens: "811",
      gen_ai_output_tokens: "92",
      gen_ai_cache_read_input_tokens: "640",
      gen_ai_reasoning_output_tokens: null,
      gen_ai_tool_name: null,
      gen_ai_agent_name: null,
      gen_ai_conversation_id: "conv_0123",
    });
    // Third-party AI spans carry no hexclave.signal.type and are not metered.
    expect(row.billing_item).toBeNull();
  });

  it("normalizes legacy Vercel AI SDK spans, preferring gen_ai spellings where both are present", () => {
    const canonical = normalizeOtlpJsonTraceRequest({
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            {
              traceId: "11111111111111111111111111111111",
              spanId: "2222222222222222",
              name: "ai.generateText",
              startTimeUnixNano: "1785888000000000001",
              endTimeUnixNano: "1785888000001000002",
              attributes: [
                { key: "ai.operationId", value: { stringValue: "ai.generateText" } },
                { key: "ai.model.id", value: { stringValue: "claude-fable-5" } },
                { key: "ai.model.provider", value: { stringValue: "anthropic.messages" } },
                { key: "ai.telemetry.functionId", value: { stringValue: "summarize-thread" } },
                { key: "ai.usage.promptTokens", value: { intValue: 1200 } },
                { key: "ai.usage.completionTokens", value: { intValue: 300 } },
              ],
            },
            {
              traceId: "11111111111111111111111111111111",
              spanId: "3333333333333333",
              parentSpanId: "2222222222222222",
              name: "ai.generateText.doGenerate",
              startTimeUnixNano: "1785888000000000001",
              endTimeUnixNano: "1785888000001000002",
              attributes: [
                { key: "ai.operationId", value: { stringValue: "ai.generateText.doGenerate" } },
                { key: "ai.model.id", value: { stringValue: "claude-fable-5" } },
                { key: "ai.model.provider", value: { stringValue: "anthropic.messages" } },
                // The legacy emitter also writes a subset of (pre-rename)
                // gen_ai attributes on provider-call spans.
                { key: "gen_ai.system", value: { stringValue: "anthropic" } },
                { key: "gen_ai.request.model", value: { stringValue: "claude-fable-5" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: 1200 } },
                { key: "gen_ai.usage.output_tokens", value: { intValue: 300 } },
              ],
            },
          ],
        }],
      }],
    });
    const rows = buildOtlpTraceRows(canonical, {
      projectId: "authenticated-project",
      branchId: "authenticated-branch",
      userId: null,
      refreshTokenId: null,
    }).spans;

    expect(rows[0]).toMatchObject({
      gen_ai_operation_name: "invoke_agent",
      gen_ai_provider_name: "anthropic.messages",
      gen_ai_request_model: "claude-fable-5",
      gen_ai_agent_name: "summarize-thread",
      gen_ai_input_tokens: "1200",
      gen_ai_output_tokens: "300",
    });
    expect(rows[1]).toMatchObject({
      gen_ai_operation_name: "chat",
      gen_ai_provider_name: "anthropic",
      gen_ai_input_tokens: "1200",
      gen_ai_output_tokens: "300",
      gen_ai_agent_name: null,
    });
  });

  it("leaves every gen_ai column NULL for non-AI spans", () => {
    const canonical = normalizeOtlpJsonTraceRequest({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
            name: "GET /orders",
            startTimeUnixNano: "1785888000000000001",
            endTimeUnixNano: "1785888000001000002",
            attributes: [{ key: "http.request.method", value: { stringValue: "GET" } }],
          }],
        }],
      }],
    });
    const [row] = buildOtlpTraceRows(canonical, {
      projectId: "authenticated-project",
      branchId: "authenticated-branch",
      userId: null,
      refreshTokenId: null,
    }).spans;

    expect(row.gen_ai_operation_name).toBeNull();
    expect(row.gen_ai_input_tokens).toBeNull();
    expect(row.gen_ai_provider_name).toBeNull();
  });

  it("scrubs custom span product data before durable JSON storage", () => {
    const canonical = normalizeOtlpJsonTraceRequest({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
            name: "checkout",
            startTimeUnixNano: "1785888000000000001",
            endTimeUnixNano: "1785888000001000002",
            attributes: [{
              key: "hexclave.data",
              value: { stringValue: JSON.stringify({ message: "failed", password: "hidden", url: "https://example.test/orders?token=hidden" }) },
            }],
          }],
        }],
      }],
    });

    const [row] = buildOtlpTraceRows(canonical, {
      projectId: "authenticated-project",
      branchId: "authenticated-branch",
      userId: null,
      refreshTokenId: null,
    }).spans;

    expect(JSON.parse(row.data)).toEqual({ message: "failed", url: "https://example.test/orders" });
    expect(row.data).not.toContain("hidden");
  });
});

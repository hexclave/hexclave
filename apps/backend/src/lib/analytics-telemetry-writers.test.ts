import { describe, expect, expectTypeOf, it } from "vitest";
import { EVENTS_COLUMNS, LOGS_COLUMNS, type ClickhouseColumn, type EventColumnName, type LogColumnName } from "../../scripts/clickhouse-migrations";
import {
  buildTelemetryWritePlan,
  getBatchDeduplicationToken,
  getTelemetryLens,
  normalizeBatchEvents,
} from "./analytics-telemetry-writers";
import { createErrorIngestProtocolProjection } from "./error-ingest/error-ingest-protocol-adapter";

function expectRowMatchesColumns(row: Record<string, unknown>, columns: readonly ClickhouseColumn[], table: string) {
  const columnNames = new Set(columns.map((column) => column.name));
  for (const key of Object.keys(row)) {
    expect(columnNames.has(key), `insert row for ${table} writes ${JSON.stringify(key)}, which is not a declared column`).toBe(true);
  }
  for (const column of columns) {
    if (column.name in row) continue;
    expect(
      column.default != null,
      `column ${JSON.stringify(column.name)} of ${table} is not written by the insert row and has no DB-side DEFAULT to fall back to`,
    ).toBe(true);
  }
}

const DRIFT_GUARD_CONTEXT = {
  projectId: "project",
  branchId: "branch",
  userId: "user",
  refreshTokenId: null,
  sessionReplayId: null,
  sessionReplaySegmentId: null,
  runtime: "browser" as const,
  resource: { service: { name: "svc" } },
  producer: "sdk" as const,
};

const DRIFT_GUARD_BATCH_ID = "00000000-0000-4000-8000-000000000000";

describe("SDK ingest insert rows vs. ClickHouse column declarations", () => {
  it("product-event rows cover the event-shaped telemetry columns", () => {
    const { productEvents } = normalizeBatchEvents(
      [{ event_type: "checkout_completed", event_at_ms: 1_700_000_000_000, data: {} }],
      DRIFT_GUARD_CONTEXT,
      DRIFT_GUARD_BATCH_ID,
    );
    expectRowMatchesColumns(productEvents[0], EVENTS_COLUMNS, "analytics_internal.events (product-event projection)");
    expectTypeOf<Exclude<keyof typeof productEvents[number], EventColumnName>>().toEqualTypeOf<never>();
  });

  it("log-occurrence rows cover the log-shaped telemetry columns", () => {
    const { logOccurrences } = normalizeBatchEvents(
      [{ event_type: "$log", event_at_ms: 1_700_000_000_000, data: {}, message: "m", level: "warn" }],
      DRIFT_GUARD_CONTEXT,
      DRIFT_GUARD_BATCH_ID,
    );
    expectRowMatchesColumns(logOccurrences[0], LOGS_COLUMNS, "analytics_internal.events (log-occurrence projection)");
    expectTypeOf<Exclude<keyof typeof logOccurrences[number], LogColumnName>>().toEqualTypeOf<never>();
  });
});

describe("error grouping normalization", () => {
  it("uses the server-side override and ignores the flat local deduplication fingerprint", () => {
    const baseData = {
      name: "TypeError",
      message: "row is null",
      handled: true,
      stack: [
        "TypeError: row is null",
        "    at renderRow (https://app.example.com/static/js/table.js:42:9)",
      ].join("\n"),
    };
    const defaultGrouping = normalizeBatchEvents([{
      event_type: "$error",
      event_at_ms: 1_700_000_000_000,
      data: baseData,
    }], DRIFT_GUARD_CONTEXT, DRIFT_GUARD_BATCH_ID);
    const localFingerprintOnly = normalizeBatchEvents([{
      event_type: "$error",
      event_at_ms: 1_700_000_000_000,
      data: { ...baseData, fingerprint: "sdk-local-dedupe-key" },
    }], DRIFT_GUARD_CONTEXT, DRIFT_GUARD_BATCH_ID);
    const customGrouping = normalizeBatchEvents([{
      event_type: "$error",
      event_at_ms: 1_700_000_000_000,
      data: { ...baseData, fingerprint_override: ["{{ type }}"], synthetic: true },
    }], DRIFT_GUARD_CONTEXT, DRIFT_GUARD_BATCH_ID);

    expect(localFingerprintOnly.issueInputs[0]?.ownerHash).toBe(defaultGrouping.issueInputs[0]?.ownerHash);
    expect(customGrouping.issueInputs[0]?.ownerHash).not.toBe(defaultGrouping.issueInputs[0]?.ownerHash);
    expect(customGrouping.issueInputs[0]?.synthetic).toBe(true);
    expect(customGrouping.logOccurrences[0]).toMatchObject({ issue_variant: "custom" });
  });

  it("does not treat an explicit synthetic false value as synthetic", () => {
    const normalized = normalizeBatchEvents([{
      event_type: "$error",
      event_at_ms: 1_700_000_000_000,
      data: {
        name: "TypeError",
        message: "ordinary failure",
        handled: true,
        synthetic: false,
      },
    }], DRIFT_GUARD_CONTEXT, DRIFT_GUARD_BATCH_ID);

    expect(normalized.issueInputs[0]?.synthetic).toBe(false);
  });

  it("persists the bounded canonical envelope without request secrets", () => {
    const normalized = normalizeBatchEvents([{
      event_type: "$error",
      event_at_ms: 1_700_000_000_000,
      data: {
        event_id: "0123456789abcdef0123456789abcdef",
        name: "TypeError",
        message: "row is null",
        handled: true,
        exception: {
          values: [{
            type: "TypeError",
            value: "row is null",
            stacktrace: { frames: [{ filename: "src/table.ts", lineno: 42, colno: 9 }] },
          }],
        },
        breadcrumbs: [{ category: "http", data: { url: "https://example.test/items?token=secret" } }],
        request: { url: "https://example.test/items?token=secret", headers: { authorization: "Bearer secret" } },
      },
    }], DRIFT_GUARD_CONTEXT, DRIFT_GUARD_BATCH_ID);

    const envelope = JSON.parse(normalized.logOccurrences[0]?.error_envelope ?? "{}");
    expect(envelope).toMatchObject({
      schema: "hexclave.error-envelope",
      version: 1,
      event_id: "0123456789abcdef0123456789abcdef",
      exception: { values: [{ type: "TypeError", value: "row is null" }] },
    });
    expect(envelope.request).toEqual({ url: "https://example.test/items" });
    expect(envelope.breadcrumbs[0].data).toEqual({ url: "https://example.test/items" });
    expect(normalized.logOccurrences[0]).toMatchObject({ error_envelope: expect.any(String) });
  });

  it("keeps one manual-capture identity coherent across envelope, occurrence, issue, and outcome projections", () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    const normalized = normalizeBatchEvents([{
      event_type: "$error",
      event_at_ms: 1_700_000_000_000,
      data: {
        event_id: eventId,
        name: "TypeError",
        message: "render failed",
        handled: false,
        release: "web@2026.08.06",
      },
    }], DRIFT_GUARD_CONTEXT, DRIFT_GUARD_BATCH_ID);
    const occurrence = normalized.logOccurrences[0];
    const issueInput = normalized.issueInputs[0];

    expect(JSON.parse(occurrence.error_envelope).event_id).toBe(eventId);
    expect(occurrence.occurrence_id).toBe(issueInput.occurrenceId);
    expect(issueInput).toMatchObject({
      value: "render failed",
      release: "web@2026.08.06",
      handled: false,
      count: 1,
    });

    const outcome = createErrorIngestProtocolProjection(DRIFT_GUARD_BATCH_ID, [{
      itemId: "event:0",
      itemType: "event",
      eventId,
      status: "accepted",
    }]);
    expect(outcome.items[0]).toMatchObject({ itemId: "event:0", eventId, status: "accepted" });
    expect(outcome.idempotencyKey).toBe(createErrorIngestProtocolProjection(DRIFT_GUARD_BATCH_ID, [{
      itemId: "event:0",
      itemType: "event",
      eventId,
      status: "accepted",
    }]).idempotencyKey);
  });

  it("rejects $error events that omit handled instead of inventing true", () => {
    expect(() => normalizeBatchEvents([{
      event_type: "$error",
      event_at_ms: 1_700_000_000_000,
      data: {
        name: "TypeError",
        message: "row is null",
      },
    }], DRIFT_GUARD_CONTEXT, DRIFT_GUARD_BATCH_ID)).toThrow(/boolean handled field/);
  });
});

describe("lens-scoped scrubbing and durable-storage data normalization", () => {
  it("stores product-event data byte-identical, even when keys and values look sensitive", () => {
    const data = { token: "secret", url: "https://x.example/path?token=abc" };
    const { productEvents, logOccurrences } = normalizeBatchEvents(
      [{ event_type: "checkout_completed", event_at_ms: 1_700_000_000_000, data }],
      DRIFT_GUARD_CONTEXT,
      DRIFT_GUARD_BATCH_ID,
    );

    expect(logOccurrences).toHaveLength(0);
    expect(productEvents[0].data).toEqual({ token: "secret", url: "https://x.example/path?token=abc" });
    expect(JSON.stringify(productEvents[0].data)).toBe(JSON.stringify(data));
  });

  it("still scrubs observability-lens occurrences before storage", () => {
    const { logOccurrences } = normalizeBatchEvents([{
      event_type: "$log",
      event_at_ms: 1_700_000_000_000,
      data: { token: "secret", url: "https://x.example/path?token=abc" },
      message: "checkout failed",
      level: "warn",
    }], DRIFT_GUARD_CONTEXT, DRIFT_GUARD_BATCH_ID);

    const serialized = JSON.stringify(logOccurrences[0].data);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("token=abc");
    expect(serialized).toContain("https://x.example/path");
  });

  it("wraps non-object product data for the typed JSON telemetry column", () => {
    const { productEvents } = normalizeBatchEvents([
      { event_type: "legacy_string_data", event_at_ms: 1_700_000_000_000, data: "just a string" },
      { event_type: "legacy_number_data", event_at_ms: 1_700_000_000_000, data: 42 },
      { event_type: "legacy_array_data", event_at_ms: 1_700_000_000_000, data: [1, "two"] },
      { event_type: "legacy_null_data", event_at_ms: 1_700_000_000_000, data: null },
      { event_type: "object_data", event_at_ms: 1_700_000_000_000, data: { kept: "as-is" } },
    ], DRIFT_GUARD_CONTEXT, DRIFT_GUARD_BATCH_ID);

    expect(productEvents.map((row) => row.data)).toEqual([
      { "$value": "just a string" },
      { "$value": 42 },
      { "$value": [1, "two"] },
      { "$value": null },
      { kept: "as-is" },
    ]);
  });
});

describe("analytics telemetry storage dispatch", () => {
  it("builds one canonical write plan after protocol-specific normalization", () => {
    const normalized = normalizeBatchEvents(
      [{ event_type: "$click", event_at_ms: 1_700_000_000_000, data: {} }],
      DRIFT_GUARD_CONTEXT,
      DRIFT_GUARD_BATCH_ID,
    );
    const plan = buildTelemetryWritePlan(normalized, DRIFT_GUARD_BATCH_ID);

    expect(plan.batchId).toBe(DRIFT_GUARD_BATCH_ID);
    expect(plan.destinations).toHaveLength(1);
    expect(plan.destinations[0]).toMatchObject({
      table: "analytics_internal.events",
      deduplicationToken: `${DRIFT_GUARD_BATCH_ID}:analytics_internal.events`,
    });
    expect(plan.destinations[0]?.values).toHaveLength(1);
    expect(plan.issueInputs).toEqual([]);
  });

  it("keeps product events out of observability logs", () => {
    for (const eventType of ["checkout.completed", "$click", "$form-submit"]) {
      expect(getTelemetryLens(eventType)).toBe("product");
    }
  });

  it("keeps log-shaped occurrences out of product events", () => {
    expect(getTelemetryLens("$log")).toBe("observability");
    expect(getTelemetryLens("$error")).toBe("observability");
  });

  it("gives each wire batch its own idempotency token", () => {
    expect(getBatchDeduplicationToken("batch-2")).not.toBe(getBatchDeduplicationToken("batch-1"));
  });

  it("stores the enclosing span identity verbatim and dispatches by taxonomy", () => {
    const normalized = normalizeBatchEvents([{
      event_type: "$log",
      event_at_ms: 1_700_000_000_000,
      data: {},
      message: "checkout failed",
      level: "error",
      page_view_span_id: "1111111111111111",
      trace_id: "22222222222222222222222222222222",
      span_id: "3333333333333333",
    }], {
      projectId: "project",
      branchId: "branch",
      userId: "user",
      refreshTokenId: "55555555-5555-4555-8555-555555555555",
      sessionReplayId: "66666666-6666-4666-8666-666666666666",
      sessionReplaySegmentId: "77777777-7777-4777-8777-777777777777",
      runtime: "browser",
      producer: "sdk",
      resource: {
        service: { namespace: "commerce", name: "storefront", version: "abc123", instanceId: "iad-1" },
        deploymentEnvironmentName: "preview",
        attributes: { region: "iad1" },
      },
    }, DRIFT_GUARD_BATCH_ID);

    expect(normalized.productEvents).toHaveLength(0);
    expect(normalized.logOccurrences[0]).toMatchObject({
      trace_id: "22222222222222222222222222222222",
      span_id: "3333333333333333",
      page_view_span_id: "1111111111111111",
      refresh_token_id: "55555555-5555-4555-8555-555555555555",
      session_replay_id: "66666666-6666-4666-8666-666666666666",
      session_replay_segment_id: "77777777-7777-4777-8777-777777777777",
    });
    expect(normalized.logOccurrences[0]).toMatchObject({
      service_namespace: "commerce",
      service_name: "storefront",
      service_version: "abc123",
      service_instance_id: "iad-1",
      deployment_environment_name: "preview",
      resource_attributes: JSON.stringify({ region: "iad1" }),
    });
  });
});

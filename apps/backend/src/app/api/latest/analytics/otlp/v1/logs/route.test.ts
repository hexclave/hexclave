import type { OtlpTenantContext } from "@/lib/otlp/trace-writer";
import type { CanonicalOtlpLogRecord } from "@/lib/otlp/logs";
import type { ErrorIngestPolicyItemOutcome } from "@/lib/error-ingest";
import { describe, expect, it } from "vitest";
import { createOtlpLogProtocolProjection } from "@/lib/error-ingest/error-ingest-protocol-projections";

const tenant: OtlpTenantContext = {
  projectId: "project-1",
  branchId: "branch-1",
  userId: null,
  refreshTokenId: null,
};

function logRecord(eventName: string): CanonicalOtlpLogRecord {
  return {
    timeUnixNano: "1720000000000000000",
    observedTimeUnixNano: "1720000000000000000",
    severityNumber: 9,
    severityText: "INFO",
    body: null,
    attributes: new Map([
      ["hexclave.signal.type", { type: "string", value: "event" }],
      ["hexclave.data", { type: "kvlist", value: new Map() }],
    ]),
    droppedAttributesCount: 0,
    flags: 0,
    traceId: null,
    spanId: null,
    eventName,
    resource: {
      attributes: new Map(),
      droppedAttributesCount: 0,
      schemaUrl: "",
    },
    scope: {
      name: "test",
      version: "1",
      attributes: new Map(),
      droppedAttributesCount: 0,
      schemaUrl: "",
    },
    errorEnvelope: null,
  };
}

describe("OTLP logs protocol boundary", () => {
  it("projects semantic record rejection without copying the record payload", () => {
    const projection = createOtlpLogProtocolProjection(
      [logRecord("valid-event"), logRecord("Authorization: Bearer secret-value")],
      new Set([0]),
      tenant,
    );

    expect(projection.status).toBe("partial");
    expect(projection.items).toEqual([
      expect.objectContaining({ itemIndex: 0, itemId: "log:0", itemType: "log", status: "accepted", rejectedByOtlp: false }),
      expect.objectContaining({ itemIndex: 1, itemId: "log:1", itemType: "log", status: "rejected", reason: "invalid", rejectedByOtlp: true }),
    ]);
    expect(projection.clientReport).toEqual({
      discarded_events: [{ category: "log_item", reason: "invalid", quantity: 1 }],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
    });
    expect(projection.otlpPartialSuccess.logs).toEqual({
      rejectedItems: 1,
      body: {
        partialSuccess: {
          rejectedLogRecords: "1",
          errorMessage: "error ingest rejected 1 item(s): rejected=1",
        },
      },
    });
    expect(JSON.stringify(projection)).not.toContain("secret-value");
    expect(JSON.stringify(projection)).not.toContain("Bearer");
  });

  it("keeps the adapter idempotency key stable for the same normalized retry", () => {
    const records = [logRecord("valid-event"), logRecord("another-event")];
    const first = createOtlpLogProtocolProjection(records, new Set([0, 1]), tenant);
    const retry = createOtlpLogProtocolProjection(records, new Set([0, 1]), tenant);

    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.otlpPartialSuccess.logs.body).toEqual({});
  });

  it("projects deterministic policy rejection through OTLP partial success and client reports", () => {
    const records = [logRecord("first"), logRecord("second")];
    const policyOutcomes: readonly ErrorIngestPolicyItemOutcome[] = [
      { itemId: "log:0", itemType: "log", status: "accepted", scrubbed: false, scrubbedBytes: 0 },
      { itemId: "log:1", itemType: "log", status: "rejected", reason: "invalid", scrubbed: false, scrubbedBytes: 0 },
    ];
    const projection = createOtlpLogProtocolProjection(
      records,
      new Set([0]),
      tenant,
      policyOutcomes,
    );

    expect(projection.otlpPartialSuccess.logs).toEqual({
      rejectedItems: 1,
      body: { partialSuccess: { rejectedLogRecords: "1", errorMessage: "error ingest rejected 1 item(s): rejected=1" } },
    });
    expect(projection.clientReport.discarded_events).toEqual([{ category: "log_item", reason: "invalid", quantity: 1 }]);
  });
});

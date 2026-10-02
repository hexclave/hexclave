import { describe, expect, it } from "vitest";
import { createErrorIngestProtocolProjection } from "./error-ingest-protocol-adapter";
import {
  buildErrorIngestClientReportRequestRows,
  buildErrorIngestClientReportRows,
  ERROR_INGEST_CLIENT_REPORT_REASON_CATEGORY_MAX_BYTES,
  ErrorIngestClientReportParseError,
  normalizeErrorIngestClientReportReportedAt,
  parseErrorIngestClientReportRequest,
} from "./error-ingest-client-reports";

const scope = {
  tenancyId: "123e4567-e89b-42d3-a456-426614174000",
  projectId: "project-1",
  branchId: "main",
};

describe("error ingest client report persistence contract", () => {
  it("projects only bounded item-loss metadata with a retry-stable key", () => {
    const projection = createErrorIngestProtocolProjection("batch-1", [
      { itemId: "event-1", itemType: "event", status: "filtered", reason: "privacy" },
      { itemId: "event-2", itemType: "event", status: "rate_limited", reason: "quota", retryAfterMs: 5000 },
      { itemId: "event-3", itemType: "event", status: "accepted" },
    ]);
    const rows = buildErrorIngestClientReportRows(scope, "otlp_logs", projection, new Date("2026-08-06T00:00:00.000Z"));
    expect(rows).toHaveLength(2);
    expect(rows.map(({ bucket, reason, category, quantity, idempotencyKey }) => ({ bucket, reason, category, quantity, idempotencyKey }))).toEqual([
      { bucket: "rate_limited_events", reason: "quota", category: "error", quantity: 1, idempotencyKey: projection.idempotencyKey },
      { bucket: "filtered_events", reason: "privacy", category: "error", quantity: 1, idempotencyKey: projection.idempotencyKey },
    ]);
    expect(rows.every((row) => row.id.length > 0 && row.reportedAt.toISOString() === "2026-08-06T00:00:00.000Z")).toBe(true);
  });

  it("rejects malformed scope, report keys, quantities, and oversized entry counts", () => {
    const valid = createErrorIngestProtocolProjection("batch-1", [
      { itemId: "event-1", itemType: "event", status: "filtered", reason: "privacy" },
    ]);
    expect(() => buildErrorIngestClientReportRows({ ...scope, tenancyId: "not-a-uuid" }, "otlp_logs", valid)).toThrow(/tenancyId/);
    expect(() => buildErrorIngestClientReportRows(scope, "otlp_logs", { ...valid, idempotencyKey: "" })).toThrow(/idempotency/);
    expect(() => buildErrorIngestClientReportRows(scope, "otlp_logs", {
      clientReport: {
        ...valid.clientReport,
        filtered_events: [{ reason: "privacy", category: "error", quantity: 0 }],
      },
      idempotencyKey: valid.idempotencyKey,
    })).toThrow(/quantity/);
    expect(() => buildErrorIngestClientReportRows(scope, "otlp_logs", {
      clientReport: {
        ...valid.clientReport,
        filtered_events: Array.from({ length: 101 }, () => ({ reason: "privacy", category: "error", quantity: 1 })),
      },
      idempotencyKey: valid.idempotencyKey,
    })).toThrow(/too many/);
  });

  it("parses the public payload without accepting arbitrary report data", () => {
    const request = parseErrorIngestClientReportRequest({
      idempotency_key: "client-batch-1",
      timestamp: "2026-08-06T00:00:00.000Z",
      discarded_events: [{ reason: "network_error", category: "error", quantity: 2 }],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
      secret: { token: "must not be copied" },
    });
    expect(request).toEqual({
      idempotencyKey: "client-batch-1",
      timestampMs: Date.parse("2026-08-06T00:00:00.000Z"),
      clientReport: {
        discarded_events: [{ reason: "network_error", category: "error", quantity: 2 }],
        rate_limited_events: [],
        filtered_events: [],
        filtered_sampling_events: [],
      },
    });
  });

  it("accepts Relay-style Unix timestamps and rejects unbounded dates", () => {
    expect(parseErrorIngestClientReportRequest({
      idempotency_key: "client-batch-seconds",
      timestamp: 1_754_444_800,
      discarded_events: [],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
    }).timestampMs).toBe(1_754_444_800_000);
    expect(() => parseErrorIngestClientReportRequest({
      idempotency_key: "client-batch-invalid",
      timestamp: "not-a-date",
      discarded_events: [],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
    })).toThrow(/timestamp/iu);
  });

  it("keeps reason and category within the PostgreSQL varchar limit", () => {
    const validEntry = {
      reason: "r".repeat(ERROR_INGEST_CLIENT_REPORT_REASON_CATEGORY_MAX_BYTES),
      category: "c".repeat(ERROR_INGEST_CLIENT_REPORT_REASON_CATEGORY_MAX_BYTES),
      quantity: 1,
    };
    expect(parseErrorIngestClientReportRequest({
      idempotency_key: "client-report-varchar-limit",
      discarded_events: [validEntry],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
    }).clientReport.discarded_events).toEqual([validEntry]);

    expect(() => parseErrorIngestClientReportRequest({
      idempotency_key: "client-report-reason-too-long",
      discarded_events: [{ ...validEntry, reason: `${validEntry.reason}x` }],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
    })).toThrow(/reason and category/iu);
    expect(() => parseErrorIngestClientReportRequest({
      idempotency_key: "client-report-category-too-long",
      discarded_events: [{ ...validEntry, category: `${validEntry.category}x` }],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
    })).toThrow(/reason and category/iu);
  });

  it("treats omitted buckets as empty, rounds fractional Unix timestamps, and rejects secret-bearing text as a typed parse error", () => {
    const request = parseErrorIngestClientReportRequest({
      idempotency_key: "client-batch-minimal",
      timestamp: 1_754_444_800.25,
      discarded_events: [{ reason: "network_error", category: "error", quantity: 1 }],
    });
    expect(request.timestampMs).toBe(1_754_444_800_250);
    expect(request.clientReport).toEqual({
      discarded_events: [{ reason: "network_error", category: "error", quantity: 1 }],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
    });

    let thrown: unknown;
    try {
      parseErrorIngestClientReportRequest({
        idempotency_key: "client-batch-secret",
        discarded_events: [{ reason: "Bearer top-secret", category: "error", quantity: 1 }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ErrorIngestClientReportParseError);
    expect(String(thrown)).toContain("secret-bearing");
    expect(() => parseErrorIngestClientReportRequest({
      idempotency_key: "Bearer secret-token",
      discarded_events: [],
    })).toThrow(/secret-bearing/iu);
    expect(() => parseErrorIngestClientReportRequest("not-an-object")).toThrow(ErrorIngestClientReportParseError);
  });

  it("merges same-identity entries in one request so skipDuplicates cannot drop quantity", () => {
    const request = parseErrorIngestClientReportRequest({
      idempotency_key: "client-batch-duplicates",
      discarded_events: [
        { reason: "network_error", category: "error", quantity: 2 },
        { reason: "network_error", category: "error", quantity: 3 },
        { reason: "queue_overflow", category: "error", quantity: 1 },
      ],
    });
    const rows = buildErrorIngestClientReportRequestRows(scope, request);
    expect(rows.map(({ bucket, reason, category, quantity }) => ({ bucket, reason, category, quantity }))).toEqual([
      { bucket: "discarded_events", reason: "network_error", category: "error", quantity: 5 },
      { bucket: "discarded_events", reason: "queue_overflow", category: "error", quantity: 1 },
    ]);
  });

  it("uses the client timestamp for durable report chronology", () => {
    const timestampMs = Date.parse("2026-08-06T00:00:00.000Z");
    const request = parseErrorIngestClientReportRequest({
      idempotency_key: "client-batch-chronology",
      timestamp: timestampMs / 1_000,
      discarded_events: [{ reason: "network_error", category: "error", quantity: 1 }],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
    });
    const rows = buildErrorIngestClientReportRequestRows(scope, request);
    expect(rows[0]?.reportedAt.getTime()).toBe(timestampMs);
  });

  it("applies Relay-style clock-drift correction only beyond the drift threshold", () => {
    const request = parseErrorIngestClientReportRequest({
      idempotency_key: "client-batch-drift",
      timestamp: "2026-08-06T00:00:00.000Z",
      discarded_events: [],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
    });
    const clientTimestamp = Date.parse("2026-08-06T00:00:00.000Z");
    const sentAt = new Date("2026-08-06T02:00:00.000Z");
    const receivedAt = new Date("2026-08-06T03:00:00.000Z");
    expect(normalizeErrorIngestClientReportReportedAt(request, sentAt, receivedAt).getTime()).toBe(clientTimestamp + 60 * 60 * 1_000);
    expect(normalizeErrorIngestClientReportReportedAt(request, new Date("2026-08-06T02:59:30.000Z"), receivedAt).getTime()).toBe(clientTimestamp);
  });
});

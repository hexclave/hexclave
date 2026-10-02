import { describe, expect, it } from "vitest";
import {
  createErrorIngestProtocolProjection,
  type ErrorIngestProtocolOutcomeInput,
  type ErrorIngestUnknownDropOutcome,
} from "./error-ingest-protocol-adapter";
import { createErrorIngestItemOutcome, type ErrorIngestItemDescriptor } from "./error-ingest-outcomes";

function item(itemId: string, itemType: ErrorIngestItemDescriptor["itemType"] = "event"): ErrorIngestItemDescriptor {
  return { itemId, itemType };
}

function mixedOutcomes(): readonly ErrorIngestProtocolOutcomeInput[] {
  return [
    createErrorIngestItemOutcome(item("a"), { status: "accepted" }),
    createErrorIngestItemOutcome(item("b", "log"), { status: "filtered", reason: "privacy" }),
    createErrorIngestItemOutcome(item("c", "span"), { status: "filtered", reason: "sampling" }),
    createErrorIngestItemOutcome(item("d"), { status: "rate_limited", reason: "quota" }),
    createErrorIngestItemOutcome(item("e"), { status: "rejected", reason: "invalid" }),
    createErrorIngestItemOutcome(item("f"), { status: "deduplicated", canonicalItemId: "a" }),
    createErrorIngestItemOutcome(item("g"), { status: "queued", reason: "retryable" }),
    createErrorIngestItemOutcome(item("h", "unknown"), { status: "dropped", reason: "internal" }),
  ];
}

describe("error-ingest protocol adapter", () => {
  it("projects mixed outcomes into count-only legacy, OTLP, and Relay-shaped reports", () => {
    const projection = createErrorIngestProtocolProjection("batch-1", mixedOutcomes());

    expect(projection.status).toBe("partial");
    expect(projection.counts).toEqual({
      accepted: 1,
      filtered: 2,
      rate_limited: 1,
      rejected: 1,
      deduplicated: 1,
      dropped: 1,
      queued: 1,
    });
    expect(projection.clientReport).toEqual({
      discarded_events: [
        { category: "error", reason: "deduplicated", quantity: 1 },
        { category: "error", reason: "invalid", quantity: 1 },
        { category: "unknown", reason: "internal", quantity: 1 },
      ],
      rate_limited_events: [
        { category: "error", reason: "quota", quantity: 1 },
      ],
      filtered_events: [
        { category: "log_item", reason: "privacy", quantity: 1 },
      ],
      filtered_sampling_events: [
        { category: "span", reason: "sampling", quantity: 1 },
      ],
    });
    expect(projection.otlpPartialSuccess.logs).toEqual({
      rejectedItems: 1,
      body: {
        partialSuccess: {
          rejectedLogRecords: "1",
          errorMessage: "error ingest rejected 1 item(s): filtered=1",
        },
      },
    });
    expect(projection.otlpPartialSuccess.traces.body.partialSuccess).toEqual({
      rejectedSpans: "1",
      errorMessage: "error ingest rejected 1 item(s): filtered=1",
    });
    expect(JSON.stringify(projection)).not.toContain("stack");
    expect(JSON.stringify(projection)).not.toContain("message");
  });

  it("aggregates independently of input order and keeps retry idempotency stable", () => {
    const original = mixedOutcomes();
    const reordered = [...original].reverse();
    const first = createErrorIngestProtocolProjection("batch-retry", original);
    const retry = createErrorIngestProtocolProjection("batch-retry", reordered);

    expect(retry.clientReport).toEqual(first.clientReport);
    expect(retry.counts).toEqual(first.counts);
    expect(retry.otlpPartialSuccess).toEqual(first.otlpPartialSuccess);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.idempotencyKey).toMatch(/^error-ingest-v1:[0-9a-f]{32}$/u);

    const firstRateLimit = createErrorIngestProtocolProjection("retry-hint", [
      createErrorIngestItemOutcome(item("limited"), { status: "rate_limited", reason: "quota", retryAfterMs: 1_000 }),
    ]);
    const retryWithNewHint = createErrorIngestProtocolProjection("retry-hint", [
      createErrorIngestItemOutcome(item("limited"), { status: "rate_limited", reason: "quota", retryAfterMs: 2_000 }),
    ]);
    expect(retryWithNewHint.idempotencyKey).toBe(firstRateLimit.idempotencyKey);
  });

  it("collapses unknown drop reasons into a typed unknown report reason", () => {
    const unknownDrop: ErrorIngestUnknownDropOutcome = {
      ...item("unknown-drop"),
      status: "dropped",
      reason: "unknown",
    };
    const projection = createErrorIngestProtocolProjection("unknown-batch", [unknownDrop]);

    expect(projection.items[0]).toMatchObject({
      status: "dropped",
      reason: "unknown",
      clientReportBucket: "discarded_events",
      clientReportReason: "unknown",
      rejectedByOtlp: true,
    });
    expect(projection.clientReport.discarded_events).toEqual([
      { category: "error", reason: "unknown", quantity: 1 },
    ]);
  });

  it("truncates report entries deterministically while retaining complete counts", () => {
    const outcomes = [
      createErrorIngestItemOutcome(item("z"), { status: "dropped", reason: "shutdown" }),
      createErrorIngestItemOutcome(item("a"), { status: "rejected", reason: "auth" }),
      createErrorIngestItemOutcome(item("m"), { status: "rate_limited", reason: "rate_limit" }),
    ];
    const projection = createErrorIngestProtocolProjection("truncated", outcomes, {
      limits: { maxClientReportEntries: 1 },
    });

    expect(projection.counts).toEqual({
      accepted: 0,
      filtered: 0,
      rate_limited: 1,
      rejected: 1,
      deduplicated: 0,
      dropped: 1,
      queued: 0,
    });
    expect(projection.clientReport.discarded_events).toEqual([
      { category: "error", reason: "auth", quantity: 1 },
    ]);
    expect(projection.clientReport.rate_limited_events).toEqual([]);
    expect(projection.truncation).toEqual({ clientReportEntries: 2, clientReportItems: 2 });
  });

  it("bounds OTLP error text without copying item reasons or payloads", () => {
    const projection = createErrorIngestProtocolProjection(
      "bounded",
      [createErrorIngestItemOutcome(item("secret-item", "log"), { status: "rejected", reason: "invalid" })],
      { limits: { maxErrorMessageBytes: 12 } },
    );
    const partialSuccess = projection.otlpPartialSuccess.logs.body.partialSuccess;

    expect(partialSuccess?.rejectedLogRecords).toBe("1");
    expect(partialSuccess?.errorMessage).toBe("error ingest");
    expect(partialSuccess?.errorMessage).not.toContain("secret-item");
    expect(partialSuccess?.errorMessage).not.toContain("invalid");
  });

  it("does not treat queued or deduplicated retries as OTLP rejection", () => {
    const projection = createErrorIngestProtocolProjection("retry-safe", [
      createErrorIngestItemOutcome(item("queued"), { status: "queued", reason: "offline" }),
      createErrorIngestItemOutcome(item("duplicate"), { status: "deduplicated", canonicalItemId: "canonical" }),
    ]);

    expect(projection.otlpPartialSuccess.logs).toEqual({ rejectedItems: 0, body: {} });
    expect(projection.otlpPartialSuccess.traces).toEqual({ rejectedItems: 0, body: {} });
    expect(projection.clientReport.discarded_events).toEqual([
      { category: "error", reason: "deduplicated", quantity: 1 },
    ]);
  });

  it("reports unsupported transactions under the native transaction category", () => {
    const projection = createErrorIngestProtocolProjection("transaction-batch", [
      createErrorIngestItemOutcome(
        { itemId: "transaction:0", itemType: "transaction", eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { status: "rejected", reason: "unsupported" },
      ),
    ]);

    expect(projection.items[0]).toMatchObject({
      itemType: "transaction",
      category: "transaction",
      status: "rejected",
      reason: "unsupported",
      clientReportBucket: "discarded_events",
      clientReportReason: "unsupported",
    });
    expect(projection.clientReport.discarded_events).toEqual([
      { category: "transaction", reason: "unsupported", quantity: 1 },
    ]);
    expect(projection.otlpPartialSuccess.logs).toMatchObject({ rejectedItems: 0 });
    expect(projection.otlpPartialSuccess.traces).toMatchObject({ rejectedItems: 1 });
  });
});

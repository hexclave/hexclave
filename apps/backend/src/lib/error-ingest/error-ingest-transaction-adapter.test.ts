import { describe, expect, it } from "vitest";
import { parseErrorIngestEnvelope } from "./error-ingest-envelope";
import {
  ErrorIngestTransactionAdapterError,
  sentryTransactionToCanonicalOtlpSpans,
} from "./error-ingest-transaction-adapter";
import { buildOtlpTraceRows, getOtlpTraceDeduplicationToken } from "@/lib/otlp/trace-writer";

const EVENT_ID = "55555555555555555555555555555555";
const TRACE_ID = "66666666666666666666666666666666";
const ROOT_SPAN_ID = "7777777777777777";
const CHILD_SPAN_ID = "8888888888888888";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function envelope(payload: unknown): Uint8Array {
  const payloadBytes = new TextEncoder().encode(json(payload));
  const header = new TextEncoder().encode(`${JSON.stringify({ event_id: EVENT_ID, sdk: { name: "fixture", version: "1.0.0" } })}\n`);
  const itemHeader = new TextEncoder().encode(`${JSON.stringify({ type: "transaction", length: payloadBytes.byteLength, content_type: "application/json" })}\n`);
  const result = new Uint8Array(header.byteLength + itemHeader.byteLength + payloadBytes.byteLength + 1);
  result.set(header, 0);
  result.set(itemHeader, header.byteLength);
  result.set(payloadBytes, header.byteLength + itemHeader.byteLength);
  result[result.byteLength - 1] = 0x0a;
  return result;
}

function transactionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: EVENT_ID,
    type: "transaction",
    transaction: "GET /checkout/:id?token=transaction-secret",
    transaction_info: { source: "route" },
    start_timestamp: 1_754_444_800,
    timestamp: 1_754_444_801.25,
    release: "release-1",
    environment: "production",
    contexts: {
      trace: {
        trace_id: TRACE_ID,
        span_id: ROOT_SPAN_ID,
        op: "http.server",
        status: "ok",
      },
    },
    tags: { component: "checkout" },
    spans: [{
      trace_id: TRACE_ID,
      span_id: CHILD_SPAN_ID,
      parent_span_id: ROOT_SPAN_ID,
      start_timestamp: 1_754_444_800.25,
      timestamp: 1_754_444_800.75,
      op: "db",
      description: "SELECT users",
      data: { "db.system": "postgres", password: "child-secret" },
      tags: { table: "users" },
    }],
    ...overrides,
  };
}

function parseTransaction(overrides: Record<string, unknown> = {}) {
  const parsed = parseErrorIngestEnvelope(envelope(transactionPayload(overrides)));
  const transaction = parsed.items[0]?.transaction;
  if (transaction === undefined) throw new Error("Expected a parsed transaction");
  return transaction;
}

const context = {
  resource: {
    attributes: new Map([
      ["service.name", { type: "string" as const, value: "sentry-fixture" }],
      ["deployment.environment.name", { type: "string" as const, value: "production" }],
    ]),
    droppedAttributesCount: 0,
    schemaUrl: "",
  },
  scope: {
    name: "sentry-envelope",
    version: "1.0.0",
    attributes: new Map(),
    droppedAttributesCount: 0,
    schemaUrl: "",
  },
};

describe("Sentry transaction to canonical OTLP adapter", () => {
  it("writes the transaction root and embedded spans as one canonical trace", () => {
    const spans = sentryTransactionToCanonicalOtlpSpans(parseTransaction(), context);

    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      traceId: TRACE_ID,
      spanId: ROOT_SPAN_ID,
      parentSpanId: null,
      name: "GET /checkout/:id?token=[Filtered]",
      startTimeUnixNano: "1754444800000000000",
      endTimeUnixNano: "1754444801250000000",
      status: { code: 1, message: "" },
    });
    expect(spans[1]).toMatchObject({
      traceId: TRACE_ID,
      spanId: CHILD_SPAN_ID,
      parentSpanId: ROOT_SPAN_ID,
      name: "db",
      startTimeUnixNano: "1754444800250000000",
      endTimeUnixNano: "1754444800750000000",
    });
    expect(spans[1]?.attributes.get("sentry.span.data")).toEqual(expect.objectContaining({ type: "kvlist" }));
    expect(spans.map((span) => span.attributes.get("hexclave.signal.type"))).toEqual([
      { type: "string", value: "custom_span" },
      { type: "string", value: "custom_span" },
    ]);
  });

  it("retains the distributed upstream ancestor on the transaction root", () => {
    const upstreamSpanId = "9999999999999999";
    const spans = sentryTransactionToCanonicalOtlpSpans(parseTransaction({
      contexts: {
        trace: {
          trace_id: TRACE_ID,
          span_id: ROOT_SPAN_ID,
          parent_span_id: upstreamSpanId,
          op: "http.server",
          status: "ok",
        },
      },
    }), context);
    expect(spans[0]).toMatchObject({ spanId: ROOT_SPAN_ID, parentSpanId: upstreamSpanId });
  });

  it("keeps the authenticated retry identity stable while preserving privacy in rows", () => {
    const transaction = parseTransaction();
    const first = sentryTransactionToCanonicalOtlpSpans(transaction, context);
    const retry = sentryTransactionToCanonicalOtlpSpans(transaction, context);
    const tenant = {
      projectId: "project-1",
      branchId: "branch-1",
      userId: null,
      refreshTokenId: null,
    };

    expect(getOtlpTraceDeduplicationToken(first, tenant)).toBe(getOtlpTraceDeduplicationToken(retry, tenant));
    expect(getOtlpTraceDeduplicationToken(first, tenant)).not.toBe(getOtlpTraceDeduplicationToken(first, { ...tenant, projectId: "project-2" }));

    const rows = buildOtlpTraceRows(first, tenant);
    expect(JSON.stringify(rows)).not.toContain("transaction-secret");
    expect(JSON.stringify(rows)).not.toContain("child-secret");
    expect(JSON.stringify(rows)).toContain("GET /checkout/:id");
  });

  it("fails closed for duplicate embedded span identities and OTLP-range timestamps", () => {
    const duplicate = parseTransaction({
      spans: [
        {
          trace_id: TRACE_ID,
          span_id: CHILD_SPAN_ID,
          start_timestamp: 1_754_444_800,
          timestamp: 1_754_444_801,
        },
        {
          trace_id: TRACE_ID,
          span_id: CHILD_SPAN_ID,
          start_timestamp: 1_754_444_800,
          timestamp: 1_754_444_801,
        },
      ],
    });
    expect(() => sentryTransactionToCanonicalOtlpSpans(duplicate, context)).toThrow(ErrorIngestTransactionAdapterError);

    const outsideOtlpRange = parseTransaction({
      start_timestamp: 20_000_000_000,
      timestamp: 20_000_000_001,
    });
    expect(() => sentryTransactionToCanonicalOtlpSpans(outsideOtlpRange, context)).toThrow(/OTLP timestamp range/iu);

    const zeroParentParsed = parseErrorIngestEnvelope(envelope(transactionPayload({
      contexts: {
        trace: {
          trace_id: TRACE_ID,
          span_id: ROOT_SPAN_ID,
          parent_span_id: "0000000000000000",
          op: "http.server",
          status: "ok",
        },
      },
    })));
    expect(zeroParentParsed.items[0]?.transaction).toBeUndefined();
    expect(zeroParentParsed.items[0]?.outcome).toMatchObject({ status: "rejected", reason: "invalid" });
  });
});

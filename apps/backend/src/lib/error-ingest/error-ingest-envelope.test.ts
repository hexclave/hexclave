import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ERROR_INGEST_ENVELOPE_LIMITS,
  ErrorIngestEnvelopeError,
  parseErrorIngestEnvelope,
} from "./error-ingest-envelope";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function envelope(header: unknown, items: readonly { header: unknown, payload: string | Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [new TextEncoder().encode(`${json(header)}\n`)];
  for (const [index, item] of items.entries()) {
    const payload = typeof item.payload === "string" ? new TextEncoder().encode(item.payload) : item.payload;
    chunks.push(new TextEncoder().encode(`${json(item.header)}\n`), payload);
    if (index < items.length - 1) chunks.push(new Uint8Array([0x0a]));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function lengthFramedItem(header: Record<string, unknown>, payload: Uint8Array | string): { header: Record<string, unknown>, payload: Uint8Array } {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  return { header: { ...header, length: bytes.byteLength }, payload: bytes };
}

describe("Sentry-style error ingest envelope contract", () => {
  it("frames event, client report, and attachment metadata without exposing attachment bytes", () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    const attachmentBytes = new TextEncoder().encode("private attachment bytes");
    const input = envelope(
      {
        event_id: eventId,
        sent_at: "2026-08-06T00:00:00.000Z",
        sdk: { name: "fixture", version: "1.0.0" },
        trace: {
          trace_id: "0123456789abcdef0123456789abcdef",
          replay_id: "fedcba9876543210fedcba9876543210",
          sample_rand: "0.25",
          org_id: "org-123",
        },
      },
      [
        { header: { type: "event" }, payload: json({ event_id: eventId, message: "boom", request: { headers: { authorization: "Bearer secret" }, body: { password: "secret" } } }) },
        { header: { type: "client_report" }, payload: json({ timestamp: "2026-08-06T00:00:00.000Z", discarded_events: [{ reason: "network_error", category: "error", quantity: 2 }] }) },
        { header: lengthFramedItem({ type: "attachment", filename: "log.txt", content_type: "text/plain" }, attachmentBytes).header, payload: attachmentBytes },
      ],
    );

    const attachmentPayloads = new Map<string, Uint8Array>();
    const parsed = parseErrorIngestEnvelope(input, {
      onAttachment: (payload) => attachmentPayloads.set(payload.itemId, payload.bytes),
    });
    expect(parsed.header.trace).toMatchObject({ replay_id: "fedcba9876543210fedcba9876543210", sample_rand: "0.25", org_id: "org-123" });
    expect(parsed.items.map((item) => item.itemType)).toEqual(["event", "client_report", "attachment"]);
    expect(parsed.items.map((item) => item.outcome.status)).toEqual(["accepted", "accepted", "accepted"]);
    expect(parsed.items[0]?.event).toMatchObject({ event_id: eventId, message: "boom" });
    expect(JSON.stringify(parsed.items[0]?.event)).not.toContain("Bearer secret");
    expect(JSON.stringify(parsed.items[0]?.event)).not.toContain("password");
    expect(parsed.items[1]?.clientReport?.clientReport.discarded_events).toEqual([
      { reason: "network_error", category: "error", quantity: 2 },
    ]);
    expect(parsed.items[1]?.clientReport?.timestampMs).toBe(Date.parse("2026-08-06T00:00:00.000Z"));
    expect(parsed.items[2]?.attachment).toEqual({
      eventId,
      filename: "log.txt",
      contentType: "text/plain",
      attachmentType: "event.attachment",
      byteLength: attachmentBytes.byteLength,
      sha256: createHash("sha256").update(attachmentBytes).digest("hex"),
    });
    const attachmentItemId = parsed.items[2]?.itemId;
    expect(attachmentPayloads.get(attachmentItemId)).toEqual(attachmentBytes);
    expect(JSON.stringify(parsed)).not.toContain("private attachment bytes");
    expect(parsed.protocolProjection.items.map((item) => item.status)).toEqual(["accepted", "accepted", "accepted"]);
    expect(parsed.protocolProjection.items.map((item) => item.category)).toEqual(["error", "client_report", "attachment"]);
  });

  it("accepts a length-framed final item terminated by EOF and one terminated by a newline", () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    const attachmentBytes = new TextEncoder().encode("binary\xffbytes");
    const item = lengthFramedItem({ type: "attachment", filename: "crash.bin", content_type: "application/octet-stream" }, attachmentBytes);
    const atEof = envelope({ event_id: eventId }, [{ header: item.header, payload: attachmentBytes }]);
    expect(atEof[atEof.byteLength - 1]).not.toBe(0x0a);
    expect(parseErrorIngestEnvelope(atEof).items[0]?.outcome.status).toBe("accepted");

    const withNewline = new Uint8Array(atEof.byteLength + 1);
    withNewline.set(atEof, 0);
    withNewline[withNewline.byteLength - 1] = 0x0a;
    expect(parseErrorIngestEnvelope(withNewline).items[0]?.outcome.status).toBe("accepted");

    const truncated = atEof.subarray(0, atEof.byteLength - 1);
    expect(() => parseErrorIngestEnvelope(truncated)).toThrow(/framing/iu);
  });

  it("accepts Dynamic Sampling Context trace headers carrying the public DSN key", () => {
    const eventId = "0123456789abcdef0123456789abcdef";
    const parsed = parseErrorIngestEnvelope(envelope(
      {
        event_id: eventId,
        trace: {
          trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          public_key: "abcdef0123456789abcdef0123456789",
          sample_rate: "1.0",
        },
      },
      [{ header: { type: "event" }, payload: json({ event_id: eventId, message: "boom" }) }],
    ));
    expect(parsed.header.trace).toMatchObject({ public_key: "abcdef0123456789abcdef0123456789" });
    expect(parsed.items[0]?.outcome.status).toBe("accepted");
  });

  it("uses the envelope event identity for retries that change payload metadata", () => {
    const eventId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const first = parseErrorIngestEnvelope(envelope(
      { event_id: eventId },
      [{ header: { type: "event" }, payload: json({ event_id: eventId, message: "first" }) }],
    ));
    const retried = parseErrorIngestEnvelope(envelope(
      { event_id: eventId },
      [{ header: { type: "event" }, payload: json({ event_id: eventId, message: "enriched on retry" }) }],
    ));

    expect(retried.batchId).toBe(first.batchId);
    expect(retried.items[0]?.itemId).toBe(first.items[0]?.itemId);
  });

  it("accepts Relay-compatible event content_type metadata without retaining the hint", () => {
    const eventId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const payload = json({ event_id: eventId, message: "content type is only a wire hint" });
    const item = lengthFramedItem({ type: "event", content_type: "application/json" }, payload);
    const parsed = parseErrorIngestEnvelope(envelope(
      { event_id: eventId },
      [{ header: item.header, payload: item.payload }],
    ));

    expect(parsed.items[0]?.outcome).toEqual(expect.objectContaining({ status: "accepted", eventId }));
    expect(parsed.items[0]?.event).toEqual({ event_id: eventId, message: "content type is only a wire hint" });
    expect(JSON.stringify(parsed)).not.toContain("content_type");
  });

  it("does not turn an invalid client report into recursive feedback", () => {
    const parsed = parseErrorIngestEnvelope(envelope(
      { event_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      [{
        header: { type: "client_report" },
        payload: json({
          discarded_events: [{ reason: "Bearer report-secret", category: "error", quantity: 0 }],
        }),
      }],
    ));

    expect(parsed.items[0]?.outcome).toEqual(expect.objectContaining({
      itemType: "client_report",
      status: "rejected",
      reason: "invalid",
    }));
    expect(parsed.protocolProjection.items[0]).toMatchObject({
      itemType: "client_report",
      category: "client_report",
      status: "rejected",
      rejectedByOtlp: true,
    });
    expect(parsed.protocolProjection.items[0]).not.toHaveProperty("clientReportBucket");
    expect(parsed.protocolProjection.clientReport).toEqual({
      discarded_events: [],
      rate_limited_events: [],
      filtered_events: [],
      filtered_sampling_events: [],
    });
    expect(JSON.stringify(parsed)).not.toContain("report-secret");
  });

  it("accepts native transactions without turning performance data into an error issue", () => {
    const eventId = "55555555555555555555555555555555";
    const transactionPayload = json({
      event_id: eventId,
      type: "transaction",
      transaction: "/checkout/:id?token=transaction-secret",
      transaction_info: { source: "route" },
      start_timestamp: 1_754_444_800,
      timestamp: 1_754_444_801.25,
      contexts: {
        trace: {
          trace_id: "66666666666666666666666666666666",
          span_id: "7777777777777777",
        },
      },
      tags: { component: "checkout" },
      spans: [{
        trace_id: "66666666666666666666666666666666",
        span_id: "8888888888888888",
        parent_span_id: "7777777777777777",
        start_timestamp: 1_754_444_800.25,
        timestamp: 1_754_444_800.75,
        op: "db",
        description: "SELECT 1",
        data: { password: "child-secret", "db.system": "postgres" },
      }],
    });
    const transactionItem = lengthFramedItem(
      { type: "transaction", content_type: "application/json" },
      transactionPayload,
    );
    const parsed = parseErrorIngestEnvelope(envelope(
      { event_id: eventId },
      [{ header: transactionItem.header, payload: transactionItem.payload }],
    ));

    expect(parsed.items[0]?.itemType).toBe("transaction");
    expect(parsed.items[0]?.outcome).toEqual(expect.objectContaining({ eventId, status: "accepted" }));
    expect(parsed.items[0]?.transaction).toMatchObject({
      eventId,
      name: "/checkout/:id?token=[Filtered]",
      source: "route",
      startTimestampMs: 1_754_444_800_000,
      timestampMs: 1_754_444_801_250,
      durationMs: 1_250,
      traceId: "66666666666666666666666666666666",
      spanId: "7777777777777777",
      spanCount: 1,
      tags: { component: "checkout" },
    });
    expect(parsed.items[0]?.transaction?.spans).toEqual([expect.objectContaining({
      traceId: "66666666666666666666666666666666",
      spanId: "8888888888888888",
      parentSpanId: "7777777777777777",
      op: "db",
      description: "SELECT 1",
      startTimestampMs: 1_754_444_800_250,
      timestampMs: 1_754_444_800_750,
      data: { "db.system": "postgres" },
    })]);
    expect(JSON.stringify(parsed)).not.toContain("transaction-secret");
    expect(parsed.protocolProjection.items[0]).toMatchObject({
      itemType: "transaction",
      category: "transaction",
      status: "accepted",
      rejectedByOtlp: false,
    });
    expect(parsed.protocolProjection.clientReport.discarded_events).toEqual([]);
  });

  it("rejects transaction items with invalid trace metadata or excessive embedded spans", () => {
    const eventId = "88888888888888888888888888888888";
    const missingTrace = parseErrorIngestEnvelope(envelope(
      { event_id: eventId },
      [{
        header: { type: "transaction" },
        payload: json({
          event_id: eventId,
          transaction: "/checkout",
          start_timestamp: 1_754_444_800,
          timestamp: 1_754_444_801,
        }),
      }],
    ));
    expect(missingTrace.items[0]?.outcome).toEqual(expect.objectContaining({ status: "rejected", reason: "invalid" }));
    expect(missingTrace.items[0]?.transaction).toBeUndefined();

    const tooManySpans = Array.from({ length: ERROR_INGEST_ENVELOPE_LIMITS.maxTransactionSpanCount + 1 }, () => ({}));
    const parsed = parseErrorIngestEnvelope(envelope(
      { event_id: eventId },
      [{
        header: { type: "transaction" },
        payload: json({
          event_id: eventId,
          transaction: "/checkout",
          start_timestamp: 1_754_444_800,
          timestamp: 1_754_444_801,
          contexts: { trace: { trace_id: "99999999999999999999999999999999", span_id: "aaaaaaaaaaaaaaaa" } },
          spans: tooManySpans,
        }),
      }],
    ));
    expect(parsed.items[0]?.outcome).toEqual(expect.objectContaining({ status: "rejected", reason: "payload_too_large" }));
    expect(parsed.items[0]?.transaction).toBeUndefined();
  });

  it("rejects all-zero W3C transaction and child identities", () => {
    const eventId = "99999999999999999999999999999999";
    const parse = (traceId: string, spanId: string, spans: unknown[] = []) => parseErrorIngestEnvelope(envelope(
      { event_id: eventId },
      [{
        header: { type: "transaction" },
        payload: json({
          event_id: eventId,
          transaction: "/checkout",
          start_timestamp: 1_754_444_800,
          timestamp: 1_754_444_801,
          contexts: { trace: { trace_id: traceId, span_id: spanId } },
          spans,
        }),
      }],
    ));

    expect(parse("0".repeat(32), "7777777777777777").items[0]?.outcome).toEqual(expect.objectContaining({ status: "rejected", reason: "invalid" }));
    expect(parse("66666666666666666666666666666666", "7777777777777777", [{
      trace_id: "66666666666666666666666666666666",
      span_id: "0".repeat(16),
      start_timestamp: 1_754_444_800,
      timestamp: 1_754_444_801,
    }]).items[0]?.outcome).toEqual(expect.objectContaining({ status: "rejected", reason: "invalid" }));
  });

  it("scrubs JSON and source-map-like attachments before the private callback", () => {
    const eventId = "11111111111111111111111111111111";
    const sourceMap = json({
      version: 3,
      file: "app.min.js",
      sourcesContent: ["fetch('/api', { headers: { Authorization: 'Bearer map-secret' } })"],
      password: "map-password",
    });
    const sourceMapBytes = new TextEncoder().encode(sourceMap);
    const sourceMapItem = lengthFramedItem({ type: "attachment", filename: "app.min.js.map", content_type: "application/octet-stream" }, sourceMapBytes);
    const received: Uint8Array[] = [];
    const receivedItemIds: string[] = [];
    const parsed = parseErrorIngestEnvelope(envelope(
      { event_id: eventId },
      [{
        header: sourceMapItem.header,
        payload: sourceMapItem.payload,
      }],
    ), {
      onAttachment: (payload) => {
        received.push(payload.bytes);
        receivedItemIds.push(payload.itemId);
      },
    });

    const item = parsed.items[0];
    const receivedBytes = received[0];
    const attachment = item.attachment;
    if (attachment === undefined) {
      throw new Error("Expected a stored attachment item");
    }
    const receivedJson: unknown = JSON.parse(new TextDecoder().decode(receivedBytes));
    expect(receivedJson).not.toHaveProperty("password");
    expect(JSON.stringify(receivedJson)).not.toContain("map-password");
    expect(JSON.stringify(receivedJson)).not.toContain("map-secret");
    expect(receivedItemIds[0]).toBe(item.itemId);
    expect(attachment.byteLength).toBe(receivedBytes.byteLength);
    expect(attachment.sha256).toBe(createHash("sha256").update(receivedBytes).digest("hex"));
  });

  it("preserves opaque binary attachment bytes without decoding them", () => {
    const eventId = "22222222222222222222222222222222";
    const binary = new Uint8Array([0xff, 0x00, 0x80, 0x42, 0x9f, 0xc3, 0x28]);
    const received: Uint8Array[] = [];
    const parsed = parseErrorIngestEnvelope(envelope(
      { event_id: eventId },
      [{
        header: lengthFramedItem({ type: "attachment", filename: "crash.dmp", content_type: "application/octet-stream" }, binary).header,
        payload: binary,
      }],
    ), {
      onAttachment: (payload) => received.push(payload.bytes),
    });

    expect(received[0]).toEqual(binary);
    expect(parsed.items[0]?.attachment).toMatchObject({
      byteLength: binary.byteLength,
      sha256: createHash("sha256").update(binary).digest("hex"),
    });
  });

  it("rejects malformed recognized text without handing raw bytes to private storage", () => {
    const received: Uint8Array[] = [];
    const parsed = parseErrorIngestEnvelope(envelope(
      { event_id: "33333333333333333333333333333333" },
      [
        {
          header: lengthFramedItem({ type: "attachment", filename: "notes.txt", content_type: "text/plain" }, new Uint8Array([0xc3, 0x28])).header,
          payload: new Uint8Array([0xc3, 0x28]),
        },
        {
          header: lengthFramedItem({ type: "attachment", filename: "app.js.map", content_type: "application/octet-stream" }, "{not-json").header,
          payload: "{not-json",
        },
      ],
    ), {
      onAttachment: (payload) => received.push(payload.bytes),
    });

    expect(received).toEqual([]);
    expect(parsed.items.map((item) => item.outcome)).toEqual([
      expect.objectContaining({ status: "rejected", reason: "invalid" }),
      expect.objectContaining({ status: "rejected", reason: "invalid" }),
    ]);
  });

  it("rejects oversized attachments before private storage", () => {
    const payload = new Uint8Array(9).fill(0x41);
    const received: Uint8Array[] = [];
    const parsed = parseErrorIngestEnvelope(envelope(
      { event_id: "44444444444444444444444444444444" },
      [{
        header: lengthFramedItem({ type: "attachment", filename: "large.bin", content_type: "application/octet-stream" }, payload).header,
        payload,
      }],
    ), {
      limits: { maxItemPayloadBytes: 8 },
      onAttachment: (attachment) => received.push(attachment.bytes),
    });

    expect(received).toEqual([]);
    expect(parsed.items[0]?.outcome).toEqual(expect.objectContaining({ status: "rejected", reason: "payload_too_large" }));
    expect(parsed.items[0]?.attachment).toBeUndefined();
  });

  it("preserves item-level rejection beside accepted items", () => {
    const eventId = "fedcba9876543210fedcba9876543210";
    const parsed = parseErrorIngestEnvelope(envelope(
      { event_id: eventId },
      [
        { header: { type: "event", length: 9 }, payload: "not-json!" },
        { header: { type: "future_type" }, payload: "ignored" },
        { header: { type: "event" }, payload: json({ event_id: eventId, message: "kept" }) },
      ],
    ));

    expect(parsed.items.map((item) => item.outcome)).toEqual([
      expect.objectContaining({ status: "rejected", reason: "invalid" }),
      expect.objectContaining({ status: "rejected", reason: "unsupported" }),
      expect.objectContaining({ status: "accepted", eventId }),
    ]);
    expect(parsed.protocolProjection.status).toBe("partial");
    expect(parsed.protocolProjection.counts).toMatchObject({ accepted: 1, rejected: 2 });
  });

  it("fails closed on malformed framing, secret-bearing metadata, and envelope limits", () => {
    expect(() => parseErrorIngestEnvelope(new TextEncoder().encode("{}"))).toThrow(ErrorIngestEnvelopeError);
    expect(() => parseErrorIngestEnvelope(envelope({ authorization: "Bearer secret" }, []))).toThrow(/secret-bearing/iu);
    expect(() => parseErrorIngestEnvelope(envelope({ dsn: "https://public:secret@example.com/1" }, []))).toThrow(/public DSN/iu);

    const tooManyItems = Array.from({ length: ERROR_INGEST_ENVELOPE_LIMITS.maxItems + 1 }, () => ({
      header: { type: "future_type" },
      payload: "x",
    }));
    expect(() => parseErrorIngestEnvelope(envelope({}, tooManyItems))).toThrow(/too many items/iu);
  });

  it("rejects oversized item payloads without retaining their bytes", () => {
    const eventId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const payload = "x".repeat(ERROR_INGEST_ENVELOPE_LIMITS.maxEventPayloadBytes + 1);
    const parsed = parseErrorIngestEnvelope(envelope(
      { event_id: eventId },
      [{ header: { type: "event", length: new TextEncoder().encode(payload).byteLength }, payload }],
    ));
    expect(parsed.items[0]?.outcome).toEqual(expect.objectContaining({ status: "rejected", reason: "payload_too_large" }));
    expect(JSON.stringify(parsed)).not.toContain(payload);
  });
});

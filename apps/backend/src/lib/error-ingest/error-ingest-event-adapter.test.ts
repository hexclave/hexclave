import { describe, expect, it } from "vitest";
import { projectSentryEnvelopeEvent } from "./error-ingest-event-adapter";
import type { ErrorIngestEnvelopeHeader, ErrorIngestEnvelopeItem } from "./error-ingest-envelope";
import { scrubErrorIngestPayload } from "./error-ingest-scrubber";

const eventId = "0123456789abcdef0123456789abcdef";

const header: ErrorIngestEnvelopeHeader = {
  eventId,
  sentAt: null,
  sdk: { name: "sentry.javascript.browser", version: "8.0.0" },
  trace: { trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  dsnPresent: false,
};

const item = {
  itemIndex: 0,
  itemId: "envelope:item:0",
  wireType: "event",
  itemType: "event",
  payloadBytes: 100,
  outcome: { itemId: "envelope:item:0", itemType: "event", eventId, status: "accepted" },
} satisfies ErrorIngestEnvelopeItem;

function scrubEvent(value: unknown) {
  const result = scrubErrorIngestPayload(value);
  if (result.value === undefined) throw new Error("test event was scrubbed entirely");
  return result.value;
}

describe("Sentry envelope event adapter", () => {
  it("flattens the root exception while retaining the scrubbed rich event", () => {
    const projected = projectSentryEnvelopeEvent({
      header,
      item,
      receivedAtMs: 1_000,
      event: scrubEvent({
        event_id: eventId,
        timestamp: 2.5,
        level: "warning",
        exception: {
          values: [
            { type: "Error", value: "outer", mechanism: { handled: true } },
            {
              type: "TypeError",
              value: "inner",
              mechanism: { handled: false, synthetic: true },
              stacktrace: { frames: [{ function: "run", filename: "app.js", lineno: 12, colno: 4 }] },
            },
          ],
        },
        contexts: { trace: { span_id: "bbbbbbbbbbbbbbbb" } },
        request: { url: "https://example.com/path", headers: { authorization: "Bearer filtered" } },
      }),
    });

    expect(projected).toMatchObject({
      event_type: "$error",
      event_at_ms: 2_500,
      level: "warn",
      trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      span_id: "bbbbbbbbbbbbbbbb",
      data: {
        event_id: header.eventId,
        name: "TypeError",
        message: "inner",
        handled: false,
        synthetic: true,
      },
    });
    expect(JSON.stringify(projected)).toContain("at run (app.js:12:4)");
    expect(JSON.stringify(projected)).not.toContain("Bearer filtered");
  });

  it("uses the envelope receipt time when the event has no usable timestamp", () => {
    const projected = projectSentryEnvelopeEvent({
      header: { ...header, trace: null },
      item,
      receivedAtMs: 42_000,
      event: scrubEvent({ event_id: eventId, message: "captured", handled: true }),
    });

    expect(projected.event_at_ms).toBe(42_000);
    expect(projected.data).toMatchObject({ name: "Error", message: "captured", kind: "message", handled: true });
    expect(projected.trace_id).toBeUndefined();
    expect(projected.span_id).toBeUndefined();
  });

  it("falls back to receipt time for numeric timestamps beyond the supported Date range", () => {
    const projected = projectSentryEnvelopeEvent({
      header: { ...header, trace: null },
      item,
      receivedAtMs: 42_000,
      event: scrubEvent({ event_id: eventId, timestamp: 9_000_000_000_000, message: "captured", handled: true }),
    });
    expect(projected.event_at_ms).toBe(42_000);
  });

  it("emits the span identity only when both trace_id and span_id are present", () => {
    const traceOnly = projectSentryEnvelopeEvent({
      header,
      item,
      receivedAtMs: 1_000,
      event: scrubEvent({ event_id: eventId, message: "captured", handled: true }),
    });
    expect(traceOnly.trace_id).toBeUndefined();
    expect(traceOnly.span_id).toBeUndefined();

    const spanOnly = projectSentryEnvelopeEvent({
      header: { ...header, trace: null },
      item,
      receivedAtMs: 1_000,
      event: scrubEvent({ event_id: eventId, message: "captured", handled: true, contexts: { trace: { span_id: "bbbbbbbbbbbbbbbb" } } }),
    });
    expect(spanOnly.trace_id).toBeUndefined();
    expect(spanOnly.span_id).toBeUndefined();
  });

  it("accepts Sentry ISO timestamps and normalizes fatal levels to the telemetry vocabulary", () => {
    const projected = projectSentryEnvelopeEvent({
      header,
      item,
      receivedAtMs: 42_000,
      event: scrubEvent({ event_id: eventId, timestamp: "2026-08-06T00:00:00.000Z", level: "fatal", message: "captured", handled: true }),
    });
    expect(projected.event_at_ms).toBe(Date.parse("2026-08-06T00:00:00.000Z"));
    expect(projected.level).toBe("error");
  });

  it("defaults valid message and exception events without handled metadata to handled", () => {
    const message = projectSentryEnvelopeEvent({
      header: { ...header, trace: null },
      item,
      receivedAtMs: 42_000,
      event: scrubEvent({ event_id: eventId, message: "captured" }),
    });
    const exception = projectSentryEnvelopeEvent({
      header: { ...header, trace: null },
      item,
      receivedAtMs: 42_000,
      event: scrubEvent({
        event_id: eventId,
        exception: { values: [{ type: "Error", value: "captured", mechanism: { type: "generic" } }] },
      }),
    });

    expect(message.data).toMatchObject({ kind: "message", handled: true });
    expect(exception.data).toMatchObject({ kind: "exception", handled: true });
  });
});

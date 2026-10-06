import { describe, expect, it } from "vitest";
import { normalizeOtlpJsonTraceRequest } from "./traces";

describe("OTLP JSON trace normalization", () => {
  it("preserves canonical resource, scope, span, event, link, flags, and trace state", () => {
    const [span] = normalizeOtlpJsonTraceRequest({
      resourceSpans: [{
        schemaUrl: "https://opentelemetry.io/schemas/1.43.0",
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "checkout" } }],
          droppedAttributesCount: 2,
        },
        scopeSpans: [{
          schemaUrl: "https://scope.example/schema",
          scope: {
            name: "@prisma/instrumentation",
            version: "7.0.0",
            attributes: [{ key: "scope.mode", value: { stringValue: "client" } }],
            droppedAttributesCount: 3,
          },
          spans: [{
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
            traceState: "vendor=value",
            parentSpanId: "3333333333333333",
            flags: 257,
            name: "SELECT users",
            kind: 3,
            startTimeUnixNano: "1785888000000000000",
            endTimeUnixNano: "1785888000001000000",
            attributes: [
              { key: "db.system", value: { stringValue: "postgresql" } },
              { key: "db.rows", value: { intValue: "4" } },
            ],
            droppedAttributesCount: 4,
            events: [{
              name: "exception",
              timeUnixNano: "1785888000000500000",
              attributes: [{ key: "exception.message", value: { stringValue: "boom" } }],
              droppedAttributesCount: 5,
            }],
            droppedEventsCount: 6,
            links: [{
              traceId: "44444444444444444444444444444444",
              spanId: "5555555555555555",
              traceState: "other=value",
              flags: 1,
              attributes: [{ key: "link.reason", value: { stringValue: "retry" } }],
              droppedAttributesCount: 7,
            }],
            droppedLinksCount: 8,
            status: { code: 2, message: "failed" },
          }],
        }],
      }],
    });

    expect(span).toMatchObject({
      traceState: "vendor=value",
      flags: 257,
      name: "SELECT users",
      kind: 3,
      droppedAttributesCount: 4,
      droppedEventsCount: 6,
      droppedLinksCount: 8,
      status: { code: 2, message: "failed" },
      resource: { droppedAttributesCount: 2, schemaUrl: "https://opentelemetry.io/schemas/1.43.0" },
      scope: { name: "@prisma/instrumentation", version: "7.0.0", droppedAttributesCount: 3, schemaUrl: "https://scope.example/schema" },
    });
    expect(span.attributes).toEqual(new Map([
      ["db.system", { type: "string", value: "postgresql" }],
      ["db.rows", { type: "int", value: "4" }],
    ]));
    expect(span.events[0]).toMatchObject({ name: "exception", droppedAttributesCount: 5 });
    expect(span.links[0]).toMatchObject({
      traceState: "other=value",
      flags: 1,
      droppedAttributesCount: 7,
    });
  });

  it("preserves AnyValue types and the full int64 range", () => {
    const [span] = normalizeOtlpJsonTraceRequest({
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        name: "typed",
        startTimeUnixNano: "1",
        endTimeUnixNano: "2",
        attributes: [
          { key: "numeric-looking-string", value: { stringValue: "9223372036854775807" } },
          { key: "max-int64", value: { intValue: "9223372036854775807" } },
          { key: "bytes", value: { bytesValue: "AAE=" } },
        ],
      }] }] }],
    });
    expect(span.attributes).toEqual(new Map([
      ["numeric-looking-string", { type: "string", value: "9223372036854775807" }],
      ["max-int64", { type: "int", value: "9223372036854775807" }],
      ["bytes", { type: "bytes", value: "AAE=" }],
    ]));
  });

  it("rejects malformed identities and duplicate attributes", () => {
    const request = {
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: "invalid",
        spanId: "2222222222222222",
        name: "bad",
        startTimeUnixNano: "1",
        endTimeUnixNano: "2",
        attributes: [
          { key: "same", value: { stringValue: "a" } },
          { key: "same", value: { stringValue: "b" } },
        ],
      }] }] }],
    };
    expect(() => normalizeOtlpJsonTraceRequest(request)).toThrow(/traceId/);
    request.resourceSpans[0].scopeSpans[0].spans[0].traceId = "11111111111111111111111111111111";
    expect(() => normalizeOtlpJsonTraceRequest(request)).toThrow(/duplicate key/);
  });

  it("accepts endTimeUnixNano 0 as the open-span marker but still rejects end < start", () => {
    const requestWithEnd = (endTimeUnixNano: string) => ({
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        name: "$page-view",
        startTimeUnixNano: "1785888000000000000",
        endTimeUnixNano,
      }] }] }],
    });
    expect(normalizeOtlpJsonTraceRequest(requestWithEnd("0"))[0]).toMatchObject({ endTimeUnixNano: "0" });
    expect(() => normalizeOtlpJsonTraceRequest(requestWithEnd("1785887999999999999"))).toThrow(/must not precede/);
    expect(normalizeOtlpJsonTraceRequest(requestWithEnd("00"))[0]).toMatchObject({ endTimeUnixNano: "0" });
  });

  it("rejects self-parented spans, mirroring batch ingestion", () => {
    expect(() => normalizeOtlpJsonTraceRequest({
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        parentSpanId: "2222222222222222",
        name: "cycle",
        startTimeUnixNano: "1",
        endTimeUnixNano: "2",
      }] }] }],
    })).toThrow(/parentSpanId must not equal spanId/);
  });

  it("rejects attribute nesting beyond the shared depth limit instead of overflowing the stack", () => {
    let value: Record<string, unknown> = { stringValue: "leaf" };
    for (let index = 0; index < 100; index++) {
      value = { kvlistValue: { values: [{ key: "nested", value }] } };
    }
    expect(() => normalizeOtlpJsonTraceRequest({
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        name: "deep",
        startTimeUnixNano: "1",
        endTimeUnixNano: "2",
        attributes: [{ key: "deep", value }],
      }] }] }],
    })).toThrow(/maximum attribute depth/);
  });
});

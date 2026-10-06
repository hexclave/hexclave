import { describe, expect, it } from "vitest";
import {
  decodeOtlpProtobufRequest,
  decodeOtlpProtobufResponse,
  encodeOtlpProtobufRequest,
  encodeOtlpProtobufResponse,
  OtlpProtobufError,
} from "./protobuf";

const traceId = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const spanId = Uint8Array.from({ length: 8 }, (_, index) => index + 17);

describe("OTLP protobuf codec", () => {
  it("preserves the standard trace wire model and converts identity bytes to OTLP JSON hex", () => {
    const encoded = encodeOtlpProtobufRequest("traces", {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
        scopeSpans: [{
          scope: { name: "example.instrumentation", version: "1.2.3" },
          spans: [{
            traceId,
            spanId,
            traceState: "vendor=value",
            name: "POST /checkout",
            kind: 2,
            startTimeUnixNano: "1720000000000000000",
            endTimeUnixNano: "1720000000001000000",
            attributes: [{ key: "binary", value: { bytesValue: Uint8Array.from([1, 2, 3]) } }],
            events: [{ timeUnixNano: "1720000000000500000", name: "validated" }],
            status: { code: 1 },
            flags: 1,
          }],
        }],
      }],
    });

    expect(decodeOtlpProtobufRequest("traces", encoded)).toMatchObject({
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
        scopeSpans: [{
          scope: { name: "example.instrumentation", version: "1.2.3" },
          spans: [{
            traceId: "0102030405060708090a0b0c0d0e0f10",
            spanId: "1112131415161718",
            traceState: "vendor=value",
            name: "POST /checkout",
            attributes: [{ key: "binary", value: { bytesValue: "AQID" } }],
            events: [{ name: "validated" }],
            flags: 1,
          }],
        }],
      }],
    });
  });

  it("preserves log correlation, event name, timestamps, and AnyValue fields", () => {
    const encoded = encodeOtlpProtobufRequest("logs", {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: "1720000000000000000",
            observedTimeUnixNano: "1720000000000001000",
            severityNumber: 9,
            severityText: "INFO",
            body: { stringValue: "checkout completed" },
            eventName: "checkout.completed",
            traceId,
            spanId,
          }],
        }],
      }],
    });

    expect(decodeOtlpProtobufRequest("logs", encoded)).toMatchObject({
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: "1720000000000000000",
            observedTimeUnixNano: "1720000000000001000",
            severityNumber: 9,
            severityText: "INFO",
            body: { stringValue: "checkout completed" },
            eventName: "checkout.completed",
            traceId: "0102030405060708090a0b0c0d0e0f10",
            spanId: "1112131415161718",
          }],
        }],
      }],
    });
  });

  it("preserves representative OTLP metric point types, exemplars, and uint64 timestamps", () => {
    const timestamp = "17200000000000000001";
    const encoded = encodeOtlpProtobufRequest("metrics", {
      resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
        schemaUrl: "https://example.test/resource/1",
        scopeMetrics: [{
          scope: { name: "example.metrics", version: "1.2.3" },
          schemaUrl: "https://example.test/metrics/1",
          metrics: [
            {
              name: "checkout.requests",
              description: "Requests accepted by checkout",
              unit: "{request}",
              sum: {
                dataPoints: [{
                  attributes: [{ key: "route", value: { stringValue: "/checkout" } }],
                  startTimeUnixNano: "17200000000000000000",
                  timeUnixNano: timestamp,
                  asInt: "42",
                  flags: 1,
                  exemplars: [{
                    timeUnixNano: timestamp,
                    asInt: "1",
                    traceId,
                    spanId,
                    filteredAttributes: [{ key: "tenant", value: { stringValue: "redacted" } }],
                  }],
                }],
                aggregationTemporality: 2,
                isMonotonic: true,
              },
              metadata: [{ key: "owner", value: { stringValue: "payments" } }],
            },
            {
              name: "checkout.latency",
              unit: "ms",
              histogram: {
                dataPoints: [{
                  timeUnixNano: timestamp,
                  count: "2",
                  sum: 12.5,
                  bucketCounts: ["1", "1"],
                  explicitBounds: [5],
                  min: 4,
                  max: 8,
                }],
                aggregationTemporality: 1,
              },
            },
            {
              name: "checkout.queue",
              exponentialHistogram: {
                dataPoints: [{
                  timeUnixNano: timestamp,
                  count: "1",
                  scale: 2,
                  zeroCount: "0",
                  positive: { offset: 0, bucketCounts: ["1"] },
                  negative: { offset: 0, bucketCounts: [] },
                  zeroThreshold: 0.001,
                }],
                aggregationTemporality: 2,
              },
            },
            {
              name: "checkout.summary",
              summary: {
                dataPoints: [{
                  timeUnixNano: timestamp,
                  count: "2",
                  sum: 12,
                  quantileValues: [{ quantile: 0.5, value: 6 }],
                }],
              },
            },
            {
              name: "checkout.inflight",
              gauge: {
                dataPoints: [{ timeUnixNano: timestamp, asDouble: 3.5 }],
              },
            },
          ],
        }],
      }],
    });

    expect(decodeOtlpProtobufRequest("metrics", encoded)).toMatchObject({
      resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
        schemaUrl: "https://example.test/resource/1",
        scopeMetrics: [{
          scope: { name: "example.metrics", version: "1.2.3" },
          schemaUrl: "https://example.test/metrics/1",
          metrics: [
            {
              name: "checkout.requests",
              sum: {
                dataPoints: [{
                  startTimeUnixNano: "17200000000000000000",
                  timeUnixNano: timestamp,
                  asInt: "42",
                  flags: 1,
                  exemplars: [{
                    timeUnixNano: timestamp,
                    asInt: "1",
                    traceId: "0102030405060708090a0b0c0d0e0f10",
                    spanId: "1112131415161718",
                  }],
                }],
                aggregationTemporality: 2,
                isMonotonic: true,
              },
            },
            { name: "checkout.latency", histogram: { dataPoints: [{ count: "2", sum: 12.5, min: 4, max: 8 }] } },
            { name: "checkout.queue", exponentialHistogram: { dataPoints: [{ count: "1", scale: 2, zeroCount: "0" }] } },
            { name: "checkout.summary", summary: { dataPoints: [{ count: "2", sum: 12, quantileValues: [{ quantile: 0.5, value: 6 }] }] } },
            { name: "checkout.inflight", gauge: { dataPoints: [{ timeUnixNano: timestamp, asDouble: 3.5 }] } },
          ],
        }],
      }],
    });
  });

  it("encodes full-success responses as empty protobuf messages", () => {
    expect(encodeOtlpProtobufResponse("traces")).toHaveLength(0);
    expect(encodeOtlpProtobufResponse("logs")).toHaveLength(0);
  });

  it("encodes standard trace and log partial-success responses", () => {
    const traceResponse = encodeOtlpProtobufResponse("traces", {
      partialSuccess: { rejectedSpans: "2", errorMessage: "invalid spans" },
    });
    const logsResponse = encodeOtlpProtobufResponse("logs", {
      partialSuccess: { rejectedLogRecords: "3", errorMessage: "invalid logs" },
    });

    expect(decodeOtlpProtobufResponse("traces", traceResponse)).toMatchObject({
      partialSuccess: { rejectedSpans: "2", errorMessage: "invalid spans" },
    });
    expect(decodeOtlpProtobufResponse("logs", logsResponse)).toMatchObject({
      partialSuccess: { rejectedLogRecords: "3", errorMessage: "invalid logs" },
    });
  });

  it("encodes metrics partial success using rejected_data_points", () => {
    const response = encodeOtlpProtobufResponse("metrics", {
      partialSuccess: { rejectedDataPoints: "7", errorMessage: "invalid metrics" },
    });

    expect(decodeOtlpProtobufResponse("metrics", response)).toMatchObject({
      partialSuccess: { rejectedDataPoints: "7", errorMessage: "invalid metrics" },
    });
  });

  it("rejects malformed protobuf instead of partially decoding it", () => {
    expect(() => decodeOtlpProtobufRequest("traces", Uint8Array.from([10, 4, 1]))).toThrow(OtlpProtobufError);
  });
});

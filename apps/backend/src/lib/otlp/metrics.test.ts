import { describe, expect, it } from "vitest";
import {
  DEFAULT_OTLP_METRICS_NORMALIZATION_LIMITS,
  normalizeOtlpJsonMetricsRequest,
} from "./metrics";

const START_TIME = "1785888000000000000";
const END_TIME = "1785888000001000000";
const TRACE_ID = "11111111111111111111111111111111";
const SPAN_ID = "2222222222222222";

function gaugeRequest(dataPoint: Record<string, unknown>): Record<string, unknown> {
  return {
    resourceMetrics: [{
      scopeMetrics: [{
        metrics: [{
          name: "test.gauge",
          gauge: { dataPoints: [dataPoint] },
        }],
      }],
    }],
  };
}

function sumRequest(sum: Record<string, unknown>): Record<string, unknown> {
  return {
    resourceMetrics: [{
      scopeMetrics: [{
        metrics: [{
          name: "test.sum",
          sum: {
            dataPoints: [{ startTimeUnixNano: START_TIME, timeUnixNano: END_TIME, asDouble: 1 }],
            ...sum,
          },
        }],
      }],
    }],
  };
}

describe("OTLP JSON metrics normalization", () => {
  it("preserves resource, scope, metadata, and every official metric data variant", () => {
    const normalized = normalizeOtlpJsonMetricsRequest({
      resourceMetrics: [{
        schemaUrl: "https://resource.example/schema/1",
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "checkout" } }],
          droppedAttributesCount: 2,
        },
        scopeMetrics: [{
          schemaUrl: "https://scope.example/schema/1",
          scope: {
            name: "checkout.metrics",
            version: "1.2.3",
            attributes: [{ key: "scope.mode", value: { stringValue: "server" } }],
            droppedAttributesCount: 3,
          },
          metrics: [
            {
              name: "checkout.gauge",
              description: "current queue depth",
              unit: "{items}",
              metadata: [{ key: "owner", value: { stringValue: "" } }],
              gauge: {
                dataPoints: [{
                  timeUnixNano: END_TIME,
                  asDouble: 10,
                  flags: 1,
                  attributes: [{ key: "queue", value: { stringValue: "payments" } }],
                }],
              },
            },
            {
              name: "checkout.requests",
              unit: "{request}",
              sum: {
                aggregationTemporality: 2,
                isMonotonic: true,
                dataPoints: [{
                  startTimeUnixNano: START_TIME,
                  timeUnixNano: END_TIME,
                  asInt: "9223372036854775807",
                  exemplars: [{
                    timeUnixNano: END_TIME,
                    asDouble: 1.5,
                    filteredAttributes: [{ key: "route", value: { stringValue: "/checkout" } }],
                    traceId: TRACE_ID,
                    spanId: SPAN_ID,
                  }],
                }],
              },
            },
            {
              name: "checkout.duration",
              unit: "s",
              histogram: {
                aggregationTemporality: 1,
                dataPoints: [{
                  startTimeUnixNano: START_TIME,
                  timeUnixNano: END_TIME,
                  count: "3",
                  sum: 5,
                  bucketCounts: ["1", "2"],
                  explicitBounds: [1],
                  min: 0.5,
                  max: 2.5,
                }],
              },
            },
            {
              name: "checkout.size",
              unit: "By",
              exponentialHistogram: {
                aggregationTemporality: 1,
                dataPoints: [{
                  startTimeUnixNano: START_TIME,
                  timeUnixNano: END_TIME,
                  count: "4",
                  sum: 10,
                  scale: -2,
                  zeroCount: "1",
                  zeroThreshold: 0.1,
                  positive: { offset: 2, bucketCounts: ["2"] },
                  negative: { offset: -1, bucketCounts: ["1"] },
                  min: 0,
                  max: 5,
                }],
              },
            },
            {
              name: "checkout.quantiles",
              unit: "s",
              summary: {
                dataPoints: [{
                  startTimeUnixNano: START_TIME,
                  timeUnixNano: END_TIME,
                  count: "3",
                  sum: 5,
                  quantileValues: [
                    { quantile: 0.5, value: 1 },
                    { quantile: 0.99, value: 4 },
                  ],
                }],
              },
            },
          ],
        }],
      }],
      futureField: "ignored by the OTLP forward-compatibility rule",
    });

    const resourceMetrics = normalized.resourceMetrics[0];
    const scopeMetrics = resourceMetrics.scopeMetrics[0];
    expect(resourceMetrics).toMatchObject({
      schemaUrl: "https://resource.example/schema/1",
      resource: { droppedAttributesCount: 2 },
    });
    expect(scopeMetrics).toMatchObject({
      schemaUrl: "https://scope.example/schema/1",
      scope: { name: "checkout.metrics", version: "1.2.3", droppedAttributesCount: 3 },
    });
    expect(resourceMetrics.resource.attributes).toEqual(new Map([
      ["service.name", { type: "string", value: "checkout" }],
    ]));
    expect(scopeMetrics.metrics.map((metric) => metric.name)).toEqual([
      "checkout.gauge",
      "checkout.requests",
      "checkout.duration",
      "checkout.size",
      "checkout.quantiles",
    ]);
    expect(scopeMetrics.metrics[0].metadata).toEqual(new Map([
      ["owner", { type: "string", value: "" }],
    ]));

    const gauge = scopeMetrics.metrics[0].data;
    if (gauge.type !== "gauge") throw new Error("Expected gauge data");
    expect(gauge.dataPoints[0]).toMatchObject({
      timeUnixNano: END_TIME,
      startTimeUnixNano: null,
      flags: 1,
      value: { type: "double", value: 10 },
    });

    const sum = scopeMetrics.metrics[1].data;
    if (sum.type !== "sum") throw new Error("Expected sum data");
    expect(sum).toMatchObject({ aggregationTemporality: 2, isMonotonic: true });
    expect(sum.dataPoints[0].value).toEqual({ type: "int", value: "9223372036854775807" });
    expect(sum.dataPoints[0].exemplars[0]).toMatchObject({
      timeUnixNano: END_TIME,
      spanId: SPAN_ID,
      traceId: TRACE_ID,
      value: { type: "double", value: 1.5 },
    });
    expect(sum.dataPoints[0].exemplars[0].filteredAttributes.get("route")).toEqual({
      type: "string",
      value: "/checkout",
    });

    const histogram = scopeMetrics.metrics[2].data;
    if (histogram.type !== "histogram") throw new Error("Expected histogram data");
    expect(histogram).toMatchObject({ aggregationTemporality: 1 });
    expect(histogram.dataPoints[0]).toMatchObject({
      count: "3",
      bucketCounts: ["1", "2"],
      explicitBounds: [1],
      sum: 5,
      min: 0.5,
      max: 2.5,
    });

    const exponentialHistogram = scopeMetrics.metrics[3].data;
    if (exponentialHistogram.type !== "exponentialHistogram") throw new Error("Expected exponential histogram data");
    expect(exponentialHistogram.dataPoints[0]).toMatchObject({
      count: "4",
      scale: -2,
      zeroCount: "1",
      positive: { offset: 2, bucketCounts: ["2"] },
      negative: { offset: -1, bucketCounts: ["1"] },
      zeroThreshold: 0.1,
    });

    const summary = scopeMetrics.metrics[4].data;
    if (summary.type !== "summary") throw new Error("Expected summary data");
    expect(summary.dataPoints[0]).toMatchObject({
      count: "3",
      sum: 5,
      quantileValues: [{ quantile: 0.5, value: 1 }, { quantile: 0.99, value: 4 }],
    });
  });

  it("rejects duplicate attributes at the metric boundary", () => {
    expect(() => normalizeOtlpJsonMetricsRequest(gaugeRequest({
      timeUnixNano: END_TIME,
      asDouble: 1,
      attributes: [
        { key: "same", value: { stringValue: "first" } },
        { key: "same", value: { stringValue: "second" } },
      ],
    }))).toThrow(/duplicate key/);
  });

  it("rejects zero or non-integral timestamps and a sum start after the end", () => {
    expect(() => normalizeOtlpJsonMetricsRequest(gaugeRequest({ timeUnixNano: "0", asDouble: 1 })))
      .toThrow(/timeUnixNano.*greater than zero/);
    expect(() => normalizeOtlpJsonMetricsRequest(sumRequest({
      aggregationTemporality: 2,
      dataPoints: [{
        startTimeUnixNano: END_TIME,
        timeUnixNano: START_TIME,
        asDouble: 1,
      }],
    }))).toThrow(/startTimeUnixNano.*after/);
    expect(() => normalizeOtlpJsonMetricsRequest(gaugeRequest({ timeUnixNano: 1.5, asDouble: 1 })))
      .toThrow(/timeUnixNano.*uint64/);
  });

  it("requires a valid temporality and boolean monotonicity for sums", () => {
    expect(() => normalizeOtlpJsonMetricsRequest(sumRequest({ isMonotonic: true })))
      .toThrow(/aggregationTemporality/);
    expect(() => normalizeOtlpJsonMetricsRequest(sumRequest({ aggregationTemporality: 0 })))
      .toThrow(/DELTA.*CUMULATIVE/);
    expect(() => normalizeOtlpJsonMetricsRequest(sumRequest({ aggregationTemporality: 2, isMonotonic: "true" })))
      .toThrow(/isMonotonic.*boolean/);
    expect(() => normalizeOtlpJsonMetricsRequest(sumRequest({ aggregationTemporality: "AGGREGATION_TEMPORALITY_DELTA" })))
      .toThrow(/DELTA.*CUMULATIVE/);
  });

  it("rejects invalid metric oneofs and malformed exemplar correlation", () => {
    expect(() => normalizeOtlpJsonMetricsRequest(gaugeRequest({
      timeUnixNano: END_TIME,
      asDouble: 1,
      asInt: "1",
    }))).toThrow(/exactly one of asDouble or asInt/);
    expect(() => normalizeOtlpJsonMetricsRequest({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "invalid", gauge: {}, summary: {} }] }] }],
    })).toThrow(/exactly one metric data variant/);
    expect(() => normalizeOtlpJsonMetricsRequest(sumRequest({
      aggregationTemporality: 2,
      dataPoints: [{
        startTimeUnixNano: START_TIME,
        timeUnixNano: END_TIME,
        asDouble: 1,
        exemplars: [{ timeUnixNano: END_TIME, asDouble: 1, traceId: TRACE_ID }],
      }],
    }))).toThrow(/both traceId and spanId/);
    expect(() => normalizeOtlpJsonMetricsRequest(sumRequest({
      aggregationTemporality: 2,
      dataPoints: [{
        startTimeUnixNano: START_TIME,
        timeUnixNano: END_TIME,
        asDouble: 1,
        exemplars: [{ timeUnixNano: END_TIME, asDouble: 1, traceId: "not-an-id", spanId: SPAN_ID }],
      }],
    }))).toThrow(/trace ID/);
  });

  it("keeps uint64 timestamps, counts, and int values lossless", () => {
    const maxUint64 = "18446744073709551615";
    const normalized = normalizeOtlpJsonMetricsRequest({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{
        name: "large-values",
        sum: {
          aggregationTemporality: 2,
          dataPoints: [{
            startTimeUnixNano: "1",
            timeUnixNano: maxUint64,
            asInt: "-9223372036854775808",
          }],
        },
      }] }] }],
    });
    const data = normalized.resourceMetrics[0].scopeMetrics[0].metrics[0].data;
    if (data.type !== "sum") throw new Error("Expected sum data");
    expect(data.dataPoints[0].timeUnixNano).toBe(maxUint64);
    expect(data.dataPoints[0].value).toEqual({ type: "int", value: "-9223372036854775808" });

    const safeNumber = normalizeOtlpJsonMetricsRequest(gaugeRequest({
      timeUnixNano: 9_007_199_254_740_991,
      asDouble: 1,
    }));
    expect(safeNumber.resourceMetrics[0].scopeMetrics[0].metrics[0].data)
      .toMatchObject({ dataPoints: [{ timeUnixNano: "9007199254740991" }] });
    expect(() => normalizeOtlpJsonMetricsRequest(gaugeRequest({
      timeUnixNano: 9_007_199_254_740_992,
      asDouble: 1,
    }))).toThrow(/uint64/);
  });

  it("checks histogram, exponential histogram, and summary invariants", () => {
    expect(() => normalizeOtlpJsonMetricsRequest({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{
        name: "bad.histogram",
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [{ timeUnixNano: END_TIME, count: "3", bucketCounts: ["1"], explicitBounds: [1] }],
        },
      }] }] }],
    })).toThrow(/one more bucket count/);
    expect(() => normalizeOtlpJsonMetricsRequest({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{
        name: "bad.summary",
        summary: {
          dataPoints: [{
            timeUnixNano: END_TIME,
            count: "1",
            sum: 1,
            quantileValues: [{ quantile: 0.9, value: 1 }, { quantile: 0.5, value: 2 }],
          }],
        },
      }] }] }],
    })).toThrow(/quantileValues.*strictly increasing/);
    expect(() => normalizeOtlpJsonMetricsRequest({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{
        name: "bad.exponential",
        exponentialHistogram: {
          aggregationTemporality: 1,
          dataPoints: [{
            timeUnixNano: END_TIME,
            count: "2",
            zeroCount: "1",
            positive: { bucketCounts: ["2"] },
          }],
        },
      }] }] }],
    })).toThrow(/sum of bucketCounts/);
  });

  it("enforces structural bounds before normalizing the payload", () => {
    const limits = {
      ...DEFAULT_OTLP_METRICS_NORMALIZATION_LIMITS,
      maxResourceMetrics: 1,
    };
    expect(() => normalizeOtlpJsonMetricsRequest({ resourceMetrics: [{}, {}] }, limits))
      .toThrow(/at most 1 entries/);
  });
});

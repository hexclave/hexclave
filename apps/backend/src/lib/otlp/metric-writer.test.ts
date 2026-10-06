import { describe, expect, it } from "vitest";
import { normalizeOtlpJsonMetricsRequest } from "./metrics";
import { buildOtlpMetricRows, getOtlpMetricsDeduplicationToken } from "./metric-writer";

const tenant = {
  projectId: "project-1",
  branchId: "branch-1",
  userId: null,
  refreshTokenId: null,
};

function request() {
  return normalizeOtlpJsonMetricsRequest({
    resourceMetrics: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout" } }] },
      schemaUrl: "https://example.test/resource/1",
      scopeMetrics: [{
        scope: { name: "checkout.metrics", version: "1.0.0" },
        schemaUrl: "https://example.test/metrics/1",
        metrics: [
          { name: "checkout.requests", sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: [{
              startTimeUnixNano: "17200000000000000000",
              timeUnixNano: "17200000000000000001",
              attributes: [{ key: "route", value: { stringValue: "/checkout" } }],
              asInt: "42",
              exemplars: [{
                timeUnixNano: "17200000000000000001",
                asInt: "1",
                traceId: "0102030405060708090a0b0c0d0e0f10",
                spanId: "1112131415161718",
              }],
            }],
          } },
          { name: "checkout.gauge", gauge: {
            dataPoints: [{ timeUnixNano: "17200000000000000001", asDouble: 2.5 }],
          } },
          { name: "checkout.histogram", histogram: {
            aggregationTemporality: 1,
            dataPoints: [{ timeUnixNano: "17200000000000000001", count: "1", bucketCounts: ["1"], explicitBounds: [] }],
          } },
          { name: "checkout.exp", exponentialHistogram: {
            aggregationTemporality: 2,
            dataPoints: [{ timeUnixNano: "17200000000000000001", count: "1", zeroCount: "1" }],
          } },
          { name: "checkout.summary", summary: {
            dataPoints: [{ timeUnixNano: "17200000000000000001", count: "1", sum: 2 }],
          } },
        ],
      }],
    }],
  });
}

describe("OTLP metric writer", () => {
  it("flattens every metric type while keeping server-owned tenancy and exemplar links", () => {
    const rows = buildOtlpMetricRows(request(), tenant);
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.metric_type)).toEqual([
      "sum",
      "gauge",
      "histogram",
      "exponential_histogram",
      "summary",
    ]);
    expect(rows[0]).toMatchObject({
      project_id: "project-1",
      branch_id: "branch-1",
      metric_name: "checkout.requests",
      aggregation_temporality: 2,
      is_monotonic: 1,
      time_unix_nano: "17200000000000000001",
      exemplar_trace_id: "0102030405060708090a0b0c0d0e0f10",
      exemplar_span_id: "1112131415161718",
      user_id: null,
      runtime: "server",
    });
    expect(rows[0].data_point).toContain("17200000000000000001");
    expect(rows[0].resource_attributes).toContain("service.name");
  });

  it("scrubs caller-supplied attribute maps inside the raw data_point JSON", () => {
    const scrubberRequest = normalizeOtlpJsonMetricsRequest({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{ name: "checkout.requests", sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: [{
              timeUnixNano: "17200000000000000001",
              attributes: [
                { key: "route", value: { stringValue: "/checkout" } },
                { key: "password", value: { stringValue: "hidden-secret" } },
              ],
              asInt: "42",
              exemplars: [{
                timeUnixNano: "17200000000000000001",
                asInt: "1",
                filteredAttributes: [{ key: "api_key", value: { stringValue: "hidden-secret" } }],
              }],
            }],
          } }],
        }],
      }],
    });
    const [row] = buildOtlpMetricRows(scrubberRequest, tenant);
    expect(row.attributes).not.toContain("hidden-secret");
    expect(row.data_point).not.toContain("hidden-secret");
    expect(JSON.parse(row.data_point)).toMatchObject({
      value: { type: "int", value: "42" },
      attributes: { route: { type: "string", value: "/checkout" } },
    });
  });

  it("uses deterministic point identity and batch tokens when attribute order changes", () => {
    const first = request();
    const second = request();
    const firstRows = buildOtlpMetricRows(first, tenant);
    const secondRows = buildOtlpMetricRows(second, tenant);
    expect(firstRows[0].point_id).toBe(secondRows[0].point_id);
    expect(getOtlpMetricsDeduplicationToken(firstRows, tenant))
      .toBe(getOtlpMetricsDeduplicationToken(secondRows, tenant));
  });
});

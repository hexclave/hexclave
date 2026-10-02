import {
  buildOtlpMetricCatalogEntryQuery,
  buildOtlpMetricCatalogQuery,
  buildOtlpMetricSeriesQuery,
  getOtlpMetricBucketNanoseconds,
  parseOtlpMetricCatalogRows,
  parseOtlpMetricQueryHours,
  parseOtlpMetricQueryType,
  parseOtlpMetricSeriesRows,
  parseOtlpMetricUint64,
  queryOtlpMetrics,
} from "./metric-query";
import type { ClickHouseClient } from "@/lib/clickhouse";
import { describe, expect, it } from "vitest";

function catalogRow(overrides: Partial<{ metric_name: string, metric_type: string, point_count: number }>) {
  return {
    metric_name: "http.server.duration",
    metric_description: "",
    metric_unit: "ms",
    metric_type: "histogram",
    aggregation_temporality: 2,
    is_monotonic: 0,
    point_count: 1,
    latest_time_unix_nano: "1720000000000000000",
    ...overrides,
  };
}

function fakeCatalogClient(responses: Array<{ expectQueryContains?: string, rows: unknown[] }>) {
  const executed: Array<{ query: string, query_params: Record<string, unknown> }> = [];
  const query = async (options: { query: string, query_params: Record<string, unknown> }) => {
    executed.push({ query: options.query, query_params: options.query_params });
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected extra ClickHouse query");
    if (response.expectQueryContains !== undefined && !options.query.includes(response.expectQueryContains)) {
      throw new Error(`Expected query to contain ${JSON.stringify(response.expectQueryContains)}: ${options.query}`);
    }
    return { json: async () => response.rows };
  };
  // SAFETY: the metric-query helpers only call client.query and read .json() off the result, so a query-only
  // fixture is sufficient; starting from an empty base means any new ClickHouseClient dependency of the code
  // under test fails loudly here instead of being silently mocked.
  const client = Object.assign({} as ClickHouseClient, { query });
  return { client, executed };
}

describe("OTLP metric query contract", () => {
  it("keeps the public time-range allowlist explicit", () => {
    expect(parseOtlpMetricQueryHours(undefined)).toBe(24);
    expect(parseOtlpMetricQueryHours(1)).toBe(1);
    expect(parseOtlpMetricQueryHours(720)).toBe(720);
    expect(() => parseOtlpMetricQueryHours(2)).toThrow("hours must be one of 1, 24, 168, 720");
  });

  it("uses bounded bucket widths for every supported range", () => {
    expect(getOtlpMetricBucketNanoseconds(1)).toBe(300_000_000_000n);
    expect(getOtlpMetricBucketNanoseconds(24)).toBe(3_600_000_000_000n);
    expect(getOtlpMetricBucketNanoseconds(168)).toBe(21_600_000_000_000n);
    expect(getOtlpMetricBucketNanoseconds(720)).toBe(86_400_000_000_000n);
  });

  it("makes tenant scoping and canonical replacement explicit in both queries", () => {
    expect(buildOtlpMetricCatalogQuery(24)).toContain("FROM analytics_internal.metrics FINAL");
    expect(buildOtlpMetricCatalogQuery(24)).toContain("PREWHERE project_id = {projectId:String}");
    expect(buildOtlpMetricCatalogQuery(24)).toContain("branch_id = {branchId:String}");
    expect(buildOtlpMetricCatalogQuery(24)).toContain("toString(max(time_unix_nano)) AS latest_time_unix_nano");
    expect(buildOtlpMetricCatalogQuery(24)).toContain("argMax(metric_description, (time_unix_nano, created_at, point_id))");
    expect(buildOtlpMetricSeriesQuery(24)).toContain("m.metric_name = {metricName:String}");
    expect(buildOtlpMetricSeriesQuery(24)).toContain("m.metric_type = {metricType:String}");
    expect(buildOtlpMetricSeriesQuery(24)).toContain("PREWHERE m.project_id = {projectId:String}");
    expect(buildOtlpMetricSeriesQuery(24)).toContain("toString(bucket_start_unix_nano_value) AS bucket_start_unix_nano");
    expect(buildOtlpMetricSeriesQuery(24)).toContain("bucketNanoseconds:UInt64");
  });

  it("validates the requested metric type against the OTLP allowlist", () => {
    expect(parseOtlpMetricQueryType(undefined)).toBeNull();
    expect(parseOtlpMetricQueryType("histogram")).toBe("histogram");
    expect(() => parseOtlpMetricQueryType("timer")).toThrow("metric_type must be one of");
  });

  it("requires a metric name when selecting by metric type", async () => {
    const { client, executed } = fakeCatalogClient([]);
    await expect(queryOtlpMetrics({
      tenancy: { project: { id: "p" }, branchId: "b" },
      request: { metricType: "histogram" },
      client,
    })).rejects.toThrow("metric_type requires metric_name");
    expect(executed).toHaveLength(0);
  });

  it("scopes the targeted catalog-entry lookup by name and optionally type", () => {
    expect(buildOtlpMetricCatalogEntryQuery(false)).toContain("metric_name = {metricName:String}");
    expect(buildOtlpMetricCatalogEntryQuery(false)).not.toContain("{metricType:String}");
    expect(buildOtlpMetricCatalogEntryQuery(true)).toContain("metric_type = {metricType:String}");
    expect(buildOtlpMetricCatalogEntryQuery(true)).toContain("PREWHERE project_id = {projectId:String}");
  });

  it("selects the requested (name, type) pair instead of a same-name sibling type", async () => {
    const { client, executed } = fakeCatalogClient([
      { rows: [
        catalogRow({ metric_name: "checkout.duration", metric_type: "sum", point_count: 100 }),
        catalogRow({ metric_name: "checkout.duration", metric_type: "histogram", point_count: 5 }),
      ] },
      { rows: [] },
    ]);
    const response = await queryOtlpMetrics({
      tenancy: { project: { id: "p" }, branchId: "b" },
      request: { metricName: "checkout.duration", metricType: "histogram" },
      client,
    });
    expect(response.selected_metric_name).toBe("checkout.duration");
    expect(response.selected_metric_type).toBe("histogram");
    expect(executed[1].query_params).toMatchObject({ metricName: "checkout.duration", metricType: "histogram" });
  });

  it("resolves a named metric that fell below the bounded catalog and surfaces it in the response", async () => {
    const { client } = fakeCatalogClient([
      { rows: [catalogRow({ metric_name: "popular.metric", metric_type: "gauge", point_count: 100 })] },
      { expectQueryContains: "metric_name = {metricName:String}", rows: [catalogRow({ metric_name: "rare.metric", metric_type: "gauge", point_count: 1 })] },
      { rows: [] },
    ]);
    const response = await queryOtlpMetrics({
      tenancy: { project: { id: "p" }, branchId: "b" },
      request: { metricName: "rare.metric" },
      client,
    });
    expect(response.selected_metric_name).toBe("rare.metric");
    expect(response.catalog.map((entry) => entry.metric_name)).toEqual(["popular.metric", "rare.metric"]);
  });

  it("returns an empty series when the requested metric has no rows at all", async () => {
    const { client } = fakeCatalogClient([
      { rows: [] },
      { expectQueryContains: "metric_name = {metricName:String}", rows: [] },
    ]);
    const response = await queryOtlpMetrics({
      tenancy: { project: { id: "p" }, branchId: "b" },
      request: { metricName: "missing.metric" },
      client,
    });
    expect(response.selected_metric_name).toBeNull();
    expect(response.series).toEqual([]);
  });

  it("preserves large UInt64 timestamps serialized as strings", () => {
    const timestamp = "18446744073709551615";
    expect(parseOtlpMetricUint64(timestamp, "time_unix_nano")).toBe(timestamp);
    expect(() => parseOtlpMetricUint64(Number.MAX_SAFE_INTEGER + 1, "time_unix_nano")).toThrow("unsafe");
  });

  it("marks histogram and summary catalog entries as numerically aggregatable", () => {
    const catalog = parseOtlpMetricCatalogRows([
      {
        metric_name: "http.server.duration",
        metric_description: "Request duration",
        metric_unit: "ms",
        metric_type: "histogram",
        aggregation_temporality: 2,
        is_monotonic: 0,
        point_count: "3",
        latest_time_unix_nano: "1720000000000000000",
      },
      {
        metric_name: "queue.depth",
        metric_description: "Queue depth",
        metric_unit: "{items}",
        metric_type: "gauge",
        aggregation_temporality: 0,
        is_monotonic: 0,
        point_count: 4,
        latest_time_unix_nano: "1720000000000000001",
      },
    ]);

    expect(catalog.map((entry) => [entry.metric_type, entry.supports_numeric_aggregation])).toEqual([
      ["histogram", true],
      ["gauge", true],
    ]);
  });

  it("preserves exemplar identity and null numeric state in series rows", () => {
    expect(parseOtlpMetricSeriesRows([
      {
        bucket_start_unix_nano: "1720000000000000000",
        point_count: "2",
        numeric_value: null,
        minimum_value: null,
        maximum_value: null,
        exemplar_trace_id: "0123456789abcdef0123456789abcdef",
        exemplar_span_id: "0123456789abcdef",
      },
    ])).toEqual([
      {
        bucket_start_unix_nano: "1720000000000000000",
        point_count: 2,
        numeric_value: null,
        minimum_value: null,
        maximum_value: null,
        exemplar: {
          trace_id: "0123456789abcdef0123456789abcdef",
          span_id: "0123456789abcdef",
        },
      },
    ]);
  });
});

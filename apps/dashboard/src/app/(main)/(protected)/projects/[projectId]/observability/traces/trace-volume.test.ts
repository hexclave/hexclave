import { describe, expect, it } from "vitest";
import {
  getTraceVolumeQuery,
  parseTraceVolumeRows,
} from "./trace-volume";
import { getBucketGranularity } from "../bucket-granularity";

describe("trace volume", () => {
  it.each([
    { hours: 1, bucketCount: 60, historySql: "INTERVAL 59 MINUTE", stepSql: "INTERVAL 1 MINUTE" },
    { hours: 24, bucketCount: 24, historySql: "INTERVAL 23 HOUR", stepSql: "INTERVAL 1 HOUR" },
    { hours: 168, bucketCount: 28, historySql: "INTERVAL 162 HOUR", stepSql: "INTERVAL 6 HOUR" },
    { hours: 720, bucketCount: 30, historySql: "INTERVAL 29 DAY", stepSql: "INTERVAL 1 DAY" },
  ] as const)("uses the requested bucket grain for $hours hours", ({ hours, bucketCount, historySql, stepSql }) => {
    expect(getBucketGranularity(hours)).toMatchObject({
      bucketCount,
      stepSql,
    });
    const { query } = getTraceVolumeQuery(hours, null);
    expect(query).toContain(`toStartOfInterval(r.started_at, ${stepSql}) AS bucket_start`);
    expect(query).toContain(`STEP ${stepSql}`);
    expect(query).toContain(`range_end - ${historySql} AS range_start`);
    expect(query).toContain("WITH FILL");
  });

  it("counts only the same physical roots as the trace inbox", () => {
    const { query } = getTraceVolumeQuery(24, null);
    expect(query).toContain("FROM default.trace_roots AS r");
    expect(query).not.toContain("$http-client");
    expect(query).not.toContain("UNION ALL");
    expect(query).not.toContain("bridged-server");
    expect(query).not.toContain("bridge_root_rank");
    expect(query).toContain("count() AS trace_count");
  });

  it("applies the selected physical service to every trace in the aggregate", () => {
    const { query, params } = getTraceVolumeQuery(168, {
      namespace: "server",
      name: "stack-backend",
    });
    expect(query).toContain("FROM default.trace_services");
    expect(query).toContain("coalesce(service_namespace, '') = {serviceNamespace:String}");
    expect(query).toContain("service_name = {serviceName:String}");
    expect(params).toEqual({
      serviceNamespace: "server",
      serviceName: "stack-backend",
    });
  });

  it("parses numeric and serialized ClickHouse counts and rejects malformed buckets", () => {
    expect(parseTraceVolumeRows([
      { bucket_start: "2026-07-28 12:00:00.000", trace_count: 3 },
      { bucket_start: "2026-07-28 13:00:00.000", trace_count: "5" },
    ])).toEqual([
      { bucketMs: Date.UTC(2026, 6, 28, 12), count: 3 },
      { bucketMs: Date.UTC(2026, 6, 28, 13), count: 5 },
    ]);
    expect(() => parseTraceVolumeRows([
      { bucket_start: "not-a-date", trace_count: 2 },
    ])).toThrowError("Trace volume query returned an invalid bucket");
  });
});

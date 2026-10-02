import { describe, expect, it } from "vitest";
import {
  ATTENTION_THRESHOLDS,
  buildServiceTimelines,
  dependenciesForService,
  detectServiceAttention,
  getServiceBucketGranularity,
  getServiceDependenciesQuery,
  getServiceTimelineQuery,
  getServicesSummaryQuery,
  MAX_TIMELINE_SERVICES,
  parseServiceDependencyRow,
  parseServiceSummaryRow,
  rankServiceAttention,
  relativeChange,
  serviceErrorRate,
  type ServiceSummary,
  type ServiceTimeline,
} from "./services-data";

function summary(overrides: Partial<ServiceSummary> = {}): ServiceSummary {
  return {
    identity: { namespace: "checkout", name: "api" },
    spanCount: 1000,
    traceCount: 400,
    requestCount: 600,
    errorCount: 0,
    openSpanCount: 0,
    instanceCount: 3,
    p95DurationMs: 48,
    baselineRequestCount: 600,
    baselineErrorCount: 0,
    baselineP95DurationMs: 48,
    sampledSpanCount: 0,
    lastSeenAt: "2026-07-28 17:04:00.000",
    lastErrorAt: null,
    ...overrides,
  };
}

function timeline(errorCounts: readonly number[], requestCount = 100): ServiceTimeline {
  return {
    identity: { namespace: "checkout", name: "api" },
    buckets: errorCounts.map((errorCount, index) => ({
      bucketMs: index * 3_600_000,
      requestCount,
      errorCount,
    })),
  };
}

describe("services queries", () => {
  it("compares the selected window against the equally long window before it", () => {
    const { query, params } = getServicesSummaryQuery(24);

    expect(params).toEqual({ hours: 24 });
    expect(query).toContain("range_end - INTERVAL {hours:UInt32} HOUR AS range_start");
    expect(query).toContain("range_start - INTERVAL {hours:UInt32} HOUR AS baseline_start");
    expect(query).toContain("WHERE started_at >= baseline_start");
    expect(query).toContain("AS baseline_request_count");
    expect(query).toContain("AS baseline_error_count");
    expect(query).toContain("AS baseline_p95_duration_ms");
    expect(query).toContain("AS last_error_at");
    expect(query).toContain("countIf(producer = 'hexclave-backend' AND started_at >= range_start) AS sampled_span_count");
    expect(query).toContain("GROUP BY service_namespace, service_name");
  });

  it("buckets the timeline query and bounds its fan-out", () => {
    const { query, params } = getServiceTimelineQuery(24);

    expect(params).toEqual({ hours: 24 });
    expect(query).toContain("toStartOfInterval(now64(3), INTERVAL 1 HOUR) AS current_bucket_start");
    expect(query).toContain("current_bucket_start - INTERVAL 23 HOUR AS range_start");
    expect(query).toContain(`LIMIT ${MAX_TIMELINE_SERVICES}`);
    expect(query).toContain("GROUP BY service_namespace, service_name, bucket_start");
  });

  it("derives every dependency edge from one scalar parent/child join, and bounds it", () => {
    const { query, params } = getServiceDependenciesQuery(24);

    expect(params).toEqual({ hours: 24 });
    expect(query).toContain("child.trace_id = parent.trace_id");
    expect(query).toContain("child.parent_span_id = parent.span_id");
    expect(query).toContain("AND parent_span_id IS NOT NULL");
    expect(query).toContain("LIMIT 500");
    expect(query).not.toContain("bridged_edges");
    expect(query).not.toContain("UNION ALL");
    expect(query).not.toContain("startsWith(");
    expect(query).not.toContain("parent_span_ids");
  });

  it("keeps payload columns off the parent side of the dependency join", () => {
    const { query } = getServiceDependenciesQuery(24);
    const parentProjection = query.match(/parent_spans AS \(\n([\s\S]*?)\n\),\ndependency_edges/)?.[1];

    expect(query).toContain("now64(3) - INTERVAL {hours:UInt32} HOUR AS range_start");
    expect(query).toContain("FROM default.trace_services");
    expect(query).toContain("HAVING count() > 1");
    expect(query.match(/WHERE trace_id IN multi_service_traces/g)).toHaveLength(2);
    expect(parentProjection).toBeDefined();
    expect(parentProjection).toContain("trace_id");
    expect(parentProjection).toContain("span_id");
    expect(parentProjection).not.toContain("data");
    expect(parentProjection).not.toContain("status_code");
    expect(parentProjection).not.toContain("started_at,");
    expect(query).not.toContain("recent_spans");
  });

  it("uses the same error definition in every query so the panels cannot disagree", () => {
    const errorSql = "JSONExtractUInt(data, 'http.response.status_code') >= 500";
    expect(getServicesSummaryQuery(24).query).toContain(errorSql);
    expect(getServiceTimelineQuery(24).query).toContain(errorSql);
    expect(getServiceDependenciesQuery(24).query)
      .toContain("JSONExtractUInt(edge_data, 'http.response.status_code') >= 500");
  });

  it("rejects time ranges that are not offered by the UI", () => {
    expect(() => getServicesSummaryQuery(12)).toThrowError("Unsupported services time range: 12");
    expect(() => getServiceTimelineQuery(12)).toThrowError("Unsupported services time range: 12");
    expect(() => getServiceDependenciesQuery(12)).toThrowError("Unsupported services time range: 12");
  });

  it("keeps every bucket grid dense enough to show shape but coarse enough to stay readable", () => {
    for (const hours of [1, 24, 168, 720] as const) {
      const granularity = getServiceBucketGranularity(hours);
      expect(granularity.bucketCount).toBeGreaterThanOrEqual(24);
      expect(granularity.bucketCount).toBeLessThanOrEqual(60);
      expect(86_400_000 % granularity.stepMs === 0 || granularity.stepMs % 86_400_000 === 0).toBe(true);
    }
  });
});

describe("parseServiceSummaryRow", () => {
  it("parses a full row including its baseline columns", () => {
    const parsed = parseServiceSummaryRow({
      service_namespace: "checkout",
      service_name: "api",
      span_count: 1000,
      trace_count: 400,
      request_count: 600,
      error_count: 12,
      open_span_count: 2,
      instance_count: 3,
      p95_duration_ms: 48.2,
      baseline_request_count: 550,
      baseline_error_count: 4,
      baseline_p95_duration_ms: 42,
      sampled_span_count: 0,
      last_seen_at: "2026-07-28 17:04:00.000",
      last_error_at: "2026-07-28 17:01:00.000",
    });

    expect(parsed.identity).toEqual({ namespace: "checkout", name: "api" });
    expect(parsed.baselineErrorCount).toBe(4);
    expect(parsed.lastErrorAt).toBe("2026-07-28 17:01:00.000");
  });

  it("refuses rows that are missing a metric rather than defaulting it to zero", () => {
    expect(() => parseServiceSummaryRow({
      service_namespace: "checkout",
      service_name: "api",
      span_count: 1000,
      trace_count: 400,
      request_count: 600,
      error_count: 12,
      open_span_count: 2,
      instance_count: 3,
      p95_duration_ms: null,
      baseline_request_count: 550,
      baseline_error_count: 4,
      baseline_p95_duration_ms: null,
      last_seen_at: "2026-07-28 17:04:00.000",
      last_error_at: null,
    })).toThrowError("Analytics sampled_span_count must be a finite number");
  });
});

describe("serviceErrorRate", () => {
  it("reports a rate for services whose spans are all retained", () => {
    expect(serviceErrorRate(summary({ requestCount: 200, errorCount: 10 }))).toBeCloseTo(0.05);
  });

  it("hides the rate when any span came from head-sampled backend traces", () => {
    expect(serviceErrorRate(summary({ requestCount: 200, errorCount: 10, sampledSpanCount: 1 }))).toBeNull();
  });

  it("has no rate to report without requests", () => {
    expect(serviceErrorRate(summary({ requestCount: 0, errorCount: 0 }))).toBeNull();
  });
});

describe("relativeChange", () => {
  it("returns a signed ratio against a real baseline", () => {
    expect(relativeChange(150, 100)).toBeCloseTo(0.5);
    expect(relativeChange(50, 100)).toBeCloseTo(-0.5);
  });

  it("returns null rather than a fake +100% when nothing existed before", () => {
    expect(relativeChange(150, 0)).toBeNull();
  });
});

describe("buildServiceTimelines", () => {
  const nowMs = Date.UTC(2026, 6, 28, 17, 30);

  it("fills gaps so a silent tail still occupies the end of the series", () => {
    const timelines = buildServiceTimelines([
      {
        service_namespace: "checkout",
        service_name: "api",
        bucket_start: "2026-07-28 09:00:00.000",
        request_count: 40,
        error_count: 2,
      },
    ], 24, nowMs);

    const built = timelines.get("checkout/api");
    if (built == null) throw new Error("expected a timeline for checkout/api");
    expect(built.buckets).toHaveLength(24);
    expect(built.buckets[0].bucketMs).toBe(Date.UTC(2026, 6, 27, 18));
    expect(built.buckets.at(-1)).toEqual({ bucketMs: Date.UTC(2026, 6, 28, 17), requestCount: 0, errorCount: 0 });
    expect(built.buckets[15]).toEqual({ bucketMs: Date.UTC(2026, 6, 28, 9), requestCount: 40, errorCount: 2 });
  });

  it("drops rows outside the reconstructed grid instead of misplacing them", () => {
    const timelines = buildServiceTimelines([
      {
        service_namespace: "checkout",
        service_name: "api",
        bucket_start: "2026-07-20 09:00:00.000",
        request_count: 40,
        error_count: 2,
      },
    ], 24, nowMs);

    expect(timelines.size).toBe(0);
  });

  it("keeps services apart", () => {
    const timelines = buildServiceTimelines([
      {
        service_namespace: "checkout",
        service_name: "api",
        bucket_start: "2026-07-28 17:00:00.000",
        request_count: 10,
        error_count: 0,
      },
      {
        service_namespace: "",
        service_name: "worker",
        bucket_start: "2026-07-28 17:00:00.000",
        request_count: 5,
        error_count: 1,
      },
    ], 24, nowMs);

    expect([...timelines.keys()].sort()).toEqual(["checkout/api", "worker"]);
  });
});

describe("detectServiceAttention", () => {
  it("stays quiet for a service that is merely, persistently imperfect", () => {
    const steady = summary({ errorCount: 40, baselineErrorCount: 38, lastErrorAt: "2026-07-28 17:00:00.000" });
    expect(detectServiceAttention(steady, timeline(Array(24).fill(2)))).toBeNull();
  });

  it("flags a burst in the newest bucket even when the window total looks normal", () => {
    const buckets = [...Array(23).fill(1), 20];
    const signal = detectServiceAttention(
      summary({ errorCount: 43, baselineErrorCount: 40, lastErrorAt: "2026-07-28 17:00:00.000" }),
      timeline(buckets),
    );

    if (signal == null) throw new Error("expected a burst signal");
    expect(signal.reasons).toContain("error-burst");
    expect(signal.latestBucketErrorCount).toBe(20);
  });

  it("does not call a handful of errors a burst", () => {
    const buckets = [...Array(23).fill(0), ATTENTION_THRESHOLDS.minBurstErrors - 1];
    expect(detectServiceAttention(summary({ errorCount: 2 }), timeline(buckets))).toBeNull();
  });

  it("flags errors that did not exist in the previous window", () => {
    const signal = detectServiceAttention(
      summary({ errorCount: 9, baselineErrorCount: 0, lastErrorAt: "2026-07-28 17:00:00.000" }),
      null,
    );

    if (signal == null) throw new Error("expected a new-errors signal");
    expect(signal.reasons).toEqual(["new-errors"]);
  });

  it("flags a window-over-window error spike", () => {
    const signal = detectServiceAttention(
      summary({ errorCount: 30, baselineErrorCount: 5, lastErrorAt: "2026-07-28 17:00:00.000" }),
      null,
    );

    if (signal == null) throw new Error("expected an error-spike signal");
    expect(signal.reasons).toEqual(["error-spike"]);
  });

  it("requires latency to regress both proportionally and absolutely", () => {
    expect(detectServiceAttention(summary({ p95DurationMs: 6, baselineP95DurationMs: 3 }), null)).toBeNull();

    const signal = detectServiceAttention(summary({ p95DurationMs: 400, baselineP95DurationMs: 120 }), null);
    if (signal == null) throw new Error("expected a latency-regression signal");
    expect(signal.reasons).toEqual(["latency-regression"]);
  });

  it("flags a service that stopped serving traffic it used to serve", () => {
    const signal = detectServiceAttention(
      summary({ requestCount: 0, baselineRequestCount: 500, p95DurationMs: null }),
      null,
    );

    if (signal == null) throw new Error("expected a went-silent signal");
    expect(signal.reasons).toEqual(["went-silent"]);
  });

  it("does not call a barely-used service silent", () => {
    expect(detectServiceAttention(
      summary({
        requestCount: 0,
        baselineRequestCount: ATTENTION_THRESHOLDS.minSilentBaselineRequests - 1,
        p95DurationMs: null,
      }),
      null,
    )).toBeNull();
  });
});

describe("rankServiceAttention", () => {
  it("returns only flagged services, worst first", () => {
    const bursting = summary({
      identity: { namespace: "checkout", name: "api" },
      errorCount: 43,
      baselineErrorCount: 40,
      lastErrorAt: "2026-07-28 17:00:00.000",
    });
    const slow = summary({
      identity: { namespace: "", name: "worker" },
      p95DurationMs: 400,
      baselineP95DurationMs: 120,
    });
    const fine = summary({ identity: { namespace: "", name: "cron" } });

    const ranked = rankServiceAttention([fine, slow, bursting], new Map([
      ["checkout/api", timeline([...Array(23).fill(1), 20])],
    ]));

    expect(ranked.map((signal) => signal.identity.name)).toEqual(["api", "worker"]);
  });
});

describe("dependenciesForService", () => {
  it("splits incoming and outgoing dependencies for an exact service identity", () => {
    const incoming = parseServiceDependencyRow({
      source_service_namespace: "web",
      source_service_name: "dashboard",
      target_service_namespace: "core",
      target_service_name: "api",
      call_count: 120,
      error_count: 2,
      p95_duration_ms: 82,
    });
    const outgoing = parseServiceDependencyRow({
      source_service_namespace: "core",
      source_service_name: "api",
      target_service_namespace: "data",
      target_service_name: "postgres",
      call_count: 90,
      error_count: 0,
      p95_duration_ms: null,
    });

    expect(dependenciesForService([incoming, outgoing], { namespace: "core", name: "api" })).toEqual({
      incoming: [incoming],
      outgoing: [outgoing],
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";

// The data module reaches the backend through the admin app's internals
// symbol, so the test injects a fake `sendRequest` through that same seam
// instead of mocking the module. The real `sendInternalAdminRequest` runs,
// which also pins the "admin" request type in the call assertions.
const sendRequestMock = vi.fn();
const adminApp = { [hexclaveAppInternalsSymbol]: { sendRequest: sendRequestMock } };

import {
  buildPerformanceTimeline,
  fetchPerformanceMetrics,
  fetchWebVitals,
  getPerformanceMetricChartDomain,
  getPerformanceBehaviorQuery,
  getPerformancePagesQuery,
  getPerformanceTimelineQuery,
  getPerformanceVitalsOverviewQuery,
  mergePagePerformance,
  MIN_FRICTION_CLICKS,
  MIN_SHALLOW_VIEWS,
  MIN_VITAL_INSIGHT_SAMPLES,
  parsePerformanceMetricResponse,
  parsePerformancePageRow,
  parsePerformanceVitalsOverviewRow,
  rankPageInsights,
  selectAvailableTimelineMetric,
  sortPerformancePages,
  sumPageBehavior,
  webVitalRating,
  WEB_VITAL_METRICS,
  type PagePerformance,
} from "./performance-data";

function responseBody() {
  return {
    window: {
      start_time_unix_nano: "1720000000000000000",
      end_time_unix_nano: "1720003600000000000",
      hours: 1,
    },
    catalog: [{
      metric_name: "queue.depth",
      metric_description: "Queue depth",
      metric_unit: "{items}",
      metric_type: "gauge",
      aggregation_temporality: 0,
      is_monotonic: false,
      point_count: 2,
      latest_time_unix_nano: "1720003599000000000",
      supports_numeric_aggregation: true,
    }],
    selected_metric_name: "queue.depth",
    selected_metric_type: "gauge",
    series: [{
      bucket_start_unix_nano: "1720003500000000000",
      point_count: 2,
      numeric_value: 4.5,
      minimum_value: 3,
      maximum_value: 6,
      exemplar: {
        trace_id: "0123456789abcdef0123456789abcdef",
        span_id: "0123456789abcdef",
      },
    }],
    partial: {
      has_unsupported_metric_types: false,
      unsupported_metric_types: [],
    },
  };
}

describe("performance metrics data contract", () => {
  it("parses the native metric read model and preserves exemplars", () => {
    const parsed = parsePerformanceMetricResponse(responseBody());
    expect(parsed.catalog[0]?.supports_numeric_aggregation).toBe(true);
    expect(parsed.series[0]?.numeric_value).toBe(4.5);
    expect(parsed.series[0]?.exemplar?.trace_id).toBe("0123456789abcdef0123456789abcdef");
  });

  it("rejects malformed or unsupported response state instead of silently defaulting", () => {
    expect(() => parsePerformanceMetricResponse({ ...responseBody(), catalog: "not-an-array" })).toThrow("catalog must be an array");
    expect(() => parsePerformanceMetricResponse({ ...responseBody(), window: { ...responseBody().window, hours: 2 } })).toThrow("unsupported time range");
    expect(() => parsePerformanceMetricResponse({
      ...responseBody(),
      catalog: [{ ...responseBody().catalog[0], metric_type: "unknown" }],
    })).toThrow("unknown metric type");
  });

  it("uses the typed admin route and sends no arbitrary SQL", async () => {
    sendRequestMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(responseBody()), { status: 200 })));
    const result = await fetchPerformanceMetrics(adminApp, { hours: 1, metricName: "queue.depth", metricType: "gauge" });

    expect(result.selected_metric_name).toBe("queue.depth");
    expect(sendRequestMock).toHaveBeenCalledWith("/internal/analytics/metrics", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ hours: 1, metric_name: "queue.depth", metric_type: "gauge" }),
    }), "admin");
  });

  it("resolves by name only when no metric type is selected", async () => {
    sendRequestMock.mockClear();
    sendRequestMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(responseBody()), { status: 200 })));
    await fetchPerformanceMetrics(adminApp, { hours: 1, metricName: "queue.depth", metricType: null });

    expect(sendRequestMock).toHaveBeenCalledWith("/internal/analytics/metrics", expect.objectContaining({
      body: JSON.stringify({ hours: 1, metric_name: "queue.depth" }),
    }), "admin");
  });

  it("loads each browser metric stream in parallel for the overview cards", async () => {
    sendRequestMock.mockClear();
    sendRequestMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(responseBody()), { status: 200 })));

    const result = await fetchWebVitals(adminApp, 1);

    expect(result.size).toBe(WEB_VITAL_METRICS.length);
    expect(sendRequestMock).toHaveBeenCalledTimes(WEB_VITAL_METRICS.length);
    expect(sendRequestMock.mock.calls.map((call) => JSON.parse(call[1].body).metric_name)).toEqual(
      WEB_VITAL_METRICS.map((metric) => metric.metricName),
    );
  });

  it("keeps a flat numeric stream centered in a non-zero chart domain", () => {
    const [minimum, maximum] = getPerformanceMetricChartDomain([0.02, 0.02, 0.02], false);
    expect(minimum).toBeCloseTo(0.018);
    expect(maximum).toBeCloseTo(0.022);
    expect(getPerformanceMetricChartDomain([4, 4], true)).toEqual([0, 4.4]);
  });
});
function page(overrides: Partial<PagePerformance> = {}): PagePerformance {
  return {
    path: "/pricing",
    views: 40,
    users: 20,
    softNavViews: 10,
    lcpP75: 1800,
    lcpSamples: 20,
    inpP75: 90,
    inpSamples: 20,
    clsP75: 0.04,
    clsSamples: 20,
    avgTimeOnPageMs: 20_000,
    avgScrollRatio: 0.6,
    clicks: 30,
    rageClicks: 0,
    deadClicks: 0,
    formSubmits: 0,
    outboundClicks: 0,
    ...overrides,
  };
}

describe("performance page-view queries", () => {
  it("reads p75 and rating buckets from $page-view spans, not native metric averages", () => {
    const { query, params } = getPerformanceVitalsOverviewQuery(24);

    expect(params).toEqual({ hours: 24 });
    expect(query).toContain("/* performance:vitals-overview */");
    expect(query).toContain("FROM default.spans");
    expect(query).toContain("span_type = '$page-view'");
    expect(query).toContain("quantileTDigestIf(0.75)");
    expect(query).toContain("lcp_ms IS NOT NULL AND soft_nav != 1");
    expect(query).toContain("lcp_ms <= 2500");
    expect(query).toContain("viewport_width < 768");
    expect(query).not.toContain("hexclave.web.vitals.lcp");
  });

  it("groups pages by path and keeps hard-load LCP out of soft-nav rows", () => {
    const { query } = getPerformancePagesQuery(24);

    expect(query).toContain("GROUP BY path");
    expect(query).toContain("JSONExtractString(data, 'path') AS path");
    expect(query).toContain("scroll_depth_ratio");
    expect(query).toContain("dateDiff('millisecond', started_at, ended_at)");
    expect(query).toContain("lcp_ms IS NOT NULL AND soft_nav != 1");
  });

  it("aggregates rage, dead, and form events by path from default.events", () => {
    const { query } = getPerformanceBehaviorQuery(24);

    expect(query).toContain("FROM default.events");
    expect(query).toContain("JSONExtractString(toString(data), 'path')");
    expect(query).toContain("JSONExtractUInt(toString(data), 'rage') = 1");
    expect(query).toContain("JSONExtractUInt(toString(data), 'dead') = 1");
    expect(query).toContain("event_type = '$form-submit'");
  });

  it("buckets the timeline onto the shared observability grid", () => {
    const { query } = getPerformanceTimelineQuery(24);

    expect(query).toContain("toStartOfInterval(now64(3), INTERVAL 1 HOUR)");
    expect(query).toContain("INTERVAL 23 HOUR");
    expect(query).toContain("GROUP BY bucket_start");
  });

  it("rejects unsupported time ranges instead of substituting a default", () => {
    expect(() => getPerformanceVitalsOverviewQuery(2)).toThrow("Unsupported performance time range");
  });
});
describe("performance page-view parsers and ranking", () => {
  it("parses a vitals overview row including null p75s when a stream has no samples", () => {
    const parsed = parsePerformanceVitalsOverviewRow({
      page_views: 12,
      users: "4",
      soft_nav_views: 3,
      avg_time_on_page_ms: 1500,
      avg_scroll_ratio: 0.4,
      lcp_samples: 0,
      lcp_p75: null,
      lcp_good: 0,
      lcp_needs_work: 0,
      lcp_poor: 0,
      lcp_p75_mobile: null,
      lcp_p75_desktop: null,
      fcp_samples: 0,
      fcp_p75: "nan",
      fcp_good: 0,
      fcp_needs_work: 0,
      fcp_poor: 0,
      ttfb_samples: 0,
      ttfb_p75: null,
      ttfb_good: 0,
      ttfb_needs_work: 0,
      ttfb_poor: 0,
      inp_samples: 8,
      inp_p75: 140,
      inp_good: 6,
      inp_needs_work: 2,
      inp_poor: 0,
      cls_samples: 8,
      cls_p75: 0.08,
      cls_good: 8,
      cls_needs_work: 0,
      cls_poor: 0,
      fps_samples: 0,
      fps_p75: null,
      fps_good: 0,
      fps_needs_work: 0,
      fps_poor: 0,
    });

    expect(parsed.pageViews).toBe(12);
    expect(parsed.users).toBe(4);
    expect(parsed.lcp.p75).toBeNull();
    expect(parsed.fcp.p75).toBeNull();
    expect(parsed.inp.p75).toBe(140);
    expect(parsed.inp.good).toBe(6);
  });

  it("merges behavior onto pages by path and defaults missing paths to zero", () => {
    const pages = mergePagePerformance(
      [parsePerformancePageRow({
        path: "/checkout",
        views: 10,
        users: 4,
        soft_nav_views: 2,
        lcp_samples: 8,
        lcp_p75: 4100,
        inp_samples: 8,
        inp_p75: 90,
        cls_samples: 8,
        cls_p75: 0.02,
        avg_time_on_page_ms: 12_000,
        avg_scroll_ratio: 0.5,
      })],
      [{
        path: "/other",
        clicks: 9,
        rageClicks: 2,
        deadClicks: 1,
        formSubmits: 0,
        outboundClicks: 0,
      }],
    );

    expect(pages).toHaveLength(1);
    expect(pages[0]?.path).toBe("/checkout");
    expect(pages[0]?.rageClicks).toBe(0);
    expect(sumPageBehavior(pages).clicks).toBe(0);
  });

  it("fills timeline gaps so a silent tail still occupies the chart", () => {
    const buckets = buildPerformanceTimeline(
      [{ bucket_start: "2026-08-12 10:00:00.000", views: 4, lcp_p75: 1800, inp_p75: 90 }],
      24,
      Date.parse("2026-08-12T12:30:00.000Z"),
    );

    expect(buckets).toHaveLength(24);
    const filled = buckets.filter((bucket) => bucket.views > 0);
    expect(filled).toHaveLength(1);
    expect(filled[0]?.lcpP75).toBe(1800);
    expect(buckets[0]?.views).toBe(0);
  });

  it("rates p75 against Core Web Vital thresholds, not a mean", () => {
    const lcp = WEB_VITAL_METRICS.find((metric) => metric.key === "lcp");
    if (lcp == null) throw new Error("LCP metric is missing from WEB_VITAL_METRICS");
    expect(webVitalRating(lcp, 2400).label).toBe("Good");
    expect(webVitalRating(lcp, 3000).label).toBe("Needs work");
    expect(webVitalRating(lcp, 5000).label).toBe("Poor");
    expect(webVitalRating(lcp, null).label).toBe("No data");
  });

  it("sorts SPA-only pages by INP when LCP has no samples", () => {
    const sorted = sortPerformancePages([
      page({ path: "/popular", views: 100, lcpP75: null, lcpSamples: 0, inpP75: null, inpSamples: 0 }),
      page({ path: "/responsive", views: 20, lcpP75: null, lcpSamples: 0, inpP75: 80, inpSamples: 10 }),
      page({ path: "/laggy", views: 5, lcpP75: null, lcpSamples: 0, inpP75: 600, inpSamples: 10 }),
    ], "slowest");

    expect(sorted.map((entry) => entry.path)).toEqual(["/laggy", "/responsive", "/popular"]);
  });

  it("opens the timeline on the populated metric when the preferred series is empty", () => {
    expect(selectAvailableTimelineMetric([
      { bucketMs: 1, views: 2, lcpP75: null, inpP75: 120 },
    ], "lcp")).toBe("inp");
    expect(selectAvailableTimelineMetric([
      { bucketMs: 1, views: 2, lcpP75: 1800, inpP75: 120 },
    ], "lcp")).toBe("lcp");
  });

  it("surfaces at most one insight per kind and ignores undersampled slow pages", () => {
    const insights = rankPageInsights([
      page({ path: "/thin", lcpP75: 8000, lcpSamples: MIN_VITAL_INSIGHT_SAMPLES - 1 }),
      page({ path: "/slow", lcpP75: 5200, lcpSamples: MIN_VITAL_INSIGHT_SAMPLES, views: 50 }),
      page({ path: "/rage", rageClicks: 9, clicks: 40 }),
      page({
        path: "/dead",
        clicks: MIN_FRICTION_CLICKS,
        deadClicks: 4,
      }),
      page({
        path: "/bounce",
        views: MIN_SHALLOW_VIEWS,
        avgScrollRatio: 0.1,
        avgTimeOnPageMs: 3000,
      }),
    ]);

    expect(insights.map((insight) => insight.kind)).toEqual(["slow-lcp", "rage", "dead-clicks"]);
    expect(insights.find((insight) => insight.kind === "slow-lcp")?.page.path).toBe("/slow");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildAnalyticsOverviewUserAgentFilterFragmentsForTest,
  getAnalyticsOverviewTelemetrySqlForTest,
  getMetricsWindowBounds,
  isMetricsRevenueInvoiceStatus,
  normalizeAnalyticsOverviewFilters,
  reconcileAnalyticsVisitorCount,
} from "./route";

describe("internal metrics helpers", () => {
  it("only counts paid and succeeded invoices as revenue", () => {
    expect(isMetricsRevenueInvoiceStatus("paid")).toBe(true);
    expect(isMetricsRevenueInvoiceStatus("succeeded")).toBe(true);
    expect(isMetricsRevenueInvoiceStatus("failed")).toBe(false);
    expect(isMetricsRevenueInvoiceStatus("uncollectible")).toBe(false);
    expect(isMetricsRevenueInvoiceStatus(null)).toBe(false);
  });

  it("derives a single UTC-aligned rolling window from one clock", () => {
    const { todayUtc, since, untilExclusive } = getMetricsWindowBounds(new Date("2026-04-13T23:59:59.999Z"));

    expect(todayUtc.toISOString()).toBe("2026-04-13T00:00:00.000Z");
    expect(since.toISOString()).toBe("2026-03-14T00:00:00.000Z");
    expect(untilExclusive.toISOString()).toBe("2026-04-14T00:00:00.000Z");
  });

  it("normalizes analytics overview filters before adding them to ClickHouse params", () => {
    expect(normalizeAnalyticsOverviewFilters({
      country_code: " us ",
      referrer: " https://example.com ",
      browser: "",
      os: " macOS ",
      device: " Desktop ",
      since: " 2026-06-01T00:00:00.000Z ",
      until: "",
    })).toMatchInlineSnapshot(`
      {
        "browser": undefined,
        "country_code": "US",
        "device": "Desktop",
        "os": "macOS",
        "referrer": "https://example.com",
        "since": "2026-06-01T00:00:00.000Z",
        "until": undefined,
      }
    `);
  });

  it("builds deterministic user-agent filter fragments without a raw user-agent allowlist", () => {
    expect(buildAnalyticsOverviewUserAgentFilterFragmentsForTest({
      browser: "Chrome",
      os: "macOS",
      device: "Desktop",
    })).toMatchInlineSnapshot(`
      {
        "hasBrowserFilter": true,
        "hasDeviceFilter": true,
        "hasOsFilter": true,
        "params": {
          "browserFilter": "Chrome",
          "deviceFilter": "Desktop",
          "osFilter": "macOS",
        },
        "usesRawUserAgentAllowlist": false,
      }
    `);
  });

  it("reads page views through the time-ordered public store", () => {
    const sql = getAnalyticsOverviewTelemetrySqlForTest();

    expect(sql).toContain("event_type = '$click'");
    expect(sql).toContain("CAST('$page-view'");
    expect(sql).toContain("FROM analytics_internal.events");
    expect(sql).toContain("FROM default.page_views");
    expect(sql).not.toContain("FROM analytics_internal.spans");
    expect(sql).toContain("WHERE project_id = {projectId:String}");
    expect(sql).toContain("AND branch_id = {branchId:String}");
    expect(sql).toContain("AND started_at >= {since:DateTime}");
    expect(sql).toContain("AND started_at < {untilExclusive:DateTime}");
  });

  it("uses the same reconciled visitor count for display and per-visitor revenue", () => {
    expect(reconcileAnalyticsVisitorCount(12, 20)).toBe(20);
    expect(reconcileAnalyticsVisitorCount(25, 20)).toBe(25);
  });
});

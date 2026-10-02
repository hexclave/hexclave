import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { ALL_APPS_FRONTEND } from "@/lib/apps-frontend";
import {
  DEFAULT_LOG_TIME_RANGE_HOURS,
  getLogsQuery,
  LOG_LEVELS,
  LOG_SERVICES_QUERY,
  selectValueToLogLevel,
} from "./page-client";
import { OBSERVABILITY_TIME_RANGES } from "../filters";
import {
  selectValueToServiceIdentity,
  serviceIdentityToSelectValue,
} from "../service-identity";

describe("observability logs page", () => {
  it("reads the dedicated logs view with a scan-bounding time range", () => {
    const { query } = getLogsQuery(DEFAULT_LOG_TIME_RANGE_HOURS);
    expect(query).toContain("FROM default.logs");
    expect(query).not.toContain("event_type");
    expect(query).toContain("event_at >= now64(3) - INTERVAL 720 HOUR");
    expect(query).toContain("JSONExtractString(toString(e.body), 'value')");
    expect(query).toContain("e.level");
    expect(query).toContain("lowerUTF8(e.severity_text)");
    expect(query).toContain("e.service_namespace");
    expect(query).toContain("e.service_name");
    expect(query).toContain("e.deployment_environment_name");
    expect(query).toContain("e.user_id");
    expect(query).toContain("e.data");
    expect(query).toContain("e.trace_id");
    expect(query).toContain("e.span_id");
    expect(query).toContain("e.session_replay_id");
    expect(query).not.toContain("source");
    expect(query).toContain("AS message");
    expect(query).toContain("severity_text");
    expect(query).not.toContain("scope_");
    expect(query).not.toContain("resource_");
  });

  it("resolves user display info in the same query like the traces list does", () => {
    const { query } = getLogsQuery(DEFAULT_LOG_TIME_RANGE_HOURS);
    expect(query).toContain("LEFT JOIN default.users AS u");
    expect(query).toContain("u.display_name AS user_display_name");
    expect(query).toContain("u.primary_email AS user_primary_email");
  });

  it("filters by level only through the fixed level set", () => {
    for (const level of LOG_LEVELS) {
      expect(getLogsQuery(DEFAULT_LOG_TIME_RANGE_HOURS, level).query).toContain(`= '${level}'`);
    }
    expect(getLogsQuery(DEFAULT_LOG_TIME_RANGE_HOURS, null).query).not.toContain("= 'error'");
  });

  it("filters by service through a bound ClickHouse parameter", () => {
    const filtered = getLogsQuery(DEFAULT_LOG_TIME_RANGE_HOURS, null, {
      namespace: "server",
      name: "stack-backend",
    });
    expect(filtered.query).toContain("coalesce(e.service_namespace, '') = {serviceNamespace:String}");
    expect(filtered.query).toContain("e.service_name = {serviceName:String}");
    expect(filtered.query).not.toContain("stack-backend");
    expect(filtered.params).toEqual({
      serviceNamespace: "server",
      serviceName: "stack-backend",
    });

    const unfiltered = getLogsQuery(DEFAULT_LOG_TIME_RANGE_HOURS);
    expect(unfiltered.query).not.toContain("{serviceName:String}");
    expect(unfiltered.params).toEqual({});
  });

  it("lists distinct services from the logs view for the filter dropdown", () => {
    expect(LOG_SERVICES_QUERY).toContain("FROM default.logs");
    expect(LOG_SERVICES_QUERY).not.toContain("event_type");
    expect(LOG_SERVICES_QUERY).toContain("service_name IS NOT NULL");
    expect(LOG_SERVICES_QUERY).toContain("service_name != ''");
    expect(LOG_SERVICES_QUERY).toContain("GROUP BY service_namespace, service_name");
  });

  it("round-trips the level filter select values", () => {
    expect(selectValueToLogLevel("all")).toBeNull();
    expect(selectValueToLogLevel("warn")).toBe("warn");
    expect(selectValueToLogLevel("error")).toBe("error");
    expect(() => selectValueToLogLevel("fatal")).toThrow("Unexpected log level select value: fatal");
  });

  it("round-trips the service filter select values", () => {
    const identity = { namespace: "server", name: "stack-backend" };
    const value = serviceIdentityToSelectValue(identity);
    expect(serviceIdentityToSelectValue(null)).toBe("all");
    expect(selectValueToServiceIdentity("all")).toBeNull();
    expect(selectValueToServiceIdentity(value)).toEqual(identity);
  });

  it("defaults to the widest range so the control only ever narrows the scan", () => {
    expect(DEFAULT_LOG_TIME_RANGE_HOURS).toBe(Math.max(...OBSERVABILITY_TIME_RANGES.map((range) => range.hours)));
  });

  it("bounds every selectable range and rejects hours outside the fixed set", () => {
    for (const range of OBSERVABILITY_TIME_RANGES) {
      expect(getLogsQuery(range.hours).query).toContain(`event_at >= now64(3) - INTERVAL ${range.hours} HOUR`);
    }
    expect(() => getLogsQuery(12)).toThrow("Unknown logs time range: 12");
  });

  it("is reachable from the Observability app only", () => {
    expect(ALL_APPS_FRONTEND.analytics.navigationItems).not.toContainEqual({
      displayName: "Logs",
      href: "./logs",
    });
    expect(ALL_APPS_FRONTEND.observability.navigationItems).toContainEqual({
      displayName: "Logs",
      href: "./logs",
    });
  });
});

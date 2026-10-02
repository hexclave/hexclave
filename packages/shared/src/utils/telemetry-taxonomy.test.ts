import { describe, expect, it } from "vitest";
import {
  CLIENT_SYSTEM_SPAN_TYPES,
  SYSTEM_EVENT_TYPES,
  SYSTEM_SIGNALS,
  canWriteTelemetrySignal,
  classifyTelemetrySignal,
} from "./analytics-wire";

describe("telemetry taxonomy", () => {
  it("classifies product and code signals by product ownership", () => {
    expect(classifyTelemetrySignal("$click", "event")).toMatchObject({ kind: "event", lens: "analytics" });
    expect(classifyTelemetrySignal("checkout.completed", "event")).toMatchObject({ kind: "event", lens: "analytics" });
    expect(classifyTelemetrySignal("$page-view", "span")).toMatchObject({ kind: "span", lens: "analytics" });
    expect(classifyTelemetrySignal("$log", "event")).toMatchObject({ kind: "log", lens: "observability" });
    expect(classifyTelemetrySignal("$error", "event")).toMatchObject({ kind: "error", lens: "observability" });
    expect(classifyTelemetrySignal("db.query", "span", "server")).toMatchObject({
      kind: "span",
      lens: "observability",
      origin: "server",
      billingItem: "analytics_spans",
    });
    expect(classifyTelemetrySignal("checkout.completed", "event").billingItem).toBe("analytics_events");
  });

  it("describes every accepted system wire signal exactly once per wire kind", () => {
    const expectedCount = SYSTEM_EVENT_TYPES.length + CLIENT_SYSTEM_SPAN_TYPES.length;
    expect(SYSTEM_SIGNALS.size).toBe(expectedCount);

    for (const type of SYSTEM_EVENT_TYPES) expect(SYSTEM_SIGNALS.has(`event:${type}`)).toBe(true);
    for (const type of CLIENT_SYSTEM_SPAN_TYPES) {
      expect(SYSTEM_SIGNALS.has(`span:${type}`)).toBe(true);
    }
  });

  it("declares client and server write permissions for every wire signal", () => {
    for (const descriptor of SYSTEM_SIGNALS.values()) {
      expect(descriptor.writableOrigins.length).toBeGreaterThan(0);
    }
    expect(canWriteTelemetrySignal("$click", "event", "client")).toBe(true);
    expect(canWriteTelemetrySignal("$click", "event", "server")).toBe(false);
    expect(canWriteTelemetrySignal("$log", "event", "server")).toBe(true);
    expect(canWriteTelemetrySignal("$page-view", "span", "client")).toBe(true);
    expect(canWriteTelemetrySignal("$page-view", "span", "server")).toBe(false);
    expect(canWriteTelemetrySignal("checkout.completed", "event", "server")).toBe(true);
    expect(canWriteTelemetrySignal("db.query", "span", "server")).toBe(true);
  });
});

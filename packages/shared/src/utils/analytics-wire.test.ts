import { describe, expect, it } from "vitest";
import { CLIENT_SYSTEM_SPAN_TYPES, SYSTEM_EVENT_TYPES, generateW3cSpanId, generateW3cTraceId, getTelemetryResourceError, isW3cSpanId, isW3cTraceId, snapshotTelemetryResource, truncateUtf8Bytes, uuidToW3cSpanId, uuidToW3cTraceId } from "./analytics-wire";

describe("telemetry resource", () => {
  it("accepts the explicit service identity and bounded primitive attributes", () => {
    expect(getTelemetryResourceError({
      service: { name: "checkout", namespace: "store", version: "abc123", instanceId: "iad-1" },
      deploymentEnvironmentName: "production",
      attributes: { region: "iad1", replicas: 3, active: true, zones: ["iad1", "iad2"], optional: null },
    })).toBeNull();
  });

  it("rejects nested and non-finite attribute values", () => {
    expect(getTelemetryResourceError({
      service: { name: "checkout" },
      attributes: { nested: { secret: "value" } },
    })).toContain("must be a primitive");
    expect(getTelemetryResourceError({
      service: { name: "checkout" },
      attributes: { load: Number.NaN },
    })).toContain("must be a primitive");
  });

  it("rejects unknown resource and service fields instead of silently ignoring them", () => {
    expect(getTelemetryResourceError({
      service: { name: "checkout", guessedRuntime: "browser" },
    })).toContain("unknown field");
    expect(getTelemetryResourceError({
      service: { name: "checkout" },
      environment: "production",
    })).toContain("unknown field");
  });

  it("deeply snapshots identity and primitive-array attributes", () => {
    const zones = ["iad1", "iad2"];
    const input = {
      service: { name: "checkout", namespace: "store" },
      attributes: { zones },
    };
    const snapshot = snapshotTelemetryResource(input);

    input.service.name = "mutated";
    zones.push("sfo1");

    expect(snapshot).toEqual({
      service: { name: "checkout", namespace: "store" },
      attributes: { zones: ["iad1", "iad2"] },
    });
  });
});

describe("truncateUtf8Bytes", () => {
  it("returns short values unchanged", () => {
    expect(truncateUtf8Bytes("hello", 8)).toBe("hello");
    expect(truncateUtf8Bytes("", 0)).toBe("");
  });

  it("rejects a NaN byte budget instead of bypassing the cap", () => {
    expect(truncateUtf8Bytes("sensitive payload", Number.NaN)).toBe("");
  });

  it("truncates by bytes, not characters", () => {
    const truncated = truncateUtf8Bytes("\u{20AC}".repeat(3000), 6000);
    expect("\u{20AC}".repeat(3000).startsWith(truncated)).toBe(true);
    const byteLength = new TextEncoder().encode(truncated).length;
    expect(byteLength).toBeLessThanOrEqual(6000);
    expect(byteLength).toBeGreaterThan(6000 - 64 * 3);
  });

  it("never splits a code point at the boundary", () => {
    const value = "x".repeat(100) + "\u{1F600}".repeat(50);
    for (const budget of [0, 1, 99, 100, 101, 102, 103, 150, 299, 300]) {
      const truncated = truncateUtf8Bytes(value, budget);
      expect(value.startsWith(truncated)).toBe(true);
      expect(new TextEncoder().encode(truncated).length).toBeLessThanOrEqual(budget);
      expect(new TextDecoder().decode(new TextEncoder().encode(truncated))).toBe(truncated);
    }
  });
});

describe("wire type lists", () => {
  it("keeps the system type lists $-prefixed and unique", () => {
    for (const list of [SYSTEM_EVENT_TYPES, CLIENT_SYSTEM_SPAN_TYPES]) {
      expect(new Set(list).size).toBe(list.length);
      for (const type of list) expect(type.startsWith("$")).toBe(true);
    }
  });

  it("includes the new wire types the ingestion route must accept", () => {
    expect(SYSTEM_EVENT_TYPES).toContain("$keystroke");
    expect(SYSTEM_EVENT_TYPES).toContain("$error");
    expect(SYSTEM_EVENT_TYPES).toContain("$log");
  });
});

describe("W3C trace context", () => {
  it("derives stable lifecycle trace and span ids from a UUID", () => {
    const uuid = "12345678-1234-4123-8123-123456789abc";
    expect(uuidToW3cTraceId(uuid)).toBe("12345678123441238123123456789abc");
    expect(uuidToW3cSpanId(uuid)).toBe("8123123456789abc");
    expect(() => uuidToW3cTraceId("not-a-uuid")).toThrow(/Expected a telemetry uuid/);
  });

  it("generates ids of the right shape that are never the all-zero id", () => {
    for (let i = 0; i < 50; i++) {
      const traceId = generateW3cTraceId();
      const spanId = generateW3cSpanId();
      expect(isW3cTraceId(traceId)).toBe(true);
      expect(isW3cSpanId(spanId)).toBe(true);
    }
  });

  it("rejects the all-zero ids the spec forbids, and wrong-length hex", () => {
    expect(isW3cTraceId("0".repeat(32))).toBe(false);
    expect(isW3cSpanId("0".repeat(16))).toBe(false);
    expect(isW3cTraceId("abc")).toBe(false);
    expect(isW3cTraceId(generateW3cSpanId())).toBe(false);
    expect(isW3cSpanId(generateW3cTraceId())).toBe(false);
    expect(isW3cTraceId("A".repeat(32))).toBe(false);
  });

});

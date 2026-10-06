import { describe, expect, it } from "vitest";
import {
  BAGGAGE_HEADER,
  buildFetchInitWithSpanContext,
  buildPropagationHeaderValues,
  decodeCorrelationBaggage,
  encodeCorrelationBaggage,
  shouldPropagateSpanContext,
  trustedDomainsToPropagationOrigins,
} from "./span-propagation";

const SEGMENT_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_SPAN_ID = "3333333333333333";

describe("OTel propagation facade", () => {
  it("uses namespaced W3C baggage without tenant identity", () => {
    const header = encodeCorrelationBaggage({
      projectId: "untrusted-project",
      sessionReplaySegmentId: SEGMENT_ID,
      pageViewSpanId: PAGE_SPAN_ID,
    });
    expect(BAGGAGE_HEADER).toBe("baggage");
    expect(header).not.toContain("project");
    expect(decodeCorrelationBaggage(header)).toEqual({
      sessionReplaySegmentId: SEGMENT_ID,
      pageViewSpanId: PAGE_SPAN_ID,
    });
  });

  it("serializes traceparent and opaque tracestate with the official propagator", () => {
    expect(buildPropagationHeaderValues({
      traceparent: {
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        sampled: true,
        traceState: "vendor=value",
      },
      context: null,
    })).toEqual({
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      tracestate: "vendor=value",
    });
  });

  it("merges Hexclave baggage into caller baggage without overwriting explicit hierarchy", () => {
    const result = buildFetchInitWithSpanContext({
      input: "https://app.example.com/api",
      init: { headers: { baggage: "vendor.key=value", traceparent: "caller" } },
      headerValues: {
        baggage: `hexclave.session_replay.segment.id=${SEGMENT_ID}`,
        traceparent: "hexclave",
      },
      selfOrigin: "https://app.example.com",
      allowedOrigins: [],
    });
    const headers = new Headers(result?.init.headers);
    expect(headers.get("traceparent")).toBe("caller");
    expect(headers.get("baggage")).toContain("vendor.key=value");
    expect(headers.get("baggage")).toContain(`hexclave.session_replay.segment.id=${SEGMENT_ID}`);
  });
});

describe("correlation privacy policy", () => {
  it("allows same-origin, explicit origins, and opted-in localhost only", () => {
    expect(shouldPropagateSpanContext({
      targetUrl: "/api",
      selfOrigin: "https://app.example.com",
    })).toBe(true);
    expect(shouldPropagateSpanContext({
      targetUrl: "https://api.example.com/path",
      selfOrigin: "https://app.example.com",
      allowedOrigins: ["https://api.example.com"],
    })).toBe(true);
    expect(shouldPropagateSpanContext({
      targetUrl: "http://localhost:3001/path",
      selfOrigin: "http://localhost:3000",
      allowLocalhost: true,
    })).toBe(true);
    expect(shouldPropagateSpanContext({
      targetUrl: "https://third-party.example/path",
      selfOrigin: "https://app.example.com",
    })).toBe(false);
  });

  it("derives only exact valid HTTP origins from trusted domains", () => {
    expect(trustedDomainsToPropagationOrigins([
      "https://api.example.com/path",
      "https://*.example.com",
      "mailto:test@example.com",
      "invalid",
    ])).toEqual(["https://api.example.com"]);
  });
});

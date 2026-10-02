import { describe, expect, it } from "vitest";
import { propagation } from "@opentelemetry/api";
import {
  BAGGAGE_HEADER,
  TRACESTATE_HEADER,
  TRACEPARENT_HEADER,
  buildFetchInitWithSpanContext,
  buildPropagationHeaderValues,
  decodeCorrelationBaggage,
  extractW3cTraceContext,
} from "./span-propagation";

const TRACE_ID = "11111111111111111111111111111111";
const SPAN_ID = "2222222222222222";
const SEGMENT_ID = "33333333-3333-4333-8333-333333333333";

describe("OTel-native HTTP propagation", () => {
  it("loads the OTel baggage API from the SDK dependency", () => {
    expect(propagation.createBaggage).toBeTypeOf("function");
  });
  it("injects traceparent, tracestate, and Hexclave correlation baggage", () => {
    const headers = buildPropagationHeaderValues({
      traceparent: {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        sampled: true,
        traceState: "vendor=value",
      },
      context: { sessionReplaySegmentId: SEGMENT_ID },
    });

    expect(headers).toMatchObject({
      [TRACEPARENT_HEADER]: `00-${TRACE_ID}-${SPAN_ID}-01`,
      [TRACESTATE_HEADER]: "vendor=value",
    });
    expect(decodeCorrelationBaggage(headers[BAGGAGE_HEADER])).toEqual({
      sessionReplaySegmentId: SEGMENT_ID,
    });
  });

  it("extracts sampled trace identity and opaque tracestate through the OTel propagator", () => {
    expect(extractW3cTraceContext(new Headers({
      [TRACEPARENT_HEADER]: `00-${TRACE_ID}-${SPAN_ID}-01`,
      [TRACESTATE_HEADER]: "vendor=value",
    }))).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 1,
      sampled: true,
      traceState: "vendor=value",
    });
  });

  it("merges Hexclave keys into caller baggage without replacing other vendors", () => {
    const values = buildPropagationHeaderValues({
      traceparent: null,
      context: { sessionReplaySegmentId: SEGMENT_ID },
    });
    const result = buildFetchInitWithSpanContext({
      input: "https://app.example.test/api",
      init: { headers: { baggage: "vendor.route=checkout" } },
      headerValues: values,
      selfOrigin: "https://app.example.test",
      allowedOrigins: [],
    });

    expect(result).not.toBeNull();
    const baggage = new Headers(result?.init.headers).get(BAGGAGE_HEADER);
    expect(baggage).toContain("vendor.route=checkout");
    expect(decodeCorrelationBaggage(baggage)).toEqual({
      sessionReplaySegmentId: SEGMENT_ID,
    });
  });
});

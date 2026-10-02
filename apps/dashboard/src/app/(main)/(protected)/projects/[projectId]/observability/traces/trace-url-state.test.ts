import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACE_PAGE_URL_STATE,
  parseTracePageUrlState,
  serializeTracePageUrlState,
  type TracePageUrlState,
} from "./trace-url-state";

function roundTrip(state: TracePageUrlState): TracePageUrlState {
  return parseTracePageUrlState(serializeTracePageUrlState(state, new URLSearchParams()));
}

describe("trace page URL state", () => {
  it("serializes defaults to an empty query string", () => {
    expect(serializeTracePageUrlState(DEFAULT_TRACE_PAGE_URL_STATE, new URLSearchParams()).toString()).toBe("");
  });

  it("round-trips a highlighted custom event inside an existing trace", () => {
    const state: TracePageUrlState = {
      hours: 168,
      service: { namespace: "web", name: "storefront" },
      search: "checkout",
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      eventType: "checkout_completed",
      eventAtMs: 1_720_000_000_000,
    };
    expect(roundTrip(state)).toEqual(state);
  });

  it("falls back to defaults on a hand-edited URL rather than crashing", () => {
    expect(parseTracePageUrlState(new URLSearchParams("range=nope&at=abc&service=%"))).toEqual({
      ...DEFAULT_TRACE_PAGE_URL_STATE,
      service: null,
    });
  });
});

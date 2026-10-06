import { TraceFlags } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { buildAmbientSessionContext, traceFlagsForSampleRate } from "./otel-context";
import { trace } from "@opentelemetry/api";

describe("session anchor sampling", () => {
  it("carries explicit zero and full sampling decisions into ambient context", () => {
    const traceId = "1".repeat(32);
    expect(traceFlagsForSampleRate(traceId, 0)).toBe(TraceFlags.NONE);
    expect(traceFlagsForSampleRate(traceId, 1)).toBe(TraceFlags.SAMPLED);

    const ambient = buildAmbientSessionContext({
      anchor: { traceId, spanId: "2".repeat(16), traceFlags: TraceFlags.NONE },
      sessionReplaySegmentId: "segment",
    });
    expect(trace.getSpanContext(ambient)?.traceFlags).toBe(TraceFlags.NONE);
  });
});

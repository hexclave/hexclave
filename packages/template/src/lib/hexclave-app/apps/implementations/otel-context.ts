import { context, isSpanContextValid, propagation, ROOT_CONTEXT, SamplingDecision, SpanKind, trace, TraceFlags, type Context } from "@opentelemetry/api";
import { RandomIdGenerator, TraceIdRatioBasedSampler, type Sampler } from "@opentelemetry/sdk-trace-base";
import { HEXCLAVE_PAGE_VIEW_SPAN_ID_BAGGAGE_KEY, HEXCLAVE_SESSION_REPLAY_SEGMENT_ID_BAGGAGE_KEY } from "@hexclave/shared/dist/utils/span-context-codec";
import type { SpanContext } from "./telemetry-core";

const idGenerator = new RandomIdGenerator();

/** Official SDK IDs for inert facade placeholders; recording providers generate their own. */
export function generateOtelTraceId(): string {
  return idGenerator.generateTraceId();
}

export function generateOtelSpanId(): string {
  return idGenerator.generateSpanId();
}

export function traceFlagsForSampleRate(traceId: string, traceSampleRate: number): TraceFlags {
  const sampler: Sampler = new TraceIdRatioBasedSampler(traceSampleRate);
  const sampling = sampler.shouldSample(
    ROOT_CONTEXT,
    traceId,
    "$session-root",
    SpanKind.INTERNAL,
    {},
    [],
  );
  return sampling.decision === SamplingDecision.RECORD_AND_SAMPLED ? TraceFlags.SAMPLED : TraceFlags.NONE;
}

/**
 * Returns the span owned by the configured OpenTelemetry context manager.
 * Hexclave deliberately does not maintain a parallel ambient-context stack:
 * integrations and the public span facade must agree on this single authority.
 */
/**
 * Builds the ambient base Context the managed browser SDK hands to its
 * context manager (see AmbientBaseStackContextManager): the anchor span (a
 * live `$page-view`, or the refresh-token session root before one exists)
 * plus the correlation baggage every span started on this page must carry.
 * Shared between the lazily-loaded EventTracker and the eager ClientAnalytics
 * facade so both windows anchor identically.
 */
export function buildAmbientSessionContext(options: {
  anchor: SpanContext,
  sessionReplaySegmentId: string,
  pageViewSpanId?: string,
}): Context {
  const withSpan = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: options.anchor.traceId,
    spanId: options.anchor.spanId,
    traceFlags: options.anchor.traceFlags ?? TraceFlags.NONE,
    isRemote: false,
  });
  return propagation.setBaggage(withSpan, propagation.createBaggage({
    [HEXCLAVE_SESSION_REPLAY_SEGMENT_ID_BAGGAGE_KEY]: { value: options.sessionReplaySegmentId },
    ...options.pageViewSpanId === undefined ? {} : { [HEXCLAVE_PAGE_VIEW_SPAN_ID_BAGGAGE_KEY]: { value: options.pageViewSpanId } },
  }));
}

export function getActiveOtelSpanContext(): SpanContext | null {
  const active = trace.getSpan(context.active())?.spanContext();
  if (active === undefined || !isSpanContextValid(active)) return null;
  return {
    traceId: active.traceId,
    spanId: active.spanId,
    traceFlags: active.traceFlags,
    ...active.traceState === undefined ? {} : { traceState: active.traceState.serialize() },
  };
}

import { context, createTraceState, propagation, ROOT_CONTEXT, SpanStatusCode, trace, TraceFlags, type Context, type Link, type Tracer } from "@opentelemetry/api";
import { isW3cSpanId, isW3cTraceId } from "@hexclave/shared/dist/utils/analytics-wire";
import { BAGGAGE_HEADER, decodeCorrelationBaggage, mergeCorrelationBaggage } from "@hexclave/shared/dist/utils/span-context-codec";
import { assertValidSpanStartInput, getCustomTelemetryDataError, rejectedPreCaught, withSpanImpl, type Span, type SpanContext, type StartSpanOptions, type TrackOptions } from "./telemetry-core";
import { runWithSpanFrame } from "./span-context";

const TRUSTED_SPAN_LINK_WRITER = Symbol.for("hexclave.analytics.trusted-span-link-writer.v1");

export type OtelSpanFacadeCapabilities = {
  trackEvent: (eventType: string, data: Record<string, unknown> | undefined, options: TrackOptions) => Promise<void>,
  getSpanPropagationHeaders: (span: Span) => Record<string, string>,
  fetch: (span: Span, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  /**
   * Invoked once for EVERY facade this factory creates — including children
   * minted through the recursive `startSpan`/`withSpan`, which reuse the same
   * capabilities object. The tracker needs this to register child facades in
   * its live-span registries (`_liveSpanControls`/global sweep): without it a
   * never-ended CHILD facade is invisible to the sign-out/clearBuffer inert
   * sweep, because only the top-level `startSpan` call site could register
   * the handles it created itself.
   */
  onStarted?: (span: Span) => void,
  onEnded?: (span: Span) => void,
};

function contextFromSpanContext(spanContext: SpanContext): Context {
  if (!isW3cTraceId(spanContext.traceId) || !isW3cSpanId(spanContext.spanId)) {
    throw new Error("Hexclave analytics: invalid parent span context");
  }
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags ?? TraceFlags.SAMPLED,
    isRemote: true,
    ...spanContext.traceState === undefined ? {} : { traceState: createTraceState(spanContext.traceState) },
  });
}

function linkFromSpan(span: SpanContext): Link {
  return {
    context: {
      traceId: span.traceId,
      spanId: span.spanId,
      traceFlags: span.traceFlags ?? TraceFlags.SAMPLED,
      isRemote: true,
      ...span.traceState === undefined ? {} : { traceState: createTraceState(span.traceState) },
    },
  };
}

function parentRefContext(parent: StartSpanOptions["parent"]): SpanContext | null {
  if (parent === undefined) return null;
  return "spanContext" in parent ? parent.spanContext() : parent;
}

function dataJson(data: Record<string, unknown>): string {
  const error = getCustomTelemetryDataError(data);
  if (error !== null) throw new Error(`Hexclave analytics: ${error}`);
  return JSON.stringify(data);
}

export function createOtelSpanFacade(options: {
  tracer: Tracer,
  spanType: string,
  startOptions?: StartSpanOptions,
  parentContext?: Context,
  correlationAttributes?: Record<string, string>,
  /**
   * `spanPropagation.enabled` threading (default true). When false, the facade
   * stops CONSTRUCTING Hexclave correlation baggage: the execution context no
   * longer carries the correlationAttributes as baggage entries, and
   * getSpanPropagationHeaders() skips the correlation-fallback merge. The
   * correlationAttributes still stamp the span's own wire-row ATTRIBUTES —
   * this flag gates propagation, not row data — and W3C trace context
   * (traceparent/tracestate) is untouched.
   */
  correlationBaggage?: boolean,
  capabilities: OtelSpanFacadeCapabilities,
}): Span {
  assertValidSpanStartInput(options.spanType, options.startOptions);
  const explicitParent = parentRefContext(options.startOptions?.parent);
  const parentContext = explicitParent !== null
    ? contextFromSpanContext(explicitParent)
    : options.startOptions?.root === true
      ? ROOT_CONTEXT
      : options.parentContext ?? context.active();
  const links = (options.startOptions?.links ?? []).map((link) => linkFromSpan("spanContext" in link ? link.spanContext() : link));
  let accumulatedData = { ...options.startOptions?.data ?? {} };
  const otelSpan = options.tracer.startSpan(options.spanType, {
    ...options.startOptions?.startedAtMs === undefined ? {} : { startTime: options.startOptions.startedAtMs },
    links,
    attributes: {
      "hexclave.signal.type": "custom_span",
      "hexclave.data": dataJson(accumulatedData),
      ...options.correlationAttributes,
    },
  }, parentContext);
  const spanContext = otelSpan.spanContext();
  let ended = false;

  const correlationBaggageEnabled = options.correlationBaggage !== false;

  const executionContext = (base: Context): Context => {
    let scoped = trace.setSpan(base, otelSpan);
    if (correlationBaggageEnabled) {
      let baggage = propagation.getBaggage(scoped) ?? propagation.createBaggage();
      for (const [key, value] of Object.entries(options.correlationAttributes ?? {})) {
        baggage = baggage.setEntry(key, { value });
      }
      scoped = propagation.setBaggage(scoped, baggage);
    }
    return scoped;
  };

  let facade!: Span;
  facade = {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    spanType: options.spanType,
    get isEnded() {
      return ended;
    },
    setData: async (data) => {
      if (ended) return await rejectedPreCaught(`setData() called on already-ended span "${options.spanType}"`);
      const merged = { ...accumulatedData, ...data };
      otelSpan.setAttribute("hexclave.data", dataJson(merged));
      if (typeof merged.error === "string") otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: merged.error });
      accumulatedData = merged;
    },
    end: async (endOptions) => {
      if (ended) return;
      ended = true;
      otelSpan.end(endOptions?.endedAtMs);
      options.capabilities.onEnded?.(facade);
    },
    trackEvent: (eventType, data, trackOptions) => options.capabilities.trackEvent(eventType, data, { ...trackOptions, parent: facade }),
    startSpan: (spanType, startOptions) => createOtelSpanFacade({
      tracer: options.tracer,
      spanType,
      startOptions,
      parentContext: executionContext(context.active()),
      correlationAttributes: options.correlationAttributes,
      ...options.correlationBaggage === undefined ? {} : { correlationBaggage: options.correlationBaggage },
      capabilities: options.capabilities,
    }),
    withSpan: <T,>(spanType: string, optionsOrFn: StartSpanOptions | ((span: Span) => Promise<T> | T), maybeFn?: (span: Span) => Promise<T> | T) =>
      withSpanImpl((childType, childOptions) => facade.startSpan(childType, childOptions), spanType, optionsOrFn, maybeFn),
    run: async <T,>(fn: () => T): Promise<Awaited<T>> => await runWithSpanFrame(
      facade.spanContext(),
      () => context.with(executionContext(context.active()), fn),
    ),
    getSpanPropagationHeaders: () => {
      const fallback = options.capabilities.getSpanPropagationHeaders(facade);
      const carrier = new Map<string, string>();
      propagation.inject(executionContext(context.active()), carrier, {
        set(target, key, value) {
          target.set(key, value);
        },
      });
      if (correlationBaggageEnabled) {
        const correlation = decodeCorrelationBaggage(fallback[BAGGAGE_HEADER]);
        if (correlation !== null) {
          const baggage = mergeCorrelationBaggage(carrier.get(BAGGAGE_HEADER) ?? null, correlation);
          if (baggage !== null) carrier.set(BAGGAGE_HEADER, baggage);
        }
      }
      return { ...fallback, ...Object.fromEntries(carrier) };
    },
    fetch: (input, init) => options.capabilities.fetch(facade, input, init),
    spanContext: () => ({
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      ...spanContext.traceState === undefined ? {} : { traceState: spanContext.traceState.serialize() },
    }),
  };

  Object.defineProperty(facade, TRUSTED_SPAN_LINK_WRITER, {
    enumerable: false,
    value: (link: SpanContext & { linkedProjectId?: string, linkedBranchId?: string }) => {
      const attributes: Record<string, string> = {};
      if (link.linkedProjectId !== undefined) attributes["hexclave.linked.project.id"] = link.linkedProjectId;
      if (link.linkedBranchId !== undefined) attributes["hexclave.linked.branch.id"] = link.linkedBranchId;
      otelSpan.addLink({ ...linkFromSpan(link), attributes });
      return Promise.resolve();
    },
  });

  try {
    options.capabilities.onStarted?.(facade);
  } catch (error) {
    ended = true;
    otelSpan.end();
    try {
      options.capabilities.onEnded?.(facade);
    } catch {
    }
    throw error;
  }

  return facade;
}

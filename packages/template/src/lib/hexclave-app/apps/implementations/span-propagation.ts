import { createTraceState, isSpanContextValid, ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BAGGAGE_HEADER, decodeCorrelationBaggage, encodeCorrelationBaggage, mergeCorrelationBaggage, readRequestHeader, type SpanPropagationContext } from "@hexclave/shared/dist/utils/span-context-codec";
import { isLocalhost } from "@hexclave/shared/dist/utils/urls";
import type { SpanContext } from "./telemetry-core";

export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

const traceContextPropagator = new W3CTraceContextPropagator();

/** Extracts standard W3C hierarchy without interpreting opaque tracestate. */
export function extractW3cTraceContext(headers: Parameters<typeof readRequestHeader>[0]): (SpanContext & { sampled: boolean }) | null {
  const extracted = traceContextPropagator.extract(ROOT_CONTEXT, headers, {
    keys: () => [TRACEPARENT_HEADER, TRACESTATE_HEADER],
    get: (target, key) => readRequestHeader(target, key) ?? undefined,
  });
  const spanContext = trace.getSpanContext(extracted);
  if (spanContext === undefined || !isSpanContextValid(spanContext)) return null;
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    sampled: (spanContext.traceFlags & TraceFlags.SAMPLED) !== 0,
    ...spanContext.traceState === undefined ? {} : { traceState: spanContext.traceState.serialize() },
  };
}

export {
  BAGGAGE_HEADER,
  decodeCorrelationBaggage,
  encodeCorrelationBaggage,
  readRequestHeader,
  readBaggageHeader,
  type SpanPropagationContext,
} from "@hexclave/shared/dist/utils/span-context-codec";

/**
 * Hexclave correlation baggage is privacy-filtered before OTel injects it.
 * Hierarchy itself remains the standard `traceparent`/`tracestate` contract.
 */
export function shouldPropagateSpanContext(opts: {
  targetUrl: string | URL,
  selfOrigin: string | null,
  allowedOrigins?: readonly string[],
  allowLocalhost?: boolean,
}): boolean {
  let target: URL;
  try {
    target = typeof opts.targetUrl === "string" ? new URL(opts.targetUrl, opts.selfOrigin ?? undefined) : opts.targetUrl;
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (opts.selfOrigin !== null && target.origin === opts.selfOrigin) return true;
  if (opts.allowedOrigins?.includes(target.origin) === true) return true;
  return opts.allowLocalhost === true && isLocalhost(target);
}

export function trustedDomainsToPropagationOrigins(trustedDomains: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const domain of trustedDomains) {
    if (domain.includes("*")) continue;
    try {
      const url = new URL(domain);
      if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin);
    } catch {
    }
  }
  return [...origins];
}

function requestInputUrl(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return null;
}

function requestInputMode(input: unknown, init: RequestInit | undefined): string | undefined {
  if (init?.mode !== undefined) return init.mode;
  if (typeof Request !== "undefined" && input instanceof Request) return input.mode;
  return undefined;
}

/** Applies an explicit facade span context without mutating caller-owned headers. */
export function buildFetchInitWithSpanContext(opts: {
  input: unknown,
  init: RequestInit | undefined,
  headerValues: Readonly<Record<string, string>>,
  selfOrigin: string | null,
  allowedOrigins: readonly string[],
  allowLocalhost?: boolean,
  bypassOriginPolicy?: boolean,
}): { init: RequestInit, attachedHeaderNames: Set<string> } | null {
  if (requestInputMode(opts.input, opts.init) === "no-cors") return null;
  if (opts.bypassOriginPolicy !== true) {
    const url = requestInputUrl(opts.input);
    if (url === null || !shouldPropagateSpanContext({
      targetUrl: url,
      selfOrigin: opts.selfOrigin,
      allowedOrigins: opts.allowedOrigins,
      allowLocalhost: opts.allowLocalhost,
    })) return null;
  }
  const requestHeaders = typeof Request !== "undefined" && opts.input instanceof Request ? opts.input.headers : undefined;
  const headers = new Headers(opts.init?.headers ?? requestHeaders);
  const attachedHeaderNames = new Set<string>();
  for (const [name, value] of Object.entries(opts.headerValues)) {
    if (headers.has(name)) {
      if (name !== BAGGAGE_HEADER) continue;
      const correlation = decodeCorrelationBaggage(value);
      if (correlation === null) continue;
      const merged = mergeCorrelationBaggage(headers.get(name), correlation);
      if (merged === null) continue;
      headers.set(name, merged);
    } else {
      headers.set(name, value);
    }
    attachedHeaderNames.add(name);
  }
  if (attachedHeaderNames.size === 0) return null;
  return { init: { ...opts.init, headers }, attachedHeaderNames };
}

let warnedFetchPropagationFailure = false;

/**
 * Performs `fetch` with span-propagation headers attached when the origin
 * policy allows it. Propagation is a best-effort enhancement, so an internal
 * failure here falls back to a plain fetch — but it must never be silent:
 * silently dropped propagation headers break trace correlation in ways that
 * are nearly impossible to debug, so we warn once per page load.
 */
export function fetchWithSpanPropagation(opts: {
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  headerValues: Readonly<Record<string, string>>,
  selfOrigin: string | null,
  allowedOrigins: readonly string[],
  allowLocalhost?: boolean,
}): Promise<Response> {
  try {
    const initWithHeader = buildFetchInitWithSpanContext({
      input: opts.input,
      init: opts.init,
      headerValues: opts.headerValues,
      selfOrigin: opts.selfOrigin,
      allowedOrigins: opts.allowedOrigins,
      allowLocalhost: opts.allowLocalhost,
    });
    return globalThis.fetch(opts.input, initWithHeader?.init ?? opts.init);
  } catch (error) {
    if (!warnedFetchPropagationFailure) {
      warnedFetchPropagationFailure = true;
      console.warn("Hexclave could not attach span propagation headers to a fetch; continuing without trace correlation for this request.", error);
    }
    return globalThis.fetch(opts.input, opts.init);
  }
}

/** Serializes explicit facade context through the official W3C propagator. */
export function buildPropagationHeaderValues(opts: {
  traceparent: { traceId: string, spanId: string, sampled: boolean, traceState?: string } | null,
  context: SpanPropagationContext | null,
}): Record<string, string> {
  const hasCorrelation = opts.context !== null && (
    opts.context.sessionReplayId !== undefined
    || opts.context.sessionReplaySegmentId !== undefined
    || opts.context.pageViewSpanId !== undefined
  );
  if (opts.traceparent === null && !hasCorrelation) return {};
  const carrier: Record<string, string> = {};
  if (opts.traceparent !== null) {
    const propagationContext = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: opts.traceparent.traceId,
      spanId: opts.traceparent.spanId,
      traceFlags: opts.traceparent.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
      isRemote: false,
      ...opts.traceparent.traceState === undefined ? {} : { traceState: createTraceState(opts.traceparent.traceState) },
    });
    traceContextPropagator.inject(propagationContext, carrier, {
      set: (target, key, value) => {
        target[key] = value;
      },
    });
  }
  if (opts.context !== null) {
    const baggage = encodeCorrelationBaggage(opts.context);
    if (baggage !== null) carrier[BAGGAGE_HEADER] = baggage;
  }
  return carrier;
}

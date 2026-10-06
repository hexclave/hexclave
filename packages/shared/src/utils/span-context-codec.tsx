import { propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { W3CBaggagePropagator } from "@opentelemetry/core";
import { isW3cSpanId, TELEMETRY_UUID_RE } from "./analytics-wire";

/**
 * Hexclave correlation carried as standard W3C baggage.
 *
 * These values are untrusted application context. Consumers may use them to
 * correlate telemetry, but never for authentication, authorization, billing,
 * or any other security decision. Tenancy comes from the authenticated request,
 * not from baggage.
 */
export type SpanPropagationContext = {
  /** @deprecated Tenancy is authenticated out of band and is never propagated. */
  projectId?: string,
  sessionReplayId?: string,
  sessionReplaySegmentId?: string,
  pageViewSpanId?: string,
};

export const BAGGAGE_HEADER = "baggage";

export const HEXCLAVE_SESSION_REPLAY_ID_BAGGAGE_KEY = "hexclave.session_replay.id";
export const HEXCLAVE_SESSION_REPLAY_SEGMENT_ID_BAGGAGE_KEY = "hexclave.session_replay.segment.id";
export const HEXCLAVE_PAGE_VIEW_SPAN_ID_BAGGAGE_KEY = "hexclave.page_view.span_id";

const HEXCLAVE_BAGGAGE_KEYS = new Set([
  HEXCLAVE_SESSION_REPLAY_ID_BAGGAGE_KEY,
  HEXCLAVE_SESSION_REPLAY_SEGMENT_ID_BAGGAGE_KEY,
  HEXCLAVE_PAGE_VIEW_SPAN_ID_BAGGAGE_KEY,
]);
const MAX_BAGGAGE_HEADER_LENGTH = 8192;

const baggagePropagator = new W3CBaggagePropagator();

type RequestLikeHeaders = { get: (name: string) => string | null } | Record<string, string | null>;

export function readRequestHeader(headers: RequestLikeHeaders, name: string): string | null {
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

export function readBaggageHeader(headers: RequestLikeHeaders): string | null {
  return readRequestHeader(headers, BAGGAGE_HEADER);
}


/**
 * Serializes only the correlation keys Hexclave owns. The OTel propagator
 * handles W3C escaping and validation; unrelated caller baggage is merged by
 * the higher-level composite propagation path instead of entering this model.
 */
export function encodeCorrelationBaggage(context: SpanPropagationContext): string | null {
  let baggage = propagation.createBaggage();
  if (context.sessionReplayId !== undefined) {
    baggage = baggage.setEntry(HEXCLAVE_SESSION_REPLAY_ID_BAGGAGE_KEY, { value: context.sessionReplayId });
  }
  if (context.sessionReplaySegmentId !== undefined) {
    baggage = baggage.setEntry(HEXCLAVE_SESSION_REPLAY_SEGMENT_ID_BAGGAGE_KEY, { value: context.sessionReplaySegmentId });
  }
  if (context.pageViewSpanId !== undefined) {
    baggage = baggage.setEntry(HEXCLAVE_PAGE_VIEW_SPAN_ID_BAGGAGE_KEY, { value: context.pageViewSpanId });
  }
  if (baggage.getAllEntries().length === 0) return null;

  const baggageContext = propagation.setBaggage(ROOT_CONTEXT, baggage);
  const carrier: Record<string, string> = {};
  baggagePropagator.inject(baggageContext, carrier, {
    set(target, key, value) {
      target[key] = value;
    },
  });
  return carrier[BAGGAGE_HEADER] ?? null;
}

function parseBaggageMember(member: string): { key: string, value: string } | null {
  const keyValue = member.trim().split(";", 1)[0];
  const equals = keyValue.indexOf("=");
  if (equals <= 0) return null;
  try {
    return {
      key: decodeURIComponent(keyValue.slice(0, equals).trim()),
      value: decodeURIComponent(keyValue.slice(equals + 1).trim()),
    };
  } catch {
    return null;
  }
}

/** Adds or replaces Hexclave's namespaced entries while preserving caller baggage. */
export function mergeCorrelationBaggage(
  existingHeader: string | null,
  context: SpanPropagationContext,
): string | null {
  const correlationHeader = encodeCorrelationBaggage(context);
  if (correlationHeader === null) return existingHeader;
  const unrelatedMembers = existingHeader?.split(",").filter((member) => {
    const parsed = parseBaggageMember(member);
    return parsed === null || !HEXCLAVE_BAGGAGE_KEYS.has(parsed.key);
  }) ?? [];
  const merged = [...unrelatedMembers, correlationHeader].join(",");
  return merged.length <= MAX_BAGGAGE_HEADER_LENGTH ? merged : null;
}

/**
 * Extracts only well-formed Hexclave keys from W3C baggage. Invalid Hexclave
 * entries are ignored without affecting unrelated baggage or request handling.
 */
export function decodeCorrelationBaggage(headerValue: string | null | undefined): SpanPropagationContext | null {
  if (headerValue == null || headerValue.length === 0) return null;
  const context: SpanPropagationContext = {};
  const entries = new Map<string, string>();
  for (const member of headerValue.split(",")) {
    const parsed = parseBaggageMember(member);
    if (parsed !== null && HEXCLAVE_BAGGAGE_KEYS.has(parsed.key)) entries.set(parsed.key, parsed.value);
  }
  const sessionReplayId = entries.get(HEXCLAVE_SESSION_REPLAY_ID_BAGGAGE_KEY);
  if (sessionReplayId !== undefined && TELEMETRY_UUID_RE.test(sessionReplayId)) {
    context.sessionReplayId = sessionReplayId;
  }
  const sessionReplaySegmentId = entries.get(HEXCLAVE_SESSION_REPLAY_SEGMENT_ID_BAGGAGE_KEY);
  if (sessionReplaySegmentId !== undefined && TELEMETRY_UUID_RE.test(sessionReplaySegmentId)) {
    context.sessionReplaySegmentId = sessionReplaySegmentId;
  }
  const pageViewSpanId = entries.get(HEXCLAVE_PAGE_VIEW_SPAN_ID_BAGGAGE_KEY);
  if (isW3cSpanId(pageViewSpanId)) {
    context.pageViewSpanId = pageViewSpanId;
  }
  return Object.keys(context).length === 0 ? null : context;
}

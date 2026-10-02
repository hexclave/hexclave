import {
  ALL_SERVICES_SELECT_VALUE,
  isObservabilityTimeRangeHours,
  type ObservabilityTimeRangeHours,
} from "../filters";
import {
  selectValueToServiceIdentity,
  serviceIdentityToSelectValue,
  type ServiceIdentity,
} from "../service-identity";


export type TracePageUrlState = {
  hours: ObservabilityTimeRangeHours,
  service: ServiceIdentity | null,
  search: string,
  traceId: string | null,
  spanId: string | null,
  eventType: string | null,
  eventAtMs: number | null,
};

export const DEFAULT_TRACE_PAGE_URL_STATE: TracePageUrlState = {
  hours: 24,
  service: null,
  search: "",
  traceId: null,
  spanId: null,
  eventType: null,
  eventAtMs: null,
};

const PARAM_KEYS = {
  hours: "range",
  service: "service",
  search: "search",
  traceId: "trace",
  spanId: "span",
  eventType: "event",
  eventAtMs: "at",
} as const;

function safeSelectValueToServiceIdentity(value: string): ServiceIdentity | null {
  try {
    return selectValueToServiceIdentity(value);
  } catch {
    return null;
  }
}

function parseOptionalString(raw: string | null): string | null {
  return raw != null && raw !== "" ? raw : null;
}

function parseEventAtMs(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

export function parseTracePageUrlState(params: URLSearchParams): TracePageUrlState {
  const rawHours = Number(params.get(PARAM_KEYS.hours));
  const rawService = params.get(PARAM_KEYS.service);
  return {
    hours: isObservabilityTimeRangeHours(rawHours) ? rawHours : DEFAULT_TRACE_PAGE_URL_STATE.hours,
    service: rawService == null || rawService === ALL_SERVICES_SELECT_VALUE
      ? null
      : safeSelectValueToServiceIdentity(rawService),
    search: params.get(PARAM_KEYS.search) ?? DEFAULT_TRACE_PAGE_URL_STATE.search,
    traceId: parseOptionalString(params.get(PARAM_KEYS.traceId)),
    spanId: parseOptionalString(params.get(PARAM_KEYS.spanId)),
    eventType: parseOptionalString(params.get(PARAM_KEYS.eventType)),
    eventAtMs: parseEventAtMs(params.get(PARAM_KEYS.eventAtMs)),
  };
}

export function serializeTracePageUrlState(state: TracePageUrlState, params: URLSearchParams): URLSearchParams {
  const setOrDelete = (key: string, value: string | null) => {
    if (value == null) params.delete(key);
    else params.set(key, value);
  };
  setOrDelete(PARAM_KEYS.hours, state.hours === DEFAULT_TRACE_PAGE_URL_STATE.hours ? null : String(state.hours));
  setOrDelete(PARAM_KEYS.service, state.service == null ? null : serviceIdentityToSelectValue(state.service));
  setOrDelete(PARAM_KEYS.search, state.search === "" ? null : state.search);
  setOrDelete(PARAM_KEYS.traceId, state.traceId);
  setOrDelete(PARAM_KEYS.spanId, state.spanId);
  setOrDelete(PARAM_KEYS.eventType, state.eventType);
  setOrDelete(PARAM_KEYS.eventAtMs, state.eventAtMs == null ? null : String(state.eventAtMs));
  return params;
}

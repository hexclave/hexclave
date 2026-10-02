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

export const DEFAULT_LOG_TIME_RANGE_HOURS = 720;

export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFilters = {
  hours: ObservabilityTimeRangeHours,
  level: LogLevel | null,
  service: ServiceIdentity | null,
};

export const DEFAULT_LOG_FILTERS: LogFilters = {
  hours: DEFAULT_LOG_TIME_RANGE_HOURS,
  level: null,
  service: null,
};

const PARAM_KEYS = {
  hours: "range",
  level: "level",
  service: "service",
} as const;

function safeSelectValueToServiceIdentity(value: string): ServiceIdentity | null {
  try {
    return selectValueToServiceIdentity(value);
  } catch {
    return null;
  }
}

export function parseLogFilters(params: URLSearchParams): LogFilters {
  const rawHours = Number(params.get(PARAM_KEYS.hours));
  const rawLevel = params.get(PARAM_KEYS.level);
  const rawService = params.get(PARAM_KEYS.service);
  return {
    hours: isObservabilityTimeRangeHours(rawHours) ? rawHours : DEFAULT_LOG_FILTERS.hours,
    level: LOG_LEVELS.find((candidate) => candidate === rawLevel) ?? null,
    service: rawService == null || rawService === ALL_SERVICES_SELECT_VALUE
      ? null
      : safeSelectValueToServiceIdentity(rawService),
  };
}

export function serializeLogFilters(filters: LogFilters, params: URLSearchParams): URLSearchParams {
  const setOrDelete = (key: string, value: string | null) => {
    if (value == null) params.delete(key);
    else params.set(key, value);
  };
  setOrDelete(PARAM_KEYS.hours, filters.hours === DEFAULT_LOG_FILTERS.hours ? null : String(filters.hours));
  setOrDelete(PARAM_KEYS.level, filters.level);
  setOrDelete(PARAM_KEYS.service, filters.service == null ? null : serviceIdentityToSelectValue(filters.service));
  return params;
}

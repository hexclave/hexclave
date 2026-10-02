import { context, createTraceState, ROOT_CONTEXT, trace, TraceFlags, type Context } from "@opentelemetry/api";
import { logs, SeverityNumber, type AnyValue, type AnyValueMap } from "@opentelemetry/api-logs";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import type { LogLevel } from "@hexclave/shared/dist/utils/analytics-wire";
import type { LogEmitItem } from "./logs";

const SEVERITY_NUMBERS = new Map<LogLevel, SeverityNumber>([
  ["trace", SeverityNumber.TRACE],
  ["debug", SeverityNumber.DEBUG],
  ["info", SeverityNumber.INFO],
  ["warn", SeverityNumber.WARN],
  ["error", SeverityNumber.ERROR],
]);

function objectEntriesToAnyValueMap(value: Record<string, unknown>): AnyValueMap {
  const result: AnyValueMap = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "function" || child === undefined) continue;
    const converted = toOtelAnyValue(child, key);
    if (converted !== undefined) result[key] = converted;
  }
  return result;
}

function toOtelAnyValue(value: unknown, key = ""): AnyValue | undefined {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    return Array.from(value, (entry, index) => toOtelAnyValue(entry, String(index)) ?? null);
  }
  if (isRecord(value)) {
    const toJson = value["toJSON"];
    if (typeof toJson === "function") {
      const jsonValue: unknown = toJson.call(value, key);
      return isRecord(jsonValue) && !(jsonValue instanceof Uint8Array)
        ? objectEntriesToAnyValueMap(jsonValue)
        : toOtelAnyValue(jsonValue);
    }
    return objectEntriesToAnyValueMap(value);
  }
  return undefined;
}

/**
 * Emits the ergonomic Hexclave logger call through the active OTel
 * LoggerProvider. By default trace correlation comes from the official active
 * Context; the facade does not create or transport a second log
 * representation.
 *
 * `options` mirrors emitHexclaveOtelEvent for callers that resolve their own
 * attribution (the server's request-scoped `_emitLog`): `correlationAttributes`
 * stamps `hexclave.*` scalars onto the record, and `parent` overrides the
 * record's context — an explicit span context parents the record there, `null`
 * forces a root record, and OMITTING it keeps the active-context default.
 */
export function emitHexclaveOtelLog(item: LogEmitItem, clientVersion: string, options?: {
  parent?: { traceId: string, spanId: string, traceFlags?: number, traceState?: string } | null,
  correlationAttributes?: Record<string, string>,
}): void {
  const severityNumber = SEVERITY_NUMBERS.get(item.level);
  if (severityNumber === undefined) throw new Error(`Unsupported Hexclave log level: ${item.level}`);
  const attributes: AnyValueMap = {
    "hexclave.signal.type": "log",
  };
  if (item.data !== undefined) attributes["hexclave.data"] = toOtelAnyValue(item.data);
  for (const [key, value] of Object.entries(options?.correlationAttributes ?? {})) attributes[key] = value;
  logs.getLogger("hexclave.sdk", clientVersion).emit({
    eventName: "$log",
    severityNumber,
    severityText: item.level.toUpperCase(),
    body: item.message,
    attributes,
    context: options?.parent === undefined ? context.active() : otelLogContextForParent(options.parent),
  });
}

export function otelLogContextForParent(parent: { traceId: string, spanId: string, traceFlags?: number, traceState?: string } | null): Context {
  if (parent === null) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags: parent.traceFlags ?? TraceFlags.SAMPLED,
    isRemote: false,
    ...parent.traceState === undefined ? {} : { traceState: createTraceState(parent.traceState) },
  });
}

/** Emits a Hexclave product event as a standard named OTel LogRecord. */
export function emitHexclaveOtelEvent(options: {
  eventName: string,
  data: Record<string, unknown> | undefined,
  clientVersion: string,
  parent: { traceId: string, spanId: string, traceFlags?: number, traceState?: string } | null,
  correlationAttributes?: Record<string, string>,
  timestamp?: number,
}): void {
  const attributes: AnyValueMap = {
    "hexclave.signal.type": "event",
    "hexclave.data": toOtelAnyValue(options.data ?? {}),
  };
  for (const [key, value] of Object.entries(options.correlationAttributes ?? {})) attributes[key] = value;
  logs.getLogger("hexclave.sdk", options.clientVersion).emit({
    eventName: options.eventName,
    attributes,
    context: otelLogContextForParent(options.parent),
    ...options.timestamp === undefined ? {} : { timestamp: options.timestamp },
  });
}

/** Emits an automatic error as a standard error-severity OTel LogRecord. */
export function emitHexclaveOtelError(options: {
  data: Record<string, unknown>,
  clientVersion: string,
  parent: { traceId: string, spanId: string, traceFlags?: number, traceState?: string } | null,
  correlationAttributes?: Record<string, string>,
}): void {
  const eventId = options.data.event_id;
  const attributes: AnyValueMap = {
    "hexclave.signal.type": "error",
    "hexclave.data": toOtelAnyValue(options.data),
    ...typeof eventId === "string" ? { "hexclave.event.id": eventId } : {},
  };
  for (const [key, value] of Object.entries(options.correlationAttributes ?? {})) attributes[key] = value;
  const message = options.data.message;
  logs.getLogger("hexclave.sdk", options.clientVersion).emit({
    eventName: "$error",
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    ...typeof message === "string" ? { body: message } : {},
    attributes,
    context: otelLogContextForParent(options.parent),
  });
}

import type { BatchEventWireItem } from "@/lib/analytics-telemetry-writers";
import type { LogLevel } from "@hexclave/shared/dist/utils/analytics-wire";
import type { ErrorIngestEnvelopeHeader, ErrorIngestEnvelopeItem } from "./error-ingest-envelope";
import { isErrorIngestScrubbedRecord, type ErrorIngestScrubbedRecord, type ErrorIngestScrubbedValue } from "./error-ingest-scrubber";

function field(value: ErrorIngestScrubbedRecord | undefined, key: string): ErrorIngestScrubbedValue | undefined {
  return value?.[key];
}

function stringField(value: ErrorIngestScrubbedRecord | undefined, key: string): string | undefined {
  const result = field(value, key);
  return typeof result === "string" ? result : undefined;
}

function booleanField(value: ErrorIngestScrubbedRecord | undefined, key: string): boolean | undefined {
  const result = field(value, key);
  return typeof result === "boolean" ? result : undefined;
}

function sentryLevel(value: string | undefined): LogLevel | undefined {
  switch (value) {
    case "fatal":
    case "error": { return "error"; }
    case "warning":
    case "warn": { return "warn"; }
    case "info": { return "info"; }
    case "debug": { return "debug"; }
    default: { return undefined; }
  }
}

function recordField(value: ErrorIngestScrubbedRecord | undefined, key: string): ErrorIngestScrubbedRecord | undefined {
  const result = field(value, key);
  return isErrorIngestScrubbedRecord(result) ? result : undefined;
}

function lastExceptionValue(event: ErrorIngestScrubbedRecord): ErrorIngestScrubbedRecord | undefined {
  const exception = recordField(event, "exception");
  const values = field(exception, "values");
  if (!Array.isArray(values)) return undefined;
  let last: ErrorIngestScrubbedRecord | undefined;
  for (const value of values) {
    if (isErrorIngestScrubbedRecord(value)) last = value;
  }
  return last;
}

function stackFromFrames(stacktrace: ErrorIngestScrubbedRecord | undefined): string | undefined {
  const frames = field(stacktrace, "frames");
  if (!Array.isArray(frames) || frames.length === 0) return undefined;
  const lines: string[] = [];
  for (const frame of frames) {
    if (!isErrorIngestScrubbedRecord(frame)) continue;
    const filename = stringField(frame, "filename") ?? stringField(frame, "abs_path") ?? "<anonymous>";
    const functionName = stringField(frame, "function") ?? "<anonymous>";
    const line = typeof field(frame, "lineno") === "number" ? String(field(frame, "lineno")) : "?";
    const column = typeof field(frame, "colno") === "number" ? String(field(frame, "colno")) : "?";
    lines.push(`    at ${functionName} (${filename}:${line}:${column})`);
  }
  return lines.length === 0 ? undefined : lines.join("\n");
}

function traceIdFromEvent(event: ErrorIngestScrubbedRecord, header: ErrorIngestEnvelopeHeader): string | undefined {
  const traceContext = recordField(recordField(event, "contexts"), "trace");
  const traceId = stringField(traceContext, "trace_id") ?? header.trace?.trace_id;
  return traceId !== undefined && /^[0-9a-f]{32}$/u.test(traceId) ? traceId : undefined;
}

function spanIdFromEvent(event: ErrorIngestScrubbedRecord): string | undefined {
  const traceContext = recordField(recordField(event, "contexts"), "trace");
  const spanId = stringField(traceContext, "span_id");
  return spanId !== undefined && /^[0-9a-f]{16}$/u.test(spanId) ? spanId : undefined;
}

function eventTimeMs(event: ErrorIngestScrubbedRecord, receivedAtMs: number): number {
  const timestamp = field(event, "timestamp");
  if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0) {
    const milliseconds = Math.round(timestamp * 1_000);
    if (Number.isSafeInteger(milliseconds) && milliseconds >= 0 && Number.isFinite(new Date(milliseconds).getTime())) return milliseconds;
  }
  if (typeof timestamp === "string") {
    const milliseconds = Date.parse(timestamp);
    if (Number.isSafeInteger(milliseconds) && milliseconds >= 0) return milliseconds;
  }
  return receivedAtMs;
}

export function projectSentryEnvelopeEvent(options: {
  event: ErrorIngestScrubbedValue,
  header: ErrorIngestEnvelopeHeader,
  item: ErrorIngestEnvelopeItem,
  receivedAtMs: number,
}): BatchEventWireItem {
  if (!isErrorIngestScrubbedRecord(options.event)) throw new Error("Sentry envelope event must be an object");
  if (options.item.outcome.eventId === undefined) throw new Error("Sentry envelope event is missing its validated event id");

  const root = lastExceptionValue(options.event);
  const rootStacktrace = recordField(root, "stacktrace") ?? recordField(options.event, "stacktrace");
  const name = stringField(root, "type") ?? stringField(options.event, "name") ?? "Error";
  const message = stringField(root, "value") ?? stringField(options.event, "message") ?? "";
  const rawStack = stringField(rootStacktrace, "raw") ?? stringField(options.event, "stack") ?? stackFromFrames(rootStacktrace);
  const mechanism = recordField(root, "mechanism") ?? recordField(options.event, "mechanism");
  const handled = booleanField(mechanism, "handled") ?? booleanField(options.event, "handled") ?? true;
  const synthetic = booleanField(mechanism, "synthetic") ?? booleanField(options.event, "synthetic");
  const level = sentryLevel(stringField(options.event, "level"));

  const data: ErrorIngestScrubbedRecord = {
    ...options.event,
    event_id: options.item.outcome.eventId,
    event_type: "$error",
    kind: root === undefined ? "message" : "exception",
    name,
    message,
    handled,
  };
  if (rawStack !== undefined) data.stack = rawStack;
  if (synthetic !== undefined) data.synthetic = synthetic;
  if (level !== undefined) data.level = level;

  const traceId = traceIdFromEvent(options.event, options.header);
  const spanId = spanIdFromEvent(options.event);

  const result: BatchEventWireItem = {
    event_type: "$error",
    event_at_ms: eventTimeMs(options.event, options.receivedAtMs),
    data,
  };
  if (traceId !== undefined && spanId !== undefined) {
    result.trace_id = traceId;
    result.span_id = spanId;
  }
  if (level !== undefined) result.level = level;
  return result;
}

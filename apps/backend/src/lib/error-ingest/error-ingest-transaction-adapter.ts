import type { ErrorIngestScrubbedRecord, ErrorIngestScrubbedValue } from "./error-ingest-scrubber";
import { isErrorIngestScrubbedRecord, scrubErrorIngestPayload } from "./error-ingest-scrubber";
import type { ErrorIngestEnvelopeTransactionMetadata } from "./error-ingest-envelope";
import type { CanonicalOtlpSpan } from "@/lib/otlp/traces";
import type { OtlpAttributeValue, OtlpAttributes } from "@/lib/otlp/json";
import { isW3cSpanId } from "@hexclave/shared/dist/utils/analytics-wire";

const MAX_OTLP_TIMESTAMP_NANO = 18_446_744_073_709_551_615n;
const MAX_ATTRIBUTE_DEPTH = 8;
const MAX_ATTRIBUTE_BYTES = 64 * 1024;

export type SentryTransactionOtlpContext = {
  resource: CanonicalOtlpSpan["resource"],
  scope: CanonicalOtlpSpan["scope"],
};

export class ErrorIngestTransactionAdapterError extends Error {
  public readonly code: "invalid" | "payload_too_large";

  public constructor(code: "invalid" | "payload_too_large", message: string) {
    super(message);
    this.name = "ErrorIngestTransactionAdapterError";
    this.code = code;
  }
}

function boundedRecord(value: ErrorIngestScrubbedRecord, label: string): ErrorIngestScrubbedRecord {
  const result = scrubErrorIngestPayload(value, {
    maxPayloadBytes: MAX_ATTRIBUTE_BYTES,
    maxStringBytes: MAX_ATTRIBUTE_BYTES,
    maxCollectionEntries: 100,
  });
  if (result.value === undefined || !isErrorIngestScrubbedRecord(result.value)) {
    throw new ErrorIngestTransactionAdapterError("payload_too_large", `${label} exceeds its privacy budget`);
  }
  return result.value;
}

function toOtlpValue(value: ErrorIngestScrubbedValue, label: string, depth = 0): OtlpAttributeValue {
  if (depth > MAX_ATTRIBUTE_DEPTH) {
    throw new ErrorIngestTransactionAdapterError("payload_too_large", `${label} exceeds its attribute depth`);
  }
  if (value === null) return { type: "null", value: null };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ErrorIngestTransactionAdapterError("invalid", `${label} contains a non-finite number`);
    return Number.isSafeInteger(value)
      ? { type: "int", value: String(value) }
      : { type: "double", value };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      value: value.map((entry, index) => toOtlpValue(entry, `${label}[${index}]`, depth + 1)),
    };
  }
  const record = boundedRecord(value, label);
  return { type: "kvlist", value: toOtlpAttributes(record, label, depth + 1) };
}

function toOtlpAttributes(value: ErrorIngestScrubbedRecord, label: string, depth = 0): OtlpAttributes {
  const bounded = boundedRecord(value, label);
  const result: OtlpAttributes = new Map();
  for (const [key, entry] of Object.entries(bounded).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    result.set(key, toOtlpValue(entry, `${label}.${key}`, depth));
  }
  return result;
}

function addStringAttribute(attributes: OtlpAttributes, key: string, value: string | null): void {
  if (value !== null) attributes.set(key, { type: "string", value });
}

function addRecordAttribute(attributes: OtlpAttributes, key: string, value: ErrorIngestScrubbedRecord | null): void {
  if (value !== null) attributes.set(key, { type: "kvlist", value: toOtlpAttributes(value, key) });
}

function timestampToUnixNano(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ErrorIngestTransactionAdapterError("invalid", `${label} is outside the OTLP timestamp range`);
  }
  const nanos = BigInt(value) * 1_000_000n;
  if (nanos > MAX_OTLP_TIMESTAMP_NANO) {
    throw new ErrorIngestTransactionAdapterError("invalid", `${label} is outside the OTLP timestamp range`);
  }
  return nanos.toString();
}

function statusCode(value: string | null): number {
  if (value === null || value === "unknown") return 0;
  if (value === "ok") return 1;
  return 2;
}

function status(value: string | null): { code: number, message: string } {
  return { code: statusCode(value), message: value === "ok" || value === "unknown" ? "" : value ?? "" };
}

function rootAttributes(transaction: ErrorIngestEnvelopeTransactionMetadata): OtlpAttributes {
  const attributes: OtlpAttributes = new Map();
  addStringAttribute(attributes, "hexclave.signal.type", "custom_span");
  addStringAttribute(attributes, "sentry.event_id", transaction.eventId);
  addStringAttribute(attributes, "sentry.transaction.source", transaction.source);
  addStringAttribute(attributes, "sentry.transaction.op", transaction.traceOperation);
  addStringAttribute(attributes, "sentry.transaction.status", transaction.traceStatus);
  addStringAttribute(attributes, "sentry.transaction.origin", transaction.traceOrigin);
  addStringAttribute(attributes, "sentry.release", transaction.release);
  addStringAttribute(attributes, "sentry.environment", transaction.environment);
  addStringAttribute(attributes, "sentry.platform", transaction.platform);
  addRecordAttribute(attributes, "sentry.contexts", transaction.contexts);
  addRecordAttribute(attributes, "sentry.tags", transaction.tags);
  addRecordAttribute(attributes, "sentry.extra", transaction.extra);
  addRecordAttribute(attributes, "sentry.measurements", transaction.measurements);
  return attributes;
}

function childAttributes(
  transaction: ErrorIngestEnvelopeTransactionMetadata,
  span: ErrorIngestEnvelopeTransactionMetadata["spans"][number],
): OtlpAttributes {
  const attributes: OtlpAttributes = new Map();
  addStringAttribute(attributes, "hexclave.signal.type", "custom_span");
  addStringAttribute(attributes, "sentry.event_id", transaction.eventId);
  addStringAttribute(attributes, "sentry.transaction.name", transaction.name);
  addStringAttribute(attributes, "sentry.span.op", span.op);
  addStringAttribute(attributes, "sentry.span.description", span.description);
  addStringAttribute(attributes, "sentry.span.origin", span.origin);
  addStringAttribute(attributes, "sentry.span.status", span.status);
  addRecordAttribute(attributes, "sentry.span.data", span.data);
  addRecordAttribute(attributes, "sentry.span.tags", span.tags);
  addRecordAttribute(attributes, "sentry.span.measurements", span.measurements);
  return attributes;
}

function baseSpan(
  context: SentryTransactionOtlpContext,
): Pick<CanonicalOtlpSpan, "traceState" | "flags" | "kind" | "droppedAttributesCount" | "droppedEventsCount" | "droppedLinksCount" | "events" | "links" | "resource" | "scope"> {
  return {
    traceState: "",
    flags: 0,
    kind: 0,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    events: [],
    links: [],
    resource: context.resource,
    scope: context.scope,
  };
}

export function sentryTransactionToCanonicalOtlpSpans(
  transaction: ErrorIngestEnvelopeTransactionMetadata,
  context: SentryTransactionOtlpContext,
): CanonicalOtlpSpan[] {
  if (transaction.name === null) {
    throw new ErrorIngestTransactionAdapterError("invalid", "Transaction name is required");
  }
  if (transaction.parentSpanId !== null && !isW3cSpanId(transaction.parentSpanId)) {
    throw new ErrorIngestTransactionAdapterError("invalid", "Transaction parent_span_id must be a valid W3C span id");
  }

  const seenSpanIds = new Set<string>([transaction.spanId]);
  for (const span of transaction.spans) {
    if (seenSpanIds.has(span.spanId)) {
      throw new ErrorIngestTransactionAdapterError("invalid", "Transaction contains duplicate span identities");
    }
    seenSpanIds.add(span.spanId);
  }

  const root: CanonicalOtlpSpan = {
    ...baseSpan(context),
    traceId: transaction.traceId,
    spanId: transaction.spanId,
    parentSpanId: transaction.parentSpanId,
    name: transaction.name,
    startTimeUnixNano: timestampToUnixNano(transaction.startTimestampMs, "Transaction start_timestamp"),
    endTimeUnixNano: timestampToUnixNano(transaction.timestampMs, "Transaction timestamp"),
    attributes: rootAttributes(transaction),
    status: status(transaction.traceStatus),
  };

  const children = transaction.spans.map((span, index): CanonicalOtlpSpan => ({
    ...baseSpan(context),
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? transaction.spanId,
    name: span.op ?? span.description ?? "sentry.span",
    startTimeUnixNano: timestampToUnixNano(span.startTimestampMs, `Transaction span ${index} start_timestamp`),
    endTimeUnixNano: timestampToUnixNano(span.timestampMs, `Transaction span ${index} timestamp`),
    attributes: childAttributes(transaction, span),
    status: status(span.status),
  }));

  return [root, ...children];
}

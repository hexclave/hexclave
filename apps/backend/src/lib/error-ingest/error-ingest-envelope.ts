import { createHash } from "node:crypto";
import {
  createErrorIngestProtocolProjection,
  type ErrorIngestProtocolProjection,
} from "./error-ingest-protocol-adapter";
import { parseErrorIngestClientReportRequest, type ErrorIngestClientReportRequest } from "./error-ingest-client-reports";
import { createErrorIngestItemOutcome, type ErrorIngestItemOutcome, type ErrorIngestItemType } from "./error-ingest-outcomes";
import {
  isErrorIngestScrubbedRecord,
  scrubErrorIngestPayload,
  type ErrorIngestScrubbedValue,
} from "./error-ingest-scrubber";
import { isW3cSpanId, isW3cTraceId } from "@hexclave/shared/dist/utils/analytics-wire";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { utf8ByteLength } from "@/lib/utf8";

const TEXT_ENCODER = new TextEncoder();
const EVENT_ID_RE = /^[0-9a-f]{32}$/u;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]*$/u;
const SECRET_KEY_RE = /(?:access[-_.]?token|api[-_.]?key|authorization|cookie|credential|password|private[-_.]?key|refresh[-_.]?token|secret|session[-_.]?token|signature|token)/iu;
const SECRET_TEXT_RE = /(?:bearer\s+|basic\s+|-----begin [^-]*private key-----|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;
const SOURCE_MAP_FILENAME_RE = /\.map$/iu;

export const ERROR_INGEST_ENVELOPE_LIMITS = {
  maxEnvelopeBytes: 8 * 1024 * 1024,
  maxEnvelopeHeaderBytes: 16 * 1024,
  maxItemHeaderBytes: 16 * 1024,
  maxItems: 100,
  maxItemPayloadBytes: 2 * 1024 * 1024,
  maxEventPayloadBytes: 256 * 1024,
  maxClientReportPayloadBytes: 256 * 1024,
  maxClientReportEntries: 100,
  maxTransactionNameBytes: 200,
  maxTransactionDescriptionBytes: 2 * 1024,
  maxTransactionAttributeBytes: 64 * 1024,
  maxTransactionSourceBytes: 64,
  maxTransactionSpanCount: 1_000,
  maxHeaderTextBytes: 512,
  maxFilenameBytes: 255,
  maxContentTypeBytes: 255,
  maxAttachmentTypeBytes: 64,
};

export type ErrorIngestEnvelopeLimits = {
  [K in keyof typeof ERROR_INGEST_ENVELOPE_LIMITS]: number;
};

export type ErrorIngestEnvelopeHeader = {
  eventId: string | null,
  sentAt: string | null,
  sdk: { name: string, version: string } | null,
  trace: Readonly<Record<string, string>> | null,
  dsnPresent: boolean,
};

export type ErrorIngestEnvelopeAttachmentMetadata = {
  eventId: string,
  filename: string,
  contentType: string,
  attachmentType: string,
  byteLength: number,
  sha256: string,
};

export type ErrorIngestEnvelopeTransactionMetadata = {
  eventId: string,
  name: string | null,
  source: string | null,
  release: string | null,
  environment: string | null,
  platform: string | null,
  contexts: { [key: string]: ErrorIngestScrubbedValue } | null,
  tags: { [key: string]: ErrorIngestScrubbedValue } | null,
  extra: { [key: string]: ErrorIngestScrubbedValue } | null,
  measurements: { [key: string]: ErrorIngestScrubbedValue } | null,
  traceOperation: string | null,
  traceStatus: string | null,
  traceOrigin: string | null,
  startTimestampMs: number,
  timestampMs: number,
  durationMs: number,
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
  spanCount: number,
  spans: readonly ErrorIngestEnvelopeTransactionSpan[],
};

export type ErrorIngestEnvelopeTransactionSpan = {
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
  op: string | null,
  description: string | null,
  origin: string | null,
  status: string | null,
  startTimestampMs: number,
  timestampMs: number,
  data: { [key: string]: ErrorIngestScrubbedValue },
  tags: { [key: string]: ErrorIngestScrubbedValue } | null,
  measurements: { [key: string]: ErrorIngestScrubbedValue } | null,
};

export type ErrorIngestEnvelopeItem = {
  itemIndex: number,
  itemId: string,
  wireType: string,
  itemType: ErrorIngestItemType,
  payloadBytes: number,
  outcome: ErrorIngestItemOutcome,
  event?: ErrorIngestScrubbedValue,
  clientReport?: ErrorIngestClientReportRequest,
  transaction?: ErrorIngestEnvelopeTransactionMetadata,
  attachment?: ErrorIngestEnvelopeAttachmentMetadata,
};

export type ErrorIngestEnvelopeAttachmentPayload = ErrorIngestEnvelopeAttachmentMetadata & {
  itemId: string,
  itemIndex: number,
  bytes: Uint8Array,
};

export type ErrorIngestEnvelopeParseOptions = {
  limits?: Partial<ErrorIngestEnvelopeLimits>,
  onAttachment?: (payload: ErrorIngestEnvelopeAttachmentPayload) => void,
};

export type ErrorIngestEnvelope = {
  batchId: string,
  header: ErrorIngestEnvelopeHeader,
  items: readonly ErrorIngestEnvelopeItem[],
  protocolProjection: ErrorIngestProtocolProjection,
};

export type ErrorIngestEnvelopeRejectReason = "invalid" | "payload_too_large" | "unsupported";

export class ErrorIngestEnvelopeError extends Error {
  public readonly code: "malformed" | "payload_too_large" | "secret_metadata";

  public constructor(code: "malformed" | "payload_too_large" | "secret_metadata", message: string) {
    super(message);
    this.name = "ErrorIngestEnvelopeError";
    this.code = code;
  }
}

function byteLength(value: string): number {
  return utf8ByteLength(value);
}

function validateLimits(overrides: Partial<ErrorIngestEnvelopeLimits> | undefined): ErrorIngestEnvelopeLimits {
  const limits = { ...ERROR_INGEST_ENVELOPE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ErrorIngestEnvelopeError("malformed", `Envelope limit ${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function decodeUtf8(bytes: Uint8Array, context: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ErrorIngestEnvelopeError("malformed", `${context} is not valid UTF-8`);
  }
}

function nextNewline(bytes: Uint8Array, start: number): number {
  for (let index = start; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a) return index;
  }
  return -1;
}

function parseJsonLine(
  bytes: Uint8Array,
  start: number,
  maxBytes: number,
  context: string,
): { value: Readonly<Record<string, unknown>>, nextOffset: number } {
  const newline = nextNewline(bytes, start);
  if (newline < 0) throw new ErrorIngestEnvelopeError("malformed", `${context} is missing its newline`);
  const line = bytes.subarray(start, newline);
  if (line.byteLength === 0 || line.byteLength > maxBytes) {
    throw new ErrorIngestEnvelopeError("payload_too_large", `${context} exceeds its byte limit`);
  }
  const text = decodeUtf8(line, context);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ErrorIngestEnvelopeError("malformed", `${context} is not valid JSON`);
  }
  if (!isRecord(value)) throw new ErrorIngestEnvelopeError("malformed", `${context} must be a JSON object`);
  return { value, nextOffset: newline + 1 };
}

function safeText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > maxBytes || !SAFE_TEXT_RE.test(value)) {
    throw new ErrorIngestEnvelopeError("malformed", `${name} is not a bounded printable string`);
  }
  if (SECRET_TEXT_RE.test(value)) {
    throw new ErrorIngestEnvelopeError("secret_metadata", `${name} contains secret-bearing text`);
  }
  return value;
}

function safeOptionalText(value: unknown, name: string, maxBytes: number): string | null {
  if (value === undefined || value === null) return null;
  return safeText(value, name, maxBytes);
}

function validateEventId(value: unknown, name: string): string {
  if (typeof value !== "string" || !EVENT_ID_RE.test(value)) {
    throw new ErrorIngestEnvelopeError("malformed", `${name} must be 32 lowercase hexadecimal characters`);
  }
  return value;
}

function validateDsn(value: unknown): void {
  if (typeof value !== "string" || byteLength(value) > 512 || SECRET_TEXT_RE.test(value)) {
    throw new ErrorIngestEnvelopeError("secret_metadata", "Envelope DSN is not safe");
  }
  try {
    const parsed = new URL(value);
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username === "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
      throw new Error();
    }
  } catch {
    throw new ErrorIngestEnvelopeError("secret_metadata", "Envelope DSN is not a public DSN");
  }
}

function assertAllowedKeys(value: Readonly<Record<string, unknown>>, allowedKeys: ReadonlySet<string>, context: string): void {
  for (const key of Object.keys(value)) {
    if (SECRET_KEY_RE.test(key)) {
      throw new ErrorIngestEnvelopeError("secret_metadata", `${context} contains secret-bearing metadata`);
    }
    if (!allowedKeys.has(key)) {
      throw new ErrorIngestEnvelopeError("malformed", `${context} contains unsupported metadata`);
    }
  }
}

function parseEnvelopeHeader(value: Readonly<Record<string, unknown>>, limits: ErrorIngestEnvelopeLimits): ErrorIngestEnvelopeHeader {
  assertAllowedKeys(value, new Set(["event_id", "sent_at", "sdk", "trace", "dsn"]), "Envelope header");
  const eventId = value.event_id === undefined ? null : validateEventId(value.event_id, "Envelope event_id");
  const sentAt = safeOptionalText(value.sent_at, "Envelope sent_at", limits.maxHeaderTextBytes);

  let sdk: ErrorIngestEnvelopeHeader["sdk"] = null;
  if (value.sdk !== undefined) {
    if (!isRecord(value.sdk)) throw new ErrorIngestEnvelopeError("malformed", "Envelope sdk must be an object");
    assertAllowedKeys(value.sdk, new Set(["name", "version"]), "Envelope sdk");
    sdk = {
      name: safeText(value.sdk.name, "Envelope sdk.name", limits.maxHeaderTextBytes),
      version: safeText(value.sdk.version, "Envelope sdk.version", limits.maxHeaderTextBytes),
    };
  }

  let trace: Readonly<Record<string, string>> | null = null;
  if (value.trace !== undefined) {
    if (!isRecord(value.trace)) throw new ErrorIngestEnvelopeError("malformed", "Envelope trace must be an object");
    const traceKeys = new Set([
      "trace_id",
      "public_key",
      "sample_rate",
      "release",
      "environment",
      "transaction",
      "sampled",
      "replay_id",
      "sample_rand",
      "org_id",
    ]);
    assertAllowedKeys(value.trace, traceKeys, "Envelope trace");
    const parsedTrace: Record<string, string> = {};
    for (const [key, traceValue] of Object.entries(value.trace)) {
      parsedTrace[key] = safeText(traceValue, `Envelope trace.${key}`, limits.maxHeaderTextBytes);
    }
    trace = parsedTrace;
  }

  let dsnPresent = false;
  if (value.dsn !== undefined) {
    validateDsn(value.dsn);
    dsnPresent = true;
  }

  return { eventId, sentAt, sdk, trace, dsnPresent };
}

function scrubEventPayload(value: unknown, limits: ErrorIngestEnvelopeLimits): ErrorIngestScrubbedValue {
  const scrubbed = scrubErrorIngestPayload(value, {
    // Trust the validated limit: item framing above already rejected payloads
    // larger than limits.maxEventPayloadBytes, so clamping it here would only
    // create an inconsistency between the two checks.
    maxPayloadBytes: limits.maxEventPayloadBytes,
  });
  if (scrubbed.value === undefined || !isErrorIngestScrubbedRecord(scrubbed.value)) {
    throw new ErrorIngestEnvelopeError("malformed", "Event payload is not a bounded JSON object");
  }
  return scrubbed.value;
}

function transactionText(
  value: ErrorIngestScrubbedValue | undefined,
  name: string,
  maxBytes: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > maxBytes || !SAFE_TEXT_RE.test(value)) {
    throw new ErrorIngestEnvelopeError("malformed", `${name} is not a bounded printable string`);
  }
  return value;
}

function transactionRecordField(value: ErrorIngestScrubbedValue | undefined, key: string): ErrorIngestScrubbedValue | undefined {
  return isErrorIngestScrubbedRecord(value) ? value[key] : undefined;
}

function transactionRecord(
  value: ErrorIngestScrubbedValue | undefined,
  name: string,
): { [key: string]: ErrorIngestScrubbedValue } | null {
  if (value === undefined || value === null) return null;
  if (!isErrorIngestScrubbedRecord(value)) throw new ErrorIngestEnvelopeError("malformed", `${name} must be an object`);
  return value;
}

function transactionAttributeBudget(
  value: { [key: string]: ErrorIngestScrubbedValue } | null,
  name: string,
  limits: ErrorIngestEnvelopeLimits,
): { [key: string]: ErrorIngestScrubbedValue } | null {
  if (value === null) return null;
  if (byteLength(JSON.stringify(value)) > limits.maxTransactionAttributeBytes) {
    throw new ErrorIngestEnvelopeError("payload_too_large", `${name} exceeds its byte limit`);
  }
  return value;
}

function parseTransactionTimestamp(value: unknown, name: string): number {
  let timestampMs: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new ErrorIngestEnvelopeError("malformed", `${name} is not a valid Sentry timestamp`);
    }
    timestampMs = Math.round(value * 1_000);
  } else if (typeof value === "string") {
    if (value.length === 0 || byteLength(value) > 64 || !SAFE_TEXT_RE.test(value)) {
      throw new ErrorIngestEnvelopeError("malformed", `${name} is not a valid Sentry timestamp`);
    }
    timestampMs = Date.parse(value);
  } else {
    throw new ErrorIngestEnvelopeError("malformed", `${name} is not a valid Sentry timestamp`);
  }

  if (!Number.isSafeInteger(timestampMs) || !Number.isFinite(new Date(timestampMs).getTime())) {
    throw new ErrorIngestEnvelopeError("malformed", `${name} is outside the supported date range`);
  }
  return timestampMs;
}

function parseTransactionSpan(
  value: unknown,
  scrubbedValue: ErrorIngestScrubbedValue,
  index: number,
  transaction: { traceId: string, spanId: string },
  limits: ErrorIngestEnvelopeLimits,
): ErrorIngestEnvelopeTransactionSpan {
  if (!isRecord(value) || !isErrorIngestScrubbedRecord(scrubbedValue)) {
    throw new ErrorIngestEnvelopeError("malformed", `Transaction span ${index} must be an object`);
  }
  const traceId = transactionId(value.trace_id, `Transaction span ${index} trace_id`, /^[0-9a-f]{32}$/u, isW3cTraceId);
  if (traceId !== transaction.traceId) {
    throw new ErrorIngestEnvelopeError("malformed", `Transaction span ${index} trace_id does not match the transaction`);
  }
  const spanId = transactionId(value.span_id, `Transaction span ${index} span_id`, /^[0-9a-f]{16}$/u, isW3cSpanId);
  if (spanId === transaction.spanId) {
    throw new ErrorIngestEnvelopeError("malformed", `Transaction span ${index} reuses the transaction span_id`);
  }

  let parentSpanId: string | null = null;
  if (value.parent_span_id !== undefined && value.parent_span_id !== null) {
    parentSpanId = transactionId(value.parent_span_id, `Transaction span ${index} parent_span_id`, /^[0-9a-f]{16}$/u, isW3cSpanId);
    if (parentSpanId === spanId) {
      throw new ErrorIngestEnvelopeError("malformed", `Transaction span ${index} is self-parented`);
    }
  }

  const startTimestampMs = parseTransactionTimestamp(value.start_timestamp, `Transaction span ${index} start_timestamp`);
  const timestampMs = parseTransactionTimestamp(value.timestamp, `Transaction span ${index} timestamp`);
  if (timestampMs < startTimestampMs) {
    throw new ErrorIngestEnvelopeError("malformed", `Transaction span ${index} timestamp precedes start_timestamp`);
  }

  const op = transactionText(transactionRecordField(scrubbedValue, "op"), `Transaction span ${index} op`, limits.maxTransactionDescriptionBytes);
  const description = transactionText(transactionRecordField(scrubbedValue, "description"), `Transaction span ${index} description`, limits.maxTransactionDescriptionBytes);
  const origin = transactionText(transactionRecordField(scrubbedValue, "origin"), `Transaction span ${index} origin`, limits.maxTransactionSourceBytes);
  const status = transactionText(transactionRecordField(scrubbedValue, "status"), `Transaction span ${index} status`, limits.maxTransactionSourceBytes);
  const data = transactionAttributeBudget(
    transactionRecord(transactionRecordField(scrubbedValue, "data"), `Transaction span ${index} data`) ?? {},
    `Transaction span ${index} data`,
    limits,
  ) ?? {};
  const tags = transactionAttributeBudget(
    transactionRecord(transactionRecordField(scrubbedValue, "tags"), `Transaction span ${index} tags`),
    `Transaction span ${index} tags`,
    limits,
  );
  const measurements = transactionAttributeBudget(
    transactionRecord(transactionRecordField(scrubbedValue, "measurements"), `Transaction span ${index} measurements`),
    `Transaction span ${index} measurements`,
    limits,
  );

  return {
    traceId,
    spanId,
    parentSpanId,
    op,
    description,
    origin,
    status,
    startTimestampMs,
    timestampMs,
    data,
    tags,
    measurements,
  };
}

function transactionId(value: unknown, name: string, pattern: RegExp, validator: (value: unknown) => boolean = () => true): string {
  if (typeof value !== "string" || !pattern.test(value) || !validator(value)) {
    throw new ErrorIngestEnvelopeError("malformed", `${name} is not a valid Sentry trace identifier`);
  }
  return value;
}

function parseTransactionMetadata(
  rawTransaction: Readonly<Record<string, unknown>>,
  envelopeHeader: ErrorIngestEnvelopeHeader,
  limits: ErrorIngestEnvelopeLimits,
): ErrorIngestEnvelopeTransactionMetadata {
  if (rawTransaction.type !== undefined && rawTransaction.type !== "transaction") {
    throw new ErrorIngestEnvelopeError("malformed", "Transaction payload type must be transaction");
  }

  const payloadEventId = rawTransaction.event_id === undefined
    ? null
    : validateEventId(rawTransaction.event_id, "Transaction event_id");
  if (envelopeHeader.eventId !== null && payloadEventId !== null && envelopeHeader.eventId !== payloadEventId) {
    throw new ErrorIngestEnvelopeError("malformed", "Envelope and transaction event_id values disagree");
  }
  const eventId = payloadEventId ?? envelopeHeader.eventId;
  if (eventId === null) throw new ErrorIngestEnvelopeError("malformed", "Transaction requires an event_id");

  const startTimestampMs = parseTransactionTimestamp(rawTransaction.start_timestamp, "Transaction start_timestamp");
  const timestampMs = parseTransactionTimestamp(rawTransaction.timestamp, "Transaction timestamp");
  if (timestampMs < startTimestampMs) {
    throw new ErrorIngestEnvelopeError("malformed", "Transaction timestamp precedes start_timestamp");
  }

  const rawSpans = rawTransaction.spans;
  if (rawSpans !== undefined && !Array.isArray(rawSpans)) {
    throw new ErrorIngestEnvelopeError("malformed", "Transaction spans must be an array");
  }
  const spanCount = rawSpans?.length ?? 0;
  if (spanCount > limits.maxTransactionSpanCount) {
    throw new ErrorIngestEnvelopeError("payload_too_large", "Transaction contains too many spans");
  }

  const rawContexts = rawTransaction.contexts;
  if (!isRecord(rawContexts)) throw new ErrorIngestEnvelopeError("malformed", "Transaction contexts are required");
  const rawTrace = rawContexts.trace;
  if (!isRecord(rawTrace)) throw new ErrorIngestEnvelopeError("malformed", "Transaction trace context is required");
  const traceId = transactionId(rawTrace.trace_id, "Transaction trace_id", /^[0-9a-f]{32}$/u, isW3cTraceId);
  const spanId = transactionId(rawTrace.span_id, "Transaction span_id", /^[0-9a-f]{16}$/u, isW3cSpanId);
  let parentSpanId: string | null = null;
  if (rawTrace.parent_span_id !== undefined && rawTrace.parent_span_id !== null) {
    parentSpanId = transactionId(rawTrace.parent_span_id, "Transaction parent_span_id", /^[0-9a-f]{16}$/u, isW3cSpanId);
    if (parentSpanId === spanId) {
      throw new ErrorIngestEnvelopeError("malformed", "Transaction is self-parented");
    }
  }

  const scrubbedResult = scrubErrorIngestPayload(rawTransaction, {
    // Same as scrubEventPayload: trust the validated limit — the transaction
    // item was already size-checked against limits.maxEventPayloadBytes during
    // framing.
    maxPayloadBytes: limits.maxEventPayloadBytes,
    maxCollectionEntries: Math.max(100, limits.maxTransactionSpanCount + 1),
  });
  if (scrubbedResult.value === undefined || !isErrorIngestScrubbedRecord(scrubbedResult.value)) {
    throw new ErrorIngestEnvelopeError("malformed", "Transaction payload is not a bounded JSON object");
  }
  const scrubbed = scrubbedResult.value;
  const transactionInfo = transactionRecordField(scrubbed, "transaction_info");
  const name = transactionText(transactionRecordField(scrubbed, "transaction"), "Transaction name", limits.maxTransactionNameBytes);
  const source = transactionText(transactionRecordField(transactionInfo, "source"), "Transaction source", limits.maxTransactionSourceBytes);
  const contexts = transactionAttributeBudget(transactionRecord(transactionRecordField(scrubbed, "contexts"), "Transaction contexts"), "Transaction contexts", limits);
  const tags = transactionAttributeBudget(transactionRecord(transactionRecordField(scrubbed, "tags"), "Transaction tags"), "Transaction tags", limits);
  const extra = transactionAttributeBudget(transactionRecord(transactionRecordField(scrubbed, "extra"), "Transaction extra"), "Transaction extra", limits);
  const measurements = transactionAttributeBudget(transactionRecord(transactionRecordField(scrubbed, "measurements"), "Transaction measurements"), "Transaction measurements", limits);
  const scrubbedTrace = transactionRecord(transactionRecordField(contexts ?? undefined, "trace"), "Transaction trace context");
  const traceOperation = transactionText(transactionRecordField(scrubbedTrace ?? undefined, "op"), "Transaction trace op", limits.maxTransactionDescriptionBytes);
  const traceStatus = transactionText(transactionRecordField(scrubbedTrace ?? undefined, "status"), "Transaction trace status", limits.maxTransactionSourceBytes);
  const traceOrigin = transactionText(transactionRecordField(scrubbedTrace ?? undefined, "origin"), "Transaction trace origin", limits.maxTransactionSourceBytes);
  const release = transactionText(transactionRecordField(scrubbed, "release"), "Transaction release", limits.maxHeaderTextBytes);
  const environment = transactionText(transactionRecordField(scrubbed, "environment"), "Transaction environment", limits.maxHeaderTextBytes);
  const platform = transactionText(transactionRecordField(scrubbed, "platform"), "Transaction platform", limits.maxHeaderTextBytes);

  const scrubbedSpansValue = transactionRecordField(scrubbed, "spans");
  const scrubbedSpans = scrubbedSpansValue === undefined || scrubbedSpansValue === null
    ? []
    : Array.isArray(scrubbedSpansValue) ? scrubbedSpansValue : null;
  if (scrubbedSpans === null) throw new ErrorIngestEnvelopeError("malformed", "Transaction spans must be an array");
  if (scrubbedSpans.length !== spanCount) {
    throw new ErrorIngestEnvelopeError("payload_too_large", "Transaction spans were truncated by the privacy boundary");
  }
  const spans = (rawSpans ?? []).map((span, index) => parseTransactionSpan(
    span,
    scrubbedSpans[index] ?? null,
    index,
    { traceId, spanId },
    limits,
  ));

  return {
    eventId,
    name,
    source,
    release,
    environment,
    platform,
    contexts,
    tags,
    extra,
    measurements,
    traceOperation,
    traceStatus,
    traceOrigin,
    startTimestampMs,
    timestampMs,
    durationMs: timestampMs - startTimestampMs,
    traceId,
    spanId,
    parentSpanId,
    spanCount,
    spans,
  };
}

function parseClientReportPayload(
  value: unknown,
  idempotencyKey: string,
  limits: ErrorIngestEnvelopeLimits,
): ErrorIngestClientReportRequest {
  if (!isRecord(value)) throw new ErrorIngestEnvelopeError("malformed", "Client report payload must be an object");
  const fields: readonly ("discarded_events" | "rate_limited_events" | "filtered_events" | "filtered_sampling_events")[] = [
    "discarded_events",
    "rate_limited_events",
    "filtered_events",
    "filtered_sampling_events",
  ];
  // Staging value for the canonical client-report parser: absent categories
  // are defaulted to [] on the wire, everything else stays unparsed for
  // parseErrorIngestClientReportRequest to validate. An explicitly-undefined
  // timestamp reads the same as an absent one there.
  const normalized = {
    idempotency_key: idempotencyKey,
    timestamp: value.timestamp,
    discarded_events: value.discarded_events === undefined ? [] : value.discarded_events,
    rate_limited_events: value.rate_limited_events === undefined ? [] : value.rate_limited_events,
    filtered_events: value.filtered_events === undefined ? [] : value.filtered_events,
    filtered_sampling_events: value.filtered_sampling_events === undefined ? [] : value.filtered_sampling_events,
  };
  try {
    const parsed = parseErrorIngestClientReportRequest(normalized);
    const entryCount = fields.reduce((count, field) => count + parsed.clientReport[field].length, 0);
    if (entryCount > limits.maxClientReportEntries) {
      throw new ErrorIngestEnvelopeError("payload_too_large", "Client report contains too many entries");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ErrorIngestEnvelopeError) throw error;
    throw new ErrorIngestEnvelopeError("malformed", "Client report payload is invalid");
  }
}

function parseAttachmentMetadata(
  header: Readonly<Record<string, unknown>>,
  payload: Uint8Array,
  eventId: string | null,
  limits: ErrorIngestEnvelopeLimits,
): ErrorIngestEnvelopeAttachmentMetadata {
  if (eventId === null) throw new ErrorIngestEnvelopeError("malformed", "Attachment requires an envelope event_id");
  assertAllowedKeys(header, new Set(["type", "length", "filename", "content_type", "attachment_type"]), "Attachment header");
  const filename = safeText(header.filename, "Attachment filename", limits.maxFilenameBytes);
  if (filename === "." || filename === ".." || /[\\/]/u.test(filename)) {
    throw new ErrorIngestEnvelopeError("malformed", "Attachment filename must be one safe path segment");
  }
  const contentType = safeOptionalText(header.content_type, "Attachment content_type", limits.maxContentTypeBytes) ?? "application/octet-stream";
  const attachmentType = safeOptionalText(header.attachment_type, "Attachment attachment_type", limits.maxAttachmentTypeBytes) ?? "event.attachment";
  const sha256 = createHash("sha256").update(payload).digest("hex");
  return { eventId, filename, contentType, attachmentType, byteLength: payload.byteLength, sha256 };
}

function scrubAttachmentPayload(
  metadata: ErrorIngestEnvelopeAttachmentMetadata,
  payload: Uint8Array,
  limits: ErrorIngestEnvelopeLimits,
): Uint8Array {
  const mediaType = metadata.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const isJson = mediaType === "application/json"
    || mediaType.endsWith("+json")
    || SOURCE_MAP_FILENAME_RE.test(metadata.filename)
    || metadata.attachmentType === "event.view_hierarchy";
  const isText = mediaType.startsWith("text/");

  if (!isJson && !isText) return new Uint8Array(payload);

  const text = decodeUtf8(payload, "Textual attachment payload");
  let value: unknown = text;
  if (isJson) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new ErrorIngestEnvelopeError("malformed", "JSON attachment payload is not valid JSON");
    }
  }

  const scrubbed = scrubErrorIngestPayload(value, {
    maxPayloadBytes: limits.maxItemPayloadBytes,
    maxStringBytes: limits.maxItemPayloadBytes,
  });
  if (scrubbed.value === undefined) {
    throw new ErrorIngestEnvelopeError("payload_too_large", "Scrubbed attachment payload exceeds its byte limit");
  }

  const output = isJson ? JSON.stringify(scrubbed.value) : scrubbed.value;
  if (typeof output !== "string") {
    throw new ErrorIngestEnvelopeError("malformed", "Attachment payload could not be serialized safely");
  }
  // TextEncoder (not utf8ByteLength/Buffer) is intentional here: we need the
  // encoded bytes themselves, and untrusted input may contain lone surrogates
  // that must be encoded with standard U+FFFD replacement semantics.
  const scrubbedBytes = TEXT_ENCODER.encode(output);
  if (scrubbedBytes.byteLength > limits.maxItemPayloadBytes) {
    throw new ErrorIngestEnvelopeError("payload_too_large", "Scrubbed attachment payload exceeds its byte limit");
  }
  return scrubbedBytes;
}

function payloadAsJson(payload: Uint8Array, context: string): Json {
  const text = decodeUtf8(payload, context);
  try {
    // JSON.parse output is Json by construction; the annotation replaces the
    // `any` the lib signature would otherwise leak.
    const parsed: Json = JSON.parse(text);
    return parsed;
  } catch {
    throw new ErrorIngestEnvelopeError("malformed", `${context} is not valid JSON`);
  }
}

function rejectItem(
  itemIndex: number,
  itemId: string,
  wireType: string,
  itemType: ErrorIngestItemType,
  payloadBytes: number,
  reason: ErrorIngestEnvelopeRejectReason,
): ErrorIngestEnvelopeItem {
  const outcome = createErrorIngestItemOutcome(
    { itemId, itemType },
    { status: "rejected", reason },
  );
  return { itemIndex, itemId, wireType, itemType, payloadBytes, outcome };
}

function itemTypeForWireType(value: string): ErrorIngestItemType {
  switch (value) {
    case "event": { return "event"; }
    case "transaction": { return "transaction"; }
    case "attachment": { return "attachment"; }
    case "client_report": { return "client_report"; }
    default: { return "unknown"; }
  }
}

export function parseErrorIngestEnvelope(
  input: Uint8Array | ArrayBuffer,
  options?: ErrorIngestEnvelopeParseOptions,
): ErrorIngestEnvelope {
  const limits = validateLimits(options?.limits);
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (bytes.byteLength === 0) throw new ErrorIngestEnvelopeError("malformed", "Envelope body is empty");
  if (bytes.byteLength > limits.maxEnvelopeBytes) throw new ErrorIngestEnvelopeError("payload_too_large", "Envelope body is too large");

  const headerLine = parseJsonLine(bytes, 0, limits.maxEnvelopeHeaderBytes, "Envelope header");
  const header = parseEnvelopeHeader(headerLine.value, limits);
  const batchId = header.eventId === null
    ? `envelope:${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`
    : `envelope:event:${header.eventId}`;
  const items: ErrorIngestEnvelopeItem[] = [];
  let offset = headerLine.nextOffset;

  while (offset < bytes.byteLength) {
    if (items.length >= limits.maxItems) throw new ErrorIngestEnvelopeError("payload_too_large", "Envelope contains too many items");
    const itemHeaderLine = parseJsonLine(bytes, offset, limits.maxItemHeaderBytes, "Envelope item header");
    const itemHeader = itemHeaderLine.value;
    const itemIndex = items.length;
    const wireType = typeof itemHeader.type === "string" && itemHeader.type.length > 0
      ? safeText(itemHeader.type, "Envelope item type", limits.maxHeaderTextBytes)
      : "";
    const itemId = `${batchId}:item:${itemIndex}`;
    const itemType = itemTypeForWireType(wireType);
    const length = itemHeader.length;
    let payloadEnd: number;
    let nextOffset: number;
    if (length === undefined) {
      const newline = nextNewline(bytes, itemHeaderLine.nextOffset);
      payloadEnd = newline < 0 ? bytes.byteLength : newline;
      nextOffset = newline < 0 ? bytes.byteLength : newline + 1;
    } else {
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        throw new ErrorIngestEnvelopeError("malformed", "Envelope item length is invalid");
      }
      payloadEnd = itemHeaderLine.nextOffset + length;
      if (payloadEnd > bytes.byteLength || (payloadEnd < bytes.byteLength && bytes[payloadEnd] !== 0x0a)) {
        throw new ErrorIngestEnvelopeError("malformed", "Envelope item payload framing is invalid");
      }
      nextOffset = payloadEnd < bytes.byteLength ? payloadEnd + 1 : payloadEnd;
    }
    const payload = bytes.subarray(itemHeaderLine.nextOffset, payloadEnd);
    offset = nextOffset;

    if (payload.byteLength > limits.maxItemPayloadBytes) {
      items.push(rejectItem(itemIndex, itemId, wireType, itemType, payload.byteLength, "payload_too_large"));
      continue;
    }

    try {
      if (wireType === "event") {
        if (payload.byteLength > limits.maxEventPayloadBytes) {
          items.push(rejectItem(itemIndex, itemId, wireType, itemType, payload.byteLength, "payload_too_large"));
          continue;
        }
        assertAllowedKeys(itemHeader, new Set(["type", "length", "content_type"]), "Event item header");
        safeOptionalText(itemHeader.content_type, "Event content_type", limits.maxContentTypeBytes);
        const rawEvent = payloadAsJson(payload, "Event payload");
        if (!isRecord(rawEvent)) throw new ErrorIngestEnvelopeError("malformed", "Event payload must be an object");
        // A parsed-JSON record can never hold an `undefined` value, so key
        // presence is the precise "was event_id sent" check.
        const payloadEventId = "event_id" in rawEvent ? validateEventId(rawEvent.event_id, "Event event_id") : null;
        if (header.eventId !== null && payloadEventId !== null && header.eventId !== payloadEventId) {
          throw new ErrorIngestEnvelopeError("malformed", "Envelope and event event_id values disagree");
        }
        const eventId = payloadEventId ?? header.eventId;
        if (eventId === null) throw new ErrorIngestEnvelopeError("malformed", "Event requires an event_id");
        const event = scrubEventPayload(rawEvent, limits);
        const outcome = createErrorIngestItemOutcome({ itemId, itemType, eventId }, { status: "accepted" });
        items.push({ itemIndex, itemId, wireType, itemType, payloadBytes: payload.byteLength, outcome, event });
        continue;
      }

      if (wireType === "client_report") {
        if (payload.byteLength > limits.maxClientReportPayloadBytes) {
          items.push(rejectItem(itemIndex, itemId, wireType, itemType, payload.byteLength, "payload_too_large"));
          continue;
        }
        assertAllowedKeys(itemHeader, new Set(["type", "length"]), "Client report item header");
        const report = parseClientReportPayload(payloadAsJson(payload, "Client report payload"), `${batchId}:${itemIndex}`, limits);
        const outcome = createErrorIngestItemOutcome({ itemId, itemType }, { status: "accepted" });
        items.push({ itemIndex, itemId, wireType, itemType, payloadBytes: payload.byteLength, outcome, clientReport: report });
        continue;
      }

      if (wireType === "transaction") {
        if (payload.byteLength > limits.maxEventPayloadBytes) {
          items.push(rejectItem(itemIndex, itemId, wireType, itemType, payload.byteLength, "payload_too_large"));
          continue;
        }
        assertAllowedKeys(itemHeader, new Set(["type", "length", "content_type"]), "Transaction item header");
        const contentType = safeOptionalText(itemHeader.content_type, "Transaction content_type", limits.maxContentTypeBytes);
        if (contentType !== null && !/^application\/json(?:;[^\u0000-\u001f\u007f]*)?$/iu.test(contentType)) {
          throw new ErrorIngestEnvelopeError("malformed", "Transaction content_type must be application/json");
        }
        const rawTransaction = payloadAsJson(payload, "Transaction payload");
        if (!isRecord(rawTransaction)) throw new ErrorIngestEnvelopeError("malformed", "Transaction payload must be an object");
        const transaction = parseTransactionMetadata(rawTransaction, header, limits);
        const outcome = createErrorIngestItemOutcome({ itemId, itemType, eventId: transaction.eventId }, { status: "accepted" });
        items.push({ itemIndex, itemId, wireType, itemType, payloadBytes: payload.byteLength, outcome, transaction });
        continue;
      }

      if (wireType === "attachment") {
        if (length === undefined) throw new ErrorIngestEnvelopeError("malformed", "Attachment requires a declared length");
        const rawAttachment = parseAttachmentMetadata(itemHeader, payload, header.eventId, limits);
        const privateBytes = scrubAttachmentPayload(rawAttachment, payload, limits);
        const attachment = parseAttachmentMetadata(itemHeader, privateBytes, header.eventId, limits);
        const outcome = createErrorIngestItemOutcome({ itemId, itemType, eventId: attachment.eventId }, { status: "accepted" });
        options?.onAttachment?.({ ...attachment, itemId, itemIndex, bytes: privateBytes });
        items.push({ itemIndex, itemId, wireType, itemType, payloadBytes: payload.byteLength, outcome, attachment });
        continue;
      }

      items.push(rejectItem(itemIndex, itemId, wireType, itemType, payload.byteLength, "unsupported"));
    } catch (error) {
      if (error instanceof ErrorIngestEnvelopeError) {
        const reason: ErrorIngestEnvelopeRejectReason = error.code === "payload_too_large" ? "payload_too_large" : "invalid";
        items.push(rejectItem(itemIndex, itemId, wireType, itemType, payload.byteLength, reason));
        continue;
      }
      throw error;
    }
  }

  const protocolProjection = createErrorIngestProtocolProjection(batchId, items.map((item) => item.outcome));
  return { batchId, header, items, protocolProjection };
}

import type { ReadonlyJson } from "./json";
import { isRecord } from "./objects";

/** Stable product schema identifier, stamped onto every normalized envelope. */
export const ERROR_ENVELOPE_SCHEMA = "hexclave.error-envelope";
export const ERROR_ENVELOPE_VERSION = 1;

export type ErrorEnvelopeLimits = {
  maxDepth: number,
  maxEventBytes: number,
  maxStringBytes: number,
  maxExceptionValues: number,
  maxFrames: number,
  maxBreadcrumbs: number,
  maxTags: number,
  maxContexts: number,
  maxExtraFields: number,
  maxAttachmentItems: number,
  maxDebugImages: number,
  maxCollectionEntries: number,
};

export const ERROR_ENVELOPE_LIMITS: ErrorEnvelopeLimits = {
  maxDepth: 8,
  maxEventBytes: 256 * 1024,
  maxStringBytes: 8 * 1024,
  maxExceptionValues: 10,
  maxFrames: 50,
  maxBreadcrumbs: 100,
  maxTags: 100,
  maxContexts: 50,
  maxExtraFields: 100,
  maxAttachmentItems: 20,
  maxDebugImages: 20,
  maxCollectionEntries: 100,
};

export type ErrorEnvelopeLevel = "fatal" | "error" | "warning" | "info" | "debug" | "log";
export type ErrorEnvelopeKind = "exception" | "message" | "event";

export type ErrorEnvelopeMechanism = {
  type?: string,
  handled?: boolean,
  synthetic?: boolean,
  data?: Readonly<Record<string, ReadonlyJson>>,
};

export type ErrorEnvelopeStackFrame = {
  filename?: string,
  abs_path?: string,
  function?: string,
  module?: string,
  lineno?: number,
  colno?: number,
  in_app?: boolean,
  context_line?: string,
};

export type ErrorEnvelopeStacktrace = {
  raw?: string,
  frames?: readonly ErrorEnvelopeStackFrame[],
  symbolication_state?: "pending" | "complete" | "failed" | "not_requested",
};

export type ErrorEnvelopeExceptionValue = {
  type?: string,
  value?: string,
  module?: string,
  mechanism?: ErrorEnvelopeMechanism,
  stacktrace?: ErrorEnvelopeStacktrace,
};

export type ErrorEnvelopeUser = {
  id?: string,
  email?: string,
  username?: string,
};

/** Only these request fields are safe to retain by default. Headers, query, cookies, and bodies are intentionally absent. */
export type ErrorEnvelopeRequest = {
  url?: string,
  method?: string,
  status_code?: number,
};

export type ErrorEnvelopeBreadcrumb = {
  timestamp?: number,
  category?: string,
  message?: string,
  level?: ErrorEnvelopeLevel,
  data?: Readonly<Record<string, ReadonlyJson>>,
};

export type ErrorEnvelopeSdk = {
  name?: string,
  version?: string,
  integrations?: readonly string[],
};

export type ErrorEnvelopeRuntime = {
  platform?: string,
  name?: string,
  version?: string,
  service_name?: string,
  service_version?: string,
};

export type ErrorEnvelopeCorrelation = {
  trace_id?: string,
  span_id?: string,
  parent_span_id?: string,
  page_view_id?: string,
  session_id?: string,
  replay_id?: string,
};

export type ErrorEnvelopeDebugImage = {
  type?: string,
  debug_id?: string,
  code_file?: string,
  arch?: string,
  image_addr?: string,
  image_size?: string,
  uuid?: string,
  name?: string,
};

export type ErrorEnvelopeDebugMeta = {
  images?: readonly ErrorEnvelopeDebugImage[],
};

export type ErrorEnvelopeAttachment = {
  id?: string,
  filename?: string,
  content_type?: string,
  size?: number,
  checksum?: string,
  attachment_type?: string,
};

export type ErrorEnvelopeItemMetadata = {
  item_type: "event",
  content_type?: string,
  length?: number,
  filename?: string,
};

export type ErrorEnvelopeNormalization = {
  truncated: boolean,
  dropped: readonly string[],
};

export type ErrorEnvelopeV1 = {
  schema: typeof ERROR_ENVELOPE_SCHEMA,
  version: typeof ERROR_ENVELOPE_VERSION,
  event_id: string,
  kind: ErrorEnvelopeKind,
  level: ErrorEnvelopeLevel,
  handled: boolean,
  synthetic?: boolean,
  message?: string,
  name?: string,
  stack?: string,
  exception?: {
    values: readonly ErrorEnvelopeExceptionValue[],
  },
  stacktrace?: ErrorEnvelopeStacktrace,
  mechanism?: ErrorEnvelopeMechanism,
  request?: ErrorEnvelopeRequest,
  user?: ErrorEnvelopeUser,
  tags: Readonly<Record<string, string>>,
  contexts: Readonly<Record<string, ReadonlyJson>>,
  extra: Readonly<Record<string, ReadonlyJson>>,
  breadcrumbs: readonly ErrorEnvelopeBreadcrumb[],
  fingerprint: readonly string[],
  sdk?: ErrorEnvelopeSdk,
  runtime?: ErrorEnvelopeRuntime,
  release?: string,
  dist?: string,
  environment?: string,
  correlation?: ErrorEnvelopeCorrelation,
  debug_meta?: ErrorEnvelopeDebugMeta,
  attachments: readonly ErrorEnvelopeAttachment[],
  item_metadata: ErrorEnvelopeItemMetadata,
  normalization: ErrorEnvelopeNormalization,
};

/**
 * The flat `$error` payload as produced by our SDKs on the wire (either
 * directly or projected out of an OTLP LogRecord's `hexclave.data` attribute
 * by the OTLP receiver). Every field is `unknown` because this is the
 * untrusted pre-normalization shape; `normalizeErrorEnvelope` bounds and types
 * it into `ErrorEnvelopeV1`.
 */
export type FlatErrorEventInput = {
  event_id?: unknown,
  kind?: unknown,
  level?: unknown,
  handled?: unknown,
  synthetic?: unknown,
  message?: unknown,
  name?: unknown,
  stack?: unknown,
  exception?: unknown,
  stacktrace?: unknown,
  mechanism?: unknown,
  mechanism_type?: unknown,
  request?: unknown,
  user?: unknown,
  tags?: unknown,
  contexts?: unknown,
  extra?: unknown,
  breadcrumbs?: unknown,
  fingerprint?: unknown,
  sdk?: unknown,
  sdk_version?: unknown,
  runtime?: unknown,
  platform?: unknown,
  release?: unknown,
  dist?: unknown,
  environment?: unknown,
  trace_id?: unknown,
  span_id?: unknown,
  parent_span_id?: unknown,
  page_view_id?: unknown,
  session_id?: unknown,
  replay_id?: unknown,
  debug_meta?: unknown,
  debug_images?: unknown,
  attachments?: unknown,
  item_metadata?: unknown,
};

export type ErrorEnvelopeInput = ErrorEnvelopeV1 | FlatErrorEventInput;

export type ErrorEnvelopeNormalizationOptions = Partial<ErrorEnvelopeLimits>;

class NormalizationState {
  truncated = false;
  readonly dropped = new Set<string>();
  readonly activeObjects = new WeakSet<object>();

  drop(reason: string): void {
    this.truncated = true;
    this.dropped.add(reason.slice(0, 160));
  }

  snapshot(): ErrorEnvelopeNormalization {
    const allReasons = [...this.dropped].sort();
    const dropped = allReasons.length > 32 ? [...allReasons.slice(0, 31), "more-drops"] : allReasons;
    return { truncated: this.truncated, dropped };
  }
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function firstField(values: readonly unknown[], keys: readonly string[]): unknown {
  for (const value of values) {
    for (const key of keys) {
      const result = field(value, key);
      if (result !== undefined) return result;
    }
  }
  return undefined;
}

function stringValue(value: unknown, state: NormalizationState, path: string, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = truncateUtf8Bytes(value, maxBytes, () => state.drop(`${path}.string`));
  return result;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown): number | undefined {
  const result = finiteNumber(value);
  return result !== undefined && Number.isInteger(result) ? result : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isSensitiveKey(key: string): boolean {
  return /^(authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|credential|signature|body|query|search|raw[-_]?body)$/i.test(key)
    || /(^|[-_.])(authorization|cookie|token|secret|password|credential)([-_.]|$)/i.test(key);
}

function truncateUtf8Bytes(value: string, maxBytes: number, onTruncate?: () => void): string {
  if (new TextEncoder().encode(value).length <= maxBytes) return value;
  onTruncate?.();
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).length;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function normalizeJson(value: unknown, state: NormalizationState, path: string, limits: ErrorEnvelopeLimits, depth = 0): ReadonlyJson | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return truncateUtf8Bytes(value, limits.maxStringBytes, () => state.drop(`${path}.string`));
  if (typeof value !== "object") return undefined;
  if (depth >= limits.maxDepth) {
    state.drop(`${path}.depth`);
    return undefined;
  }
  if (state.activeObjects.has(value)) {
    state.drop(`${path}.cycle`);
    return undefined;
  }
  state.activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      const result: ReadonlyJson[] = [];
      for (const [index, item] of value.slice(0, limits.maxCollectionEntries).entries()) {
        const normalized = normalizeJson(item, state, `${path}[${index}]`, limits, depth + 1);
        if (normalized !== undefined) result.push(normalized);
      }
      if (value.length > limits.maxCollectionEntries) state.drop(`${path}.items`);
      return result;
    }
    const result: Record<string, ReadonlyJson> = {};
    for (const [index, key] of Object.keys(value).sort().entries()) {
      if (index >= limits.maxCollectionEntries) {
        state.drop(`${path}.fields`);
        break;
      }
      if (isSensitiveKey(key)) {
        state.drop(`${path}.${key}`);
        continue;
      }
      const normalized = normalizeJson(field(value, key), state, `${path}.${key}`, limits, depth + 1);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  } finally {
    state.activeObjects.delete(value);
  }
}

function normalizeRecord(value: unknown, state: NormalizationState, path: string, limits: typeof ERROR_ENVELOPE_LIMITS, maxEntries = limits.maxCollectionEntries): Readonly<Record<string, ReadonlyJson>> {
  const result: Record<string, ReadonlyJson> = {};
  if (!isRecord(value)) return result;
  for (const [index, key] of Object.keys(value).sort().entries()) {
    if (index >= maxEntries) {
      state.drop(`${path}.fields`);
      break;
    }
    if (isSensitiveKey(key)) {
      state.drop(`${path}.${key}`);
      continue;
    }
    const normalized = normalizeJson(value[key], state, `${path}.${key}`, limits);
    if (normalized !== undefined) result[truncateUtf8Bytes(key, 256, () => state.drop(`${path}.key`))] = normalized;
  }
  return result;
}

function normalizeLevel(value: unknown, fallback: ErrorEnvelopeLevel): ErrorEnvelopeLevel {
  return value === "fatal" || value === "error" || value === "warning" || value === "info" || value === "debug" || value === "log" ? value : fallback;
}

function normalizeFrames(value: unknown, state: NormalizationState, path: string, limits: typeof ERROR_ENVELOPE_LIMITS, remaining: { count: number }): ErrorEnvelopeStackFrame[] {
  if (!Array.isArray(value)) return [];
  const result: ErrorEnvelopeStackFrame[] = [];
  for (const [index, rawFrame] of value.entries()) {
    if (remaining.count >= limits.maxFrames) {
      state.drop(`${path}.frames`);
      break;
    }
    if (!isRecord(rawFrame)) continue;
    const frame: ErrorEnvelopeStackFrame = {};
    const filename = stringValue(field(rawFrame, "filename"), state, `${path}[${index}].filename`, limits.maxStringBytes);
    const absPath = stringValue(field(rawFrame, "abs_path"), state, `${path}[${index}].abs_path`, limits.maxStringBytes);
    const functionName = stringValue(field(rawFrame, "function"), state, `${path}[${index}].function`, limits.maxStringBytes);
    const moduleName = stringValue(field(rawFrame, "module"), state, `${path}[${index}].module`, limits.maxStringBytes);
    const contextLine = stringValue(field(rawFrame, "context_line"), state, `${path}[${index}].context_line`, limits.maxStringBytes);
    const lineno = integer(field(rawFrame, "lineno"));
    const colno = integer(field(rawFrame, "colno"));
    const inApp = booleanValue(field(rawFrame, "in_app"));
    if (filename !== undefined) frame.filename = filename;
    if (absPath !== undefined) frame.abs_path = absPath;
    if (functionName !== undefined) frame.function = functionName;
    if (moduleName !== undefined) frame.module = moduleName;
    if (lineno !== undefined) frame.lineno = lineno;
    if (colno !== undefined) frame.colno = colno;
    if (inApp !== undefined) frame.in_app = inApp;
    if (contextLine !== undefined) frame.context_line = contextLine;
    result.push(frame);
    remaining.count += 1;
  }
  return result;
}

function normalizeMechanism(value: unknown, state: NormalizationState, path: string, limits: typeof ERROR_ENVELOPE_LIMITS): ErrorEnvelopeMechanism | undefined {
  if (typeof value === "string") return { type: stringValue(value, state, path, limits.maxStringBytes) };
  if (!isRecord(value)) return undefined;
  const result: ErrorEnvelopeMechanism = {};
  const type = stringValue(field(value, "type"), state, `${path}.type`, limits.maxStringBytes);
  const handled = booleanValue(field(value, "handled"));
  const synthetic = booleanValue(field(value, "synthetic"));
  const data = normalizeRecord(field(value, "data"), state, `${path}.data`, limits);
  if (type !== undefined) result.type = type;
  if (handled !== undefined) result.handled = handled;
  if (synthetic !== undefined) result.synthetic = synthetic;
  if (Object.keys(data).length > 0) result.data = data;
  return result;
}

function normalizeStacktrace(value: unknown, state: NormalizationState, path: string, limits: typeof ERROR_ENVELOPE_LIMITS, remaining: { count: number }): ErrorEnvelopeStacktrace | undefined {
  if (typeof value === "string") return { raw: stringValue(value, state, `${path}.raw`, limits.maxStringBytes) };
  if (!isRecord(value)) return undefined;
  const result: ErrorEnvelopeStacktrace = {};
  const raw = stringValue(field(value, "raw"), state, `${path}.raw`, limits.maxStringBytes);
  const frames = normalizeFrames(field(value, "frames"), state, `${path}`, limits, remaining);
  const symbolicationState = field(value, "symbolication_state");
  if (raw !== undefined) result.raw = raw;
  if (frames.length > 0) result.frames = frames;
  if (symbolicationState === "pending" || symbolicationState === "complete" || symbolicationState === "failed" || symbolicationState === "not_requested") result.symbolication_state = symbolicationState;
  return result;
}

function normalizeExceptionValues(value: unknown, state: NormalizationState, path: string, limits: typeof ERROR_ENVELOPE_LIMITS, fallback: { name?: string, message?: string, stack?: string, mechanism?: ErrorEnvelopeMechanism }): ErrorEnvelopeExceptionValue[] {
  const values: ErrorEnvelopeExceptionValue[] = [];
  const remaining = { count: 0 };
  if (Array.isArray(value)) {
    for (const [index, rawValue] of value.slice(0, limits.maxExceptionValues).entries()) {
      if (!isRecord(rawValue)) continue;
      const exception: ErrorEnvelopeExceptionValue = {};
      const type = stringValue(field(rawValue, "type"), state, `${path}[${index}].type`, limits.maxStringBytes);
      const exceptionValue = stringValue(field(rawValue, "value"), state, `${path}[${index}].value`, limits.maxStringBytes);
      const moduleName = stringValue(field(rawValue, "module"), state, `${path}[${index}].module`, limits.maxStringBytes);
      const mechanism = normalizeMechanism(field(rawValue, "mechanism"), state, `${path}[${index}].mechanism`, limits);
      const stacktrace = normalizeStacktrace(field(rawValue, "stacktrace"), state, `${path}[${index}].stacktrace`, limits, remaining);
      if (type !== undefined) exception.type = type;
      if (exceptionValue !== undefined) exception.value = exceptionValue;
      if (moduleName !== undefined) exception.module = moduleName;
      if (mechanism !== undefined) exception.mechanism = mechanism;
      if (stacktrace !== undefined) exception.stacktrace = stacktrace;
      values.push(exception);
    }
    if (value.length > limits.maxExceptionValues) state.drop(`${path}.values`);
  }
  if (values.length === 0 && (fallback.name !== undefined || fallback.message !== undefined || fallback.stack !== undefined)) {
    const exception: ErrorEnvelopeExceptionValue = {};
    if (fallback.name !== undefined) exception.type = fallback.name;
    if (fallback.message !== undefined) exception.value = fallback.message;
    if (fallback.mechanism !== undefined) exception.mechanism = fallback.mechanism;
    if (fallback.stack !== undefined) exception.stacktrace = { raw: fallback.stack };
    values.push(exception);
  }
  return values;
}

function normalizeUser(value: unknown, state: NormalizationState, limits: typeof ERROR_ENVELOPE_LIMITS): ErrorEnvelopeUser | undefined {
  if (!isRecord(value)) return undefined;
  const result: ErrorEnvelopeUser = {};
  const id = stringValue(field(value, "id"), state, "user.id", limits.maxStringBytes);
  const email = stringValue(field(value, "email"), state, "user.email", limits.maxStringBytes);
  const username = stringValue(field(value, "username"), state, "user.username", limits.maxStringBytes);
  if (id !== undefined) result.id = id;
  if (email !== undefined) result.email = email;
  if (username !== undefined) result.username = username;
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeRequestUrl(value: unknown, state: NormalizationState, limits: typeof ERROR_ENVELOPE_LIMITS): string | undefined {
  const url = stringValue(value, state, "request.url", limits.maxStringBytes);
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return truncateUtf8Bytes(`${parsed.origin}${parsed.pathname}`, limits.maxStringBytes, () => state.drop("request.url.string"));
  } catch {
    const withoutQuery = url.split(/[?#]/, 1)[0];
    return withoutQuery.replace(/^(https?:\/\/)([^/@]+@)/i, "$1");
  }
}

function normalizeRequest(value: unknown, state: NormalizationState, limits: typeof ERROR_ENVELOPE_LIMITS): ErrorEnvelopeRequest | undefined {
  if (!isRecord(value)) return undefined;
  const result: ErrorEnvelopeRequest = {};
  const url = safeRequestUrl(field(value, "url"), state, limits);
  const method = stringValue(field(value, "method"), state, "request.method", 32);
  const statusCode = integer(field(value, "status_code"));
  if (url !== undefined) result.url = url;
  if (method !== undefined) result.method = method.toUpperCase();
  if (statusCode !== undefined && statusCode >= 100 && statusCode <= 599) result.status_code = statusCode;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeBreadcrumbs(value: unknown, state: NormalizationState, limits: typeof ERROR_ENVELOPE_LIMITS): ErrorEnvelopeBreadcrumb[] {
  if (!Array.isArray(value)) return [];
  const result: ErrorEnvelopeBreadcrumb[] = [];
  for (const [index, rawBreadcrumb] of value.slice(-limits.maxBreadcrumbs).entries()) {
    if (!isRecord(rawBreadcrumb)) continue;
    const breadcrumb: ErrorEnvelopeBreadcrumb = {};
    const timestamp = finiteNumber(field(rawBreadcrumb, "timestamp"));
    const category = stringValue(field(rawBreadcrumb, "category"), state, `breadcrumbs[${index}].category`, limits.maxStringBytes);
    const message = stringValue(field(rawBreadcrumb, "message"), state, `breadcrumbs[${index}].message`, limits.maxStringBytes);
    const level = normalizeLevel(field(rawBreadcrumb, "level"), "info");
    const data = normalizeRecord(field(rawBreadcrumb, "data"), state, `breadcrumbs[${index}].data`, limits);
    if (timestamp !== undefined) breadcrumb.timestamp = timestamp;
    if (category !== undefined) breadcrumb.category = category;
    if (message !== undefined) breadcrumb.message = message;
    if (field(rawBreadcrumb, "level") !== undefined) breadcrumb.level = level;
    if (Object.keys(data).length > 0) breadcrumb.data = data;
    result.push(breadcrumb);
  }
  if (value.length > limits.maxBreadcrumbs) state.drop("breadcrumbs.items");
  return result;
}

function normalizeTags(value: unknown, state: NormalizationState, limits: typeof ERROR_ENVELOPE_LIMITS): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  if (!isRecord(value)) return result;
  for (const [index, key] of Object.keys(value).sort().entries()) {
    if (index >= limits.maxTags) {
      state.drop("tags.fields");
      break;
    }
    if (isSensitiveKey(key)) {
      state.drop(`tags.${key}`);
      continue;
    }
    const tag = stringValue(value[key], state, `tags.${key}`, limits.maxStringBytes);
    if (tag !== undefined) result[truncateUtf8Bytes(key, 256, () => state.drop("tags.key"))] = tag;
  }
  return result;
}

function normalizeFingerprint(value: unknown, state: NormalizationState, limits: typeof ERROR_ENVELOPE_LIMITS): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limits.maxCollectionEntries).flatMap((item, index) => {
    const result = stringValue(item, state, `fingerprint[${index}]`, limits.maxStringBytes);
    return result === undefined ? [] : [result];
  });
}

function normalizeSdk(value: unknown, state: NormalizationState, limits: ErrorEnvelopeLimits): ErrorEnvelopeSdk | undefined {
  if (typeof value === "string") return { name: stringValue(value, state, "sdk.name", limits.maxStringBytes) };
  if (!isRecord(value)) return undefined;
  const result: ErrorEnvelopeSdk = {};
  const name = stringValue(field(value, "name"), state, "sdk.name", limits.maxStringBytes);
  const version = stringValue(field(value, "version"), state, "sdk.version", limits.maxStringBytes);
  const integrationsValue = field(value, "integrations");
  const integrations = Array.isArray(integrationsValue)
    ? integrationsValue.slice(0, limits.maxCollectionEntries).flatMap((item: unknown, index: number) => {
      const integration = stringValue(item, state, `sdk.integrations[${index}]`, limits.maxStringBytes);
      return integration === undefined ? [] : [integration];
    })
    : [];
  if (name !== undefined) result.name = name;
  if (version !== undefined) result.version = version;
  if (integrations.length > 0) result.integrations = integrations;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeRuntime(value: unknown, state: NormalizationState, limits: typeof ERROR_ENVELOPE_LIMITS): ErrorEnvelopeRuntime | undefined {
  if (!isRecord(value)) return undefined;
  const result: ErrorEnvelopeRuntime = {};
  const keys: readonly (keyof ErrorEnvelopeRuntime)[] = ["platform", "name", "version", "service_name", "service_version"];
  for (const key of keys) {
    const normalized = stringValue(field(value, key), state, `runtime.${key}`, limits.maxStringBytes);
    if (normalized !== undefined) result[key] = normalized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeCorrelation(value: unknown, state: NormalizationState, limits: typeof ERROR_ENVELOPE_LIMITS): ErrorEnvelopeCorrelation | undefined {
  if (!isRecord(value)) return undefined;
  const result: ErrorEnvelopeCorrelation = {};
  const keys: readonly (keyof ErrorEnvelopeCorrelation)[] = ["trace_id", "span_id", "parent_span_id", "page_view_id", "session_id", "replay_id"];
  for (const key of keys) {
    const normalized = stringValue(field(value, key), state, `correlation.${key}`, limits.maxStringBytes);
    if (normalized !== undefined) result[key] = normalized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeDebugMeta(value: unknown, state: NormalizationState, limits: typeof ERROR_ENVELOPE_LIMITS): ErrorEnvelopeDebugMeta | undefined {
  const imagesValue = isRecord(value) ? field(value, "images") : value;
  if (!Array.isArray(imagesValue)) return undefined;
  const images: ErrorEnvelopeDebugImage[] = [];
  const keys: readonly (keyof ErrorEnvelopeDebugImage)[] = ["type", "debug_id", "code_file", "arch", "image_addr", "image_size", "uuid", "name"];
  for (const [index, rawImage] of imagesValue.slice(0, limits.maxDebugImages).entries()) {
    if (!isRecord(rawImage)) continue;
    const image: ErrorEnvelopeDebugImage = {};
    for (const key of keys) {
      const normalized = stringValue(field(rawImage, key), state, `debug_meta.images[${index}].${key}`, limits.maxStringBytes);
      if (normalized !== undefined) image[key] = normalized;
    }
    images.push(image);
  }
  if (Array.isArray(imagesValue) && imagesValue.length > limits.maxDebugImages) state.drop("debug_meta.images");
  return images.length > 0 ? { images } : undefined;
}

function normalizeAttachments(value: unknown, state: NormalizationState, limits: typeof ERROR_ENVELOPE_LIMITS): ErrorEnvelopeAttachment[] {
  if (!Array.isArray(value)) return [];
  const result: ErrorEnvelopeAttachment[] = [];
  const keys: readonly (keyof ErrorEnvelopeAttachment)[] = ["id", "filename", "content_type", "checksum", "attachment_type"];
  for (const [index, rawAttachment] of value.slice(0, limits.maxAttachmentItems).entries()) {
    if (!isRecord(rawAttachment)) continue;
    const attachment: ErrorEnvelopeAttachment = {};
    for (const key of keys) {
      const normalized = stringValue(field(rawAttachment, key), state, `attachments[${index}].${key}`, limits.maxStringBytes);
      if (normalized === undefined) continue;
      if (key === "id") attachment.id = normalized;
      if (key === "filename") attachment.filename = normalized;
      if (key === "content_type") attachment.content_type = normalized;
      if (key === "checksum") attachment.checksum = normalized;
      if (key === "attachment_type") attachment.attachment_type = normalized;
    }
    const size = finiteNumber(field(rawAttachment, "size"));
    if (size !== undefined && size >= 0) attachment.size = size;
    result.push(attachment);
  }
  if (value.length > limits.maxAttachmentItems) state.drop("attachments.items");
  return result;
}

function normalizeItemMetadata(value: unknown, state: NormalizationState, limits: typeof ERROR_ENVELOPE_LIMITS): ErrorEnvelopeItemMetadata {
  const result: ErrorEnvelopeItemMetadata = { item_type: "event" };
  if (!isRecord(value)) return result;
  const contentType = stringValue(field(value, "content_type"), state, "item_metadata.content_type", 256);
  const length = finiteNumber(field(value, "length"));
  const filename = stringValue(field(value, "filename"), state, "item_metadata.filename", limits.maxStringBytes);
  if (contentType !== undefined) result.content_type = contentType;
  if (length !== undefined && length >= 0) result.length = length;
  if (filename !== undefined) result.filename = filename;
  return result;
}

function normalizeInputRecord(input: unknown): FlatErrorEventInput {
  if (!isRecord(input)) throw new Error("Error envelope input must be an object");
  return input;
}

function stableSerialize(value: unknown): string {
  return String(JSON.stringify(value));
}

function hash32(value: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** Deterministic identity for adapter inputs without an event ID; this is not a security hash. */
export function deriveErrorEnvelopeEventId(value: unknown): string {
  const serialized = stableSerialize(value);
  return [0, 1, 2, 3].map((seed) => hash32(serialized, seed).toString(16).padStart(8, "0")).join("");
}

function normalizeEventId(value: unknown, fallback: unknown): string {
  if (typeof value === "string") {
    const compact = value.replaceAll("-", "").toLowerCase();
    if (/^[0-9a-f]{32}$/.test(compact)) return compact;
  }
  return deriveErrorEnvelopeEventId(fallback);
}

function adaptFlatErrorInput(input: FlatErrorEventInput): FlatErrorEventInput {
  const data = field(input, "data");
  const source = isRecord(data) ? data : input;
  const pick = (key: string): unknown => firstField([source, input], [key]);
  return {
    event_id: pick("event_id"),
    kind: pick("kind"),
    level: pick("level"),
    handled: pick("handled"),
    synthetic: pick("synthetic"),
    message: pick("message"),
    name: pick("name"),
    stack: pick("stack"),
    exception: pick("exception"),
    stacktrace: pick("stacktrace"),
    mechanism: pick("mechanism"),
    mechanism_type: pick("mechanism_type"),
    request: pick("request"),
    user: pick("user"),
    tags: pick("tags"),
    contexts: pick("contexts"),
    extra: pick("extra"),
    breadcrumbs: pick("breadcrumbs"),
    fingerprint: pick("fingerprint"),
    sdk: pick("sdk"),
    sdk_version: pick("sdk_version"),
    runtime: pick("runtime"),
    platform: pick("platform"),
    release: pick("release"),
    dist: pick("dist"),
    environment: pick("environment"),
    trace_id: pick("trace_id"),
    span_id: pick("span_id"),
    parent_span_id: pick("parent_span_id"),
    page_view_id: pick("page_view_id"),
    session_id: pick("session_id"),
    replay_id: pick("replay_id"),
    debug_meta: pick("debug_meta"),
    debug_images: pick("debug_images"),
    attachments: pick("attachments"),
    item_metadata: pick("item_metadata"),
  };
}

function mergeLimits(options: ErrorEnvelopeNormalizationOptions | undefined): ErrorEnvelopeLimits {
  const result = { ...ERROR_ENVELOPE_LIMITS };
  const keys: readonly (keyof ErrorEnvelopeLimits)[] = [
    "maxDepth", "maxEventBytes", "maxStringBytes", "maxExceptionValues", "maxFrames", "maxBreadcrumbs",
    "maxTags", "maxContexts", "maxExtraFields", "maxAttachmentItems", "maxDebugImages", "maxCollectionEntries",
  ];
  for (const key of keys) {
    const value = options?.[key];
    if (value !== undefined && Number.isInteger(value) && value > 0) result[key] = value;
  }
  return result;
}

type RemovableEnvelopeField = "extra" | "contexts" | "breadcrumbs" | "attachments" | "debug_meta" | "request" | "stacktrace" | "stack" | "message" | "tags" | "fingerprint" | "user" | "sdk" | "runtime" | "correlation" | "release" | "dist" | "environment" | "mechanism" | "exception";

function optionalFieldRemoved(envelope: ErrorEnvelopeV1, fieldName: RemovableEnvelopeField): ErrorEnvelopeV1 {
  if (fieldName === "extra") return { ...envelope, extra: {} };
  if (fieldName === "contexts") return { ...envelope, contexts: {} };
  if (fieldName === "breadcrumbs") return { ...envelope, breadcrumbs: [] };
  if (fieldName === "attachments") return { ...envelope, attachments: [] };
  if (fieldName === "debug_meta") return { ...envelope, debug_meta: undefined };
  if (fieldName === "request") return { ...envelope, request: undefined };
  if (fieldName === "stacktrace") return { ...envelope, stacktrace: undefined };
  if (fieldName === "stack") return { ...envelope, stack: undefined };
  if (fieldName === "message") return { ...envelope, message: undefined };
  if (fieldName === "tags") return { ...envelope, tags: {} };
  if (fieldName === "fingerprint") return { ...envelope, fingerprint: [] };
  if (fieldName === "user") return { ...envelope, user: undefined };
  if (fieldName === "sdk") return { ...envelope, sdk: undefined };
  if (fieldName === "runtime") return { ...envelope, runtime: undefined };
  if (fieldName === "correlation") return { ...envelope, correlation: undefined };
  if (fieldName === "release") return { ...envelope, release: undefined };
  if (fieldName === "dist") return { ...envelope, dist: undefined };
  if (fieldName === "environment") return { ...envelope, environment: undefined };
  if (fieldName === "mechanism") return { ...envelope, mechanism: undefined };
  return { ...envelope, exception: undefined };
}

function fitEnvelope(envelope: ErrorEnvelopeV1, limits: typeof ERROR_ENVELOPE_LIMITS, state: NormalizationState): ErrorEnvelopeV1 {
  const withCurrentNormalization = (value: ErrorEnvelopeV1): ErrorEnvelopeV1 => ({
    ...value,
    normalization: state.snapshot(),
  });
  let result = withCurrentNormalization(envelope);
  if (new TextEncoder().encode(JSON.stringify(result)).length > limits.maxEventBytes && result.exception !== undefined) {
    result = {
      ...result,
      exception: {
        values: result.exception.values.map((value) => ({ ...value, stacktrace: undefined })),
      },
    };
    state.drop("event.exception.stacktrace");
    result = withCurrentNormalization(result);
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > limits.maxEventBytes && result.exception !== undefined && result.exception.values.length > 1) {
    result = { ...result, exception: { values: result.exception.values.slice(0, 1) } };
    state.drop("event.exception.values");
    result = withCurrentNormalization(result);
  }
  const fields: readonly RemovableEnvelopeField[] = [
    "extra", "contexts", "breadcrumbs", "attachments", "debug_meta", "request", "stacktrace", "stack", "message",
    "tags", "fingerprint", "user", "sdk", "runtime", "correlation", "release", "dist", "environment", "mechanism", "exception",
  ];
  for (const fieldName of fields) {
    if (new TextEncoder().encode(JSON.stringify(result)).length <= limits.maxEventBytes) return result;
    result = optionalFieldRemoved(result, fieldName);
    state.drop(`event.${fieldName}`);
    result = withCurrentNormalization(result);
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > limits.maxEventBytes) throw new Error(`Normalized error envelope exceeds ${limits.maxEventBytes} bytes after bounded truncation`);
  return result;
}

function normalizeToEnvelope(input: FlatErrorEventInput, limits: typeof ERROR_ENVELOPE_LIMITS, state: NormalizationState): ErrorEnvelopeV1 {
  const exceptionInput = field(input, "exception");
  const name = stringValue(field(input, "name"), state, "name", limits.maxStringBytes);
  const message = stringValue(field(input, "message"), state, "message", limits.maxStringBytes);
  const stack = stringValue(field(input, "stack"), state, "stack", limits.maxStringBytes);
  const mechanismInput = field(input, "mechanism") ?? field(input, "mechanism_type");
  const mechanism = normalizeMechanism(mechanismInput, state, "mechanism", limits);
  const exceptionValues = normalizeExceptionValues(
    isRecord(exceptionInput) ? field(exceptionInput, "values") : exceptionInput,
    state,
    "exception",
    limits,
    { name, message, stack, mechanism },
  );
  const kindValue = field(input, "kind");
  const kind: ErrorEnvelopeKind = kindValue === "message" || kindValue === "event" || kindValue === "exception"
    ? kindValue
    : exceptionValues.length > 0 || name !== undefined ? "exception" : "message";
  const level = normalizeLevel(field(input, "level"), "error");
  const handled = booleanValue(field(input, "handled")) ?? true;
  const synthetic = booleanValue(field(input, "synthetic"));
  const tags = normalizeTags(field(input, "tags"), state, limits);
  const contexts = normalizeRecord(field(input, "contexts"), state, "contexts", limits, limits.maxContexts);
  const extra = normalizeRecord(field(input, "extra"), state, "extra", limits, limits.maxExtraFields);
  const breadcrumbs = normalizeBreadcrumbs(field(input, "breadcrumbs"), state, limits);
  const fingerprint = normalizeFingerprint(field(input, "fingerprint"), state, limits);
  const sdk = normalizeSdk(field(input, "sdk"), state, limits) ?? normalizeSdk(field(input, "sdk_version"), state, limits);
  const runtime = normalizeRuntime(field(input, "runtime"), state, limits) ?? normalizeRuntime({ platform: field(input, "platform") }, state, limits);
  const correlation = normalizeCorrelation({
    trace_id: field(input, "trace_id"),
    span_id: field(input, "span_id"),
    parent_span_id: field(input, "parent_span_id"),
    page_view_id: field(input, "page_view_id"),
    session_id: field(input, "session_id"),
    replay_id: field(input, "replay_id"),
  }, state, limits);
  const topStacktrace = normalizeStacktrace(field(input, "stacktrace"), state, "stacktrace", limits, { count: 0 });
  const debugMeta = normalizeDebugMeta(field(input, "debug_meta") ?? field(input, "debug_images"), state, limits);
  const release = stringValue(field(input, "release"), state, "release", limits.maxStringBytes);
  const dist = stringValue(field(input, "dist"), state, "dist", limits.maxStringBytes);
  const environment = stringValue(field(input, "environment"), state, "environment", limits.maxStringBytes);
  const request = normalizeRequest(field(input, "request"), state, limits);
  const user = normalizeUser(field(input, "user"), state, limits);
  const attachments = normalizeAttachments(field(input, "attachments"), state, limits);
  const itemMetadata = normalizeItemMetadata(field(input, "item_metadata"), state, limits);
  const seed = {
    kind, level, handled, synthetic, message, name, stack, exception: exceptionValues,
    mechanism, request, user: field(input, "user"), tags, contexts, extra, breadcrumbs, fingerprint,
    sdk, runtime, release, dist, environment, correlation, debugMeta, attachments, itemMetadata,
  };
  const envelope: ErrorEnvelopeV1 = {
    schema: ERROR_ENVELOPE_SCHEMA,
    version: ERROR_ENVELOPE_VERSION,
    event_id: normalizeEventId(field(input, "event_id"), seed),
    kind,
    level,
    handled,
    tags,
    contexts,
    extra,
    breadcrumbs,
    fingerprint,
    attachments,
    item_metadata: itemMetadata,
    normalization: state.snapshot(),
  };
  if (synthetic !== undefined) envelope.synthetic = synthetic;
  if (message !== undefined) envelope.message = message;
  if (name !== undefined) envelope.name = name;
  if (stack !== undefined) envelope.stack = stack;
  if (exceptionValues.length > 0) envelope.exception = { values: exceptionValues };
  if (topStacktrace !== undefined) envelope.stacktrace = topStacktrace;
  if (mechanism !== undefined) envelope.mechanism = mechanism;
  if (request !== undefined) envelope.request = request;
  if (user !== undefined) envelope.user = user;
  if (sdk !== undefined) envelope.sdk = sdk;
  if (runtime !== undefined) envelope.runtime = runtime;
  if (release !== undefined) envelope.release = release;
  if (dist !== undefined) envelope.dist = dist;
  if (environment !== undefined) envelope.environment = environment;
  if (correlation !== undefined) envelope.correlation = correlation;
  if (debugMeta !== undefined) envelope.debug_meta = debugMeta;
  return fitEnvelope(envelope, limits, state);
}

export function normalizeErrorEnvelope(input: unknown, options?: ErrorEnvelopeNormalizationOptions): ErrorEnvelopeV1 {
  const raw = normalizeInputRecord(input);
  const limits = mergeLimits(options);
  const state = new NormalizationState();
  const envelope = normalizeToEnvelope(adaptFlatErrorInput(raw), limits, state);
  return envelope;
}

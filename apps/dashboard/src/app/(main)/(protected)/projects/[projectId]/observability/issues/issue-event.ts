import type { IssueFrame, IssueOccurrence } from "./issues-data";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

/**
 * An untrusted, JSON-derived event payload object. The keys are whatever the
 * reporting SDK sent, so values stay `Json` until the parsers below promote
 * them into the typed payload structures.
 */
export type IssueEventRecord = Readonly<Record<string, Json>>;

export type IssueEventField = {
  key: string,
  value: Json | undefined,
};

export type IssueSymbolicationDiagnosticCode =
  | "frame_limit_exceeded"
  | "invalid_frame"
  | "invalid_frame_location"
  | "artifact_mismatch"
  | "artifact_integrity_mismatch"
  | "invalid_debug_id"
  | "invalid_artifact"
  | "missing_artifact"
  | "missing_debug_id"
  | "artifact_storage_unavailable"
  | "missing_bundle"
  | "bundle_too_large"
  | "missing_source_map"
  | "source_map_too_large"
  | "missing_release_metadata"
  | "invalid_release_metadata"
  | "invalid_dist_metadata"
  | "missing_code_file_metadata"
  | "invalid_source_map"
  | "unsupported_source_map"
  | "no_mapping"
  | "missing_source_content"
  | "source_content_too_large"
  | "source_context_unavailable"
  | "unknown";

export type IssueSymbolicationDiagnostic = {
  code: IssueSymbolicationDiagnosticCode,
  message: string,
  debugId: string | null,
  codeFile: string | null,
  line: number | null,
  column: number | null,
  source: string | null,
};

export type IssueFrameSymbolication = {
  status: "symbolicated" | "unsymbolicated" | "not_attempted",
  sourceFile: string | null,
  originalLine: number | null,
  originalColumn: number | null,
  name: string | null,
  context: {
    line: string,
    pre: string[],
    post: string[],
  } | null,
  diagnostics: IssueSymbolicationDiagnostic[],
};

export type IssueRawFrame = Omit<IssueFrame, "symbolication">;

export type IssueEventFrame = IssueRawFrame & {
  raw: IssueRawFrame,
  symbolication: IssueFrameSymbolication | null,
  context?: { line: string, pre: string[], post: string[], symbolicated: true },
};

export type IssueExceptionValue = {
  index: number,
  type: string | null,
  value: string | null,
  mechanism: string | null,
  handled: boolean | null,
  frames: IssueEventFrame[],
  rawStack: string | null,
};

export type IssueSafeRequestContext = {
  fields: IssueEventField[],
};

export type IssueBreadcrumb = {
  index: number,
  timestamp: number | null,
  category: string | null,
  message: string | null,
  level: string | null,
  data: IssueEventRecord | null,
};

export type IssueEventPayload = {
  data: IssueEventRecord | null,
  eventId: string | null,
  occurrenceFrames: IssueEventFrame[],
  exceptionChain: IssueExceptionValue[],
  safeRequest: IssueSafeRequestContext | null,
  tags: IssueEventField[],
  contexts: IssueEventField[],
  breadcrumbs: IssueBreadcrumb[],
  extra: IssueEventField[],
  fingerprint: string[],
  fingerprintOverride: string[],
  additionalData: IssueEventField[],
  symbolicationDiagnostics: IssueSymbolicationDiagnostic[],
};

export type IssueEventOccurrenceProjection = Pick<IssueOccurrence, "data"> & {
  frames?: readonly IssueFrame[],
};

const RESERVED_EVENT_KEYS = new Set([
  "event_id",
  "message",
  "name",
  "stack",
  "exception",
  "request",
  "user",
  "tags",
  "contexts",
  "breadcrumbs",
  "extra",
  "fingerprint",
  "fingerprint_override",
  "mechanism_type",
  "handled",
  "synthetic",
  "release",
  "environment",
  "sdk_version",
  "level",
]);

function isSensitiveEventKey(key: string): boolean {
  return /(authorization|cookie|password|secret|token|header|query|body|credential|private[-_.]?key|form[-_.]?data)/i.test(key);
}

function isUrlEventKey(key: string): boolean {
  return /(?:^|[._-])(?:url|uri|http[-_.]?target|request[-_.]?(?:target|url))(?:$|[._-])/i.test(key);
}

function scrubDisplayString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic|Digest)\s+[^\s,;]+/gi, "$1 [Filtered]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[Filtered]")
    .replace(/([?&](?:access[-_.]?token|api[-_.]?key|authorization|client[-_.]?secret|password|refresh[-_.]?token|secret|signature|token)=)[^&#\s]*/gi, "$1[Filtered]");
}

function safeDisplayValue(value: Json | undefined, key: string): Json | undefined {
  if (value === undefined) return undefined;
  return safeDisplayJson(value, key, 0);
}

function safeDisplayJson(value: Json, key: string, depth: number): Json {
  if (typeof value === "string") {
    if (isUrlEventKey(key)) {
      try {
        const parsed = new URL(value);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return scrubDisplayString(value.split(/[?#]/, 1)[0]);
      }
    }
    return scrubDisplayString(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (depth >= 6) return "[Truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeDisplayJson(item, key, depth + 1));
  return Object.fromEntries(Object.entries(value)
    .filter(([entryKey]) => !isSensitiveEventKey(entryKey))
    .sort(([left], [right]) => stringCompare(left, right))
    .slice(0, 100)
    .map(([entryKey, entryValue]) => [entryKey, safeDisplayJson(entryValue, entryKey, depth + 1)]));
}

export function asIssueEventRecord(value: unknown): IssueEventRecord | null {
  if (!isRecord(value)) return null;
  // SAFETY: every value routed here is JSON-derived — occurrence payloads come
  // out of the JSON-parsed issue detail response, and nested calls re-read
  // properties of records already established as such — so property values are
  // Json by construction. The copy also drops any prototype the value carried.
  return Object.fromEntries(Object.entries(value)) as IssueEventRecord;
}

function valueAt(record: IssueEventRecord | null, key: string): Json | undefined {
  return record?.[key];
}

function stringValue(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberValue(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: Json | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function objectEntries(value: Json | undefined): IssueEventField[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([key]) => !isSensitiveEventKey(key))
    .sort(([left], [right]) => stringCompare(left, right))
    .map(([key, entryValue]) => ({ key, value: safeDisplayJson(entryValue, key, 0) }));
}

function stringList(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}

const ISSUE_SYMBOLICATION_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  "frame_limit_exceeded",
  "invalid_frame",
  "invalid_frame_location",
  "artifact_mismatch",
  "artifact_integrity_mismatch",
  "invalid_debug_id",
  "invalid_artifact",
  "missing_artifact",
  "missing_debug_id",
  "artifact_storage_unavailable",
  "missing_bundle",
  "bundle_too_large",
  "missing_source_map",
  "source_map_too_large",
  "missing_release_metadata",
  "invalid_release_metadata",
  "invalid_dist_metadata",
  "missing_code_file_metadata",
  "invalid_source_map",
  "unsupported_source_map",
  "no_mapping",
  "missing_source_content",
  "source_content_too_large",
  "source_context_unavailable",
]);

function isKnownIssueSymbolicationDiagnosticCode(value: string): value is Exclude<IssueSymbolicationDiagnosticCode, "unknown"> {
  return ISSUE_SYMBOLICATION_DIAGNOSTIC_CODES.has(value);
}

function parseSymbolicationDiagnostic(value: unknown): IssueSymbolicationDiagnostic | null {
  const record = asIssueEventRecord(value);
  if (record == null) return null;
  const rawCode = stringValue(valueAt(record, "code"));
  const code: IssueSymbolicationDiagnosticCode = rawCode != null && isKnownIssueSymbolicationDiagnosticCode(rawCode)
    ? rawCode
    : "unknown";
  return {
    code,
    message: scrubDisplayString(stringValue(valueAt(record, "message")) ?? "Symbolication diagnostic unavailable."),
    debugId: (() => {
      const value = stringValue(valueAt(record, "debug_id"));
      return value == null ? null : scrubDisplayString(value);
    })(),
    codeFile: (() => {
      const value = stringValue(valueAt(record, "code_file"));
      return value == null ? null : scrubDisplayString(value);
    })(),
    line: numberValue(valueAt(record, "line")),
    column: numberValue(valueAt(record, "column")),
    source: (() => {
      const value = stringValue(valueAt(record, "source"));
      return value == null ? null : scrubDisplayString(value);
    })(),
  };
}

function parseSymbolicationDiagnostics(value: unknown): IssueSymbolicationDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseSymbolicationDiagnostic).filter((diagnostic): diagnostic is IssueSymbolicationDiagnostic => diagnostic != null);
}

function parseSymbolicationContext(value: unknown): IssueFrameSymbolication["context"] {
  const record = asIssueEventRecord(value);
  if (record == null) return null;
  const line = stringValue(valueAt(record, "line"));
  const pre = stringList(valueAt(record, "pre"));
  const post = stringList(valueAt(record, "post"));
  if (line == null) return null;
  return {
    line: scrubDisplayString(line),
    pre: pre.map(scrubDisplayString),
    post: post.map(scrubDisplayString),
  };
}

function parseFrameSymbolication(record: IssueEventRecord): IssueFrameSymbolication | null {
  const symbolication = asIssueEventRecord(valueAt(record, "symbolication"));
  if (symbolication == null) return null;
  const rawStatus = stringValue(valueAt(symbolication, "status"));
  const status: IssueFrameSymbolication["status"] = rawStatus === "symbolicated"
    || rawStatus === "unsymbolicated"
    || rawStatus === "not_attempted"
    ? rawStatus
    : "not_attempted";
  const diagnostics = parseSymbolicationDiagnostics(valueAt(symbolication, "diagnostics"));
  if (rawStatus != null && rawStatus !== status) {
    diagnostics.unshift({
      code: "unknown",
      message: "The occurrence contained an unrecognized symbolication status.",
      debugId: null,
      codeFile: null,
      line: null,
      column: null,
      source: null,
    });
  }
  return {
    status,
    sourceFile: (() => {
      const value = stringValue(valueAt(symbolication, "source_file"));
      return value == null ? null : scrubDisplayString(value);
    })(),
    originalLine: numberValue(valueAt(symbolication, "original_line")),
    originalColumn: numberValue(valueAt(symbolication, "original_column")),
    name: (() => {
      const value = stringValue(valueAt(symbolication, "name"));
      return value == null ? null : scrubDisplayString(value);
    })(),
    context: parseSymbolicationContext(valueAt(symbolication, "context")),
    diagnostics,
  };
}

function displayFrame(raw: IssueRawFrame, symbolication: IssueFrameSymbolication | null): IssueEventFrame {
  if (symbolication?.status !== "symbolicated") return { ...raw, raw, symbolication };
  const frame: IssueEventFrame = {
    ...raw,
    filename: symbolication.sourceFile ?? raw.filename,
    function: symbolication.name ?? raw.function,
    module: symbolication.sourceFile == null ? raw.module : null,
    abs_path: symbolication.sourceFile ?? raw.abs_path,
    lineno: symbolication.originalLine ?? raw.lineno,
    colno: symbolication.originalColumn ?? raw.colno,
    raw,
    symbolication,
  };
  if (symbolication.context != null) {
    frame.context = { ...symbolication.context, symbolicated: true };
  }
  return frame;
}

function parseFrame(value: unknown): IssueEventFrame | null {
  const record = asIssueEventRecord(value);
  if (record == null) return null;
  const debugId = stringValue(valueAt(record, "debug_id"));
  const inApp = booleanValue(valueAt(record, "in_app")) ?? false;
  const raw: IssueRawFrame = {
    filename: stringValue(valueAt(record, "filename")),
    function: stringValue(valueAt(record, "function")),
    module: stringValue(valueAt(record, "module")),
    abs_path: stringValue(valueAt(record, "abs_path")),
    lineno: numberValue(valueAt(record, "lineno")),
    colno: numberValue(valueAt(record, "colno")),
    in_app: inApp,
  };
  if (debugId != null) raw.debug_id = debugId;
  return displayFrame(raw, parseFrameSymbolication(record));
}

function parseFrames(value: unknown): IssueEventFrame[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseFrame).filter((frame): frame is IssueEventFrame => frame != null);
}

function parseMechanism(value: Json | undefined): string | null {
  const direct = stringValue(value);
  if (direct != null) return direct;
  const record = asIssueEventRecord(value);
  return stringValue(valueAt(record, "type")) ?? stringValue(valueAt(record, "description"));
}

function parseExceptionChain(data: IssueEventRecord | null): IssueExceptionValue[] {
  const exception = asIssueEventRecord(valueAt(data, "exception"));
  const values = valueAt(exception, "values");
  if (!Array.isArray(values)) return [];
  return values.map((value, index) => {
    const record = asIssueEventRecord(value);
    const stacktrace = asIssueEventRecord(valueAt(record, "stacktrace"));
    return {
      index,
      type: stringValue(valueAt(record, "type")),
      value: stringValue(valueAt(record, "value")),
      mechanism: parseMechanism(valueAt(record, "mechanism")),
      handled: booleanValue(valueAt(record, "handled")),
      frames: parseFrames(valueAt(stacktrace, "frames")),
      rawStack: stringValue(valueAt(record, "stack")),
    };
  });
}

function parseSafeRequest(data: IssueEventRecord | null): IssueSafeRequestContext | null {
  const request = asIssueEventRecord(valueAt(data, "request"));
  if (request == null) return null;
  const statusCode = numberValue(valueAt(request, "status_code"));
  const fields = [
    { key: "URL", value: (() => {
      const url = stringValue(valueAt(request, "url"));
      if (url == null) return null;
      return safeDisplayValue(url, "url");
    })() },
    { key: "Method", value: stringValue(valueAt(request, "method")) },
    { key: "Status", value: statusCode },
  ].filter(({ value }) => value != null);
  return { fields };
}

function parseBreadcrumbs(data: IssueEventRecord | null): IssueBreadcrumb[] {
  const breadcrumbs = valueAt(data, "breadcrumbs");
  if (!Array.isArray(breadcrumbs)) return [];
  return breadcrumbs.flatMap((value, index) => {
    const record = asIssueEventRecord(value);
    if (record == null) return [];
    return [{
      index,
      timestamp: numberValue(valueAt(record, "timestamp")),
      category: stringValue(valueAt(record, "category")),
      message: stringValue(valueAt(record, "message")),
      level: stringValue(valueAt(record, "level")),
      data: asIssueEventRecord(safeDisplayValue(valueAt(record, "data"), "data")),
    }];
  });
}

function parseAdditionalData(data: IssueEventRecord | null): IssueEventField[] {
  return objectEntries(data).filter(({ key }) => !RESERVED_EVENT_KEYS.has(key) && !isSensitiveEventKey(key));
}

function deduplicateSymbolicationDiagnostics(
  diagnostics: readonly IssueSymbolicationDiagnostic[],
): IssueSymbolicationDiagnostic[] {
  const unique = new Map<string, IssueSymbolicationDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.code,
      diagnostic.message,
      diagnostic.debugId ?? "",
      diagnostic.codeFile ?? "",
      diagnostic.line ?? "",
      diagnostic.column ?? "",
      diagnostic.source ?? "",
    ].join("\u001f");
    unique.set(key, diagnostic);
  }
  return [...unique.values()];
}

export function heroStack(occurrence: Pick<IssueOccurrence, "data" | "frames" | "raw_stack">): {
  frames: IssueEventFrame[],
  rawStack: string | null,
} {
  const payload = getIssueEventPayload(occurrence);
  const primary = payload.exceptionChain.at(-1);
  if (primary !== undefined && (primary.frames.length > 0 || (primary.rawStack != null && primary.rawStack.trim() !== ""))) {
    return { frames: primary.frames, rawStack: primary.rawStack };
  }
  return { frames: payload.occurrenceFrames, rawStack: occurrence.raw_stack };
}

export function getIssueEventPayload(occurrence: IssueEventOccurrenceProjection): IssueEventPayload {
  const data = asIssueEventRecord(occurrence.data);
  const occurrenceFrames = parseFrames(occurrence.frames);
  const exceptionChain = parseExceptionChain(data);
  const occurrenceRecord = asIssueEventRecord(occurrence);
  const frameDiagnostics = [
    ...occurrenceFrames.flatMap((frame) => frame.symbolication?.diagnostics ?? []),
    ...exceptionChain.flatMap((exception) => exception.frames.flatMap((frame) => frame.symbolication?.diagnostics ?? [])),
  ];
  return {
    data,
    eventId: stringValue(valueAt(data, "event_id")),
    occurrenceFrames,
    exceptionChain,
    safeRequest: parseSafeRequest(data),
    tags: objectEntries(valueAt(data, "tags")),
    contexts: objectEntries(valueAt(data, "contexts")),
    breadcrumbs: parseBreadcrumbs(data),
    extra: objectEntries(valueAt(data, "extra")),
    fingerprint: stringList(valueAt(data, "fingerprint")),
    fingerprintOverride: stringList(valueAt(data, "fingerprint_override")),
    additionalData: parseAdditionalData(data),
    symbolicationDiagnostics: deduplicateSymbolicationDiagnostics([
      ...parseSymbolicationDiagnostics(valueAt(occurrenceRecord, "symbolication_diagnostics")),
      ...frameDiagnostics,
    ]),
  };
}

export function breadcrumbTimestampMillis(timestamp: number): number {
  return Math.abs(timestamp) < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
}

export function formatIssueEventValue(value: Json | undefined): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

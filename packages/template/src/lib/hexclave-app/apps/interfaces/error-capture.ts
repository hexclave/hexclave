/**
 * Public error-capture types. These deliberately describe the product-facing
 * contract rather than the current OTLP wire projection. The adapter can grow
 * without forcing callers to construct OpenTelemetry LogRecords themselves.
 */

export const ERROR_LEVELS = ["fatal", "error", "warning", "info", "debug", "log"] as const;
export type ErrorLevel = typeof ERROR_LEVELS[number];

/** Lowercase, dashless 32-character event identity used by the error protocol. */
export type ErrorEventId = string;

export type ErrorUser = {
  id?: string,
  email?: string,
  username?: string,
};

export type ErrorBreadcrumb = {
  timestamp?: number,
  category?: string,
  message?: string,
  level?: ErrorLevel,
  data?: Record<string, unknown>,
};

/** Sentry-compatible attachment kinds accepted by the SDK boundary. */
export type ErrorAttachmentType =
  | "event.attachment"
  | "event.minidump"
  | "event.applecrashreport"
  | "unreal.context"
  | "unreal.logs"
  | "event.view_hierarchy"
  | (string & {});

/**
 * Binary data associated with an error. Bytes are intentionally separate from
 * the `$error` event projection; the configured attachment transport uploads
 * them as a private item after the event is accepted.
 */
export type ErrorAttachmentInput = {
  data: string | Uint8Array,
  filename: string,
  contentType?: string,
  attachmentType?: ErrorAttachmentType,
  occurrenceId?: string,
  idempotencyKey?: string,
};

export type ErrorAttachmentMetadata = {
  id?: string,
  eventId: ErrorEventId,
  occurrenceId?: string | null,
  filename: string,
  contentType: string,
  attachmentType: string,
  byteLength: number,
  sha256?: string,
  createdAt?: string,
  status: "pending" | "uploaded" | "failed",
};

export type ErrorAttachmentUploadRequest = {
  eventId: ErrorEventId,
  attachment: ErrorAttachmentInput,
};

export type ErrorAttachmentUploadResult = {
  status: "uploaded" | "already_uploaded",
  attachment: ErrorAttachmentMetadata & {
    id: string,
    sha256: string,
    createdAt: string,
    status: "uploaded",
  },
};

export type ErrorAttachmentTransport = {
  upload(request: ErrorAttachmentUploadRequest): Promise<ErrorAttachmentUploadResult>,
};

/** A retryable, typed hand-off when automatic upload is unavailable or fails. */
export type PendingErrorAttachment = {
  eventId: ErrorEventId,
  input: ErrorAttachmentInput,
  metadata: ErrorAttachmentMetadata,
  upload(): Promise<ErrorAttachmentUploadResult>,
};

export type ErrorScopeData = {
  user?: ErrorUser | null,
  tags?: Record<string, string>,
  contexts?: Record<string, Record<string, unknown>>,
  extra?: Record<string, unknown>,
  breadcrumbs?: readonly ErrorBreadcrumb[],
  level?: ErrorLevel,
  /** Sentry-compatible grouping override. The server hashes these tokens as the issue key. */
  fingerprint?: readonly string[],
  /** Processors captured with this scope and run before the app-level beforeSend hook. */
  eventProcessors?: readonly ErrorEventProcessor[],
  /** Attachments are uploaded separately from the event envelope. */
  attachments?: readonly ErrorAttachmentInput[],
};

export type CaptureExceptionOptions = ErrorScopeData & {
  /**
   * Whether the caller handled the exception before reporting it.
   * The public `captureException` method defaults this to `true` because an
   * explicit capture is handled. Ingest and adapter payloads must send a
   * boolean; they must not invent `true` when the field is missing.
   * @default true
   */
  handled?: boolean,
  /** A stable integration/mechanism label, such as `captured` or `next.onRequestError`. */
  mechanism?: string,
};

export type CaptureMessageOptions = ErrorScopeData & {
  mechanism?: string,
};

/**
 * Stored / wire frame shape. Matches `ErrorEnvelopeStackFrame` and Sentry's
 * exception frame keys so ingest and the issue UI have one reader.
 */
export type ErrorStackFrame = {
  filename?: string,
  abs_path?: string,
  function?: string,
  module?: string,
  lineno?: number,
  colno?: number,
  in_app?: boolean,
  context_line?: string,
};

export type CapturedExceptionValue = {
  type?: string,
  value?: string,
  mechanism?: {
    type?: string,
    handled?: boolean,
    data?: Record<string, unknown>,
  },
  stacktrace?: {
    raw?: string,
    frames?: readonly ErrorStackFrame[],
  },
};

/** The bounded event shape exposed to SDK error processors. */
export type CapturedErrorEvent = {
  event_id: ErrorEventId,
  message?: string,
  name?: string,
  stack?: string,
  exception?: {
    values: readonly CapturedExceptionValue[],
  },
  mechanism_type?: string,
  handled?: boolean,
  synthetic?: 1,
  fingerprint?: string,
  release?: string,
  environment?: string,
  sdk_version?: string,
  user?: ErrorUser | null,
  tags?: Record<string, string>,
  contexts?: Record<string, Record<string, unknown>>,
  extra?: Record<string, unknown>,
  breadcrumbs?: readonly ErrorBreadcrumb[],
  level?: ErrorLevel,
  fingerprint_override?: readonly string[],
  [key: string]: unknown,
};

export type ErrorEventHint = {
  eventId: ErrorEventId,
  mechanism: string,
  handled: boolean,
  originalException?: unknown,
  scope: ErrorScopeData,
  attachments: readonly ErrorAttachmentInput[],
};

/** Explicit processor decisions; returning an event remains the terse replace form. */
export type ErrorProcessorDecision =
  | { action: "replace", event: CapturedErrorEvent }
  | { action: "drop", reason?: string };

export type ErrorProcessorResult = CapturedErrorEvent | ErrorProcessorDecision | null;

export type ErrorEventProcessor = (
  event: CapturedErrorEvent,
  hint: ErrorEventHint,
) => ErrorProcessorResult | PromiseLike<ErrorProcessorResult>;

/** `beforeSend` is the final, app-level processor and may drop or replace an event. */
export type ErrorBeforeSend = ErrorEventProcessor;

/**
 * A framework-neutral event input. `captureException` is the ergonomic path;
 * this shape is for adapters that already have a normalized exception chain or
 * need to attach an explicit stack/frame representation.
 */
export type CaptureEvent = ErrorScopeData & {
  message?: string,
  name?: string,
  stack?: string,
  exception?: {
    values: readonly CapturedExceptionValue[],
  },
  handled?: boolean,
  mechanism?: string,
  platform?: string,
  release?: string,
  environment?: string,
};

export type ErrorScope = {
  setUser(user: ErrorUser | null): ErrorScope,
  setTag(key: string, value: string): ErrorScope,
  setTags(tags: Record<string, string>): ErrorScope,
  setContext(key: string, value: Record<string, unknown>): ErrorScope,
  setExtras(extras: Record<string, unknown>): ErrorScope,
  setExtra(key: string, value: unknown): ErrorScope,
  addBreadcrumb(breadcrumb: ErrorBreadcrumb): ErrorScope,
  addEventProcessor(processor: ErrorEventProcessor): ErrorScope,
  addAttachment(attachment: ErrorAttachmentInput): ErrorScope,
  clearAttachments(): ErrorScope,
  setLevel(level: ErrorLevel): ErrorScope,
  setFingerprint(fingerprint: readonly string[]): ErrorScope,
  clear(): ErrorScope,
};

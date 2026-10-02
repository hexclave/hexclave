import { isRecord } from "@hexclave/shared/dist/utils/objects";
import type {
  ErrorAttachmentInput,
  ErrorAttachmentMetadata,
  ErrorAttachmentTransport,
  ErrorAttachmentUploadRequest,
  ErrorAttachmentUploadResult,
  ErrorEventId,
  PendingErrorAttachment,
} from "../interfaces/error-capture";

/** Keep one event from becoming an unbounded binary upload queue. */
export const MAX_ERROR_ATTACHMENTS = 10;
export const MAX_ERROR_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_ERROR_ATTACHMENT_FILENAME_BYTES = 255;
export const MAX_ERROR_ATTACHMENT_CONTENT_TYPE_BYTES = 255;
export const MAX_ERROR_ATTACHMENT_TYPE_BYTES = 64;
export const MAX_ERROR_ATTACHMENT_IDEMPOTENCY_KEY_BYTES = 256;
export const MAX_ERROR_ATTACHMENT_OCCURRENCE_ID_BYTES = 256;
const MAX_ATTACHMENT_UPLOAD_ATTEMPTS = 3;
const ATTACHMENT_RETRY_BASE_DELAY_MS = 1_000;
const ATTACHMENT_RETRY_MAX_DELAY_MS = 30_000;
const ATTACHMENT_KEEPALIVE_MAX_BODY_BYTES = 30_000;
const RETRYABLE_ATTACHMENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const DEFAULT_ATTACHMENT_TYPE = "event.attachment";
const ATTACHMENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

export function cloneErrorAttachmentInput(input: ErrorAttachmentInput): ErrorAttachmentInput {
  return normalizeErrorAttachmentInput(input);
}

export function normalizeErrorAttachmentInput(input: ErrorAttachmentInput): ErrorAttachmentInput {
  const filename = validateFilename(input.filename);
  const contentType = validateContentType(input.contentType);
  const attachmentType = validateAttachmentType(input.attachmentType);
  const idempotencyKey = validateOptionalText(input.idempotencyKey, MAX_ERROR_ATTACHMENT_IDEMPOTENCY_KEY_BYTES, "idempotencyKey");
  const occurrenceId = validateOptionalText(input.occurrenceId, MAX_ERROR_ATTACHMENT_OCCURRENCE_ID_BYTES, "occurrenceId");
  const data = cloneAttachmentData(input.data);
  return {
    data,
    filename,
    contentType,
    attachmentType,
    ...idempotencyKey === undefined ? {} : { idempotencyKey },
    ...occurrenceId === undefined ? {} : { occurrenceId },
  };
}

export function cloneErrorAttachmentInputs(inputs: readonly ErrorAttachmentInput[]): ErrorAttachmentInput[] {
  if (inputs.length > MAX_ERROR_ATTACHMENTS) {
    throw new Error(`Hexclave error capture supports at most ${MAX_ERROR_ATTACHMENTS} attachments per event`);
  }
  return inputs.map(cloneErrorAttachmentInput);
}

export function getErrorAttachmentInputs(scope: { attachments?: readonly ErrorAttachmentInput[] } | undefined): readonly ErrorAttachmentInput[] {
  return scope?.attachments ?? [];
}

export function assertErrorAttachmentDeliveryConfigured(
  attachments: readonly ErrorAttachmentInput[],
  transport: ErrorAttachmentTransport | undefined,
  onPending: ((attachment: PendingErrorAttachment) => void | PromiseLike<void>) | undefined,
): void {
  if (attachments.length > 0 && transport === undefined && onPending === undefined) {
    throw new Error(
      "Hexclave error attachments require observability.errorCapture.attachmentTransport or onAttachmentPending; bytes are never silently discarded",
    );
  }
}

export async function deliverErrorAttachments(options: {
  eventId: ErrorEventId,
  attachments: readonly ErrorAttachmentInput[],
  transport?: ErrorAttachmentTransport,
  onPending?: (attachment: PendingErrorAttachment) => void | PromiseLike<void>,
}): Promise<void> {
  for (const input of options.attachments) {
    const pending = createPendingErrorAttachment(options.eventId, input, options.transport);
    if (options.transport === undefined) {
      await notifyPendingAttachment(pending, options.onPending);
      continue;
    }
    try {
      await pending.upload();
    } catch (error) {
      const failed: PendingErrorAttachment = {
        ...pending,
        metadata: { ...pending.metadata, status: "failed" },
      };
      await notifyPendingAttachment(failed, options.onPending, error);
    }
  }
}

function createPendingErrorAttachment(
  eventId: ErrorEventId,
  input: ErrorAttachmentInput,
  transport: ErrorAttachmentTransport | undefined,
): PendingErrorAttachment {
  const normalized = cloneErrorAttachmentInput(input);
  const metadata: ErrorAttachmentMetadata = {
    eventId,
    filename: normalized.filename,
    contentType: normalized.contentType ?? DEFAULT_CONTENT_TYPE,
    attachmentType: normalized.attachmentType ?? DEFAULT_ATTACHMENT_TYPE,
    byteLength: attachmentByteLength(normalized.data),
    status: "pending",
  };
  return {
    eventId,
    input: normalized,
    metadata,
    upload: async () => {
      if (transport === undefined) throw new Error("No error attachment transport is configured");
      return await transport.upload({ eventId, attachment: normalized });
    },
  };
}

async function notifyPendingAttachment(
  pending: PendingErrorAttachment,
  onPending: ((attachment: PendingErrorAttachment) => void | PromiseLike<void>) | undefined,
  error?: unknown,
): Promise<void> {
  if (onPending !== undefined) {
    await onPending(pending);
    return;
  }
  const detail = error instanceof Error ? `: ${error.message}` : "";
  console.warn(`Hexclave error attachment remained ${pending.metadata.status} for ${pending.eventId}${detail}`);
}

/**
 * The default Hexclave transport only knows how to call the SDK request seam.
 * It deliberately has no knowledge of object storage, provider credentials, or
 * backend persistence; those remain server concerns behind the endpoint.
 */
export function createErrorAttachmentTransport(options: {
  sendRequest: (path: string, request: RequestInit) => Promise<Response>,
}): ErrorAttachmentTransport {
  return {
    upload: async (request) => {
      const body = JSON.stringify(toUploadBody(request));
      const bodyBytes = new TextEncoder().encode(body).byteLength;
      let lastStatus: number | undefined;
      for (let attempt = 1; attempt <= MAX_ATTACHMENT_UPLOAD_ATTEMPTS; attempt++) {
        let response: Response;
        try {
          response = await options.sendRequest("/analytics/attachments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            ...shouldUseAttachmentKeepalive(bodyBytes) ? { keepalive: true } : {},
          });
        } catch (error) {
          if (attempt === MAX_ATTACHMENT_UPLOAD_ATTEMPTS) {
            throw new Error("Error attachment upload encountered a network error", { cause: error });
          }
          await waitForAttachmentRetry(attempt);
          continue;
        }
        if (response.ok) return parseUploadResponse(await response.json());
        lastStatus = response.status;
        if (!RETRYABLE_ATTACHMENT_STATUSES.has(response.status)) {
          throw new Error(`Error attachment upload failed with HTTP ${response.status}`);
        }
        if (attempt < MAX_ATTACHMENT_UPLOAD_ATTEMPTS) {
          await waitForAttachmentRetry(attempt, response.headers.get("retry-after"));
        }
      }
      throw new Error(`Error attachment upload failed with HTTP ${lastStatus ?? "unknown"}`);
    },
  };
}

function shouldUseAttachmentKeepalive(bodyBytes: number): boolean {
  return typeof document !== "undefined"
    && document.visibilityState === "hidden"
    && bodyBytes <= ATTACHMENT_KEEPALIVE_MAX_BODY_BYTES;
}

async function waitForAttachmentRetry(attempt: number, retryAfterHeader?: string | null): Promise<void> {
  const retryAfterMs = parseAttachmentRetryAfter(retryAfterHeader ?? null)
    ?? Math.min(ATTACHMENT_RETRY_MAX_DELAY_MS, ATTACHMENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  await new Promise<void>((resolve) => setTimeout(resolve, retryAfterMs));
}

function parseAttachmentRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, ATTACHMENT_RETRY_MAX_DELAY_MS);
  const targetTime = Date.parse(header);
  if (Number.isNaN(targetTime)) return null;
  return Math.min(Math.max(targetTime - Date.now(), 0), ATTACHMENT_RETRY_MAX_DELAY_MS);
}

/** The JSON body of one attachment upload call, matching the backend's wire contract. */
type ErrorAttachmentUploadBody = {
  event_id: ErrorAttachmentUploadRequest["eventId"],
  occurrence_id?: string,
  idempotency_key?: string,
  filename: string,
  content_type: string,
  attachment_type: string,
  data_base64: string,
};

function toUploadBody(request: ErrorAttachmentUploadRequest): ErrorAttachmentUploadBody {
  const input = normalizeErrorAttachmentInput(request.attachment);
  const body: ErrorAttachmentUploadBody = {
    event_id: request.eventId,
    filename: input.filename,
    content_type: input.contentType ?? DEFAULT_CONTENT_TYPE,
    attachment_type: input.attachmentType ?? DEFAULT_ATTACHMENT_TYPE,
    data_base64: encodeBase64(input.data),
  };
  if (input.occurrenceId !== undefined) body.occurrence_id = input.occurrenceId;
  if (input.idempotencyKey !== undefined) body.idempotency_key = input.idempotencyKey;
  return body;
}

function parseUploadResponse(value: unknown): ErrorAttachmentUploadResult {
  if (!isRecord(value) || (value.status !== "uploaded" && value.status !== "already_uploaded") || !isRecord(value.attachment)) {
    throw new Error("Error attachment upload returned an invalid response");
  }
  const attachment = value.attachment;
  const eventId = readString(attachment.event_id);
  const filename = readString(attachment.filename);
  const contentType = readString(attachment.content_type);
  const attachmentType = readString(attachment.attachment_type);
  const id = readString(attachment.id);
  const sha256 = readString(attachment.sha256);
  const byteLength = readSafeInteger(attachment.byte_length);
  const createdAt = readString(attachment.created_at);
  const occurrenceId = attachment.occurrence_id === null ? null : readString(attachment.occurrence_id);
  return {
    status: value.status,
    attachment: {
      id,
      eventId,
      occurrenceId,
      filename,
      contentType,
      attachmentType,
      byteLength,
      sha256,
      createdAt,
      status: "uploaded",
    },
  };
}

function cloneAttachmentData(data: string | Uint8Array): string | Uint8Array {
  if (typeof data === "string") {
    const bytes = new TextEncoder().encode(data);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ERROR_ATTACHMENT_BYTES) {
      throw new Error(`Hexclave error attachment data must be between 1 and ${MAX_ERROR_ATTACHMENT_BYTES} bytes`);
    }
    return data;
  }
  const copy = new Uint8Array(data);
  if (copy.byteLength === 0 || copy.byteLength > MAX_ERROR_ATTACHMENT_BYTES) {
    throw new Error(`Hexclave error attachment data must be between 1 and ${MAX_ERROR_ATTACHMENT_BYTES} bytes`);
  }
  return copy;
}

function attachmentByteLength(data: string | Uint8Array): number {
  return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
}

function validateFilename(value: string): string {
  if (value.length === 0 || value.trim() !== value || value === "." || value === ".." || /[\\/\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Hexclave error attachment filename must be one safe path segment");
  }
  if (new TextEncoder().encode(value).byteLength > MAX_ERROR_ATTACHMENT_FILENAME_BYTES) {
    throw new Error("Hexclave error attachment filename is too long");
  }
  return value;
}

function validateContentType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_ERROR_ATTACHMENT_CONTENT_TYPE_BYTES || !/^[a-z0-9][a-z0-9!#$&^_.+*-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+*-]{0,126}(?:;[ -~]{1,96})?$/iu.test(value)) {
    throw new Error("Hexclave error attachment contentType is invalid");
  }
  return value.toLowerCase();
}

function validateAttachmentType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (new TextEncoder().encode(value).byteLength > MAX_ERROR_ATTACHMENT_TYPE_BYTES || !ATTACHMENT_TYPE_PATTERN.test(value)) {
    throw new Error("Hexclave error attachment attachmentType is invalid");
  }
  return value;
}

function validateOptionalText(value: string | undefined, maxBytes: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value) || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new Error(`Hexclave error attachment ${label} is invalid`);
  }
  return value;
}

function encodeBase64(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  if (typeof globalThis.btoa !== "function") throw new Error("Hexclave error attachment upload requires btoa");
  return globalThis.btoa(binary);
}

function readString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Error attachment upload returned invalid metadata");
  return value;
}

function readSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Error attachment upload returned invalid byte length");
  return value;
}

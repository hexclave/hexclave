import { createHash } from "node:crypto";
import { isRecord } from "@hexclave/shared/dist/utils/objects";

export const MAX_ERROR_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_ERROR_ATTACHMENT_BASE64_BYTES = Math.ceil(MAX_ERROR_ATTACHMENT_BYTES / 3) * 4 + 4;
export const MAX_ERROR_ATTACHMENT_FILENAME_BYTES = 255;
export const MAX_ERROR_ATTACHMENT_CONTENT_TYPE_BYTES = 255;
export const MAX_ERROR_ATTACHMENT_TYPE_BYTES = 64;
export const MAX_ERROR_ATTACHMENT_IDEMPOTENCY_KEY_BYTES = 256;
export const MAX_ERROR_ATTACHMENT_EVENT_ID_BYTES = 32;
export const MAX_ERROR_ATTACHMENT_OCCURRENCE_ID_BYTES = 256;
export const MAX_ERROR_ATTACHMENTS_PER_EVENT = 100;
export const MAX_ERROR_ATTACHMENT_STORAGE_KEY_BYTES = 1024;

// Thrown for all caller-input validation failures in this module. Routes catch
// exactly this class (instead of any Error) so that unexpected internal errors
// never leak their messages to clients as BadRequest responses.
export class ErrorAttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrorAttachmentValidationError";
  }
}

const EVENT_ID_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+*-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+*-]{0,126}(?:;[ -~]{1,96})?$/i;
const ATTACHMENT_TYPE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

export type ErrorAttachmentScope = {
  tenantId: string,
  projectId: string,
  branchId: string,
};

export type ValidatedErrorAttachmentUpload = {
  eventId: string,
  occurrenceId: string | null,
  idempotencyKey: string,
  filename: string,
  contentType: string,
  attachmentType: string,
  bytes: Uint8Array,
  sha256: string,
};

export type ErrorAttachmentMetadata = {
  tenancyId: string,
  projectId: string,
  branchId: string,
  id: string,
  eventId: string,
  occurrenceId: string | null,
  idempotencyKey: string,
  filename: string,
  contentType: string,
  attachmentType: string,
  byteLength: number,
  sha256: string,
  storageKey: string,
  createdAt: Date,
};

export type ErrorAttachmentUploadResult = {
  status: "uploaded" | "already_uploaded",
  attachment: ErrorAttachmentMetadata,
};

export function validateErrorAttachmentScope(scope: ErrorAttachmentScope): ErrorAttachmentScope {
  return {
    tenantId: validateScopePart(scope.tenantId, "tenantId"),
    projectId: validateScopePart(scope.projectId, "projectId"),
    branchId: validateScopePart(scope.branchId, "branchId"),
  };
}

export function validateErrorEventId(value: unknown): string {
  if (typeof value !== "string" || !EVENT_ID_RE.test(value.toLowerCase())) {
    throw new ErrorAttachmentValidationError("eventId must be 32 lowercase hexadecimal characters");
  }
  return value.toLowerCase();
}

export function validateErrorAttachmentSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new ErrorAttachmentValidationError("Attachment SHA-256 is invalid");
  return value;
}

export function validateErrorAttachmentUpload(input: unknown): ValidatedErrorAttachmentUpload {
  if (!isRecord(input)) throw new ErrorAttachmentValidationError("Attachment upload body must be an object");
  const eventId = validateErrorEventId(input.event_id ?? input.eventId);
  const filename = validateFilename(input.filename);
  const contentType = validateContentType(input.content_type ?? input.contentType);
  const attachmentType = validateAttachmentType(input.attachment_type ?? input.attachmentType);
  const occurrenceId = validateOptionalText(input.occurrence_id ?? input.occurrenceId, MAX_ERROR_ATTACHMENT_OCCURRENCE_ID_BYTES, "occurrenceId");
  const providedIdempotencyKey = validateOptionalText(input.idempotency_key ?? input.idempotencyKey, MAX_ERROR_ATTACHMENT_IDEMPOTENCY_KEY_BYTES, "idempotencyKey");
  const bytes = decodeBase64(input.data_base64 ?? input.dataBase64);
  const sha256 = sha256Hex(bytes);
  const idempotencyKey = providedIdempotencyKey ?? `${eventId}:${sha256}:${sha256Hex(new TextEncoder().encode(filename))}`;
  return { eventId, occurrenceId, idempotencyKey, filename, contentType, attachmentType, bytes, sha256 };
}

export function getErrorAttachmentObjectKey(scopeInput: ErrorAttachmentScope, eventIdInput: unknown, sha256: unknown): string {
  const scope = validateErrorAttachmentScope(scopeInput);
  const eventId = validateErrorEventId(eventIdInput);
  const digest = validateErrorAttachmentSha256(sha256);
  const key = `error-attachments/v1/tenants/${encodeURIComponent(scope.tenantId)}/projects/${encodeURIComponent(scope.projectId)}/branches/${encodeURIComponent(scope.branchId)}/events/${eventId}/objects/${digest}.bin`;
  if (Buffer.byteLength(key, "utf8") > MAX_ERROR_ATTACHMENT_STORAGE_KEY_BYTES) {
    throw new ErrorAttachmentValidationError(`Attachment storage key exceeds ${MAX_ERROR_ATTACHMENT_STORAGE_KEY_BYTES} bytes; the tenant/project/branch scope is too long to store attachments`);
  }
  return key;
}

export function encodeErrorAttachmentBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ERROR_ATTACHMENT_BASE64_BYTES || !BASE64_RE.test(value)) {
    throw new ErrorAttachmentValidationError("data_base64 must be a bounded standard base64 value");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ERROR_ATTACHMENT_BYTES) {
    throw new ErrorAttachmentValidationError(`Attachment bytes must be between 1 and ${MAX_ERROR_ATTACHMENT_BYTES} bytes`);
  }
  return bytes;
}

function validateFilename(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > MAX_ERROR_ATTACHMENT_FILENAME_BYTES) {
    throw new ErrorAttachmentValidationError("filename must be a bounded non-empty string");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_ERROR_ATTACHMENT_FILENAME_BYTES || value === "." || value === ".." || /[\\/\u0000-\u001f\u007f]/u.test(value)) {
    throw new ErrorAttachmentValidationError("filename must be a single safe path segment");
  }
  return value;
}

function validateContentType(value: unknown): string {
  const contentType = value === undefined ? "application/octet-stream" : value;
  if (typeof contentType !== "string" || Buffer.byteLength(contentType, "utf8") > MAX_ERROR_ATTACHMENT_CONTENT_TYPE_BYTES || !MIME_RE.test(contentType)) {
    throw new ErrorAttachmentValidationError("contentType must be a valid bounded MIME type");
  }
  return contentType.toLowerCase();
}

function validateAttachmentType(value: unknown): string {
  const attachmentType = value === undefined ? "event.attachment" : value;
  if (typeof attachmentType !== "string" || Buffer.byteLength(attachmentType, "utf8") > MAX_ERROR_ATTACHMENT_TYPE_BYTES || !ATTACHMENT_TYPE_RE.test(attachmentType)) {
    throw new ErrorAttachmentValidationError("attachmentType must be a bounded identifier");
  }
  return attachmentType;
}

function validateOptionalText(value: unknown, maxBytes: number, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ErrorAttachmentValidationError(`${label} must be a bounded printable string`);
  }
  return value;
}

function validateScopePart(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ErrorAttachmentValidationError(`${label} is invalid`);
  }
  return value;
}


function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

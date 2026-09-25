/** Shared image attachment limits for AI chat (client composer + `/api/latest/ai/query/[mode]`). */

import { KnownErrors } from "../known-errors";

export const MAX_IMAGES_PER_MESSAGE = 3;
export const MAX_IMAGE_BYTES_PER_FILE = 3 * 1024 * 1024;
export const MAX_IMAGE_MB_PER_FILE = MAX_IMAGE_BYTES_PER_FILE / (1024 * 1024);

/** Decoded byte length of a base64 data URL or raw base64 (padding error ≤ 2 bytes). */
export function estimateBase64ByteLength(dataUrl: string): number {
  const commaIdx = dataUrl.indexOf(",");
  const base64 = commaIdx === -1 ? dataUrl : dataUrl.slice(commaIdx + 1);
  if (base64.length === 0) return 0;
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export type ImageValidationFailure =
  | { code: "too_many", maxImages: number }
  | { code: "too_large", maxBytes: number, actualBytes: number };

export type ImageValidationResult =
  | { ok: true }
  | { ok: false, failure: ImageValidationFailure, reason: string };

type UnknownPart = { type?: unknown, image?: unknown };
type MessageLike = { role?: unknown, content?: unknown };

export function validateImageCount(imageCount: number): ImageValidationResult {
  if (imageCount > MAX_IMAGES_PER_MESSAGE) {
    return {
      ok: false,
      failure: { code: "too_many", maxImages: MAX_IMAGES_PER_MESSAGE },
      reason: `Maximum ${MAX_IMAGES_PER_MESSAGE} images per message.`,
    };
  }
  return { ok: true };
}

export function validateImageByteLength(bytes: number): ImageValidationResult {
  if (bytes > MAX_IMAGE_BYTES_PER_FILE) {
    return {
      ok: false,
      failure: { code: "too_large", maxBytes: MAX_IMAGE_BYTES_PER_FILE, actualBytes: bytes },
      reason: `Image exceeds ${MAX_IMAGE_MB_PER_FILE}MB limit (${(bytes / 1024 / 1024).toFixed(2)}MB).`,
    };
  }
  return { ok: true };
}

function throwImageValidationFailure(failure: ImageValidationFailure): never {
  switch (failure.code) {
    case "too_many": {
      throw new KnownErrors.TooManyImageAttachments(failure.maxImages);
    }
    case "too_large": {
      throw new KnownErrors.ImageAttachmentTooLarge(failure.maxBytes, failure.actualBytes);
    }
  }
}

/** Validates per-message image count and per-file size for user messages. */
export function validateImageAttachments(messages: readonly MessageLike[]): void {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    let imageCount = 0;
    for (const rawPart of msg.content as unknown[]) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as UnknownPart;
      if (part.type !== "image") continue;
      imageCount++;
      const countValidation = validateImageCount(imageCount);
      if (!countValidation.ok) throwImageValidationFailure(countValidation.failure);
      if (typeof part.image === "string") {
        const bytes = estimateBase64ByteLength(part.image);
        const sizeValidation = validateImageByteLength(bytes);
        if (!sizeValidation.ok) throwImageValidationFailure(sizeValidation.failure);
      }
    }
  }
}

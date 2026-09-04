import { z } from "zod";
import type { HexclaveAskDiagnostic, HexclaveAskRequestMetadata } from "../../../packages/shared/src/ai/hexclave-ask";

export const HEXCLAVE_FEEDBACK_INGEST_TIMEOUT_MS = 10_000;
export const HEXCLAVE_FEEDBACK_PUBLIC_ERROR_MESSAGE = "Feedback could not be recorded right now. Please try again later.";

export const FEEDBACK_CATEGORIES = ["bug", "docs-gap", "suggestion", "praise", "other"] as const;
export type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number];

export const FEEDBACK_MESSAGE_MAX_LENGTH = 10_000;

export type HexclaveFeedbackDiagnostic = HexclaveAskDiagnostic;
export type HexclaveFeedbackRequestMetadata = HexclaveAskRequestMetadata;

export type HexclaveFeedbackResult = {
  status: "ok",
  correlationId: string,
} | {
  status: "error",
  message: string,
};

const feedbackResponseSchema = z.object({ correlationId: z.string() });


export async function sendHexclaveFeedback(options: {
  internalToolBaseUrl: string,
  ingestSecret: string,
  category: FeedbackCategory,
  message: string,
  conversationId?: string | null,
  requestMetadata: HexclaveFeedbackRequestMetadata,
  timeoutMs?: number,
  onDiagnostic?: (diagnostic: HexclaveFeedbackDiagnostic) => void,
}): Promise<HexclaveFeedbackResult> {
  const timeoutMs = options.timeoutMs ?? HEXCLAVE_FEEDBACK_INGEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${options.internalToolBaseUrl.replace(/\/$/, "")}/api/public/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${options.ingestSecret}`,
        },
        body: JSON.stringify({
          category: options.category,
          message: options.message,
          conversationId: options.conversationId,
          requestMetadata: options.requestMetadata,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw error;
      }
      options.onDiagnostic?.({ event: "request-error", error });
      return { status: "error", message: HEXCLAVE_FEEDBACK_PUBLIC_ERROR_MESSAGE };
    }

    if (!response.ok) {
      const body = await response.text();
      options.onDiagnostic?.({ event: "upstream-error", status: response.status, body });
      return { status: "error", message: HEXCLAVE_FEEDBACK_PUBLIC_ERROR_MESSAGE };
    }

    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw error;
      }
      options.onDiagnostic?.({ event: "malformed-json", error });
      return { status: "error", message: HEXCLAVE_FEEDBACK_PUBLIC_ERROR_MESSAGE };
    }

    const parsed = feedbackResponseSchema.safeParse(responseJson);
    if (!parsed.success) {
      options.onDiagnostic?.({ event: "malformed-json", error: parsed.error });
      return { status: "error", message: HEXCLAVE_FEEDBACK_PUBLIC_ERROR_MESSAGE };
    }
    return { status: "ok", correlationId: parsed.data.correlationId };
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      options.onDiagnostic?.({ event: "timeout", timeoutMs });
      return { status: "error", message: HEXCLAVE_FEEDBACK_PUBLIC_ERROR_MESSAGE };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

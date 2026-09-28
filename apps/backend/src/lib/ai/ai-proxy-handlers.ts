import { buildProxyLogRow, scheduleProxyLog } from "@/lib/ai/loggers/ai-proxy-logger";
import { ALLOWED_MODEL_IDS } from "@/lib/ai/models";
import type { SanitizedBody } from "@/lib/ai/types";
import { preprocessProxyBody } from "@/private";
import { captureError, StatusError } from "@hexclave/shared/dist/utils/errors";

export const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

export function sanitizeBody(raw: ArrayBuffer): SanitizedBody {
  const text = new TextDecoder().decode(raw);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StatusError(400, "Request body must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StatusError(400, "Request body must be a JSON object");
  }

  if (!parsed.model || !ALLOWED_MODEL_IDS.has(parsed.model)) {
    parsed.model = OPENROUTER_DEFAULT_MODEL;
  }

  const metadata = Reflect.get(parsed, "metadata");
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const userId = Reflect.get(metadata, "user_id");
    if (typeof userId === "string" && userId.length > 128) {
      Reflect.set(metadata, "user_id", userId.slice(0, 128));
    }
  }

  const processed = preprocessProxyBody({ parsedBody: parsed }) as { model: string } & Record<string, unknown>;
  return { parsed: processed, bytes: new TextEncoder().encode(JSON.stringify(processed)) };
}

export async function observeAndLog(args: {
  response: Response,
  sanitizedBody: SanitizedBody,
  callerApiKey: string,
  correlationId: string,
  startedAt: number,
  responseHeaders: Record<string, string>,
}): Promise<Response> {
  const { response, sanitizedBody, callerApiKey, correlationId, startedAt, responseHeaders } = args;
  const openrouterGenerationId = response.headers.get("X-Generation-Id") ?? undefined;
  try {
    scheduleProxyLog(buildProxyLogRow({
      correlationId,
      parsed: sanitizedBody.parsed,
      apiKey: callerApiKey,
      durationMs: Math.round(performance.now() - startedAt),
      responseStatus: response.status,
      openrouterGenerationId,
    }));
  } catch (err) {
    captureError("ai-proxy-log-build", err);
  }
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

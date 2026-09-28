import { requireBackendAssertion } from "@/lib/server/backend-auth";
import { handleApiError, readJsonBody, successResponse, zJsonArrayString } from "@/lib/server/route-utils";
import { callReducerStrict, opt } from "@/lib/server/spacetimedb-client";
import { getServiceSpacetimeToken } from "@/lib/server/spacetimedb-token";
import { z } from "zod";

const bodySchema = z.object({
  correlationId: z.string(),
  mode: z.string(),
  systemPromptId: z.string(),
  quality: z.string(),
  speed: z.string(),
  modelId: z.string(),
  isAuthenticated: z.boolean(),
  projectId: z.string().optional(),
  userId: z.string().optional(),
  requestedToolsJson: zJsonArrayString,
  messagesJson: zJsonArrayString,
  stepsJson: zJsonArrayString,
  finalText: z.string(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  cacheDiscountUsd: z.number().optional(),
  openrouterGenerationId: z.string().optional(),
  stepCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  errorMessage: z.string().optional(),
  conversationId: z.string().optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    await requireBackendAssertion(req);
    const body = bodySchema.parse(await readJsonBody(req));
    const token = await getServiceSpacetimeToken();
    await callReducerStrict(token, "log_ai_query", [
      body.correlationId,
      body.mode,
      body.systemPromptId,
      body.quality,
      body.speed,
      body.modelId,
      body.isAuthenticated,
      opt(body.projectId),
      opt(body.userId),
      body.requestedToolsJson,
      body.messagesJson,
      body.stepsJson,
      body.finalText,
      opt(body.inputTokens),
      opt(body.outputTokens),
      opt(body.cachedInputTokens),
      opt(body.cacheCreationTokens),
      opt(body.costUsd),
      opt(body.cacheDiscountUsd),
      opt(body.openrouterGenerationId),
      body.stepCount,
      body.durationMs,
      opt(body.errorMessage),
      opt(body.conversationId),
    ]);
    return successResponse();
  } catch (err) {
    return handleApiError("internal-tool-backend-log-ai-query", err);
  }
}

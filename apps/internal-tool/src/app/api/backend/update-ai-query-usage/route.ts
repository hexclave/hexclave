import { requireBackendAssertion } from "@/lib/server/backend-auth";
import { handleApiError, readJsonBody, successResponse } from "@/lib/server/route-utils";
import { callReducerStrict, opt } from "@/lib/server/spacetimedb-client";
import { getServiceSpacetimeToken } from "@/lib/server/spacetimedb-token";
import { z } from "zod";

const bodySchema = z.object({
  correlationId: z.string(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  cacheDiscountUsd: z.number().optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    await requireBackendAssertion(req);
    const body = bodySchema.parse(await readJsonBody(req));
    const token = await getServiceSpacetimeToken();
    await callReducerStrict(token, "update_ai_query_usage", [
      body.correlationId,
      opt(body.inputTokens),
      opt(body.outputTokens),
      opt(body.cachedInputTokens),
      opt(body.costUsd),
      opt(body.cacheDiscountUsd),
    ]);
    return successResponse();
  } catch (err) {
    return handleApiError("internal-tool-backend-update-ai-query-usage", err);
  }
}

import { requireBackendAssertion } from "@/lib/server/backend-auth";
import { handleApiError, readJsonBody, successResponse, zJsonArrayString } from "@/lib/server/route-utils";
import { callReducerStrict, opt } from "@/lib/server/spacetimedb-client";
import { getServiceSpacetimeToken } from "@/lib/server/spacetimedb-token";
import { z } from "zod";
import { MAX_MCP_ACTOR_FIELD_LENGTH, MAX_MCP_CONTEXT_LENGTH } from "../../../../../spacetimedb/src/mcp-call-limits";

const bodySchema = z.object({
  correlationId: z.string(),
  conversationId: z.string().optional(),
  toolName: z.string(),
  reason: z.string(),
  userPrompt: z.string(),
  question: z.string(),
  response: z.string(),
  stepCount: z.number().int().nonnegative(),
  innerToolCallsJson: zJsonArrayString,
  durationMs: z.number().int().nonnegative(),
  modelId: z.string(),
  errorMessage: z.string().optional(),
  context: z.string().max(MAX_MCP_CONTEXT_LENGTH).optional(),
  user: z.string().max(MAX_MCP_ACTOR_FIELD_LENGTH).optional(),
  project: z.string().max(MAX_MCP_ACTOR_FIELD_LENGTH).optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    await requireBackendAssertion(req);
    const body = bodySchema.parse(await readJsonBody(req));
    const token = await getServiceSpacetimeToken();
    await callReducerStrict(token, "log_mcp_call", [
      body.correlationId,
      opt(body.conversationId),
      body.toolName,
      body.reason,
      body.userPrompt,
      body.question,
      body.response,
      body.stepCount,
      body.innerToolCallsJson,
      body.durationMs,
      body.modelId,
      opt(body.errorMessage),
      opt(body.context),
      opt(body.user),
      opt(body.project),
    ]);
    return successResponse();
  } catch (err) {
    return handleApiError("internal-tool-backend-log-mcp-call", err);
  }
}

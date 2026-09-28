import { requireFeedbackIngestSecret } from "@/lib/server/feedback-auth";
import { handleApiError, readJsonBody, successResponse } from "@/lib/server/route-utils";
import { callReducerStrict, opt } from "@/lib/server/spacetimedb-client";
import { getServiceSpacetimeToken } from "@/lib/server/spacetimedb-token";
import { z } from "zod";

const FEEDBACK_CATEGORIES = ["bug", "docs-gap", "suggestion", "praise", "other"] as const;
const MESSAGE_MAX_LENGTH = 10_000;

const bodySchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  message: z.string().min(1).max(MESSAGE_MAX_LENGTH),
  conversationId: z.string().max(100).nullish(),
  requestMetadata: z.object({
    transport: z.string().max(100),
    requestIp: z.string().max(100).nullish(),
    requestIpSource: z.string().max(100).nullish(),
    userAgent: z.string().max(1_000).nullish(),
    requestHost: z.string().max(255).nullish(),
    mcpProtocolVersion: z.string().max(100).nullish(),
  }),
});

export async function POST(req: Request): Promise<Response> {
  try {
    requireFeedbackIngestSecret(req);
    const body = bodySchema.parse(await readJsonBody(req));
    const correlationId = crypto.randomUUID();
    const token = await getServiceSpacetimeToken();
    await callReducerStrict(token, "log_feedback", [
      correlationId,
      opt(body.conversationId),
      body.category,
      body.message,
      body.requestMetadata.transport,
      opt(body.requestMetadata.requestIp),
      opt(body.requestMetadata.requestIpSource),
      opt(body.requestMetadata.userAgent),
      opt(body.requestMetadata.requestHost),
      opt(body.requestMetadata.mcpProtocolVersion),
    ]);
    return successResponse({ correlationId });
  } catch (err) {
    return handleApiError("internal-tool-public-feedback", err);
  }
}

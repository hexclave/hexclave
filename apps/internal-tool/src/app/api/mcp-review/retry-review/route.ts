import { requireInternalAiChatReviewer } from "@/lib/server/internal-auth";
import { clearMcpQaReview, reviewMcpCall } from "@/lib/server/qa-reviewer";
import { signSpacetimeToken } from "@/lib/server/spacetimedb-token";
import { handleApiError, readJsonBody, successResponse } from "@/lib/server/route-utils";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { after } from "next/server";
import { z } from "zod";

const bodySchema = z.object({
  correlationId: z.string(),
  question: z.string(),
  reason: z.string(),
  response: z.string(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const { user } = await requireInternalAiChatReviewer(req);
    const spacetimeToken = await signSpacetimeToken({ subject: user.id });
    const body = bodySchema.parse(await readJsonBody(req));
    await clearMcpQaReview(spacetimeToken, body.correlationId);
    after(async () => {
      try {
        await reviewMcpCall(spacetimeToken, body);
      } catch (err) {
        captureError("internal-tool-mcp-review-retry-review", err);
      }
    });
    return successResponse();
  } catch (err) {
    return handleApiError("internal-tool-mcp-review-retry-review", err);
  }
}

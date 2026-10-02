import { requireBackendAssertion } from "@/lib/server/backend-auth";
import { reviewMcpCall } from "@/lib/server/qa-reviewer";
import { handleApiError, readJsonBody, successResponse } from "@/lib/server/route-utils";
import { getServiceSpacetimeToken } from "@/lib/server/spacetimedb-token";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { after } from "next/server";
import { z } from "zod";

const bodySchema = z.object({
  correlationId: z.string(),
  question: z.string(),
  reason: z.string(),
  response: z.string(),
});

// Runs the automated LLM QA review for a freshly logged MCP call. The backend
// fires this after `log-mcp-call` succeeds (the review updates that row).
export async function POST(req: Request): Promise<Response> {
  try {
    await requireBackendAssertion(req);
    const body = bodySchema.parse(await readJsonBody(req));
    const token = await getServiceSpacetimeToken();
    after(async () => {
      try {
        await reviewMcpCall(token, body);
      } catch (err) {
        captureError("internal-tool-backend-review-mcp-call", err);
      }
    });
    return successResponse();
  } catch (err) {
    return handleApiError("internal-tool-backend-review-mcp-call", err);
  }
}

import { requireBackendAssertion } from "@/lib/server/backend-auth";
import { handleApiError } from "@/lib/server/route-utils";
import { getServiceSpacetimeToken } from "@/lib/server/spacetimedb-token";
import { getVerifiedQaContext } from "@/lib/server/verified-qa";

// Serves the human-verified published Q&A prompt block consumed by the
// backend's AI system prompts (hot path there, cached backend-side for ~60s).
export async function GET(req: Request): Promise<Response> {
  try {
    await requireBackendAssertion(req);
    const token = await getServiceSpacetimeToken();
    const context = await getVerifiedQaContext(token);
    return Response.json({ context }, {
      headers: { "Cache-Control": "private, max-age=60" },
    });
  } catch (err) {
    return handleApiError("internal-tool-backend-verified-qa", err);
  }
}

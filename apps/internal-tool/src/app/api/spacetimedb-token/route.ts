import { requireInternalAiChatReviewer } from "@/lib/server/internal-auth";
import { handleApiError } from "@/lib/server/route-utils";
import { signSpacetimeToken } from "@/lib/server/spacetimedb-token";

// Mints a short-lived SpacetimeDB JWT for the signed-in user. Stack Auth
// remains the identity source (the cookie session is verified server-side);
// this endpoint just re-issues an OIDC credential under the internal tool's
// own issuer, which SpacetimeDB can validate via our discovery document.
export async function POST(req: Request): Promise<Response> {
  try {
    const { user, reviewerName } = await requireInternalAiChatReviewer(req);
    const token = await signSpacetimeToken({ subject: user.id, name: reviewerName });
    return Response.json({ token });
  } catch (err) {
    return handleApiError("internal-tool-spacetimedb-token", err);
  }
}

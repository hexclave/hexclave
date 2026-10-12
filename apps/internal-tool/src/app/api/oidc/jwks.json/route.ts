import { handleApiError } from "@/lib/server/route-utils";
import { publicJwks } from "@/lib/server/spacetimedb-token";

// Public keys for the internal tool's SpacetimeDB token issuer; referenced by
// the discovery document's `jwks_uri`.
export async function GET(): Promise<Response> {
  try {
    return Response.json(await publicJwks(), {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  } catch (err) {
    return handleApiError("internal-tool-oidc-jwks", err);
  }
}

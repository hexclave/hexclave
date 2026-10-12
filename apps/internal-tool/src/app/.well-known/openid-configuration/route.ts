import { handleApiError } from "@/lib/server/route-utils";
import { internalToolBaseUrl } from "@/lib/server/spacetimedb-token";

// OIDC discovery document for the internal tool's own SpacetimeDB token
// issuer. SpacetimeDB validates a JWT by fetching
// `{iss}/.well-known/openid-configuration` and following `jwks_uri`; the
// `issuer` field must byte-for-byte equal the JWT's `iss` claim.
export async function GET(): Promise<Response> {
  try {
    const issuer = internalToolBaseUrl();
    return Response.json(
      {
        issuer,
        jwks_uri: `${issuer}/api/oidc/jwks.json`,
        response_types_supported: ["id_token"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
      },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  } catch (err) {
    return handleApiError("internal-tool-openid-configuration", err);
  }
}

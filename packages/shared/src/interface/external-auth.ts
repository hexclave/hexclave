export const externalAuthProviderIds = [
  "clerk-integration",
  "better-auth-integration",
  "workos-integration",
] as const;

export type ExternalAuthProviderId = typeof externalAuthProviderIds[number];

/**
 * WorkOS User Management access tokens are issued by a per-client issuer
 * (`https://api.workos.com/user_management/<clientId>`), not by the bare API origin, so both the
 * issuer and the JWKS endpoint are fully determined by the client ID. They're derived here — in one
 * place shared by the verifier and the dashboard — because two independent constructions of these
 * URLs is how the two ended up disagreeing, which rejects every genuine token with nothing pointing
 * at the issuer as the cause. The override exists only for a WorkOS deployment whose tokens carry a
 * different issuer.
 */
export function getWorkOSVerificationUrls(clientId: string, issuerOverride?: string): {
  issuer: string,
  jwksUrl: string,
} {
  const encodedClientId = encodeURIComponent(clientId);
  return {
    issuer: issuerOverride == null || issuerOverride.length === 0
      ? `https://api.workos.com/user_management/${encodedClientId}`
      : issuerOverride,
    jwksUrl: `https://api.workos.com/sso/jwks/${encodedClientId}`,
  };
}

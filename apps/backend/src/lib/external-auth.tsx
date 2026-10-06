import { Tenancy } from "@/lib/tenancies";
import { safeOAuthFetch } from "@/lib/ssrf-protection/oauth";
import { KnownErrors } from "@hexclave/shared";
import { externalAuthProviderIds, getWorkOSVerificationUrls, type ExternalAuthProviderId } from "@hexclave/shared/dist/interface/external-auth";
import { emailSchema } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { createRemoteJWKSet, customFetch, decodeJwt, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";

export { externalAuthProviderIds };
export type { ExternalAuthProviderId };

export type VerifiedExternalIdentity = {
  issuer: string,
  subject: string,
  providerSessionId: string,
  expiresAt: Date,
  email: string | null,
  name: string | null,
  emailVerified: boolean,
};

type ProviderVerificationConfig = {
  issuer: string,
  jwksUrl: string,
  audience?: string,
  authorizedParties?: string[],
  clientId?: string,
};

const remoteJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const MAX_CACHED_REMOTE_JWK_SETS = 100;

function getRemoteJwkSet(jwksUrl: string) {
  const existing = remoteJwkSets.get(jwksUrl);
  if (existing != null) {
    remoteJwkSets.delete(jwksUrl);
    remoteJwkSets.set(jwksUrl, existing);
    return existing;
  }
  const created = createRemoteJWKSet(new URL(jwksUrl), {
    [customFetch]: safeOAuthFetch,
  });
  remoteJwkSets.set(jwksUrl, created);
  if (remoteJwkSets.size > MAX_CACHED_REMOTE_JWK_SETS) {
    const leastRecentlyUsedUrl = remoteJwkSets.keys().next().value;
    if (leastRecentlyUsedUrl != null) {
      remoteJwkSets.delete(leastRecentlyUsedUrl);
    }
  }
  return created;
}

function requireConfigured(value: string | undefined): string {
  if (value == null || value.length === 0) {
    throw new KnownErrors.ExternalAuthProviderNotConfigured("required_setting_missing");
  }
  return value;
}

function getAuthorizedParties(value: string | undefined): string[] | undefined {
  if (value == null || value.trim().length === 0) {
    // Clerk treats authorizedParties as an optional allowlist. A blank setting
    // deliberately means that no azp restriction is applied.
    return undefined;
  }
  const parties = value
    .split(/[\n,]/)
    .map(party => party.trim())
    .filter(party => party.length > 0);
  if (parties.length === 0) {
    throw new KnownErrors.ExternalAuthProviderNotConfigured("invalid_authorized_party");
  }
  return parties.map(party => {
    try {
      // Clerk's azp claim contains the requesting origin, so normalize the configured entries to
      // their origin — otherwise a cosmetic difference like a trailing slash in the dashboard
      // config would reject every token.
      return new URL(party).origin;
    } catch {
      throw new KnownErrors.ExternalAuthProviderNotConfigured("invalid_authorized_party");
    }
  });
}

export function validateAuthorizedParty(payload: JWTPayload, authorizedParties: string[] | undefined): void {
  if (authorizedParties == null) return;
  const authorizedParty = payload.azp;
  // Treat absence as a validation failure when an allowlist is configured:
  // otherwise a token without azp bypasses the subdomain-cookie-leak protection
  // that authorizedParties is meant to add.
  if (typeof authorizedParty !== "string" || !authorizedParties.includes(authorizedParty)) {
    throw new KnownErrors.InvalidExternalAuthToken("authorized_party_mismatch");
  }
}

function getProviderVerificationConfig(
  tenancy: Tenancy,
  providerId: ExternalAuthProviderId,
): ProviderVerificationConfig {
  if (tenancy.config.apps.installed[providerId]?.enabled !== true) {
    throw new KnownErrors.ExternalAuthProviderNotConfigured("provider_disabled");
  }

  switch (providerId) {
    case "clerk-integration": {
      const config = tenancy.config["clerk-integration"];
      const issuer = requireConfigured(config.issuer);
      return {
        issuer,
        jwksUrl: new URL("/.well-known/jwks.json", issuer).toString(),
        authorizedParties: getAuthorizedParties(config.authorizedParties),
      };
    }
    case "better-auth-integration": {
      const config = tenancy.config["better-auth-integration"];
      return {
        issuer: requireConfigured(config.issuer),
        audience: requireConfigured(config.audience),
        jwksUrl: requireConfigured(config.jwksUrl),
      };
    }
    case "workos-integration": {
      const config = tenancy.config["workos-integration"];
      const clientId = requireConfigured(config.clientId);
      const derivedUrls = getWorkOSVerificationUrls(clientId, config.issuer);
      return {
        issuer: derivedUrls.issuer,
        clientId,
        jwksUrl: derivedUrls.jwksUrl,
      };
    }
  }
}

function getRequiredClaim(payload: JWTPayload, claim: "sub" | "sid"): string {
  const value = payload[claim];
  if (typeof value !== "string" || value.length === 0) {
    throw new KnownErrors.InvalidExternalAuthToken("missing_claim");
  }
  return value;
}

function getOptionalProfileClaim(payload: JWTPayload, claim: "email" | "name"): string | null {
  const value = payload[claim];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    return null;
  }
  if (claim === "email" && !emailSchema.isValidSync(trimmed)) {
    return null;
  }
  return trimmed;
}

function validateTokenEncoding(token: string): void {
  if (token.length > 16_384 || token.split(".").length !== 3) {
    throw new KnownErrors.InvalidExternalAuthToken("malformed_token");
  }
  try {
    decodeProtectedHeader(token);
    decodeJwt(token);
  } catch {
    throw new KnownErrors.InvalidExternalAuthToken("malformed_token");
  }
}

export function getExternalAuthTokenErrorReason(error: unknown) {
  if (error instanceof joseErrors.JWTExpired) {
    return "expired" as const;
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return error.claim === "iss"
      ? "issuer_mismatch" as const
      : error.claim === "aud"
        ? "audience_mismatch" as const
        : "unknown" as const;
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed || error instanceof joseErrors.JWKSNoMatchingKey) {
    return "signature_mismatch" as const;
  }
  if (error instanceof joseErrors.JWTInvalid || error instanceof joseErrors.JWSInvalid) {
    return "malformed_token" as const;
  }
  if (error instanceof joseErrors.JOSENotSupported) {
    return "unknown" as const;
  }
  return null;
}

export async function verifyExternalAuthToken(options: {
  tenancy: Tenancy,
  providerId: ExternalAuthProviderId,
  token: string,
}): Promise<VerifiedExternalIdentity> {
  const config = getProviderVerificationConfig(options.tenancy, options.providerId);
  validateTokenEncoding(options.token);

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(options.token, getRemoteJwkSet(config.jwksUrl), {
      issuer: config.issuer,
      ...config.audience == null ? {} : { audience: config.audience },
    });
    payload = verified.payload;
  } catch (error) {
    const reason = getExternalAuthTokenErrorReason(error);
    if (reason != null) {
      throw new KnownErrors.InvalidExternalAuthToken(reason);
    }
    throw new HexclaveAssertionError("Failed to retrieve or process an external authentication provider's signing keys.", {
      cause: error,
      providerId: options.providerId,
    });
  }

  validateAuthorizedParty(payload, config.authorizedParties);
  if (config.clientId != null && payload.client_id !== config.clientId) {
    throw new KnownErrors.InvalidExternalAuthToken("client_id_mismatch");
  }

  const subject = getRequiredClaim(payload, "sub");
  const providerSessionId = getRequiredClaim(payload, "sid");
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new KnownErrors.InvalidExternalAuthToken("missing_claim");
  }

  const email = getOptionalProfileClaim(payload, "email");
  return {
    issuer: config.issuer,
    subject,
    providerSessionId,
    expiresAt: new Date(payload.exp * 1000),
    email,
    name: getOptionalProfileClaim(payload, "name"),
    emailVerified: email != null && payload.email_verified === true,
  };
}

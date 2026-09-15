import "server-only";

import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { getPublicJwkSet, type PublicJwk } from "@hexclave/shared/dist/utils/jwt";
import * as jose from "jose";
import { derivePrivateJwkFromSeed, SPACETIMEDB_SIGNING_KEY_DERIVATION_PURPOSE } from "../derive-private-jwk-from-seed";
import { SPACETIMEDB_TOKEN_AUDIENCE } from "../spacetimedb-constants";

// The internal tool is its own OIDC issuer for SpacetimeDB: it serves
// /.well-known/openid-configuration + a JWKS under its own origin, and mints
// short-lived ES256 JWTs for callers whose Stack Auth session it has verified.
// (Stack Auth itself doesn't expose an OIDC discovery document, so its access
// tokens can't be validated by SpacetimeDB directly; this shim can be deleted
// if that ever ships — see the module's ALLOWED_ISSUERS.)

const USER_TOKEN_TTL = "30m";

/** This deployment's public base URL (no trailing slash). Used as JWT `iss` and OIDC discovery origin. */
export function internalToolBaseUrl(): string {
  const baseUrl = getEnvVariable("HEXCLAVE_INTERNAL_TOOL_BASE_URL", "").trim().replace(/\/+$/, "");
  if (baseUrl === "" || baseUrl === "REPLACE_ME") {
    throw new HexclaveAssertionError("HEXCLAVE_INTERNAL_TOOL_BASE_URL is not configured for the internal tool.");
  }
  return baseUrl;
}

function privateJwk() {
  const seed = getEnvVariable("HEXCLAVE_SPACETIMEDB_SIGNING_SEED", "").trim();
  if (seed === "" || seed === "REPLACE_ME") {
    throw new HexclaveAssertionError("HEXCLAVE_SPACETIMEDB_SIGNING_SEED is not configured for the internal tool. Generate one with: openssl rand -base64 32");
  }
  return derivePrivateJwkFromSeed(SPACETIMEDB_SIGNING_KEY_DERIVATION_PURPOSE, seed);
}

export async function signSpacetimeToken(options: { subject: string, expiresIn?: string, name?: string }): Promise<string> {
  const jwk = privateJwk();
  const key = await jose.importJWK(jwk, "ES256");
  const claims: jose.JWTPayload = {};
  if (options.name != null && options.name !== "") {
    claims.name = options.name;
  }
  return await new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
    .setIssuer(internalToolBaseUrl())
    .setAudience(SPACETIMEDB_TOKEN_AUDIENCE)
    .setSubject(options.subject)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? USER_TOKEN_TTL)
    .sign(key);
}

export async function publicJwks(): Promise<{ keys: PublicJwk[] }> {
  return await getPublicJwkSet([privateJwk()]);
}

const SERVICE_TOKEN_SUBJECT = "__spacetimedb_service__";
const SERVICE_TOKEN_TTL_MILLIS = 60 * 60 * 1000;
const SERVICE_TOKEN_REFRESH_MARGIN_MILLIS = 5 * 60 * 1000;

let cachedServiceToken: { token: string, expiresAtMillis: number } | null = null;

export async function getServiceSpacetimeToken(): Promise<string> {
  if (cachedServiceToken && Date.now() < cachedServiceToken.expiresAtMillis - SERVICE_TOKEN_REFRESH_MARGIN_MILLIS) {
    return cachedServiceToken.token;
  }
  const token = await signSpacetimeToken({
    subject: SERVICE_TOKEN_SUBJECT,
    expiresIn: `${SERVICE_TOKEN_TTL_MILLIS / 1000}s`,
  });
  cachedServiceToken = { token, expiresAtMillis: Date.now() + SERVICE_TOKEN_TTL_MILLIS };
  return token;
}

import { OAuthBaseProvider } from "@/oauth/providers/base";
import type { OAuthAccessTokenRefreshError } from "@/oauth/providers/base";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError, captureError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { extractScopes } from "@hexclave/shared/dist/utils/strings";

function captureOAuthAccessTokenRefreshIssue(options: {
  location: string,
  message: string,
  providerInstance: OAuthBaseProvider,
  errorContext: Record<string, Json>,
  refreshError: Exclude<OAuthAccessTokenRefreshError, { type: "invalid-refresh-token" }>,
}) {
  const providerId = typeof options.errorContext.providerId === "string" ? options.errorContext.providerId : "unknown";
  const providerClass = options.providerInstance.constructor.name;
  captureError(options.location, new HexclaveAssertionError(
    `${options.message} (providerId: ${providerId}, providerClass: ${providerClass}, attempts: ${options.refreshError.attempts}, retries: ${options.refreshError.retryCount})`,
    {
      cause: options.refreshError.cause,
      ...options.errorContext,
      providerId,
      providerClass,
      refreshErrorType: options.refreshError.type,
      attempts: options.refreshError.attempts,
      retryCount: options.refreshError.retryCount,
      sawAmbiguousRefreshAttempt: options.refreshError.sawAmbiguousRefreshAttempt,
      causes: options.refreshError.causes,
    },
  ));
}

/**
 * Access tokens minted under Hexclave's shared OAuth apps must not be handed
 * to clients — they carry Hexclave's brand at the provider. Only allowed when
 * the deployer explicitly opts in via STACK_ALLOW_SHARED_OAUTH_ACCESS_TOKENS.
 * NOT gated on NODE_ENV — the env-var opt-in is the only escape hatch.
 */
export function isSharedAccessTokenBlocked(providerIsShared: boolean): boolean {
  if (!providerIsShared) return false;
  return getEnvVariable("STACK_ALLOW_SHARED_OAUTH_ACCESS_TOKENS", "") !== "true";
}

import.meta.vitest?.describe("isSharedAccessTokenBlocked", () => {
  const { test, expect, beforeEach, afterEach, vi } = import.meta.vitest!;
  beforeEach(() => {
    vi.stubEnv("HEXCLAVE_ALLOW_SHARED_OAUTH_ACCESS_TOKENS", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("non-shared provider is never blocked, regardless of env var", () => {
    expect(isSharedAccessTokenBlocked(false)).toBe(false);
    vi.stubEnv("HEXCLAVE_ALLOW_SHARED_OAUTH_ACCESS_TOKENS", "true");
    expect(isSharedAccessTokenBlocked(false)).toBe(false);
  });

  test("shared provider is blocked when env var is unset or empty", () => {
    expect(isSharedAccessTokenBlocked(true)).toBe(true);
  });

  test("shared provider is blocked for any value other than the literal 'true'", () => {
    for (const v of ["false", "1", "TRUE", "yes", " true "]) {
      vi.stubEnv("HEXCLAVE_ALLOW_SHARED_OAUTH_ACCESS_TOKENS", v);
      expect(isSharedAccessTokenBlocked(true)).toBe(true);
    }
  });

  test("shared provider is allowed only when env var === 'true'", () => {
    vi.stubEnv("HEXCLAVE_ALLOW_SHARED_OAUTH_ACCESS_TOKENS", "true");
    expect(isSharedAccessTokenBlocked(true)).toBe(false);
  });

  test("result does not depend on NODE_ENV", () => {
    for (const nodeEnv of ["production", "development", "test", "preview", ""]) {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("HEXCLAVE_ALLOW_SHARED_OAUTH_ACCESS_TOKENS", "");
      expect(isSharedAccessTokenBlocked(true)).toBe(true);
      vi.stubEnv("HEXCLAVE_ALLOW_SHARED_OAUTH_ACCESS_TOKENS", "true");
      expect(isSharedAccessTokenBlocked(true)).toBe(false);
    }
  });
});

/**
 * Retrieves a valid access token for one or more OAuth accounts, or refreshes one if needed.
 *
 * When multiple account IDs are provided (legacy per-provider endpoint), tokens are searched
 * across all accounts. When a single ID is provided (per-account endpoint), only that account
 * is checked.
 */
export async function retrieveOrRefreshAccessToken(options: {
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  providerInstance: OAuthBaseProvider,
  providerId: string,
  tenancyId: string,
  oauthAccountIds: string[],
  scope: string | undefined,
  errorContext: Record<string, Json>,
}): Promise<{ access_token: string }> {
  const { prisma, providerInstance, providerId, tenancyId, oauthAccountIds, scope, errorContext } = options;
  const accountIdFilter = oauthAccountIds.length === 1
    ? { oauthAccountId: oauthAccountIds[0] }
    : { oauthAccountId: { in: oauthAccountIds } };
  const reauthorizeDetails = "The stored OAuth refresh token is missing, expired, revoked, or no longer accepted by the OAuth provider. The user needs to re-authorize this connected account.";
  const requiredScopeDetails = scope
    ? `The OAuth connection does not have a usable refresh token with the required scope (${scope}). The user needs to re-authorize this connected account with the requested scope.`
    : "The OAuth connection does not have a usable refresh token for this connected account. The user needs to re-authorize this connected account.";

  // ====================== retrieve access token if it exists ======================
  const accessTokens = await prisma.oAuthAccessToken.findMany({
    where: {
      tenancyId,
      ...accountIdFilter,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date(Date.now() + 5 * 60 * 1000) } },
      ],
      isValid: true,
    },
  });
  const filteredTokens = accessTokens.filter((t) => {
    return extractScopes(scope || "").every((s) => t.scopes.includes(s));
  });
  for (const token of filteredTokens) {
    if (await providerInstance.checkAccessTokenValidity(token.accessToken)) {
      return { access_token: token.accessToken };
    } else {
      await prisma.oAuthAccessToken.update({
        where: { id: token.id },
        data: { isValid: false },
      });
    }
  }

  // ============== no valid access token found, try to refresh the token ==============
  const refreshTokens = await prisma.oAuthToken.findMany({
    where: {
      tenancyId,
      ...accountIdFilter,
      isValid: true,
    },
  });

  const filteredRefreshTokens = refreshTokens.filter((t) => {
    return extractScopes(scope || "").every((s) => t.scopes.includes(s));
  });

  if (refreshTokens.length === 0) {
    throw new KnownErrors.OAuthAccessTokenNotAvailable(providerId, reauthorizeDetails);
  }

  if (filteredRefreshTokens.length === 0) {
    throw new KnownErrors.OAuthAccessTokenNotAvailable(providerId, requiredScopeDetails);
  }

  let invalidatedRefreshTokenDuringAttempt = false;
  for (const token of filteredRefreshTokens) {
    const tokenSetResult = await providerInstance.getAccessToken({
      refreshToken: token.refreshToken,
      scope,
    });

    if (tokenSetResult.status === "error") {
      switch (tokenSetResult.error.type) {
        case "invalid-refresh-token": {
          // Only this outcome proves that the stored refresh token should no
          // longer be used. Provider timeouts and retry ambiguity must not
          // invalidate the connection; the user usually cannot fix those.
          await prisma.oAuthToken.update({
            where: { id: token.id },
            data: { isValid: false },
          });
          invalidatedRefreshTokenDuringAttempt = true;
          continue;
        }
        case "temporarily-unavailable": {
          // The customer should retry later. Do not mark the OAuth connection as
          // broken or ask the user to reconnect based on a transient provider
          // failure.
          captureOAuthAccessTokenRefreshIssue({
            location: "oauth-access-token-refresh-provider-temporarily-unavailable",
            message: "OAuth provider temporarily unavailable during access token refresh",
            providerInstance,
            errorContext,
            refreshError: tokenSetResult.error,
          });
          throw new KnownErrors.OAuthProviderTemporarilyUnavailable();
        }
        case "invalid-client": {
          captureOAuthAccessTokenRefreshIssue({
            location: "oauth-access-token-refresh-invalid-client",
            message: "OAuth provider rejected configured client during access token refresh",
            providerInstance,
            errorContext,
            refreshError: tokenSetResult.error,
          });
          throw new StatusError(400, `Invalid client credentials for this OAuth provider. Please ensure the configuration in the Hexclave dashboard is correct.`);
        }
        case "unexpected": {
          captureOAuthAccessTokenRefreshIssue({
            location: "oauth-access-token-refresh-unexpected-error",
            message: "Unexpected OAuth provider error during access token refresh",
            providerInstance,
            errorContext,
            refreshError: tokenSetResult.error,
          });
          const assertionError = new HexclaveAssertionError('Unexpected error refreshing access token — this may indicate a bug or misconfiguration', {
            cause: tokenSetResult.error.cause,
            providerClass: providerInstance.constructor.name,
            refreshErrorType: tokenSetResult.error.type,
            attempts: tokenSetResult.error.attempts,
            retryCount: tokenSetResult.error.retryCount,
            sawAmbiguousRefreshAttempt: tokenSetResult.error.sawAmbiguousRefreshAttempt,
            causes: tokenSetResult.error.causes,
            ...errorContext,
          });
          throw assertionError;
        }
        default: {
          const _: never = tokenSetResult.error;
          throw new HexclaveAssertionError("Unhandled OAuth access token refresh error", { cause: _ });
        }
      }
    }

    const tokenSet = tokenSetResult.data;
    if (tokenSet.accessToken) {
      await prisma.oAuthAccessToken.create({
        data: {
          tenancyId,
          accessToken: tokenSet.accessToken,
          oauthAccountId: token.oauthAccountId,
          scopes: token.scopes,
          expiresAt: tokenSet.accessTokenExpiredAt,
        },
      });

      if (tokenSet.refreshToken) {
        await prisma.oAuthToken.update({
          where: { id: token.id },
          data: { isValid: false },
        });
        await prisma.oAuthToken.create({
          data: {
            tenancyId,
            refreshToken: tokenSet.refreshToken,
            oauthAccountId: token.oauthAccountId,
            scopes: token.scopes,
          },
        });
      }

      return { access_token: tokenSet.accessToken };
    } else {
      throw new HexclaveAssertionError("No access token returned");
    }
  }

  throw new KnownErrors.OAuthAccessTokenNotAvailable(
    providerId,
    invalidatedRefreshTokenDuringAttempt ? reauthorizeDetails : requiredScopeDetails,
  );
}

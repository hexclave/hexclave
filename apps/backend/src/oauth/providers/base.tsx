import { KnownErrors } from "@hexclave/shared";
import { HexclaveAssertionError, StatusError, captureError } from "@hexclave/shared/dist/utils/errors";
import { isJsonSerializable, type Json } from "@hexclave/shared/dist/utils/json";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";
import { mergeScopeStrings } from "@hexclave/shared/dist/utils/strings";
import { CallbackParamsType, Client, Issuer, TokenSet as OIDCTokenSet, custom, generators } from "openid-client";
import { assertSafeOAuthUrl, safeOAuthDnsLookup } from "@/lib/ssrf-protection/oauth";
import { OAuthUserInfo } from "../utils";

const OAUTH_USERINFO_TOTAL_ATTEMPTS = 3;
const OAUTH_USERINFO_RETRY_DELAY_BASE_MS = 250;
const OAUTH_ACCESS_TOKEN_REFRESH_TOTAL_ATTEMPTS = 2;
const OAUTH_ACCESS_TOKEN_REFRESH_RETRY_DELAY_MS = 250;
const OAUTH_HTTP_TIMEOUT_MS = 6000;
const RETRYABLE_OAUTH_NETWORK_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const RETRYABLE_OAUTH_PROVIDER_ERROR_CODES = new Set([
  "server_error",
  "temporarily_unavailable",
  "timeout",
]);

// openid-client defaults to a 3.5s HTTP timeout. OAuth providers can be slow
// enough that this causes avoidable refresh failures, so give token/userinfo
// requests a little more room while still bounding backend request latency.
custom.setHttpOptionsDefaults({
  timeout: OAUTH_HTTP_TIMEOUT_MS,
  lookup: safeOAuthDnsLookup,
});

export type TokenSet = {
  accessToken: string,
  refreshToken?: string,
  accessTokenExpiredAt: Date | null,
  idToken?: string,
};

function getStringProperty(obj: unknown, key: string): string | undefined {
  if (typeof obj !== "object" || obj === null || !(key in obj)) {
    return undefined;
  }
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function getUnknownProperty(obj: unknown, key: string): Json | undefined {
  if (typeof obj !== "object" || obj === null || !(key in obj)) {
    return undefined;
  }
  const value = obj[key];
  return isJsonSerializable(value) ? value : undefined;
}

function getNumberProperty(obj: unknown, key: string): number | undefined {
  if (typeof obj !== "object" || obj === null || !(key in obj)) {
    return undefined;
  }
  const value = obj[key];
  return typeof value === "number" ? value : undefined;
}

export function isRetryableOAuthUserInfoError(error: unknown): boolean {
  const code = getStringProperty(error, "code");
  if (code && RETRYABLE_OAUTH_NETWORK_ERROR_CODES.has(code)) {
    return true;
  }

  const providerErrorCode = getOAuthProviderErrorCode(error);
  if (providerErrorCode && RETRYABLE_OAUTH_PROVIDER_ERROR_CODES.has(providerErrorCode)) {
    return true;
  }

  const name = getStringProperty(error, "name");
  if (name === "AbortError" || name === "TimeoutError") {
    return true;
  }

  const response = getUnknownProperty(error, "response");
  const responseStatus = getNumberProperty(response, "status");
  if (responseStatus === 429 || (responseStatus != null && responseStatus >= 500)) {
    return true;
  }

  const message = getStringProperty(error, "message")?.toLowerCase();
  if (message?.includes("outgoing request timed out")) {
    return true;
  }
  if (message?.includes("timed out")) {
    return true;
  }

  const cause = getUnknownProperty(error, "cause");
  if (cause !== undefined && cause !== error) {
    return isRetryableOAuthUserInfoError(cause);
  }

  return false;
}

function getOAuthProviderErrorCode(error: unknown): string | undefined {
  const directCode = getStringProperty(error, "error");
  const nestedError = getUnknownProperty(error, "error");
  const nestedCode = getStringProperty(nestedError, "error");
  return (directCode ?? nestedCode)?.toLowerCase();
}

export type OAuthAccessTokenRefreshErrorDisposition =
  | {
    type: "invalid-refresh-token",
    message: string,
  }
  | {
    type: "temporarily-unavailable",
  }
  | {
    type: "invalid-client",
  }
  | {
    type: "unexpected",
  };

type OAuthAccessTokenRefreshErrorMetadata = {
  attempts: number,
  retryCount: number,
  sawAmbiguousRefreshAttempt: boolean,
  causes: readonly unknown[],
};

export type OAuthAccessTokenRefreshError =
  | ({
    type: "invalid-refresh-token",
    message: string,
  } & OAuthAccessTokenRefreshErrorMetadata)
  | ({
    type: "temporarily-unavailable",
    cause: unknown,
  } & OAuthAccessTokenRefreshErrorMetadata)
  | ({
    type: "invalid-client",
    cause: unknown,
  } & OAuthAccessTokenRefreshErrorMetadata)
  | ({
    type: "unexpected",
    cause: unknown,
  } & OAuthAccessTokenRefreshErrorMetadata);

/**
 * Classifies the provider error by what it says about the request itself.
 * `invalid-refresh-token` means the provider explicitly rejected the refresh
 * token, but callers still need context before deciding whether to invalidate
 * our stored token.
 */
export function getOAuthAccessTokenRefreshErrorDisposition(error: unknown): OAuthAccessTokenRefreshErrorDisposition {
  const providerErrorCode = getOAuthProviderErrorCode(error);

  if (providerErrorCode === "invalid_grant") {
    return { type: "invalid-refresh-token", message: "Refresh token is invalid or expired" };
  }
  if (providerErrorCode === "access_denied" || providerErrorCode === "consent_required") {
    return { type: "invalid-refresh-token", message: "Access was denied or consent was revoked" };
  }
  if (providerErrorCode === "invalid_token") {
    return { type: "invalid-refresh-token", message: "Refresh token is invalid" };
  }
  if (providerErrorCode === "unauthorized_client") {
    return { type: "invalid-refresh-token", message: "OAuth Client ID is no longer authorized to use this refresh token" };
  }
  if (providerErrorCode === "invalid_client") {
    return { type: "invalid-client" };
  }
  if (isRetryableOAuthUserInfoError(error)) {
    return { type: "temporarily-unavailable" };
  }

  return { type: "unexpected" };
}

/**
 * Converts a provider refresh failure into the action Stack should take.
 *
 * The subtle case is refresh-token rotation. A timeout can happen after the
 * provider has processed the refresh and rotated the refresh token, but before
 * our HTTP client receives the replacement. If we retry with the old token, the
 * provider can legitimately answer `invalid_grant`. In that situation, treating
 * the old token as revoked would lock the user out even though they did nothing
 * wrong, so we surface a temporary provider failure instead.
 */
export function getOAuthAccessTokenRefreshError(error: unknown, options: {
  sawAmbiguousRefreshAttempt: boolean,
  attempts: number,
  causes: readonly unknown[],
}): OAuthAccessTokenRefreshError {
  const disposition = getOAuthAccessTokenRefreshErrorDisposition(error);
  const metadata = {
    attempts: options.attempts,
    retryCount: options.attempts - 1,
    sawAmbiguousRefreshAttempt: options.sawAmbiguousRefreshAttempt,
    causes: [...options.causes],
  };
  if (disposition.type === "invalid-refresh-token") {
    if (options.sawAmbiguousRefreshAttempt) {
      return { type: "temporarily-unavailable", cause: error, ...metadata };
    }
    return { ...disposition, ...metadata };
  }
  if (disposition.type === "temporarily-unavailable") {
    return { type: "temporarily-unavailable", cause: error, ...metadata };
  }
  if (disposition.type === "invalid-client") {
    return { type: "invalid-client", cause: error, ...metadata };
  }
  return { type: "unexpected", cause: error, ...metadata };
}

type DefaultAccessTokenExpiresInMillis = number | null | ((tokenSet: OIDCTokenSet) => number | null | undefined);

export function getOAuthCallbackExtraParams(options: {
  includeScopeInTokenExchange: boolean | undefined,
  baseScope: string,
  extraScope: string | undefined,
}) {
  if (!options.includeScopeInTokenExchange) {
    return undefined;
  }

  return {
    exchangeBody: {
      scope: mergeScopeStrings(options.baseScope, options.extraScope ?? ""),
    },
  };
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function dateFromMillis(millis: number, context: string): Date {
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) {
    throw new HexclaveAssertionError(`Invalid OAuth access token expiry computed from ${context}`, { millis });
  }
  return date;
}

export function resolveOAuthAccessTokenExpiredAt(options: {
  expiresInSeconds: unknown,
  expiresAtSeconds: unknown,
  defaultExpiresInMillis: number | null | undefined,
  nowMillis: number,
}): Date | null {
  const expiresInSeconds = getFiniteNumber(options.expiresInSeconds);
  if (expiresInSeconds !== undefined) {
    return dateFromMillis(options.nowMillis + expiresInSeconds * 1000, "expires_in");
  }

  const expiresAtSeconds = getFiniteNumber(options.expiresAtSeconds);
  if (expiresAtSeconds !== undefined) {
    return dateFromMillis(expiresAtSeconds * 1000, "expires_at");
  }

  if (options.defaultExpiresInMillis === null) {
    return null;
  }

  if (options.defaultExpiresInMillis !== undefined) {
    if (!Number.isFinite(options.defaultExpiresInMillis)) {
      throw new HexclaveAssertionError("Invalid default OAuth access token expiry", { defaultExpiresInMillis: options.defaultExpiresInMillis });
    }
    return dateFromMillis(options.nowMillis + options.defaultExpiresInMillis, "provider default");
  }

  return dateFromMillis(options.nowMillis + 3600 * 1000, "generic fallback");
}

function processTokenSet(providerName: string, tokenSet: OIDCTokenSet, defaultAccessTokenExpiresInMillis?: DefaultAccessTokenExpiresInMillis): TokenSet {
  if (!tokenSet.access_token) {
    throw new HexclaveAssertionError(`No access token received from ${providerName}.`, { tokenSet, providerName });
  }

  // Use provider-supplied expiry first. If the provider omits expiry, a provider
  // can supply a fallback duration, return null to explicitly model
  // "non-expiring/unknown expiry", or leave it undefined to use the generic
  // one-hour fallback and capture telemetry.
  const defaultExpiresInMillis = typeof defaultAccessTokenExpiresInMillis === "function" ? defaultAccessTokenExpiresInMillis(tokenSet) : defaultAccessTokenExpiresInMillis;

  if (getFiniteNumber(tokenSet.expires_in) === undefined && getFiniteNumber(tokenSet.expires_at) === undefined && defaultExpiresInMillis === undefined) {
    captureError("processTokenSet", new HexclaveAssertionError(`No valid expires_in or expires_at received from OAuth provider ${providerName}. This provider might not support expires_at, so please add a fallback for this provider based on the information from its documentation (eg. GitHub does not return JWT access tokens so we can't know the actual expiry of the token). Falling back to 1h`, { tokenSetKeys: Object.keys(tokenSet) }));
  }

  return {
    idToken: tokenSet.id_token,
    accessToken: tokenSet.access_token,
    refreshToken: tokenSet.refresh_token,
    accessTokenExpiredAt: resolveOAuthAccessTokenExpiredAt({
      expiresInSeconds: tokenSet.expires_in,
      expiresAtSeconds: tokenSet.expires_at,
      defaultExpiresInMillis,
      nowMillis: Date.now(),
    }),
  };
}

async function assertSafeDiscoveredIssuerMetadata(issuer: {
  metadata: {
    authorization_endpoint?: string,
    token_endpoint?: string,
    userinfo_endpoint?: string,
    jwks_uri?: string,
  },
}) {
  for (const url of [
    issuer.metadata.authorization_endpoint,
    issuer.metadata.token_endpoint,
    issuer.metadata.userinfo_endpoint,
    issuer.metadata.jwks_uri,
  ]) {
    if (url !== undefined) {
      await assertSafeOAuthUrl(url);
    }
  }
}

export abstract class OAuthBaseProvider {
  constructor(
    public readonly oauthClient: Client,
    public readonly scope: string,
    public readonly redirectUri: string,
    public readonly authorizationExtraParams?: Record<string, string>,
    public readonly defaultAccessTokenExpiresInMillis?: DefaultAccessTokenExpiresInMillis,
    public readonly noPKCE?: boolean,
    public readonly openid?: boolean,
    public readonly alternativeIssuers?: string[],
    public readonly includeScopeInCallbackTokenExchange?: boolean,
    public readonly noConsentPrompt?: boolean,
  ) {}

  protected static async createConstructorArgs(options:
    & {
      clientId: string,
      clientSecret: string,
      redirectUri: string,
      baseScope: string,
      authorizationExtraParams?: Record<string, string>,
      defaultAccessTokenExpiresInMillis?: DefaultAccessTokenExpiresInMillis,
      tokenEndpointAuthMethod?: "client_secret_post" | "client_secret_basic",
      noPKCE?: boolean,
      alternativeIssuers?: string[],
      includeScopeInCallbackTokenExchange?: boolean,
      noConsentPrompt?: boolean,
    }
    & (
      | ({
        issuer: string,
        authorizationEndpoint: string,
        tokenEndpoint: string,
        userinfoEndpoint?: string,
      }
      & (
        | {
          openid: true,
          jwksUri: string,
        }
        | {
          openid?: false,
        }
      )
    )
      | {
        discoverFromUrl: string,
        openid?: boolean,
      }
    )
  ) {
    const issuer = "discoverFromUrl" in options
      ? await (async () => {
        await assertSafeOAuthUrl(options.discoverFromUrl);
        const discoveredIssuer = await Issuer.discover(options.discoverFromUrl);
        await assertSafeDiscoveredIssuerMetadata(discoveredIssuer);
        return discoveredIssuer;
      })()
      : new Issuer({
        issuer: options.issuer,
        authorization_endpoint: options.authorizationEndpoint,
        token_endpoint: options.tokenEndpoint,
        userinfo_endpoint: options.userinfoEndpoint,
        jwks_uri: options.openid ? options.jwksUri : undefined,
      });
    const oauthClient = new issuer.Client({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      response_types: ["code"],
      token_endpoint_auth_method: options.tokenEndpointAuthMethod ?? "client_secret_basic",
    });

    return [
      oauthClient,
      options.baseScope,
      options.redirectUri,
      options.authorizationExtraParams,
      options.defaultAccessTokenExpiresInMillis,
      options.noPKCE,
      options.openid,
      options.alternativeIssuers,
      options.includeScopeInCallbackTokenExchange,
      options.noConsentPrompt,
    ] as const;
  }

  getAuthorizationUrl(options: {
    codeVerifier: string,
    state: string,
    extraScope?: string,
  }) {
    return this.oauthClient.authorizationUrl({
      scope: mergeScopeStrings(this.scope, options.extraScope || ""),
      ...(this.noPKCE ? {} : {
        code_challenge_method: "S256",
        code_challenge: generators.codeChallenge(options.codeVerifier),
      }),
      state: options.state,
      response_type: "code",
      access_type: "offline",
      ...(this.noConsentPrompt ? {} : { prompt: "consent" }),
      ...this.authorizationExtraParams,
    });
  }

  async getCallback(options: {
    callbackParams: CallbackParamsType,
    codeVerifier: string,
    state: string,
    extraScope?: string,
  }): Promise<{ userInfo: OAuthUserInfo, tokenSet: TokenSet }> {
    let tokenSet;
    const callbackParams = { ...options.callbackParams };

    // If the authorization server returns an `iss` parameter (RFC 9207) that matches
    // one of the known alternative issuers, rewrite it to the configured issuer so
    // openid-client's validation accepts it.
    if (
      this.alternativeIssuers
      && typeof callbackParams.iss === "string"
      && this.alternativeIssuers.includes(callbackParams.iss)
    ) {
      callbackParams.iss = this.oauthClient.issuer.metadata.issuer;
    }

    const params = [
      this.redirectUri,
      callbackParams,
      {
        code_verifier: this.noPKCE ? undefined : options.codeVerifier,
        state: options.state,
      },
      getOAuthCallbackExtraParams({
        includeScopeInTokenExchange: this.includeScopeInCallbackTokenExchange,
        baseScope: this.scope,
        extraScope: options.extraScope,
      }),
    ] as const;

    try {
      if (this.openid) {
        tokenSet = await this.oauthClient.callback(...params);
      } else {
        tokenSet = await this.oauthClient.oauthCallback(...params);
      }
    } catch (error: any) {
      if (error?.error === "invalid_grant" || error?.error?.error === "invalid_grant") {
        // while this is technically a "user" error, it would only be caused by a client that is not properly implemented
        // to catch the case where our own client is not properly implemented, we capture the error here
        // TODO is the comment above actually true? This is inner OAuth, not outer OAuth, so why does the client implementation matter?
        // Though a reasonable scenario where this might happen is eg. if the authorization code expires before we can exchange it, or the page is reloaded so we try to reuse a code that was already used
        captureError("inner-oauth-callback", { error, params });
        throw new StatusError(400, "Inner OAuth callback failed due to invalid grant. Please try again.");
      }
      if (error?.error === 'access_denied' || error?.error === 'consent_required') {
        throw new KnownErrors.OAuthProviderAccessDenied();
      }
      if (error?.error === 'invalid_client') {
        throw new StatusError(400, `Invalid client credentials for this OAuth provider. Please ensure the configuration in the Hexclave dashboard is correct.`);
      }
      if (isRetryableOAuthUserInfoError(error)) {
        captureError("inner-oauth-callback-retryable-error", new HexclaveAssertionError("Transient OAuth provider failure during callback exchange.", {
          provider: this.constructor.name,
          params,
          cause: error,
        }));
        throw new KnownErrors.OAuthProviderTemporarilyUnavailable();
      }
      if (error?.error === 'unauthorized_scope_error') {
        const scopeMatch = error?.error_description?.match(/Scope &quot;([^&]+)&quot; is not authorized for your application/);
        const missingScope = scopeMatch ? scopeMatch[1] : null;
        throw new StatusError(400, `The OAuth provider does not allow the requested scope${missingScope ? ` "${missingScope}"` : ""}. Please ensure the scope is configured correctly in the provider's dashboard.`);
      }
      throw new HexclaveAssertionError(`Inner OAuth callback failed due to error: ${error}`, { params, cause: error });
    }

    if ('error' in tokenSet) {
      throw new HexclaveAssertionError(`Inner OAuth callback failed due to error: ${tokenSet.error}, ${tokenSet.error_description}`, { params, tokenSet });
    }
    tokenSet = processTokenSet(this.constructor.name, tokenSet, this.defaultAccessTokenExpiresInMillis);

    const userInfoResult = await Result.retry(async () => {
      try {
        return Result.ok(await this.postProcessUserInfo(tokenSet));
      } catch (error) {
        if (isRetryableOAuthUserInfoError(error)) {
          return Result.error(error);
        }
        throw error;
      }
    }, OAUTH_USERINFO_TOTAL_ATTEMPTS, {
      exponentialDelayBase: OAUTH_USERINFO_RETRY_DELAY_BASE_MS,
    });

    if (userInfoResult.status === "error") {
      captureError("oauth-userinfo-retry-exhausted", new HexclaveAssertionError("Failed to fetch OAuth user info after retries.", {
        attempts: userInfoResult.attempts,
        provider: this.constructor.name,
        cause: userInfoResult.error,
      }));
      throw new KnownErrors.OAuthProviderTemporarilyUnavailable();
    }

    return {
      userInfo: userInfoResult.data,
      tokenSet,
    };
  }

  /**
   * Refreshes the access token using a refresh token.
   *
   * This intentionally returns expected OAuth failures instead of throwing
   * KnownErrors/StatusErrors. The caller has the DB context needed to decide
   * whether to invalidate a stored refresh token, try another token, or return a
   * temporary provider failure to the customer.
   *
   * Transient provider/network failures are retried once. After any ambiguous
   * attempt (for example, a timeout), a later `invalid_grant` is not enough to
   * prove revocation because the first attempt may have rotated the token.
   */
  async getAccessToken(options: {
    refreshToken: string,
    scope?: string,
  }): Promise<Result<TokenSet, OAuthAccessTokenRefreshError>> {
    let sawAmbiguousRefreshAttempt = false;
    const refreshErrorCauses: unknown[] = [];

    for (let attemptIndex = 0; attemptIndex < OAUTH_ACCESS_TOKEN_REFRESH_TOTAL_ATTEMPTS; attemptIndex++) {
      try {
        const tokenSet = await this.oauthClient.refresh(options.refreshToken, { exchangeBody: { scope: options.scope } });
        return Result.ok(processTokenSet(this.constructor.name, tokenSet, this.defaultAccessTokenExpiresInMillis));
      } catch (error) {
        refreshErrorCauses.push(error);
        const refreshError = getOAuthAccessTokenRefreshError(error, {
          sawAmbiguousRefreshAttempt,
          attempts: attemptIndex + 1,
          causes: refreshErrorCauses,
        });
        if (refreshError.type === "temporarily-unavailable") {
          sawAmbiguousRefreshAttempt = true;
          if (attemptIndex < OAUTH_ACCESS_TOKEN_REFRESH_TOTAL_ATTEMPTS - 1) {
            await wait(OAUTH_ACCESS_TOKEN_REFRESH_RETRY_DELAY_MS);
            continue;
          }
        }
        return Result.error(refreshError);
      }
    }

    throw new HexclaveAssertionError("OAuth access token refresh finished without a result. This should never happen because the refresh loop either returns a result or throws.");
  }

  // If the token can be revoked before it expires, override this method to make an API call to the provider to check if the token is valid
  abstract checkAccessTokenValidity(accessToken: string): Promise<boolean>;

  abstract postProcessUserInfo(tokenSet: TokenSet): Promise<OAuthUserInfo>;
}

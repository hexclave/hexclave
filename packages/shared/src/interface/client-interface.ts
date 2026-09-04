import * as oauth from 'oauth4webapi';

import * as yup from 'yup';
import { KnownError, KnownErrors } from '../known-errors';
import { inlineProductSchema } from '../schema-fields';
import { AccessToken, InternalSession, RefreshToken } from '../sessions';
import { generateSecureRandomString } from '../utils/crypto';
import { HexclaveAssertionError, throwErr } from '../utils/errors';
import { globalVar } from '../utils/globals';
import { HTTP_METHODS, HttpMethod } from '../utils/http';
import { Json, ReadonlyJson } from '../utils/json';
import { publishableClientKeyNotNecessarySentinel } from '../utils/oauth';
import { filterUndefined, filterUndefinedOrNull } from '../utils/objects';
import { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '../utils/passkey';
import { wait } from '../utils/promises';
import { Result } from "../utils/results";
import { deindent } from '../utils/strings';
import { urlString } from '../utils/urls';
import { ConnectedAccountAccessTokenCrud, ConnectedAccountCrud } from './crud/connected-accounts';
import { ContactChannelsCrud } from './crud/contact-channels';
import { CurrentUserCrud } from './crud/current-user';
import type { FeatureFlagEvaluateRequest, FeatureFlagEvaluateResponse, FeatureFlagExposureBatchRequest } from './crud/feature-flags';
import { CustomerInvoicesListResponse, ListCustomerInvoicesOptions } from './crud/invoices';
import { ItemCrud } from './crud/items';
import { NotificationPreferenceCrud } from './crud/notification-preferences';
import { OAuthProviderCrud } from './crud/oauth-providers';
import { CustomerProductsListResponse, ListCustomerProductsOptions } from './crud/products';
import { TeamApiKeysCrud, UserApiKeysCrud, teamApiKeysCreateInputSchema, teamApiKeysCreateOutputSchema, userApiKeysCreateInputSchema, userApiKeysCreateOutputSchema } from './crud/project-api-keys';
import { ProjectPermissionsCrud } from './crud/project-permissions';
import { AdminUserProjectsCrud, ClientProjectsCrud } from './crud/projects';
import { SessionsCrud } from './crud/sessions';
import { TeamInvitationCrud } from './crud/team-invitation';
import { TeamMemberProfilesCrud } from './crud/team-member-profiles';
import { TeamPermissionsCrud } from './crud/team-permissions';
import { TeamsCrud } from './crud/teams';

export type ApiUrlFailure = {
  url: string,
  error: Error,
};

export class ApiUrlsFailedError extends AggregateError {
  readonly urlFailures: readonly ApiUrlFailure[];
  readonly digest?: unknown;

  constructor(urlFailures: readonly ApiUrlFailure[]) {
    const primaryFailure = urlFailures[0] ?? throwErr("ApiUrlsFailedError requires at least one URL failure");
    super(
      urlFailures.map(({ error }) => error),
      `All API URLs failed; primary URL ${primaryFailure.url} failed: ${primaryFailure.error.message}`,
      { cause: primaryFailure.error },
    );
    this.name = "ApiUrlsFailedError";
    this.urlFailures = urlFailures;
    if ("digest" in primaryFailure.error) {
      Object.defineProperty(this, "digest", {
        value: primaryFailure.error.digest,
        enumerable: true,
      });
    }
  }
}

export type RequestLogEntry = {
  path: string,
  method: string,
  status?: number,
  duration: number,
  error?: string,
};

export type RequestListener = (entry: RequestLogEntry) => void;

export type ClientInterfaceOptions = {
  clientVersion: string,
  // This is a function instead of a string because it might be different based on the environment (for example client vs server)
  getBaseUrl: () => string,
  getAnalyticsBaseUrl?: () => string,
  /**
   * Ordered list of base URLs for request routing with fallback.
   * Index 0 = primary, index 1..N = fallbacks in priority order.
   * A single-element array means no fallback occurs.
   */
  getApiUrls: () => string[],
  extraRequestHeaders: Record<string, string>,
  projectId: string,
  prepareRequest?: () => Promise<void>,
} & ({
  publishableClientKey?: string,
} | {
  projectOwnerSession: InternalSession | (() => Promise<string | null>),
});

type BotChallengeInput = {
  token?: string,
  phase?: "invisible" | "visible",
  unavailable?: true,
};

const botChallengeKnownErrors = [
  KnownErrors.BotChallengeRequired,
  KnownErrors.BotChallengeFailed,
] as const;

function isBotChallengeKnownError(error: unknown): error is KnownErrors["BotChallengeRequired"] | KnownErrors["BotChallengeFailed"] {
  return KnownErrors.BotChallengeRequired.isInstance(error) || KnownErrors.BotChallengeFailed.isInstance(error);
}

function getBotChallengeRequestFields(botChallenge: BotChallengeInput | undefined, context: string) {
  if (botChallenge?.unavailable) {
    if (botChallenge.token != null || botChallenge.phase != null) {
      throw new HexclaveAssertionError(`${context} bot challenge unavailability cannot be combined with a token or phase.`);
    }

    return {
      bot_challenge_unavailable: "true" as const,
    };
  }

  const challengeToken = botChallenge?.token?.trim() || undefined;
  if (botChallenge?.phase === "visible") {
    if (challengeToken == null) {
      // Backward-compatible fallback for older callers; prefer `unavailable: true`.
      return {
        bot_challenge_unavailable: "true",
      };
    }

    return {
      bot_challenge_token: challengeToken,
      bot_challenge_phase: "visible" as const,
    };
  }

  if (challengeToken == null) {
    if (botChallenge?.phase != null) {
      throw new HexclaveAssertionError(`${context} bot challenge phase options require a token.`);
    }

    return {};
  }

  if (botChallenge?.phase == null) {
    return {
      bot_challenge_token: challengeToken,
    };
  }

  return {
    bot_challenge_token: challengeToken,
    bot_challenge_phase: "invisible" as const,
  };
}

async function encodeGzipJsonBody(
  jsonBody: string,
  options: { keepalive: boolean },
): Promise<{ body: BodyInit, contentType: string }> {
  // Used by analytics-event and session-replay batch uploads; the server
  // gunzips application/octet-stream bodies before schema validation.
  // keepalive flushes must dispatch before page tear-down, so skip async gzip.
  if (options.keepalive) {
    return { body: jsonBody, contentType: "application/json" };
  }
  const CompressionStreamCtor: typeof CompressionStream | undefined =
    (globalVar as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (typeof CompressionStreamCtor !== "function" || typeof Blob === "undefined" || typeof Response === "undefined") {
    return { body: jsonBody, contentType: "application/json" };
  }
  try {
    const stream = new Blob([jsonBody]).stream().pipeThrough(new CompressionStreamCtor("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return { body: new Uint8Array(buffer), contentType: "application/octet-stream" };
  } catch {
    // Broken CompressionStream (e.g. Safari < 16.4): fall back to plain JSON.
    return { body: jsonBody, contentType: "application/json" };
  }
}

export class HexclaveClientInterface {
  private pendingNetworkDiagnostics?: ReturnType<HexclaveClientInterface["_runNetworkDiagnosticsInner"]>;
  private _requestListeners = new Set<RequestListener>();

  /**
   * Last API URL that succeeded for this client. Requests start here and only
   * move to the next URL in the ring when the current host looks like an outage.
   * Null means we have never succeeded yet — start at the primary (index 0).
   */
  private _currentTargetApiUrl: string | null = null;

  constructor(public readonly options: ClientInterfaceOptions) {}

  addRequestListener(listener: RequestListener): () => void {
    this._requestListeners.add(listener);
    return () => {
      this._requestListeners.delete(listener);
    };
  }

  get projectId() {
    return this.options.projectId;
  }

  getApiUrl() {
    return this.options.getBaseUrl() + "/api/v1";
  }

  getApiUrls(): string[] {
    return this.options.getApiUrls().map(u => u + "/api/v1");
  }

  /**
   * Returns the current target API URL for browser-navigated URLs (e.g. OAuth
   * authorize) where `_withFallback` can't iterate hosts. Falls back to the
   * primary if the remembered URL is no longer in the list.
   */
  getCurrentTargetApiUrl(): string {
    const apiUrls = this.getApiUrls();
    if (this._currentTargetApiUrl != null && apiUrls.includes(this._currentTargetApiUrl)) {
      return this._currentTargetApiUrl;
    }
    return apiUrls[0];
  }

  /**
   * @deprecated Use {@link getCurrentTargetApiUrl} instead.
   */
  getBestApiUrl(): string {
    return this.getCurrentTargetApiUrl();
  }

  /**
   * Routes a request through an ordered URL ring with automatic failover.
   *
   * Starts at `_currentTargetApiUrl` (or primary if unset). On an outage-like
   * failure, walks `(start + k) % n` for two full laps. On success, remembers
   * that URL as the new current target. KnownErrors and smart-wrapped 4xx
   * responses are never retried on another host (application-level errors).
   *
   * Single-URL lists skip the ring and use 5-retry behavior directly.
   */
  protected async _withFallback<T>(cb: (apiUrl: string, retryOptions: { maxAttempts: number, skipDiagnostics: boolean }) => Promise<T>): Promise<T> {
    const apiUrls = this.getApiUrls();

    // Single URL — no fallback, just retry normally.
    if (apiUrls.length <= 1) {
      return await cb(apiUrls[0], { maxAttempts: 5, skipDiagnostics: false });
    }

    const start = Math.max(0, this._currentTargetApiUrl != null ? apiUrls.indexOf(this._currentTargetApiUrl) : 0);
    const errorsByUrl = new Map<number, Error>();

    for (let k = 0; k < apiUrls.length * 2; k++) {
      const i = (start + k) % apiUrls.length;
      try {
        const result = await cb(apiUrls[i], { maxAttempts: 1, skipDiagnostics: true });
        this._currentTargetApiUrl = apiUrls[i];
        return result;
      } catch (e) {
        if (this._shouldSkipFallback(e)) {
          // Host answered with an application-level error (KnownError / smart 4xx),
          // so it's alive — stick here instead of hammering a dead earlier host next time.
          this._currentTargetApiUrl = apiUrls[i];
          throw e;
        }
        errorsByUrl.set(i, e instanceof Error ? e : new Error(String(e)));
      }
    }

    throw new ApiUrlsFailedError(apiUrls.map((url, i) => ({
      url,
      error: errorsByUrl.get(i) ?? throwErr(`Missing failure for API URL ${url}`),
    })));
  }

  /**
   * Returns true when the error is an application-level response that should
   * not hop to another host. Outages (network TypeError, 5xx, non-smart 4xx)
   * return false so the ring walk continues.
   */
  private _shouldSkipFallback(error: unknown) {
    if (error instanceof KnownError) return true;

    const response = this._getApiResponseFromError(error);
    if (response == null) return false;

    // 5xx -> hop (this host looks sick).
    if (response.status >= 500) return false;

    // Smart-wrapped 4xx -> our API answered; hopping won't help.
    if (response.status >= 400 && response.status < 500) {
      return this._isSmartWrappedResponse(response);
    }

    return false;
  }

  private _isSmartWrappedResponse(response: Response) {
    return response.headers.has("x-hexclave-request-id")
      || response.headers.has("x-stack-request-id")
      || response.headers.has("x-hexclave-known-error")
      || response.headers.has("x-stack-known-error");
  }

  private _getApiResponseFromError(error: unknown, seenErrors = new Set<Error>()): Response | null {
    if (error instanceof Response) {
      return error;
    }
    if (!(error instanceof Error) || seenErrors.has(error)) {
      return null;
    }

    seenErrors.add(error);
    return this._getApiResponseFromError(error.cause, seenErrors);
  }

  getAnalyticsApiUrl() {
    return (this.options.getAnalyticsBaseUrl ?? this.options.getBaseUrl)() + "/api/v1";
  }

  public async runNetworkDiagnostics(session?: InternalSession | null, requestType?: "client" | "server" | "admin") {
    if (this.pendingNetworkDiagnostics) {
      return await this.pendingNetworkDiagnostics;
    }

    this.pendingNetworkDiagnostics = this._runNetworkDiagnosticsInner(session, requestType);
    try {
      return await this.pendingNetworkDiagnostics;
    } finally {
      this.pendingNetworkDiagnostics = undefined;
    }
  }

  private async _runNetworkDiagnosticsInner(session?: InternalSession | null, requestType?: "client" | "server" | "admin") {
    const tryRequest = async (cb: () => Promise<void>) => {
      try {
        await cb();
        return "OK";
      } catch (e) {
        return `${e}`;
      }
    };
    const cfTrace = await tryRequest(async () => {
      const res = await fetch("https://1.1.1.1/cdn-cgi/trace");
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
      }
    });
    const baseUrlBackend = await tryRequest(async () => {
      const res = await fetch(new URL("/health", this.getApiUrl()));
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
      }
    });
    const prodDashboard = await tryRequest(async () => {
      const res = await fetch("https://app.hexclave.com/health");
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
      }
    });
    const prodBackend = await tryRequest(async () => {
      const res = await fetch("https://api.hexclave.com/health");
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
      }
    });
    return {
      "navigator?.onLine": globalVar.navigator?.onLine,
      cfTrace,
      baseUrlBackend,
      prodDashboard,
      prodBackend,
    };
  }

  protected async _createNetworkError(cause: Error, session?: InternalSession | null, requestType?: "client" | "server" | "admin") {
    return new Error(deindent`
      Hexclave is unable to connect to the server. Please check your internet connection and try again.

      If the problem persists, please contact support and provide a screenshot of your entire browser console.

      ${cause}

      ${JSON.stringify(await this.runNetworkDiagnostics(session, requestType), null, 2)}
    `, { cause: cause });
  }

  protected async _networkRetry<T>(
    cb: () => Promise<Result<T, any>>,
    session?: InternalSession | null,
    requestType?: "client" | "server" | "admin",
    options?: { maxAttempts?: number, skipDiagnostics?: boolean },
  ): Promise<T> {
    const retriedResult = await Result.retry(
      cb,
      options?.maxAttempts ?? 5,
      { exponentialDelayBase: 1000 },
    );

    // try to diagnose the error for the user
    if (retriedResult.status === "error") {
      if (globalVar.navigator && globalVar.navigator.onLine === false) {
        throw new Error("You are offline. Please check your internet connection and try again. (window.navigator.onLine is false)", { cause: retriedResult.error });
      }
      if (options?.skipDiagnostics) {
        throw retriedResult.error;
      }
      throw await this._createNetworkError(retriedResult.error, session, requestType);
    }
    return retriedResult.data;
  }

  protected async _networkRetryException<T>(
    cb: () => Promise<T>,
    session?: InternalSession | null,
    requestType?: "client" | "server" | "admin",
    options?: { maxAttempts?: number, skipDiagnostics?: boolean },
  ): Promise<T> {
    return await this._networkRetry(async () => await Result.fromThrowingAsync(cb), session, requestType, options);
  }

  public async fetchNewAccessToken(refreshToken: RefreshToken) {
    if ("projectOwnerSession" in this.options) {
      // TODO support it
      throw new Error("Admin session token is currently not supported for fetching new access token. Did you try to log in on a StackApp initiated with the admin session?");
    }

    const clientSecret = this.options.publishableClientKey ?? publishableClientKeyNotNecessarySentinel;
    return await this._withFallback(async (apiUrl, retryOptions) => {
      return await this._fetchNewAccessTokenInner(refreshToken, clientSecret, apiUrl, retryOptions);
    });
  }

  private async _fetchNewAccessTokenInner(refreshToken: RefreshToken, clientSecret: string, apiUrl: string, retryOptions?: { maxAttempts?: number, skipDiagnostics?: boolean }) {
    const tokenEndpoint = apiUrl + '/auth/oauth/token';
    const as = {
      issuer: this.options.getBaseUrl(),
      algorithm: 'oauth2',
      token_endpoint: tokenEndpoint,
    };
    const client: oauth.Client = {
      client_id: this.projectId,
      client_secret: clientSecret,
    };

    const clientAuthentication = oauth.ClientSecretPost(clientSecret);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const allowInsecure = tokenEndpoint.startsWith('http://');

    const response = await this._networkRetryException(async () => {
      const rawResponse = await oauth.refreshTokenGrantRequest(
        as,
        client,
        clientAuthentication,
        refreshToken.token,
        {
          ...(allowInsecure ? { [oauth.allowInsecureRequests]: true } : {}),
          [oauth.customFetch]: (url, options) => fetch(url, {
            ...options,
            headers: {
              ...options.headers,
              // Next.js <15 can cache otherwise-identical POST requests during static generation.
              "X-Hexclave-Random-Nonce": generateSecureRandomString(),
            },
            // Cloudflare Workers does not support RequestInit.cache.
            ...("WebSocketPair" in globalVar ? {} : { cache: "no-store" }),
          }),
        },
      );

      const response = await this._processResponse(rawResponse);

      if (response.status === "error") {
        const error = response.error;
        if (KnownErrors.RefreshTokenError.isInstance(error)) {
          return null;
        }
        throw error;
      }

      if (!response.data.ok) {
        const body = await response.data.text();
        throw new Error(`Failed to send refresh token request: ${response.status} ${body}`, { cause: response.data });
      }

      return response.data;
    }, undefined, undefined, retryOptions);
    if (!response) return null;

    let result: oauth.TokenEndpointResponse;
    try {
      result = await oauth.processRefreshTokenResponse(as, client, response);
    } catch (e){
      if (e instanceof oauth.ResponseBodyError) {
        throw new HexclaveAssertionError("ResponseBodyError when processing refresh token response", {
          cause: e.cause,
          code: e.code,
          error: e.error,
        });
      }
      throw new HexclaveAssertionError("Unexpected error when processing refresh token response", { cause: e });
    }

    if (!result.access_token) {
      throw new HexclaveAssertionError("Access token not found in token endpoint response, this is weird!");
    }

    return AccessToken.createIfValid(result.access_token) ?? throwErr("Access token in fetchNewAccessToken is invalid, looks like the backend is returning an invalid token!", { result });
  }

  public async sendClientRequest(
    path: string,
    requestOptions: RequestInit,
    session: InternalSession | null,
    requestType: "client" | "server" | "admin" = "client",
    apiUrlOverride?: string,
    retryOptions?: { maxAttempts?: number, skipDiagnostics?: boolean },
  ) {
    session ??= this.createSession({
      refreshToken: null,
    });

    if (apiUrlOverride) {
      return await this._networkRetry(
        () => this.sendClientRequestInner(path, requestOptions, session!, requestType, apiUrlOverride, retryOptions),
        session,
        requestType,
        retryOptions,
      );
    }

    return await this._withFallback(async (apiUrl, fallbackRetryOptions) => {
      return await this._networkRetry(
        () => this.sendClientRequestInner(path, requestOptions, session!, requestType, apiUrl, retryOptions),
        session,
        requestType,
        { ...fallbackRetryOptions, ...retryOptions },
      );
    });
  }

  public createSession(options: Omit<ConstructorParameters<typeof InternalSession>[0], "refreshAccessTokenCallback">): InternalSession {
    const session = new InternalSession({
      refreshAccessTokenCallback: async (refreshToken) => await this.fetchNewAccessToken(refreshToken),
      ...options,
    });
    return session;
  }

  async sendSessionReplayBatch(
    body: string,
    session: InternalSession | null,
    options: { keepalive: boolean },
  ): Promise<Result<Response, Error>> {
    try {
      const encoded = await encodeGzipJsonBody(body, { keepalive: options.keepalive });
      const response = await this.sendClientRequest(
        "/session-replays/batch",
        {
          method: "POST",
          headers: { "Content-Type": encoded.contentType },
          body: encoded.body,
          keepalive: options.keepalive,
        },
        session,
        "client",
        this.getAnalyticsApiUrl(),
        { maxAttempts: 1, skipDiagnostics: true },
      );
      return Result.ok(response);
    } catch (e) {
      return Result.error(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async sendAnalyticsEventBatch(
    body: string,
    session: InternalSession | null,
    options: { keepalive: boolean },
  ): Promise<Result<Response, Error>> {
    const result = await Result.fromThrowingAsync(async () => {
      const encoded = await encodeGzipJsonBody(body, { keepalive: options.keepalive });
      // The batch ID makes this POST idempotent at ingestion, so retrying a
      // network failure cannot duplicate analytics rows.
      return await this._networkRetryException(async () => await this.sendClientRequest(
        "/analytics/events/batch",
        {
          method: "POST",
          headers: { "Content-Type": encoded.contentType },
          body: encoded.body,
          keepalive: options.keepalive,
        },
        session,
        "client",
        this.getAnalyticsApiUrl(),
        { maxAttempts: 1, skipDiagnostics: true },
      ), session, "client", { maxAttempts: options.keepalive ? 1 : 3, skipDiagnostics: true });
    });
    if (result.status === "ok") return Result.ok(result.data);
    return Result.error(result.error instanceof Error ? result.error : new Error(String(result.error)));
  }

  async evaluateFeatureFlags<T extends Json>(
    body: FeatureFlagEvaluateRequest,
    session: InternalSession,
  ): Promise<FeatureFlagEvaluateResponse<T>> {
    const response = await this.sendClientRequest(
      "/feature-flags/evaluate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      session,
    );
    return await response.json();
  }

  async sendFeatureFlagExposureBatch(
    body: FeatureFlagExposureBatchRequest,
    session: InternalSession,
  ): Promise<void> {
    // Every exposure carries an event ID, so the ingestion endpoint can
    // safely deduplicate retries after an ambiguous network failure.
    await this._networkRetryException(async () => await this.sendClientRequest(
      "/feature-flags/exposures/batch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      session,
      "client",
      undefined,
      { maxAttempts: 1, skipDiagnostics: true },
    ), session, "client", { maxAttempts: 3, skipDiagnostics: true });
  }

  protected async sendClientRequestAndCatchKnownError<E extends typeof KnownErrors[keyof KnownErrors]>(
    path: string,
    requestOptions: RequestInit,
    tokenStoreOrNull: InternalSession | null,
    errorsToCatch: readonly E[],
  ): Promise<Result<
    Response & {
      usedTokens: {
        accessToken: AccessToken,
        refreshToken: RefreshToken | null,
      } | null,
    },
    InstanceType<E>
  >> {
    try {
      return Result.ok(await this.sendClientRequest(path, requestOptions, tokenStoreOrNull));
    } catch (e) {
      for (const errorType of errorsToCatch) {
        if (errorType.isInstance(e)) {
          return Result.error(e as InstanceType<E>);
        }
      }
      throw e;
    }
  }

  private async sendClientRequestInner(
    path: string,
    options: RequestInit,
    session: InternalSession,
    requestType: "client" | "server" | "admin",
    apiUrlOverride?: string,
    innerOptions?: { skipDiagnostics?: boolean },
  ): Promise<Result<Response & {
    usedTokens: {
      accessToken: AccessToken,
      refreshToken: RefreshToken | null,
    } | null,
  }>> {
    /**
     * `tokenObj === null` means the session is invalid/not logged in
     */
    let tokenObj = await session.getOrFetchLikelyValidTokens(20_000, null);

    let adminSession: InternalSession | null = null;
    let adminTokenObj: { accessToken: AccessToken, refreshToken: RefreshToken | null } | null = null;

    if ("projectOwnerSession" in this.options) {
      const projectOwnerSession = this.options.projectOwnerSession;

      if (typeof projectOwnerSession === 'function') {
        const accessTokenString = await projectOwnerSession();
        if (accessTokenString) {
          const accessToken = AccessToken.createIfValid(accessTokenString);
          if (accessToken) {
            adminTokenObj = { accessToken, refreshToken: null };
          }
        }
      } else {
        adminSession = projectOwnerSession;
        adminTokenObj = await projectOwnerSession.getOrFetchLikelyValidTokens(20_000, null);
      }
    }

    // all requests should be dynamic to prevent Next.js caching
    await this.options.prepareRequest?.();

    let url = (apiUrlOverride ?? this.getApiUrl()) + path;
    if (url.endsWith("/")) {
      url = url.slice(0, -1);
    }
    const params: RequestInit = {
      /**
       * This fetch may be cross-origin, in which case we don't want to send cookies of the
       * original origin (this is the default behavior of `credentials`).
       *
       * To help debugging, also omit cookies on same-origin, so we don't accidentally
       * implement reliance on cookies anywhere.
       *
       * However, Cloudflare Workers don't actually support `credentials`, so we only set it
       * if Cloudflare-exclusive globals are not detected. https://github.com/cloudflare/workers-sdk/issues/2514
       */
      ...("WebSocketPair" in globalVar ? {} : {
        credentials: "omit",
      }),
      ...options,
      headers: {
        // Hexclave rebrand: emit x-hexclave-* request headers; the backend proxy dual-accepts both x-hexclave-* and x-stack-*.
        "X-Hexclave-Override-Error-Status": "true",
        "X-Hexclave-Project-Id": this.projectId,
        "X-Hexclave-Access-Type": requestType,
        "X-Hexclave-Client-Version": this.options.clientVersion,
        ...(tokenObj ? {
          "X-Hexclave-Access-Token": tokenObj.accessToken.token,
        } : {}),
        ...(tokenObj?.refreshToken ? {
          "X-Hexclave-Refresh-Token": tokenObj.refreshToken.token,
        } : {}),
        "X-Hexclave-Allow-Anonymous-User": "true",
        ...("publishableClientKey" in this.options && this.options.publishableClientKey ? {
          "X-Hexclave-Publishable-Client-Key": this.options.publishableClientKey,
        } : {}),
        ...(adminTokenObj ? {
          "X-Hexclave-Admin-Access-Token": adminTokenObj.accessToken.token,
        } : {}),
        /**
         * Next.js until v15 would cache fetch requests by default, and forcefully disabling it was nearly impossible.
         *
         * This header is used to change the cache key and hence always disable it, because we do our own caching.
         *
         * When we drop support for Next.js <15, we may be able to remove this header, but please make sure that this is
         * the case (I haven't actually tested.)
         */
        "X-Hexclave-Random-Nonce": generateSecureRandomString(),
        // don't show a warning when proxying the API through ngrok (only relevant if the API url is an ngrok site)
        'ngrok-skip-browser-warning': 'true',
        ...this.options.extraRequestHeaders,
        ...options.headers,
      },
      /**
       * Cloudflare Workers does not support cache, so don't pass it there
       */
      ...("WebSocketPair" in globalVar ? {} : {
        cache: "no-store",
      }),
    };

    const startTime = performance.now();
    let rawRes;
    try {
      rawRes = await fetch(url, params);
    } catch (e) {
      if (this._requestListeners.size > 0) {
        const entry: RequestLogEntry = { path, method: (params.method ?? "GET").toUpperCase(), duration: Math.round(performance.now() - startTime), error: e instanceof Error ? e.message : "Network error" };
        this._requestListeners.forEach((l) => l(entry));
      }
      if (e instanceof TypeError) {
        // Likely to be a network error. Retry if the request is idempotent, throw network error otherwise.
        if (HTTP_METHODS[(params.method ?? "GET") as HttpMethod].idempotent) {
          return Result.error(e);
        } else if (innerOptions?.skipDiagnostics) {
          throw e;
        } else {
          throw await this._createNetworkError(e, session, requestType);
        }
      }
      throw e;
    }

    const preprocessedRes = await this._preprocessResponse(rawRes);

    if (this._requestListeners.size > 0) {
      const entry: RequestLogEntry = { path, method: (params.method ?? "GET").toUpperCase(), status: preprocessedRes.status, duration: Math.round(performance.now() - startTime) };
      this._requestListeners.forEach((l) => l(entry));
    }

    const processedRes = await this._processResponse(preprocessedRes);

    if (processedRes.status === "error") {
      // If the access token is invalid, reset it and retry
      if (KnownErrors.InvalidAccessToken.isInstance(processedRes.error)) {
        if (!tokenObj) {
          throw new HexclaveAssertionError("Received invalid access token, but session is not logged in", { tokenObj, processedRes });
        }
        session.markAccessTokenExpired(tokenObj.accessToken);
        return Result.error(processedRes.error);
      }

      // Same for the admin access token
      // TODO HACK: Some of the backend hasn't been ported to use the new error codes, so if we have project owner tokens we need to check for ApiKeyNotFound too. Once the migration to smartRouteHandlers is complete, we can check for InvalidAdminAccessToken only.
      if (adminSession && (KnownErrors.InvalidAdminAccessToken.isInstance(processedRes.error) || KnownErrors.ApiKeyNotFound.isInstance(processedRes.error))) {
        if (!adminTokenObj) {
          throw new HexclaveAssertionError("Received invalid admin access token, but admin session is not logged in", { adminTokenObj, processedRes });
        }
        adminSession.markAccessTokenExpired(adminTokenObj.accessToken);
        return Result.error(processedRes.error);
      }

      // Known errors are client side errors, so except for the ones above they should not be retried
      // Hence, throw instead of returning an error
      throw processedRes.error;
    }


    const res = Object.assign(processedRes.data, {
      usedTokens: tokenObj,
    });
    // Conditional GETs intentionally use 304 as a successful cache hit even
    // though Fetch's `ok` flag only covers 2xx responses.
    if (res.ok || res.status === 304) {
      return Result.ok(res);
    } else if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      if (retryAfter !== null) {
        console.log(`Rate limited while sending request to ${url}. Will retry after ${retryAfter} seconds...`);
        await wait(Number(retryAfter) * 1000);
        return Result.error(new Error(`Rate limited, retrying after ${retryAfter} seconds`));
      }

      console.log(`Rate limited while sending request to ${url}, no retry-after header received. Retrying with default backoff...`);
      return Result.error(new Error("Rate limited, no retry-after header received"));
    } else {
      const error = await res.text();

      // Do not retry, throw error instead of returning one
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`Failed to send request to ${url}: ${res.status} ${error}`, { cause: res });
      }
      const errorObj = new HexclaveAssertionError(`Failed to send request to ${url}: ${res.status} ${error}`, { request: params, res, path });

      if (res.status === 508 && error.includes("INFINITE_LOOP_DETECTED")) {
        // Some Vercel deployments seem to have an odd infinite loop bug. In that case, retry.
        // See: https://github.com/hexclave/hexclave/issues/319
        return Result.error(errorObj);
      }

      // Do not retry, throw error instead of returning one
      throw errorObj;
    }
  }

  private async _preprocessResponse(rawRes: Response): Promise<Response> {
    let res = rawRes;
    // Hexclave rebrand: prefer the x-hexclave-* response header, fall back to the legacy x-stack-* name.
    if (rawRes.headers.has("x-hexclave-actual-status") || rawRes.headers.has("x-stack-actual-status")) {
      const actualStatus = Number(rawRes.headers.get("x-hexclave-actual-status") ?? rawRes.headers.get("x-stack-actual-status"));
      res = new Response(rawRes.body, {
        status: actualStatus,
        statusText: rawRes.statusText,
        headers: rawRes.headers,
      });
    }
    return res;
  }

  private async _processResponse(res: Response): Promise<Result<Response, KnownError>> {
    // Handle known errors
    // Hexclave rebrand: prefer the x-hexclave-* response header, fall back to the legacy x-stack-* name.
    if (res.headers.has("x-hexclave-known-error") || res.headers.has("x-stack-known-error")) {
      const errorJson = await res.json();
      const knownErrorHeader = res.headers.get("x-hexclave-known-error") ?? res.headers.get("x-stack-known-error");
      if (knownErrorHeader !== errorJson.code) {
        throw new HexclaveAssertionError("Mismatch between x-hexclave-known-error/x-stack-known-error header and error code in body; the server's response is invalid");
      }
      const error = KnownError.fromJson(errorJson);
      return Result.error(error);
    }

    return Result.ok(res);
  }

  public async checkFeatureSupport(options: { featureName?: string } & ReadonlyJson): Promise<never> {
    const res = await this.sendClientRequest("/check-feature-support", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(options),
    }, null);

    throw new HexclaveAssertionError(await res.text());
  }

  public async consumeBrowserAction(
    actionId: string,
    session: InternalSession | null = null,
  ): Promise<{ javascript: string }> {
    const response = await this.sendClientRequest(
      "/browser-actions/consume",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action_id: actionId,
        }),
      },
      session,
      "client",
    );
    const body: unknown = await response.json();
    if (
      typeof body !== "object"
      || body === null
      || !("javascript" in body)
      || typeof body.javascript !== "string"
    ) {
      throw new HexclaveAssertionError("Browser action endpoint returned an invalid response");
    }
    return { javascript: body.javascript };
  }

  async sendForgotPasswordEmail(
    email: string,
    callbackUrl: string,
  ): Promise<Result<undefined, KnownErrors["UserNotFound"]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/password/send-reset-code",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          callback_url: callbackUrl,
        }),
      },
      null,
      [KnownErrors.UserNotFound],
    );

    if (res.status === "error") {
      return Result.error(res.error);
    } else {
      return Result.ok(undefined);
    }
  }

  async sendVerificationEmail(
    email: string,
    callbackUrl: string,
    session: InternalSession
  ): Promise<KnownErrors["EmailAlreadyVerified"] | undefined> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/contact-channels/send-verification-code",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          callback_url: callbackUrl,
        }),
      },
      session,
      [KnownErrors.EmailAlreadyVerified]
    );

    if (res.status === "error") {
      return res.error;
    }
  }

  async sendMagicLinkEmail(
    email: string,
    callbackUrl: string,
    botChallenge?: BotChallengeInput,
  ): Promise<Result<{ nonce: string }, KnownErrors["RedirectUrlNotWhitelisted"] | KnownErrors["BotChallengeRequired"] | KnownErrors["BotChallengeFailed"]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/otp/send-sign-in-code",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          callback_url: callbackUrl,
          ...getBotChallengeRequestFields(botChallenge, "Magic link sign-in"),
        }),
      },
      null,
      [KnownErrors.RedirectUrlNotWhitelisted, ...botChallengeKnownErrors]
    );

    if (res.status === "error") {
      return Result.error(res.error);
    } else {
      return Result.ok(await res.data.json());
    }
  }

  async resetPassword(
    options: { code: string } & ({ password: string } | { onlyVerifyCode: true })
  ): Promise<Result<undefined, KnownErrors["VerificationCodeError"]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "onlyVerifyCode" in options ? "/auth/password/reset/check-code" : "/auth/password/reset",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          code: options.code,
          ...("password" in options ? { password: options.password } : {}),
        }),
      },
      null,
      [KnownErrors.VerificationCodeError]
    );

    if (res.status === "error") {
      return Result.error(res.error);
    } else {
      return Result.ok(undefined);
    }
  }

  async updatePassword(
    options: { oldPassword: string, newPassword: string },
    session: InternalSession
  ): Promise<KnownErrors["PasswordConfirmationMismatch"] | KnownErrors["PasswordRequirementsNotMet"] | undefined> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/password/update",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          old_password: options.oldPassword,
          new_password: options.newPassword,
        }),
      },
      session,
      [KnownErrors.PasswordConfirmationMismatch, KnownErrors.PasswordRequirementsNotMet]
    );

    if (res.status === "error") {
      return res.error;
    }
  }

  async setPassword(
    options: { password: string },
    session: InternalSession
  ): Promise<KnownErrors["PasswordRequirementsNotMet"] | undefined> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/password/set",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(options),
      },
      session,
      [KnownErrors.PasswordRequirementsNotMet]
    );

    if (res.status === "error") {
      return res.error;
    }
  }

  async verifyPasswordResetCode(code: string): Promise<Result<undefined, KnownErrors["VerificationCodeError"]>> {
    const res = await this.resetPassword({ code, onlyVerifyCode: true });
    if (res.status === "error") {
      return Result.error(res.error);
    } else {
      return Result.ok(undefined);
    }
  }

  async verifyEmail(code: string): Promise<Result<undefined, KnownErrors["VerificationCodeError"]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/contact-channels/verify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          code,
        }),
      },
      null,
      [KnownErrors.VerificationCodeError]
    );

    if (res.status === "error") {
      return Result.error(res.error);
    } else {
      return Result.ok(undefined);
    }
  }

  async initiatePasskeyRegistration(
    options: {},
    session: InternalSession
  ): Promise<Result<{ options_json: PublicKeyCredentialCreationOptionsJSON, code: string }, KnownErrors[]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/passkey/initiate-passkey-registration",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(options),
      },
      session,
      []
    );

    if (res.status === "error") {
      return Result.error(res.error);
    }

    return Result.ok(await res.data.json());
  }

  async registerPasskey(
    options: { credential: RegistrationResponseJSON, code: string },
    session: InternalSession
  ): Promise<Result<undefined, KnownErrors["PasskeyRegistrationFailed"]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/passkey/register",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(options),
      },
      session,
      [KnownErrors.PasskeyRegistrationFailed]
    );
    if (res.status === "error") {
      return Result.error(res.error);
    }
    return Result.ok(undefined);
  }

  async initiatePasskeyAuthentication(
    options: {
    },
    session: InternalSession
  ): Promise<Result<{ options_json: PublicKeyCredentialRequestOptionsJSON, code: string }, KnownErrors[]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/passkey/initiate-passkey-authentication",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(options),
      },
      session,
      []
    );

    if (res.status === "error") {
      return Result.error(res.error);
    }

    return Result.ok(await res.data.json());
  }

  async sendTeamInvitation(options: {
    email: string,
    teamId: string,
    callbackUrl: string,
    session: InternalSession,
  }): Promise<void> {
    await this.sendClientRequest(
      "/team-invitations/send-code",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: options.email,
          team_id: options.teamId,
          callback_url: options.callbackUrl,
        }),
      },
      options.session,
    );
  }

  async acceptTeamInvitation<T extends 'use' | 'details' | 'check'>(options: {
    code: string,
    session: InternalSession,
    type: T,
  }): Promise<Result<T extends 'details' ? { team_display_name: string } : undefined, KnownErrors["VerificationCodeError"] | KnownErrors["TeamInvitationEmailMismatch"]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      options.type === 'check' ?
        "/team-invitations/accept/check-code" :
        options.type === 'details' ?
          "/team-invitations/accept/details" :
          "/team-invitations/accept",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          code: options.code,
        }),
      },
      options.session,
      [KnownErrors.VerificationCodeError, KnownErrors.TeamInvitationEmailMismatch]
    );

    if (res.status === "error") {
      return Result.error(res.error);
    } else {
      return Result.ok(await res.data.json());
    }
  }

  async totpMfa(
    attemptCode: string,
    totp: string,
    session: InternalSession
  ) {
    const res = await this.sendClientRequest("/auth/mfa/sign-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        code: attemptCode,
        type: "totp",
        totp: totp,
      }),
    }, session);

    const result = await res.json();
    return {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      newUser: result.is_new_user,
    };
  }

  async signInWithCredential(
    email: string,
    password: string,
    session: InternalSession
  ): Promise<Result<{ accessToken: string, refreshToken: string }, KnownErrors["EmailPasswordMismatch"]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/password/sign-in",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          password,
        }),
      },
      session,
      [KnownErrors.EmailPasswordMismatch]
    );

    if (res.status === "error") {
      return Result.error(res.error);
    }

    const result = await res.data.json();
    return Result.ok({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
    });
  }

  async signUpWithCredential(
    email: string,
    password: string,
    emailVerificationRedirectUrl: string | undefined,
    session: InternalSession,
    botChallenge?: BotChallengeInput,
  ): Promise<Result<{ accessToken: string, refreshToken: string }, KnownErrors["UserWithEmailAlreadyExists"] | KnownErrors["ContactChannelAlreadyUsedForAuthBySomeoneElse"] | KnownErrors["PasswordRequirementsNotMet"] | KnownErrors["BotChallengeRequired"] | KnownErrors["BotChallengeFailed"]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/password/sign-up",
      {
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          verification_callback_url: emailVerificationRedirectUrl,
          ...getBotChallengeRequestFields(botChallenge, "Credential sign-up"),
        }),
      },
      session,
      [KnownErrors.UserWithEmailAlreadyExists, KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse, KnownErrors.PasswordRequirementsNotMet, ...botChallengeKnownErrors]
    );

    if (res.status === "error") {
      return Result.error(res.error);
    }

    const result = await res.data.json();
    return Result.ok({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
    });
  }

  async signUpAnonymously(session: InternalSession): Promise<Result<{ accessToken: string, refreshToken: string }, never>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/anonymous/sign-up",
      {
        method: "POST",
      },
      session,
      [],
    );

    if (res.status === "error") {
      return Result.error(res.error);
    }

    const result = await res.data.json();
    return Result.ok({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
    });
  }

  async signInWithMagicLink(code: string, session: InternalSession): Promise<Result<{ newUser: boolean, accessToken: string, refreshToken: string }, KnownErrors["VerificationCodeError"]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/otp/sign-in",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          code,
        }),
      },
      session,
      [KnownErrors.VerificationCodeError]
    );

    if (res.status === "error") {
      return Result.error(res.error);
    }

    const result = await res.data.json();
    return Result.ok({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      newUser: result.is_new_user,
    });
  }

  async signInWithMfa(totp: string, code: string, session: InternalSession): Promise<Result<{ newUser: boolean, accessToken: string, refreshToken: string }, KnownErrors["VerificationCodeError"]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/mfa/sign-in",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: "totp",
          totp,
          code,
        }),
      },
      session,
      [KnownErrors.VerificationCodeError]
    );

    if (res.status === "error") {
      return Result.error(res.error);
    }

    const result = await res.data.json();
    return Result.ok({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      newUser: result.is_new_user,
    });
  }

  async signInWithPasskey(body: { authentication_response: AuthenticationResponseJSON, code: string }, session: InternalSession): Promise<Result<{accessToken: string, refreshToken: string }, KnownErrors["PasskeyAuthenticationFailed"]>> {
    const res = await this.sendClientRequestAndCatchKnownError(
      "/auth/passkey/sign-in",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
      },
      session,
      [KnownErrors.PasskeyAuthenticationFailed]
    );

    if (res.status === "error") {
      return Result.error(res.error);
    }

    const result = await res.data.json();
    return Result.ok({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
    });
  }

  async getOAuthUrl(
    options: {
      provider: string,
      redirectUrl: string,
      errorRedirectUrl: string,
      afterCallbackRedirectUrl?: string,
      codeChallenge: string,
      state: string,
      type: "authenticate" | "link",
      providerScope?: string,
      botChallenge?: BotChallengeInput,
      session: InternalSession,
    }
  ): Promise<string> {
    const updatedRedirectUrl = new URL(options.redirectUrl);
    for (const key of ["code", "state"]) {
      if (updatedRedirectUrl.searchParams.has(key)) {
        console.warn("Redirect URL already contains " + key + " parameter, removing it as it will be overwritten by the OAuth callback");
      }
      updatedRedirectUrl.searchParams.delete(key);
    }

    if ("projectOwnerSession" in this.options) {
      // TODO fix
      throw new Error("Admin session token is currently not supported for OAuth");
    }
    const clientSecret = this.options.publishableClientKey ?? publishableClientKeyNotNecessarySentinel;
    const url = new URL(this.getCurrentTargetApiUrl() + "/auth/oauth/authorize/" + options.provider.toLowerCase());
    url.searchParams.set("client_id", this.projectId);
    url.searchParams.set("client_secret", clientSecret);
    url.searchParams.set("redirect_uri", updatedRedirectUrl.toString());
    url.searchParams.set("scope", "legacy");
    url.searchParams.set("state", options.state);
    url.searchParams.set("grant_type", "authorization_code");
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("type", options.type);
    url.searchParams.set("error_redirect_url", options.errorRedirectUrl);

    // TODO: This token will expire after 45s if the token lifetime is 60s, which may be shorter than the OAuth flow.
    // We should probably find a way to request a longer-lived token here.
    const tokens = await options.session.getOrFetchLikelyValidTokens(45_000, 60_000);
    if (tokens) {
      url.searchParams.set("token", tokens.accessToken.token);
    }

    if (options.afterCallbackRedirectUrl) {
      url.searchParams.set("after_callback_redirect_url", options.afterCallbackRedirectUrl);
    }
    if (options.providerScope) {
      url.searchParams.set("provider_scope", options.providerScope);
    }
    for (const [key, value] of Object.entries(getBotChallengeRequestFields(options.botChallenge, `OAuth ${options.type}`))) {
      url.searchParams.set(key, value);
    }

    return url.toString();
  }

  async authorizeOAuth(options: {
    provider: string,
    redirectUrl: string,
    errorRedirectUrl: string,
    afterCallbackRedirectUrl?: string,
    codeChallenge: string,
    state: string,
    type: "authenticate" | "link",
    providerScope?: string,
    botChallenge?: BotChallengeInput,
    session: InternalSession,
  }): Promise<Result<string, KnownErrors["BotChallengeRequired"] | KnownErrors["BotChallengeFailed"]>> {
    if (typeof window === "undefined") {
      throw new HexclaveAssertionError("authorizeOAuth can currently only be called in a browser environment");
    }

    await this.options.prepareRequest?.();

    const url = new URL(await this.getOAuthUrl(options));
    // Hexclave rebrand: dual-emit both query param names. The current backend accepts either, but
    // a new SDK calling an OLDER backend (during deploy ordering, or a self-hoster on a stale
    // image) only recognizes `stack_response_mode` — without it the route silently falls back to
    // redirect mode and the SDK gets HTML where it expected JSON. Emit both to keep that working.
    url.searchParams.set("hexclave_response_mode", "json");
    url.searchParams.set("stack_response_mode", "json");

    let rawRes;
    try {
      rawRes = await fetch(url, {
        method: "GET",
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw await this._createNetworkError(error, options.session, "client");
      }
      throw error;
    }

    const processedResponse = await this._processResponse(rawRes);
    if (processedResponse.status === "error") {
      if (isBotChallengeKnownError(processedResponse.error)) {
        return Result.error(processedResponse.error);
      }
      throw processedResponse.error;
    }

    if (processedResponse.data.status !== 200) {
      throw new HexclaveAssertionError(`OAuth authorize returned an unexpected status: ${processedResponse.data.status}`);
    }

    const body = await processedResponse.data.json();
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      throw new HexclaveAssertionError("OAuth authorize response body must be an object", { body });
    }

    const location = body.location;
    if (typeof location !== "string") {
      throw new HexclaveAssertionError("OAuth authorize response is missing a redirect location", { body });
    }

    return Result.ok(location);
  }

  async callOAuthCallback(options: {
    oauthParams: URLSearchParams,
    redirectUri: string,
    codeVerifier: string,
    state: string,
  }): Promise<{ newUser: boolean, afterCallbackRedirectUrl?: string, accessToken: string, refreshToken: string }> {
    if ("projectOwnerSession" in this.options) {
      // TODO fix
      throw new Error("Admin session token is currently not supported for OAuth");
    }

    const clientSecret = this.options.publishableClientKey ?? publishableClientKeyNotNecessarySentinel;
    return await this._withFallback(async (apiUrl) => {
      return await this._callOAuthCallbackInner(options, clientSecret, apiUrl);
    });
  }

  private async _callOAuthCallbackInner(options: {
    oauthParams: URLSearchParams,
    redirectUri: string,
    codeVerifier: string,
    state: string,
  }, clientSecret: string, apiUrl: string): Promise<{ newUser: boolean, afterCallbackRedirectUrl?: string, accessToken: string, refreshToken: string }> {
    const tokenEndpoint = apiUrl + '/auth/oauth/token';
    const as = {
      issuer: this.options.getBaseUrl(),
      algorithm: 'oauth2',
      token_endpoint: tokenEndpoint,
    };
    const client: oauth.Client = {
      client_id: this.projectId,
      client_secret: clientSecret,
    };
    const clientAuthentication = oauth.ClientSecretPost(clientSecret);
    // Allow insecure HTTP requests only in test environment (for localhost testing)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const allowInsecure = tokenEndpoint.startsWith('http://');

    let params: URLSearchParams;
    try {
      params = oauth.validateAuthResponse(as, client, options.oauthParams, options.state);
    } catch (e) {
      if (e instanceof oauth.AuthorizationResponseError) {
        throw new HexclaveAssertionError("Authorization response error when validating outer OAuth response", {
          //cause is a URLSearchParams object for this error, so we need to serialize it better
          cause: Object.fromEntries(e.cause),
          code: e.code,
          error: e.error,
        });
      }
      throw new HexclaveAssertionError("Unexpected error when validating outer OAuth response", { cause: e });
    }
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      clientAuthentication,
      params,
      options.redirectUri,
      options.codeVerifier,
      allowInsecure ? { [oauth.allowInsecureRequests]: true } : undefined,
    );

    let result;
    try {
      result = await oauth.processAuthorizationCodeResponse(as, client, response);
    } catch (e) {
      if (e instanceof oauth.ResponseBodyError) {
        if ((e.cause as any).code === "MULTI_FACTOR_AUTHENTICATION_REQUIRED") {
          throw new KnownErrors.MultiFactorAuthenticationRequired((e.cause as any).details.attempt_code);
        }
        // TODO Handle OAuth 2.0 response body error
        throw new HexclaveAssertionError("Outer OAuth error during authorization code response", {
          cause: e.cause,
          code: e.code,
          error: e.error,
        });
      }
      throw new HexclaveAssertionError("Unexpected error when processing authorization code response", { cause: e });
    }
    return {
      newUser: result.is_new_user as boolean,
      afterCallbackRedirectUrl: result.after_callback_redirect_url as string | undefined,
      accessToken: result.access_token,
      refreshToken: result.refresh_token ?? throwErr("Refresh token not found in outer OAuth response"),
    };
  }

  async signOut(session: InternalSession): Promise<void> {
    const tokenObj = await session.getOrFetchLikelyValidTokens(20_000, null);
    if (tokenObj) {
      const resOrError = await this.sendClientRequestAndCatchKnownError(
        "/auth/sessions/current",
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({}),
        },
        session,
        [KnownErrors.RefreshTokenError]
      );
      if (resOrError.status === "error") {
        if (KnownErrors.RefreshTokenError.isInstance(resOrError.error)) {
          // refresh token was already invalid, just continue like nothing happened
        } else {
          // this should never happen
          throw new HexclaveAssertionError("Unexpected error", { cause: resOrError.error });
        }
      } else {
        // user was signed out successfully, all good
      }
    }
    session.markInvalid();
  }

  async getClientUserByToken(session: InternalSession): Promise<CurrentUserCrud["Client"]["Read"] | null> {
    const responseOrError = await this.sendClientRequestAndCatchKnownError(
      "/users/me",
      {},
      session,
      [KnownErrors.CannotGetOwnUserWithoutUser],
    );
    if (responseOrError.status === "error") {
      if (KnownErrors.CannotGetOwnUserWithoutUser.isInstance(responseOrError.error)) {
        return null;
      } else {
        throw new HexclaveAssertionError("Unexpected uncaught error", { cause: responseOrError.error });
      }
    }
    const response = responseOrError.data;
    const user: CurrentUserCrud["Client"]["Read"] = await response.json();
    if (!(user as any)) throw new HexclaveAssertionError("User endpoint returned null; this should never happen");
    return user;
  }

  async listTeamInvitations(
    options: {
      teamId: string,
    },
    session: InternalSession,
  ): Promise<TeamInvitationCrud['Client']['Read'][]> {
    const response = await this.sendClientRequest(
      "/team-invitations?" + new URLSearchParams({ team_id: options.teamId }),
      {},
      session,
    );
    const result = await response.json() as TeamInvitationCrud['Client']['List'];
    return result.items;
  }

  async listCurrentUserTeamInvitations(
    session: InternalSession,
  ): Promise<TeamInvitationCrud['Client']['Read'][]> {
    const response = await this.sendClientRequest(
      "/team-invitations?" + new URLSearchParams({ user_id: 'me' }),
      {},
      session,
    );
    const result = await response.json() as TeamInvitationCrud['Client']['List'];
    return result.items;
  }

  async acceptTeamInvitationById(
    invitationId: string,
    session: InternalSession,
  ) {
    await this.sendClientRequest(
      urlString`/team-invitations/${invitationId}/accept` + "?" + new URLSearchParams({ user_id: 'me' }),
      { method: "POST" },
      session,
    );
  }

  async revokeTeamInvitation(
    invitationId: string,
    teamId: string,
    session: InternalSession,
  ) {
    await this.sendClientRequest(
      `/team-invitations/${invitationId}?team_id=${teamId}`,
      { method: "DELETE" },
      session,
    );
  }

  async listTeamMemberProfiles(
    options: {
      teamId?: string,
      userId?: string,
    },
    session: InternalSession,
  ): Promise<TeamMemberProfilesCrud['Client']['Read'][]> {
    const response = await this.sendClientRequest(
      "/team-member-profiles?" + new URLSearchParams(filterUndefined({
        team_id: options.teamId,
        user_id: options.userId,
      })),
      {},
      session,
    );
    const result = await response.json() as TeamMemberProfilesCrud['Client']['List'];
    return result.items;
  }

  async getTeamMemberProfile(
    options: {
      teamId: string,
      userId: string,
    },
    session: InternalSession,
  ): Promise<TeamMemberProfilesCrud['Client']['Read']> {
    const response = await this.sendClientRequest(
      `/team-member-profiles/${options.teamId}/${options.userId}`,
      {},
      session,
    );
    return await response.json();
  }

  async leaveTeam(
    teamId: string,
    session: InternalSession,
  ) {
    await this.sendClientRequest(
      `/team-memberships/${teamId}/me`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      session,
    );
  }

  async removeUserFromTeam(
    teamId: string,
    userId: string,
    session: InternalSession,
  ) {
    await this.sendClientRequest(
      urlString`/team-memberships/${teamId}/${userId}`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      session,
    );
  }

  async updateTeamMemberProfile(
    options: {
      teamId: string,
      userId: string,
      profile: TeamMemberProfilesCrud['Client']['Update'],
    },
    session: InternalSession,
  ) {
    await this.sendClientRequest(
      `/team-member-profiles/${options.teamId}/${options.userId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(options.profile),
      },
      session,
    );
  }

  async updateTeam(
    options: {
      teamId: string,
      data: TeamsCrud['Client']['Update'],
    },
    session: InternalSession,
  ) {
    await this.sendClientRequest(
      `/teams/${options.teamId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(options.data),
      },
      session,
    );
  }

  async listCurrentUserTeamPermissions(
    options: {
      teamId: string,
      recursive: boolean,
    },
    session: InternalSession
  ): Promise<TeamPermissionsCrud['Client']['Read'][]> {
    const response = await this.sendClientRequest(
      `/team-permissions?team_id=${options.teamId}&user_id=me&recursive=${options.recursive}`,
      {},
      session,
    );
    const result = await response.json() as TeamPermissionsCrud['Client']['List'];
    return result.items;
  }

  async listCurrentUserProjectPermissions(
    options: {
      recursive: boolean,
    },
    session: InternalSession
  ): Promise<ProjectPermissionsCrud['Client']['Read'][]> {
    const response = await this.sendClientRequest(
      `/project-permissions?user_id=me&recursive=${options.recursive}`,
      {},
      session,
    );
    const result = await response.json() as ProjectPermissionsCrud['Client']['List'];
    return result.items;
  }

  async listCurrentUserTeams(session: InternalSession): Promise<TeamsCrud["Client"]["Read"][]> {
    const response = await this.sendClientRequest(
      "/teams?user_id=me",
      {},
      session,
    );
    const result = await response.json() as TeamsCrud["Client"]["List"];
    return result.items;
  }

  async getClientProject(): Promise<Result<ClientProjectsCrud['Client']['Read'], KnownErrors["ProjectNotFound"]>> {
    const responseOrError = await this.sendClientRequestAndCatchKnownError("/projects/current", {}, null, [KnownErrors.ProjectNotFound]);
    if (responseOrError.status === "error") {
      return Result.error(responseOrError.error);
    }
    const response = responseOrError.data;
    const project: ClientProjectsCrud['Client']['Read'] = await response.json();
    return Result.ok(project);
  }

  async updateClientUser(update: CurrentUserCrud["Client"]["Update"], session: InternalSession) {
    await this.sendClientRequest(
      "/users/me",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(update),
      },
      session,
    );
  }

  async listProjects(session: InternalSession): Promise<AdminUserProjectsCrud['Client']['Read'][]> {
    const response = await this.sendClientRequest("/internal/projects", {}, session);
    if (!response.ok) {
      throw new Error("Failed to list projects: " + response.status + " " + (await response.text()));
    }

    const json = await response.json() as AdminUserProjectsCrud['Client']['List'];
    return json.items;
  }

  async createProject(
    project: AdminUserProjectsCrud['Client']['Create'],
    session: InternalSession,
  ): Promise<AdminUserProjectsCrud['Client']['Read']> {
    const fetchResponse = await this.sendClientRequest(
      "/internal/projects",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(project),
      },
      session,
    );
    if (!fetchResponse.ok) {
      throw new Error("Failed to create project: " + fetchResponse.status + " " + (await fetchResponse.text()));
    }

    const json = await fetchResponse.json();
    return json;
  }

  async createProviderAccessToken(
    provider: string,
    scope: string,
    session: InternalSession,
  ): Promise<ConnectedAccountAccessTokenCrud['Client']['Read']> {
    const response = await this.sendClientRequest(
      `/connected-accounts/me/${provider}/access-token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ scope }),
      },
      session,
    );
    return await response.json();
  }

  /**
   * Get access token for a specific connected account by provider ID and provider account ID.
   * This is the preferred method when dealing with multiple accounts of the same provider.
   */
  async createProviderAccessTokenByAccount(
    providerId: string,
    providerAccountId: string,
    scope: string,
    session: InternalSession,
  ): Promise<ConnectedAccountAccessTokenCrud['Client']['Read']> {
    const response = await this.sendClientRequest(
      `/connected-accounts/me/${encodeURIComponent(providerId)}/${encodeURIComponent(providerAccountId)}/access-token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ scope }),
      },
      session,
    );
    return await response.json();
  }

  /**
   * List all connected accounts for the current user.
   */
  async listConnectedAccounts(
    session: InternalSession,
  ): Promise<ConnectedAccountCrud['Client']['List']> {
    const response = await this.sendClientRequest(
      `/connected-accounts/me`,
      { method: "GET" },
      session,
    );
    return await response.json();
  }

  async createClientTeam(
    data: TeamsCrud['Client']['Create'],
    session: InternalSession,
  ): Promise<TeamsCrud['Client']['Read']> {
    const response = await this.sendClientRequest(
      "/teams",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      session,
    );
    return await response.json();
  }

  async deleteTeam(
    teamId: string,
    session: InternalSession,
  ) {
    await this.sendClientRequest(
      `/teams/${teamId}`,
      {
        method: "DELETE",
      },
      session,
    );
  }

  async deleteCurrentUser(session: InternalSession) {
    await this.sendClientRequest(
      "/users/me",
      {
        method: "DELETE",
      },
      session,
    );
  }

  async createClientContactChannel(
    data: ContactChannelsCrud['Client']['Create'],
    session: InternalSession,
  ): Promise<ContactChannelsCrud['Client']['Read']> {
    const response = await this.sendClientRequest(
      "/contact-channels",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      session,
    );
    return await response.json();
  }

  async updateClientContactChannel(
    id: string,
    data: ContactChannelsCrud['Client']['Update'],
    session: InternalSession,
  ): Promise<ContactChannelsCrud['Client']['Read']> {
    const response = await this.sendClientRequest(
      `/contact-channels/me/${id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      session,
    );
    return await response.json();
  }

  async deleteClientContactChannel(
    id: string,
    session: InternalSession,
  ): Promise<void> {
    await this.sendClientRequest(
      `/contact-channels/me/${id}`,
      {
        method: "DELETE",
      },
      session,
    );
  }

  async deleteSession(
    sessionId: string,
    session: InternalSession,
  ): Promise<void> {
    await this.sendClientRequest(
      `/auth/sessions/${sessionId}?user_id=me`,
      {
        method: "DELETE",
      },
      session,
    );
  }

  async listSessions(
    session: InternalSession,
  ): Promise<SessionsCrud['Client']['List']> {
    const response = await this.sendClientRequest(
      "/auth/sessions?user_id=me",
      {
        method: "GET",
      },
      session,
    );
    return await response.json();
  }


  async listClientContactChannels(
    session: InternalSession,
  ): Promise<ContactChannelsCrud['Client']['Read'][]> {
    const response = await this.sendClientRequest(
      "/contact-channels?user_id=me",
      {
        method: "GET",
      },
      session,
    );
    const json = await response.json() as ContactChannelsCrud['Client']['List'];
    return json.items;
  }

  async sendCurrentUserContactChannelVerificationEmail(
    contactChannelId: string,
    callbackUrl: string,
    session: InternalSession,
  ): Promise<Result<undefined, KnownErrors["EmailAlreadyVerified"]>> {
    const responseOrError = await this.sendClientRequestAndCatchKnownError(
      `/contact-channels/me/${contactChannelId}/send-verification-code`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callback_url: callbackUrl }),
      },
      session,
      [KnownErrors.EmailAlreadyVerified]
    );

    if (responseOrError.status === "error") {
      return Result.error(responseOrError.error);
    }
    return Result.ok(undefined);
  }

  async cliLogin(
    loginCode: string,
    refreshToken: string,
    session: InternalSession
  ): Promise<Result<undefined, KnownErrors["SchemaError"]>> {
    const responseOrError = await this.sendClientRequestAndCatchKnownError(
      "/auth/cli/complete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          login_code: loginCode,
          refresh_token: refreshToken,
        }),
      },
      session,
      [KnownErrors.SchemaError]
    );

    if (responseOrError.status === "error") {
      return Result.error(responseOrError.error);
    }
    return Result.ok(undefined);
  }

  private async _getApiKeyRequestInfo(options: { user_id: string | null } | { team_id: string }) {
    if ("user_id" in options && "team_id" in options) {
      throw new HexclaveAssertionError("Cannot specify both user_id and team_id in _getApiKeyRequestInfo");
    }

    return {
      endpoint: "team_id" in options ? "/team-api-keys" : "/user-api-keys",
      queryParams: new URLSearchParams(filterUndefinedOrNull(options)),
    };
  }

  // API Keys CRUD operations
  listProjectApiKeys(options: { user_id: string }, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<UserApiKeysCrud['Client']['Read'][]>;
  listProjectApiKeys(options: { team_id: string }, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<TeamApiKeysCrud['Client']['Read'][]>;
  listProjectApiKeys(options: { user_id: string } | { team_id: string }, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<(UserApiKeysCrud['Client']['Read'] | TeamApiKeysCrud['Client']['Read'])[]>;
  async listProjectApiKeys(
    options: { user_id: string } | { team_id: string },
    session: InternalSession | null,
    requestType: "client" | "server" | "admin",
  ): Promise<(UserApiKeysCrud['Client']['Read'] | TeamApiKeysCrud['Client']['Read'])[]> {
    const sendRequest = (requestType === "client" ? this.sendClientRequest : (this as any).sendServerRequest as never).bind(this);
    const { endpoint, queryParams } = await this._getApiKeyRequestInfo(options);

    const response = await sendRequest(
      `${endpoint}?${queryParams.toString()}`,
      {
        method: "GET",
      },
      session,
      requestType,
    );
    const json = await response.json();
    return json.items;
  }

  createProjectApiKey(data: yup.InferType<typeof userApiKeysCreateInputSchema>, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<yup.InferType<typeof userApiKeysCreateOutputSchema>>;
  createProjectApiKey(data: yup.InferType<typeof teamApiKeysCreateInputSchema>, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<yup.InferType<typeof teamApiKeysCreateOutputSchema>>;
  createProjectApiKey(data: yup.InferType<typeof userApiKeysCreateInputSchema> | yup.InferType<typeof teamApiKeysCreateInputSchema>, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<yup.InferType<typeof userApiKeysCreateOutputSchema> | yup.InferType<typeof teamApiKeysCreateOutputSchema>>;
  async createProjectApiKey(
    data: yup.InferType<typeof userApiKeysCreateInputSchema> | yup.InferType<typeof teamApiKeysCreateInputSchema>,
    session: InternalSession | null,
    requestType: "client" | "server" | "admin",
  ): Promise<yup.InferType<typeof userApiKeysCreateOutputSchema> | yup.InferType<typeof teamApiKeysCreateOutputSchema>> {
    const sendRequest = (requestType === "client" ? this.sendClientRequest : (this as any).sendServerRequest as never).bind(this);
    const { endpoint } = await this._getApiKeyRequestInfo(data);

    const response = await sendRequest(
      `${endpoint}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      session,
      requestType,
    );
    return await response.json();
  }

  getProjectApiKey(options: { user_id: string | null }, keyId: string, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<UserApiKeysCrud['Client']['Read']>;
  getProjectApiKey(options: { team_id: string }, keyId: string, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<TeamApiKeysCrud['Client']['Read']>;
  getProjectApiKey(options: { user_id: string | null } | { team_id: string }, keyId: string, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<UserApiKeysCrud['Client']['Read'] | TeamApiKeysCrud['Client']['Read']>;
  async getProjectApiKey(
    options: { user_id: string | null } | { team_id: string },
    keyId: string,
    session: InternalSession | null,
    requestType: "client" | "server" | "admin",
  ): Promise<UserApiKeysCrud['Client']['Read'] | TeamApiKeysCrud['Client']['Read']> {
    const sendRequest = (requestType === "client" ? this.sendClientRequest : (this as any).sendServerRequest as never).bind(this);
    const { endpoint, queryParams } = await this._getApiKeyRequestInfo(options);

    const response = await sendRequest(
      `${endpoint}/${keyId}?${queryParams.toString()}`,
      {
        method: "GET",
      },
      session,
      requestType,
    );
    return await response.json();
  }

  updateProjectApiKey(options: { user_id: string }, keyId: string, data: UserApiKeysCrud['Client']['Update'], session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<UserApiKeysCrud['Client']['Read']>;
  updateProjectApiKey(options: { team_id: string }, keyId: string, data: TeamApiKeysCrud['Client']['Update'], session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<TeamApiKeysCrud['Client']['Read']>;
  updateProjectApiKey(options: { user_id: string } | { team_id: string }, keyId: string, data: UserApiKeysCrud['Client']['Update'] | TeamApiKeysCrud['Client']['Update'], session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<UserApiKeysCrud['Client']['Read'] | TeamApiKeysCrud['Client']['Read']>;
  async updateProjectApiKey(
    options: { user_id: string } | { team_id: string },
    keyId: string,
    data: UserApiKeysCrud['Client']['Update'] | TeamApiKeysCrud['Client']['Update'],
    session: InternalSession | null,
    requestType: "client" | "server" | "admin",
  ): Promise<UserApiKeysCrud['Client']['Read'] | TeamApiKeysCrud['Client']['Read']> {
    const sendRequest = (requestType === "client" ? this.sendClientRequest : (this as any).sendServerRequest as never).bind(this);
    const { endpoint, queryParams } = await this._getApiKeyRequestInfo(options);

    const response = await sendRequest(
      `${endpoint}/${keyId}?${queryParams.toString()}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      session,
      requestType,
    );
    return await response.json();
  }

  checkProjectApiKey(type: "user", apiKey: string, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<UserApiKeysCrud['Client']['Read'] | null>;
  checkProjectApiKey(type: "team", apiKey: string, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<TeamApiKeysCrud['Client']['Read'] | null>;
  checkProjectApiKey(type: "user" | "team", apiKey: string, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<UserApiKeysCrud['Client']['Read'] | TeamApiKeysCrud['Client']['Read'] | null>;
  async checkProjectApiKey(type: "user" | "team", apiKey: string, session: InternalSession | null, requestType: "client" | "server" | "admin"): Promise<UserApiKeysCrud['Client']['Read'] | TeamApiKeysCrud['Client']['Read'] | null> {
    const sendRequest = (requestType === "client" ? this.sendClientRequestAndCatchKnownError : (this as any).sendServerRequestAndCatchKnownError as never).bind(this);
    const result = await sendRequest(
      `/${type}-api-keys/check`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ api_key: apiKey }),
      },
      session,
      [KnownErrors.ApiKeyNotValid]
    );
    if (result.status === "error") {
      return null;
    }
    return await result.data.json();
  }

  async listNotificationCategories(
    session: InternalSession,
  ): Promise<NotificationPreferenceCrud['Client']['Read'][]> {
    const response = await this.sendClientRequest(
      `/emails/notification-preference/me`,
      {},
      session,
    );
    const result = await response.json() as NotificationPreferenceCrud['Client']['List'];
    return result.items;
  }

  async setNotificationsEnabled(
    notificationCategoryId: string,
    enabled: boolean,
    session: InternalSession,
  ): Promise<void> {
    await this.sendClientRequest(
      `/emails/notification-preference/me/${notificationCategoryId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled,
        }),
      },
      session,
    );
  }

  async getOAuthProvider(
    userId: string,
    providerId: string,
    session: InternalSession,
  ): Promise<OAuthProviderCrud['Client']['Read']> {
    const response = await this.sendClientRequest(
      `/oauth-providers/${userId}/${providerId}`,
      {
        method: "GET",
      },
      session,
    );
    return await response.json();
  }

  async updateOAuthProvider(
    userId: string,
    providerId: string,
    data: OAuthProviderCrud['Client']['Update'],
    session: InternalSession,
  ): Promise<OAuthProviderCrud['Client']['Read']> {
    const response = await this.sendClientRequest(
      `/oauth-providers/${userId}/${providerId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      session,
    );
    return await response.json();
  }

  async listOAuthProviders(
    options: {
      user_id?: string,
    } = {},
    session: InternalSession,
  ): Promise<OAuthProviderCrud['Client']['Read'][]> {
    const queryParams = new URLSearchParams(filterUndefined(options));
    const response = await this.sendClientRequest(
      `/oauth-providers${queryParams.toString() ? `?${queryParams.toString()}` : ''}`,
      {
        method: "GET",
      },
      session,
    );
    const result = await response.json();
    return result.items;
  }

  async deleteOAuthProvider(
    userId: string,
    providerId: string,
    session: InternalSession,
  ): Promise<void> {
    const response = await this.sendClientRequest(
      `/oauth-providers/${userId}/${providerId}`,
      {
        method: "DELETE",
      },
      session,
    );
    return await response.json();
  }

  async getItem(
    options: (
      { itemId: string, userId: string } |
      { itemId: string, teamId: string } |
      { itemId: string, customCustomerId: string }
    ),
    session: InternalSession | null,
    requestType: "client" | "server" | "admin" = "client",
  ): Promise<ItemCrud['Client']['Read']> {
    let customerType: "user" | "team" | "custom";
    let customerId: string;
    if ("userId" in options) {
      customerType = "user";
      customerId = options.userId;
    } else if ("teamId" in options) {
      customerType = "team";
      customerId = options.teamId;
    } else if ("customCustomerId" in options) {
      customerType = "custom";
      customerId = options.customCustomerId;
    } else {
      throw new HexclaveAssertionError("getItem requires one of userId, teamId, or customCustomerId");
    }

    const sendRequest = (requestType === "client" ? this.sendClientRequest : (this as any).sendServerRequest as never).bind(this);
    const response = await sendRequest(
      urlString`/payments/items/${customerType}/${customerId}/${options.itemId}`,
      {},
      session,
      requestType,
    );
    return await response.json();
  }

  async listProducts(
    options: ListCustomerProductsOptions,
    session: InternalSession | null,
    requestType: "client" | "server" | "admin" = "client",
  ): Promise<CustomerProductsListResponse> {
    const queryParams = new URLSearchParams(filterUndefined({
      cursor: options.cursor,
      limit: options.limit !== undefined ? options.limit.toString() : undefined,
    }));
    const path = urlString`/payments/products/${options.customer_type}/${options.customer_id}`;
    const sendRequest = (requestType === "client" ? this.sendClientRequest : (this as any).sendServerRequest as never).bind(this);
    const response = await sendRequest(
      `${path}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`,
      {},
      session,
      requestType,
    );
    return await response.json();
  }

  async listInvoices(
    options: ListCustomerInvoicesOptions,
    session: InternalSession | null,
  ): Promise<CustomerInvoicesListResponse> {
    const queryParams = new URLSearchParams(filterUndefined({
      cursor: options.cursor,
      limit: options.limit !== undefined ? options.limit.toString() : undefined,
    }));
    const path = urlString`/payments/invoices/${options.customer_type}/${options.customer_id}`;
    const response = await this.sendClientRequest(
      `${path}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`,
      {},
      session,
    );
    return await response.json();
  }

  async cancelSubscription(
    options: {
      customer_type: "user" | "team" | "custom",
      customer_id: string,
      product_id: string,
      subscription_id?: string,
    },
    session: InternalSession | null,
  ): Promise<void> {
    const queryParams = new URLSearchParams(filterUndefined({
      subscription_id: options.subscription_id,
    }));
    const path = urlString`/payments/products/${options.customer_type}/${options.customer_id}/${options.product_id}`;
    await this.sendClientRequest(
      `${path}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`,
      {
        method: "DELETE",
      },
      session,
    );
  }

  async switchSubscription(
    options: {
      customer_type: "user" | "team",
      customer_id: string,
      from_product_id: string,
      to_product_id: string,
      price_id?: string,
      quantity?: number,
    },
    session: InternalSession | null,
  ): Promise<void> {
    await this.sendClientRequest(
      urlString`/payments/products/${options.customer_type}/${options.customer_id}/switch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from_product_id: options.from_product_id,
          to_product_id: options.to_product_id,
          price_id: options.price_id,
          quantity: options.quantity,
        }),
      },
      session,
    );
  }

  async createCheckoutUrl(
    customer_type: "user" | "team" | "custom",
    customer_id: string,
    productIdOrInline: string | yup.InferType<typeof inlineProductSchema>,
    session: InternalSession | null,
    returnUrl?: string,
    requestType: "client" | "server" | "admin" = "client",
  ): Promise<string> {
    const productBody = typeof productIdOrInline === "string" ?
      { product_id: productIdOrInline } :
      { product_inline: productIdOrInline };
    const sendRequest = (requestType === "client" ? this.sendClientRequest : (this as any).sendServerRequest as never).bind(this);
    const response = await sendRequest(
      "/payments/purchases/create-purchase-url",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ customer_type, customer_id, ...productBody, return_url: returnUrl }),
      },
      session,
      requestType,
    );
    const { url } = await response.json() as { url: string };
    return url;
  }

  async getCustomerBilling(
    customerType: "user" | "team",
    customerId: string,
    session: InternalSession | null,
  ): Promise<{
    has_customer: boolean,
    default_payment_method: {
      id: string,
      brand: string | null,
      last4: string | null,
      exp_month: number | null,
      exp_year: number | null,
    } | null,
  }> {
    const response = await this.sendClientRequest(
      urlString`/payments/billing/${customerType}/${customerId}`,
      {},
      session,
    );
    return await response.json();
  }

  async createCustomerPaymentMethodSetupIntent(
    customerType: "user" | "team",
    customerId: string,
    session: InternalSession | null,
  ): Promise<{
    client_secret: string,
    stripe_account_id: string,
  }> {
    const response = await this.sendClientRequest(
      urlString`/payments/payment-method/${customerType}/${customerId}/setup-intent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      session,
    );
    return await response.json();
  }

  async setDefaultCustomerPaymentMethodFromSetupIntent(
    customerType: "user" | "team",
    customerId: string,
    setupIntentId: string,
    session: InternalSession | null,
  ): Promise<{
    default_payment_method: {
      id: string,
      brand: string | null,
      last4: string | null,
      exp_month: number | null,
      exp_year: number | null,
    },
  }> {
    const response = await this.sendClientRequest(
      urlString`/payments/payment-method/${customerType}/${customerId}/set-default`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          setup_intent_id: setupIntentId,
        }),
      },
      session,
    );
    return await response.json();
  }

  async transferProject(internalProjectSession: InternalSession, projectIdToTransfer: string, newTeamId: string): Promise<void> {
    if (this.options.projectId !== "internal") {
      throw new HexclaveAssertionError("HexclaveClientInterface.transferProject() is only available for internal projects (please specify the project ID in the constructor)");
    }
    await this.sendClientRequest(
      "/internal/projects/transfer",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          project_id: projectIdToTransfer,
          new_team_id: newTeamId,
        }),
      },
      internalProjectSession,
    );
  }
}

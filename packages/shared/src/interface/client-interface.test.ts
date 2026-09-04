import { afterEach, describe, expect, it, vi } from "vitest";
import { KnownErrors } from "../known-errors";
import { InternalSession, RefreshToken } from "../sessions";
import { Result } from "../utils/results";
import { ApiUrlsFailedError, HexclaveClientInterface } from "./client-interface";
import { HexclaveServerInterface } from "./server-interface";

function createClientInterface(options?: {
  baseUrl?: string,
  apiUrls?: string[],
}) {
  const apiUrls = options?.apiUrls ?? [options?.baseUrl ?? "https://api.example.com"];
  return new HexclaveClientInterface({
    clientVersion: "test",
    getBaseUrl: () => apiUrls[0],
    getApiUrls: () => apiUrls,
    extraRequestHeaders: {},
    projectId: "project-id",
    publishableClientKey: "publishable-client-key",
  });
}

function createSession() {
  return new InternalSession({
    refreshAccessTokenCallback: async () => null,
    refreshToken: null,
    accessToken: null,
  });
}

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function createKnownErrorResponse(error: InstanceType<typeof KnownErrors[keyof typeof KnownErrors]>): Response {
  return new Response(JSON.stringify({
    code: error.errorCode,
    message: error.message,
    details: error.details,
  }), {
    status: error.statusCode,
    headers: {
      "Content-Type": "application/json",
      "x-stack-known-error": error.errorCode,
    },
  });
}

function createTextResponse(body: string, options: { status: number, headers?: Record<string, string> }): Response {
  return new Response(body, options);
}

function getRequestBody(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const requestInit = fetchMock.mock.calls[0]?.[1];
  if (requestInit == null || typeof requestInit !== "object" || !("body" in requestInit)) {
    throw new Error("Expected request init to include a body");
  }

  const requestBody = requestInit.body;
  if (requestBody == null || typeof requestBody !== "string") {
    throw new Error("Expected request body to be a JSON string");
  }

  const parsed = JSON.parse(requestBody);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected parsed request body to be an object");
  }

  return parsed;
}

function getRequestUrl(fetchMock: { mock: { calls: unknown[][] } }): string {
  const input = fetchMock.mock.calls[0]?.[0];
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  throw new Error("Expected the fetch mock to receive a URL-like first argument");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HexclaveClientInterface bot challenge compatibility", () => {
  it("omits bot challenge from magic link requests when no token is provided", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ nonce: "nonce" }));
    vi.stubGlobal("fetch", fetchMock);

    const iface = createClientInterface();
    await iface.sendMagicLinkEmail("user@example.com", "https://app.example.com/callback");

    expect(getRequestBody(fetchMock)).toStrictEqual({
      email: "user@example.com",
      callback_url: "https://app.example.com/callback",
    });
  });

  it("serializes visible bot challenge retry fields for magic link requests", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ nonce: "nonce" }));
    vi.stubGlobal("fetch", fetchMock);

    const iface = createClientInterface();
    await iface.sendMagicLinkEmail("user@example.com", "https://app.example.com/callback", {
      token: " visible-token ",
      phase: "visible",
    });

    expect(getRequestBody(fetchMock)).toStrictEqual({
      email: "user@example.com",
      callback_url: "https://app.example.com/callback",
      bot_challenge_token: "visible-token",
      bot_challenge_phase: "visible",
    });
  });

  it("serializes bot challenge unavailability for magic link requests", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ nonce: "nonce" }));
    vi.stubGlobal("fetch", fetchMock);

    const iface = createClientInterface();
    await iface.sendMagicLinkEmail("user@example.com", "https://app.example.com/callback", {
      phase: "visible",
    });

    expect(getRequestBody(fetchMock)).toStrictEqual({
      email: "user@example.com",
      callback_url: "https://app.example.com/callback",
      bot_challenge_unavailable: "true",
    });
  });

  it("serializes explicit bot challenge unavailability for magic link requests", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ nonce: "nonce" }));
    vi.stubGlobal("fetch", fetchMock);

    const iface = createClientInterface();
    await iface.sendMagicLinkEmail("user@example.com", "https://app.example.com/callback", {
      unavailable: true,
    });

    expect(getRequestBody(fetchMock)).toStrictEqual({
      email: "user@example.com",
      callback_url: "https://app.example.com/callback",
      bot_challenge_unavailable: "true",
    });
  });

  it("returns BotChallengeFailed as a Result error for magic link requests", async () => {
    const fetchMock = vi.fn(async () => createKnownErrorResponse(
      new KnownErrors.BotChallengeFailed("Visible bot challenge verification failed"),
    ));
    vi.stubGlobal("fetch", fetchMock);

    const iface = createClientInterface();
    const result = await iface.sendMagicLinkEmail("user@example.com", "https://app.example.com/callback", {
      phase: "visible",
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("Expected magic link request to fail with BotChallengeFailed");
    }
    expect(result.error).toBeInstanceOf(KnownErrors.BotChallengeFailed);
  });

  it("omits bot challenge from credential signup requests when no token is provided", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const iface = createClientInterface();
    await iface.signUpWithCredential(
      "user@example.com",
      "password",
      undefined,
      createSession(),
      undefined,
    );

    expect(getRequestBody(fetchMock)).toStrictEqual({
      email: "user@example.com",
      password: "password",
    });
  });

  it("returns BotChallengeFailed as a Result error for credential signup requests", async () => {
    const fetchMock = vi.fn(async () => createKnownErrorResponse(
      new KnownErrors.BotChallengeFailed("Visible bot challenge verification failed"),
    ));
    vi.stubGlobal("fetch", fetchMock);

    const iface = createClientInterface();
    const result = await iface.signUpWithCredential(
      "user@example.com",
      "password",
      undefined,
      createSession(),
      {
        phase: "visible",
      },
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("Expected credential signup to fail with BotChallengeFailed");
    }
    expect(result.error).toBeInstanceOf(KnownErrors.BotChallengeFailed);
  });

  it("omits bot challenge from OAuth URLs when no token is provided", async () => {
    const iface = createClientInterface();
    const oauthUrl = await iface.getOAuthUrl({
      provider: "github",
      redirectUrl: "https://app.example.com/oauth/callback",
      errorRedirectUrl: "https://app.example.com/error",
      codeChallenge: "code-challenge",
      state: "state",
      type: "authenticate",
      session: createSession(),
    });

    expect(new URL(oauthUrl).searchParams.has("bot_challenge_token")).toBe(false);
  });

  it("serializes visible bot challenge retry fields in OAuth URLs", async () => {
    const iface = createClientInterface();
    const oauthUrl = await iface.getOAuthUrl({
      provider: "github",
      redirectUrl: "https://app.example.com/oauth/callback",
      errorRedirectUrl: "https://app.example.com/error",
      codeChallenge: "code-challenge",
      state: "state",
      type: "authenticate",
      botChallenge: {
        token: "visible-token",
        phase: "visible",
      },
      session: createSession(),
    });

    expect(Object.fromEntries(new URL(oauthUrl).searchParams.entries())).toMatchObject({
      bot_challenge_token: "visible-token",
      bot_challenge_phase: "visible",
    });
  });

  it("serializes bot challenge unavailability in OAuth URLs", async () => {
    const iface = createClientInterface();
    const oauthUrl = await iface.getOAuthUrl({
      provider: "github",
      redirectUrl: "https://app.example.com/oauth/callback",
      errorRedirectUrl: "https://app.example.com/error",
      codeChallenge: "code-challenge",
      state: "state",
      type: "authenticate",
      botChallenge: {
        phase: "visible",
      },
      session: createSession(),
    });

    expect(Object.fromEntries(new URL(oauthUrl).searchParams.entries())).toMatchObject({
      bot_challenge_unavailable: "true",
    });
  });

  it("authorizes OAuth via a JSON response instead of relying on manual redirects", async () => {
    const fetchCalls: [input: RequestInfo | URL, init?: RequestInit][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return createJsonResponse({
        location: "https://accounts.example.com/oauth/authorize",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {} as Window & typeof globalThis);

    const iface = createClientInterface();
    const result = await iface.authorizeOAuth({
      provider: "github",
      redirectUrl: "https://app.example.com/oauth/callback",
      errorRedirectUrl: "https://app.example.com/error",
      codeChallenge: "code-challenge",
      state: "state",
      type: "authenticate",
      session: createSession(),
    });

    expect(Result.orThrow(result)).toBe("https://accounts.example.com/oauth/authorize");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchCalls[0] ?? [];
    if (!(typeof requestUrl === "string" || requestUrl instanceof URL)) {
      throw new Error("Expected authorizeOAuth to call fetch with a URL");
    }
    expect(new URL(requestUrl.toString()).searchParams.get("stack_response_mode")).toBe("json");
    expect(requestInit).toMatchObject({
      method: "GET",
    });
    expect(requestInit).not.toHaveProperty("credentials");
  });

  it("returns BotChallengeFailed as a Result error for OAuth authorization", async () => {
    const fetchMock = vi.fn(async () => createKnownErrorResponse(
      new KnownErrors.BotChallengeFailed("Visible bot challenge verification failed"),
    ));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {} as Window & typeof globalThis);

    const iface = createClientInterface();
    const result = await iface.authorizeOAuth({
      provider: "github",
      redirectUrl: "https://app.example.com/oauth/callback",
      errorRedirectUrl: "https://app.example.com/error",
      codeChallenge: "code-challenge",
      state: "state",
      type: "authenticate",
      session: createSession(),
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("Expected OAuth authorization to fail with BotChallengeFailed");
    }
    expect(result.error).toBeInstanceOf(KnownErrors.BotChallengeFailed);
  });

  it("serializes bot challenge unavailability for credential signup requests", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const iface = createClientInterface();
    await iface.signUpWithCredential(
      "user@example.com",
      "password",
      undefined,
      createSession(),
      {
        phase: "visible",
      },
    );

    expect(getRequestBody(fetchMock)).toStrictEqual({
      email: "user@example.com",
      password: "password",
      bot_challenge_unavailable: "true",
    });
  });
});

describe("HexclaveClientInterface feature flags", () => {
  it("maps remote evaluation requests through the authenticated client route", async () => {
    const responseBody = {
      results: {
        checkout: {
          flag_key: "checkout",
          value: true,
          variant_key: "enabled",
          reason: "rule",
          rule_id: "rule-1",
          config_version: "v1",
          experiment_id: null,
          experiment_run_id: null,
          exposure_token: null,
        },
      },
    };
    const fetchMock = vi.fn(async () => createJsonResponse(responseBody));
    vi.stubGlobal("fetch", fetchMock);
    const iface = createClientInterface();

    const result = await iface.evaluateFeatureFlags<boolean>({
      flag_keys: ["checkout"],
      fallbacks: { checkout: false },
      context: { country: "US" },
    }, createSession());

    expect(result).toEqual(responseBody);
    expect(getRequestUrl(fetchMock)).toBe("https://api.example.com/api/v1/feature-flags/evaluate");
    expect(getRequestBody(fetchMock)).toEqual({
      flag_keys: ["checkout"],
      fallbacks: { checkout: false },
      context: { country: "US" },
    });
  });

  it("sends exposure batches through the authenticated client route", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ accepted: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const iface = createClientInterface();

    await iface.sendFeatureFlagExposureBatch({
      batch_id: "batch-1",
      exposures: [{ event_id: "event-1", exposure_token: "signed-token", exposed_at_ms: 123 }],
    }, createSession());

    expect(getRequestUrl(fetchMock)).toBe("https://api.example.com/api/v1/feature-flags/exposures/batch");
    expect(getRequestBody(fetchMock)).toEqual({
      batch_id: "batch-1",
      exposures: [{ event_id: "event-1", exposure_token: "signed-token", exposed_at_ms: 123 }],
    });
  });
});

describe("HexclaveServerInterface feature flag bootstrap", () => {
  it("treats a conditional 304 as a successful cache revalidation", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const ifNoneMatch = new Headers(init?.headers).get("if-none-match");
      if (ifNoneMatch === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      return createJsonResponse({ config: {}, flag_ids_by_key: {}, config_version: "v1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const iface = new HexclaveServerInterface({
      clientVersion: "test",
      getBaseUrl: () => "https://api.example.com",
      getApiUrls: () => ["https://api.example.com"],
      extraRequestHeaders: {},
      projectId: "project-id",
      secretServerKey: "secret-server-key",
    });

    expect(await iface.getFeatureFlagsBootstrap()).toEqual({
      status: "ok",
      data: { config: {}, flag_ids_by_key: {}, config_version: "v1" },
      etag: null,
    });
    expect(await iface.getFeatureFlagsBootstrap('"v1"')).toEqual({ status: "not-modified" });
  });
});

describe("_withFallback", () => {
  // ---------------------------------------------------------------------------
  // Helpers — reduce boilerplate across tests
  // ---------------------------------------------------------------------------

  /** Builds a list of N URL bases: ["https://url-0.test", "https://url-1.test", ...] */
  function urlList(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `https://url-${i}.test`);
  }

  /** Returns the index of the URL base that `fullUrl` starts with, or -1. */
  function urlIndex(urls: string[], fullUrl: string): number {
    return urls.findIndex(base => fullUrl.startsWith(base));
  }

  /** Records every fetch URL and calls `handler` to decide the outcome. */
  function mockFetch(handler: (url: string) => "ok" | "fail") {
    const log: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      log.push(url);
      if (handler(url) === "fail") throw new TypeError("Failed to fetch");
      return createJsonResponse({ display_name: "test" });
    }));
    return log;
  }

  function sendRequest(iface: HexclaveClientInterface) {
    const session = iface.createSession({ refreshToken: null, accessToken: null });
    return iface.sendClientRequest("/users/me", { method: "GET" }, session);
  }

  // ---------------------------------------------------------------------------
  // Single URL — no fallback
  // ---------------------------------------------------------------------------

  it("single URL uses standard 5-retry behavior", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new TypeError("Failed to fetch");
      return createJsonResponse({ display_name: "test" });
    }));

    const iface = createClientInterface({ apiUrls: urlList(1) });
    await sendRequest(iface);
    expect(attempts).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Ring walk — iterating through URLs in order
  // ---------------------------------------------------------------------------

  it("uses primary when it is healthy", async () => {
    const urls = urlList(3);
    const log = mockFetch(() => "ok");

    const iface = createClientInterface({ apiUrls: urls });
    await sendRequest(iface);

    expect(log.every(u => urlIndex(urls, u) === 0)).toBe(true);
  });

  it("tries URLs in order and succeeds on first working one", async () => {
    const urls = urlList(4);
    // url-0 and url-1 are down, url-2 is up
    const log = mockFetch((u) => urlIndex(urls, u) < 2 ? "fail" : "ok");

    const iface = createClientInterface({ apiUrls: urls });
    await sendRequest(iface);

    expect(urlIndex(urls, log[0])).toBe(0);
    expect(urlIndex(urls, log[1])).toBe(1);
    expect(urlIndex(urls, log[2])).toBe(2);
    expect(log.length).toBe(3);
  });

  it("does not fall back on KnownError", async () => {
    const urls = urlList(3);
    const log: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      log.push(input.toString());
      return createKnownErrorResponse(new KnownErrors.UserNotFound());
    }));

    const iface = createClientInterface({ apiUrls: urls });
    await expect(sendRequest(iface)).rejects.toThrow();
    expect(log.every(u => urlIndex(urls, u) === 0)).toBe(true);
  });

  it("sticks on the host that returned KnownError after an outage hop", async () => {
    const urls = urlList(3);
    const iface = createClientInterface({ apiUrls: urls });

    // url-0 down, url-1 returns KnownError → stick on url-1 even though the call "failed"
    const log1: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      log1.push(url);
      if (urlIndex(urls, url) === 0) throw new TypeError("Failed to fetch");
      return createKnownErrorResponse(new KnownErrors.UserNotFound());
    }));
    await expect(sendRequest(iface)).rejects.toThrow();
    expect(log1.map(u => urlIndex(urls, u))).toEqual([0, 1]);

    // Next request goes straight to url-1
    const log2 = mockFetch(() => "ok");
    await sendRequest(iface);
    expect(log2.length).toBe(1);
    expect(urlIndex(urls, log2[0])).toBe(1);
  });

  it("does not fall back on smart-wrapped 4xx responses", async () => {
    const urls = urlList(3);
    const log: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      log.push(input.toString());
      return createTextResponse("Payments are not set up", {
        status: 402,
        headers: { "x-hexclave-request-id": "req-123" },
      });
    }));

    const iface = createClientInterface({ apiUrls: urls });
    await expect(sendRequest(iface)).rejects.toMatchObject({ name: "Error" });
    expect(log.length).toBe(1);
    expect(urlIndex(urls, log[0])).toBe(0);
  });

  it("falls back on non-smart 4xx responses (no request-id)", async () => {
    const urls = urlList(3);
    const log: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      log.push(url);
      if (urlIndex(urls, url) === 0) {
        return createTextResponse("<html>Not Found</html>", {
          status: 404,
          headers: { "Content-Type": "text/html" },
        });
      }
      return createJsonResponse({ display_name: "test" });
    }));

    const iface = createClientInterface({ apiUrls: urls });
    await sendRequest(iface);
    expect(log.length).toBe(2);
    expect(urlIndex(urls, log[0])).toBe(0);
    expect(urlIndex(urls, log[1])).toBe(1);
  });

  it("wraps non-KnownError 4xx responses as normal errors", async () => {
    const response = createTextResponse("Payments are not set up", {
      status: 402,
      headers: { "x-hexclave-request-id": "req-123" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const iface = createClientInterface({ apiUrls: urlList(1) });
    await expect(sendRequest(iface)).rejects.toMatchObject({
      name: "Error",
      message: expect.stringContaining("402 Payments are not set up"),
      cause: response,
    });
  });

  it("does not retry non-KnownError 5xx responses on a single URL", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++;
      return createTextResponse("Server unavailable", { status: 503 });
    }));

    const iface = createClientInterface({ apiUrls: urlList(1) });
    await expect(sendRequest(iface)).rejects.toThrow("503 Server unavailable");
    expect(attempts).toBe(1);
  });

  it("falls back on non-KnownError 5xx responses even with request-id", async () => {
    const urls = urlList(3);
    const log: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      log.push(url);
      if (urlIndex(urls, url) === 0) {
        return createTextResponse("Server unavailable", {
          status: 503,
          headers: { "x-hexclave-request-id": "req-123" },
        });
      }
      return createJsonResponse({ display_name: "test" });
    }));

    const iface = createClientInterface({ apiUrls: urls });
    await sendRequest(iface);
    expect(log.length).toBe(2);
    expect(urlIndex(urls, log[0])).toBe(0);
    expect(urlIndex(urls, log[1])).toBe(1);
  });

  it("does not fall back on smart-wrapped 4xx refresh token responses", async () => {
    const urls = urlList(3);
    const log: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      log.push(url);
      return createTextResponse("Payments are not set up", {
        status: 402,
        headers: { "x-hexclave-request-id": "req-123" },
      });
    }));

    const iface = createClientInterface({ apiUrls: urls });
    await expect(iface.fetchNewAccessToken(new RefreshToken("refresh-token"))).rejects.toThrow("Payments are not set up");
    expect(log.length).toBe(1);
    expect(urlIndex(urls, log[0])).toBe(0);
  });

  it("makes 2 passes × N URLs attempts before throwing", async () => {
    for (const n of [2, 3, 5]) {
      const urls = urlList(n);
      const log = mockFetch(() => "fail");

      const iface = createClientInterface({ apiUrls: urls });
      await expect(sendRequest(iface)).rejects.toThrow();

      expect(log.length).toBe(2 * n);
      for (let i = 0; i < n; i++) {
        expect(log.filter(u => urlIndex(urls, u) === i).length).toBe(2);
      }
    }
  });

  it("reports the primary URL and attributes every fallback failure", async () => {
    const urls = urlList(3);
    const attemptsByUrl = new Map<string, number>();
    const log: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      log.push(url);
      const attempt = (attemptsByUrl.get(url) ?? 0) + 1;
      attemptsByUrl.set(url, attempt);
      throw new TypeError(`Failed to fetch ${url} on attempt ${attempt}`);
    }));

    const iface = createClientInterface({ apiUrls: urls });
    const request = sendRequest(iface);
    await expect(request).rejects.toMatchObject({
      name: "ApiUrlsFailedError",
      message: expect.stringContaining(`primary URL ${urls[0]}`),
    });

    try {
      await request;
      throw new Error("Expected all API URLs to fail");
    } catch (error) {
      if (!(error instanceof ApiUrlsFailedError)) throw new Error("Expected an aggregate API URL error");
      if (!(error.cause instanceof Error)) throw new Error("Expected the primary error as the aggregate cause");
      expect(error.cause.message).toContain(`${urls[0]}/api/v1/users/me on attempt 2`);
      expect(error.errors).toHaveLength(urls.length);
      expect(error.urlFailures).toHaveLength(urls.length);
      for (const [index, urlFailure] of error.urlFailures.entries()) {
        expect(urlFailure.url).toBe(`${urls[index]}/api/v1`);
        expect(urlFailure.error).toBe(error.errors[index]);
        expect(urlFailure.error.message).toContain(`${urls[index]}/api/v1/users/me on attempt 2`);
      }
    }
    expect(log).toHaveLength(urls.length * 2);
  });

  it("preserves framework error digests on the aggregate error", () => {
    const dynamicError = Object.assign(new Error("Dynamic server usage"), {
      digest: "DYNAMIC_SERVER_USAGE",
    });

    const error = new ApiUrlsFailedError([{
      url: "http://primary.test/api/v1",
      error: dynamicError,
    }]);

    expect(error.digest).toBe("DYNAMIC_SERVER_USAGE");
  });

  it("bypasses fallback when apiUrlOverride is provided", async () => {
    const log: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      log.push(input.toString());
      return createJsonResponse({ display_name: "test" });
    }));

    const iface = createClientInterface({ apiUrls: urlList(3) });
    const session = iface.createSession({ refreshToken: null, accessToken: null });
    await iface.sendClientRequest("/users/me", { method: "GET" }, session, "client", "https://override.test/api/v1");

    expect(log.every(u => u.startsWith("https://override.test"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Current target — stay on the working host until it fails
  // ---------------------------------------------------------------------------

  it("remembers the working URL: subsequent requests go straight there", async () => {
    const urls = urlList(4);
    const iface = createClientInterface({ apiUrls: urls });

    // url-0,1,2 down → current target becomes url-3
    mockFetch((u) => urlIndex(urls, u) === 3 ? "ok" : "fail");
    await sendRequest(iface);

    // Next request goes directly to url-3 (no primary probe)
    const log = mockFetch(() => "ok");
    await sendRequest(iface);

    expect(log.length).toBe(1);
    expect(urlIndex(urls, log[0])).toBe(3);
    expect(iface.getCurrentTargetApiUrl()).toBe(`${urls[3]}/api/v1`);
  });

  it("walks the ring from the current target when it fails", async () => {
    const urls = urlList(3);
    const iface = createClientInterface({ apiUrls: urls });

    // Fail over to url-1
    mockFetch((u) => urlIndex(urls, u) === 1 ? "ok" : "fail");
    await sendRequest(iface);

    // url-1 and url-2 down, url-0 up → circular order is 1, 2, 0 (not restart-from-0)
    const log = mockFetch((u) => urlIndex(urls, u) === 0 ? "ok" : "fail");
    await sendRequest(iface);

    expect(log.map(u => urlIndex(urls, u))).toEqual([1, 2, 0]);
    expect(iface.getCurrentTargetApiUrl()).toBe(`${urls[0]}/api/v1`);
  });

  it("re-targets the new working URL after a ring walk", async () => {
    const urls = urlList(4);
    const iface = createClientInterface({ apiUrls: urls });

    // current target → url-3
    mockFetch((u) => urlIndex(urls, u) === 3 ? "ok" : "fail");
    await sendRequest(iface);

    // url-3 dies, url-2 recovers → ring from 3: 3, 0, 1, 2
    mockFetch((u) => urlIndex(urls, u) === 2 ? "ok" : "fail");
    await sendRequest(iface);

    // Next request goes directly to url-2
    const log = mockFetch(() => "ok");
    await sendRequest(iface);

    expect(log.length).toBe(1);
    expect(urlIndex(urls, log[0])).toBe(2);
  });

  it("throws after 2 × N attempts starting from the current target", async () => {
    const urls = urlList(3);
    const iface = createClientInterface({ apiUrls: urls });

    // current target → url-1
    mockFetch((u) => urlIndex(urls, u) === 1 ? "ok" : "fail");
    await sendRequest(iface);

    // Everything is now down — 2 laps × 3 URLs = 6 (not sticky+iterate = 7)
    const log = mockFetch(() => "fail");
    await expect(sendRequest(iface)).rejects.toThrow();

    expect(log.length).toBe(6);
    expect(log.map(u => urlIndex(urls, u))).toEqual([1, 2, 0, 1, 2, 0]);
  });
});

/**
 * Live QA against localhost:8102 + :8110.
 *   LIVE_FALLBACK_QA=1 pnpm test run packages/shared/src/interface/client-interface.test.ts
 *
 * Start fallback backend first:
 *   BACKEND_PORT=8110 STACK_BACKEND_DEV_DISABLE_WATCH=true pnpm -C apps/backend exec dotenv -c development -- tsx src/server/server.ts
 */
describe.runIf(process.env.LIVE_FALLBACK_QA === "1")("live circular fallback QA", () => {
  const PRIMARY = "http://localhost:8102";
  const FALLBACK = "http://localhost:8110";
  const DEAD = "http://localhost:8098";
  const DEAD2 = "http://localhost:8097";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function health(url: string) {
    try {
      return (await fetch(`${url}/health`)).ok;
    } catch {
      return false;
    }
  }

  function origins(log: string[]) {
    return log.map((u) => new URL(u).origin);
  }

  it("requires both backends up", async () => {
    expect(await health(PRIMARY), "8102 should be up").toBe(true);
    expect(await health(FALLBACK), "8110 should be up").toBe(true);
  });

  it("fails over from dead primary to live fallback and sticks", async () => {
    const iface = createClientInterface({ apiUrls: [DEAD, FALLBACK] });
    const hits: string[] = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      hits.push(url);
      return await realFetch(input, init);
    });

    const session = iface.createSession({ refreshToken: null, accessToken: null });
    await iface.sendClientRequest("/users/me", { method: "GET" }, session).catch(() => null);
    expect(origins(hits)[0]).toBe(DEAD);
    expect(origins(hits)).toContain(FALLBACK);
    expect(iface.getCurrentTargetApiUrl()).toContain("8110");

    hits.length = 0;
    await iface.sendClientRequest("/users/me", { method: "GET" }, session).catch(() => null);
    expect(origins(hits)).toEqual([FALLBACK]);
  });

  it("when current fallback dies, rings back to primary", async () => {
    const iface = createClientInterface({ apiUrls: [PRIMARY, FALLBACK] });
    const realFetch = globalThis.fetch.bind(globalThis);
    const hits: string[] = [];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      hits.push(url);
      if (url.includes("8102")) throw new TypeError("Failed to fetch (simulated primary outage)");
      return await realFetch(input, init);
    });
    const session = iface.createSession({ refreshToken: null, accessToken: null });
    await iface.sendClientRequest("/users/me", { method: "GET" }, session).catch(() => null);
    expect(iface.getCurrentTargetApiUrl()).toContain("8110");

    hits.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      hits.push(url);
      if (url.includes("8110")) throw new TypeError("Failed to fetch (simulated fallback outage)");
      return await realFetch(input, init);
    });
    await iface.sendClientRequest("/users/me", { method: "GET" }, session).catch(() => null);

    expect(origins(hits)[0]).toBe(FALLBACK);
    expect(origins(hits)).toContain(PRIMARY);
    expect(iface.getCurrentTargetApiUrl()).toContain("8102");
  });

  it("both healthy → primary only", async () => {
    const iface = createClientInterface({ apiUrls: [PRIMARY, FALLBACK] });
    const hits: string[] = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      hits.push(url);
      return await realFetch(input, init);
    });
    const session = iface.createSession({ refreshToken: null, accessToken: null });
    await iface.sendClientRequest("/users/me", { method: "GET" }, session).catch(() => null);
    expect(origins(hits)).toEqual([PRIMARY]);
  });

  it("all down → ApiUrlsFailedError after 2×n attempts", async () => {
    const iface = createClientInterface({ apiUrls: [DEAD, DEAD2] });
    const hits: string[] = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      hits.push(String(input));
      return await realFetch(input, init);
    });
    const session = iface.createSession({ refreshToken: null, accessToken: null });
    await expect(iface.sendClientRequest("/users/me", { method: "GET" }, session)).rejects.toBeInstanceOf(ApiUrlsFailedError);
    expect(hits).toHaveLength(4);
  });
});

function getRequestInit(fetchMock: { mock: { calls: unknown[][] } }): RequestInit {
  const init = fetchMock.mock.calls[0]?.[1];
  if (init == null || typeof init !== "object") throw new Error("expected RequestInit");
  return init as RequestInit;
}

async function gunzipToText(body: unknown): Promise<string> {
  if (!(body instanceof Uint8Array)) throw new Error("expected Uint8Array body");
  const stream = new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

describe("sendAnalyticsEventBatch encoding", () => {
  function captureFetch() {
    const fetchMock = vi.fn(async () => createJsonResponse({ inserted: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("gzips body and sends application/octet-stream when keepalive is false", async () => {
    const fetchMock = captureFetch();
    const iface = createClientInterface();
    const payload = JSON.stringify({ batch_id: "abc", events: [{ event_type: "$click" }] });

    await iface.sendAnalyticsEventBatch(payload, null, { keepalive: false });

    const init = getRequestInit(fetchMock);
    const contentType = new Headers(init.headers).get("Content-Type");
    expect(contentType).toBe("application/octet-stream");
    expect(init.body).toBeInstanceOf(Uint8Array);
    await expect(gunzipToText(init.body)).resolves.toBe(payload);
  });

  it("falls back to plain JSON when keepalive is true (avoids racing pagehide tear-down)", async () => {
    const fetchMock = captureFetch();
    const iface = createClientInterface();
    const payload = JSON.stringify({ batch_id: "abc", events: [] });

    await iface.sendAnalyticsEventBatch(payload, null, { keepalive: true });

    const init = getRequestInit(fetchMock);
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(payload);
  });

  it("falls back to plain JSON when CompressionStream is unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const fetchMock = captureFetch();
    const iface = createClientInterface();
    const payload = JSON.stringify({ batch_id: "abc", events: [] });

    await iface.sendAnalyticsEventBatch(payload, null, { keepalive: false });

    const init = getRequestInit(fetchMock);
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(payload);
  });

  it("falls back to plain JSON when CompressionStream throws at runtime", async () => {
    class ThrowingCompressionStream {
      constructor() { throw new Error("compression unsupported"); }
    }
    vi.stubGlobal("CompressionStream", ThrowingCompressionStream);
    const fetchMock = captureFetch();
    const iface = createClientInterface();
    const payload = JSON.stringify({ batch_id: "abc", events: [] });

    await iface.sendAnalyticsEventBatch(payload, null, { keepalive: false });

    const init = getRequestInit(fetchMock);
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(payload);
  });
});

describe("sendSessionReplayBatch encoding", () => {
  function captureFetch() {
    const fetchMock = vi.fn(async () => createJsonResponse({ session_replay_id: "r", batch_id: "b", s3_key: "k", deduped: false }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("gzips body and sends application/octet-stream when keepalive is false", async () => {
    const fetchMock = captureFetch();
    const iface = createClientInterface();
    // A large, highly-compressible payload — the case the wire-limit drop used to lose.
    const payload = JSON.stringify({ batch_id: "abc", events: [{ type: 2, data: "x".repeat(1_000_000) }] });

    await iface.sendSessionReplayBatch(payload, null, { keepalive: false });

    const init = getRequestInit(fetchMock);
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/octet-stream");
    expect(init.body).toBeInstanceOf(Uint8Array);
    // The compressed body is far smaller than the 1MB+ raw payload.
    expect((init.body as Uint8Array).byteLength).toBeLessThan(100_000);
    await expect(gunzipToText(init.body)).resolves.toBe(payload);
  });

  it("falls back to plain JSON when keepalive is true (avoids racing pagehide tear-down)", async () => {
    const fetchMock = captureFetch();
    const iface = createClientInterface();
    const payload = JSON.stringify({ batch_id: "abc", events: [] });

    await iface.sendSessionReplayBatch(payload, null, { keepalive: true });

    const init = getRequestInit(fetchMock);
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(payload);
  });

  it("falls back to plain JSON when CompressionStream is unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const fetchMock = captureFetch();
    const iface = createClientInterface();
    const payload = JSON.stringify({ batch_id: "abc", events: [] });

    await iface.sendSessionReplayBatch(payload, null, { keepalive: false });

    const init = getRequestInit(fetchMock);
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(payload);
  });

  it("falls back to plain JSON when CompressionStream throws at runtime", async () => {
    class ThrowingCompressionStream {
      constructor() { throw new Error("compression unsupported"); }
    }
    vi.stubGlobal("CompressionStream", ThrowingCompressionStream);
    const fetchMock = captureFetch();
    const iface = createClientInterface();
    const payload = JSON.stringify({ batch_id: "abc", events: [] });

    await iface.sendSessionReplayBatch(payload, null, { keepalive: false });

    const init = getRequestInit(fetchMock);
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(payload);
  });
});

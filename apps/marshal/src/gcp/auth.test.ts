import { afterEach, describe, expect, it, vi } from "vitest";
import { googleAccessToken, recordHostIdentityAssertion, resetGoogleAuthCacheForTests } from "./auth.js";

afterEach(() => {
  resetGoogleAuthCacheForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AUDIENCE = "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/vercel/providers/vercel";

function stubFederationEnv(): void {
  vi.stubEnv("HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_AUDIENCE", AUDIENCE);
  vi.stubEnv("HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_SERVICE_ACCOUNT", "marshal-controller@platform.iam.gserviceaccount.com");
  // Both of these are read by the module, so an ambient value in the shell of whoever runs the
  // suite (anyone with a real Marshal environment sourced) would otherwise decide the outcome.
  vi.stubEnv("HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_TOKEN_ENV", "");
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
}

function stubExchange(expiresInMillis = 3600_000) {
  const expireTime = new Date(Date.now() + expiresInMillis).toISOString();
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.startsWith("https://sts.googleapis.com/")
    ? new Response(JSON.stringify({ access_token: "federated-token", expires_in: 3600 }), { status: 200 })
    : new Response(JSON.stringify({ accessToken: "impersonated-token", expireTime }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// An assertion the way the platform mints one: a JWT whose `aud` is this pool provider.
// recordHostIdentityAssertion only caches assertions that carry it, so an opaque string is no
// longer a usable stand-in — an unauthenticated caller could otherwise post one at /health and
// poison the credential every provider-backed route depends on.
function assertion(claims: Record<string, unknown> = {}): string {
  const payload = Buffer.from(JSON.stringify({ aud: AUDIENCE, ...claims }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

function request(headers: Record<string, string>): Request {
  return new Request("https://marshal.example.com/v1/namespaces/n", { headers });
}

describe("workload identity federation", () => {
  it("exchanges the host's OIDC assertion and impersonates the controller service account", async () => {
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", assertion({ sub: "build-time" }));
    const fetchMock = stubExchange();

    expect(await googleAccessToken()).toBe("impersonated-token");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [stsUrl, stsInit] = fetchMock.mock.calls[0];
    expect(stsUrl).toBe("https://sts.googleapis.com/v1/token");
    const exchange = new URLSearchParams(String(stsInit?.body));
    // The audience is the single most important value this module forwards: a wrong one is a
    // 400 from STS that no other assertion here would catch.
    expect(exchange.get("audience")).toBe(AUDIENCE);
    expect(exchange.get("subject_token")).toBe(assertion({ sub: "build-time" }));
    expect(exchange.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(exchange.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(exchange.get("scope")).toBe("https://www.googleapis.com/auth/cloud-platform");
    const [impersonationUrl, impersonationInit] = fetchMock.mock.calls[1];
    expect(impersonationUrl).toBe("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/marshal-controller%40platform.iam.gserviceaccount.com:generateAccessToken");
    expect((impersonationInit?.headers as Record<string, string>).authorization).toBe("Bearer federated-token");
  });

  it("takes the assertion from the request header, which is the only place a hosted function has one", async () => {
    // REGRESSION: reading only VERCEL_OIDC_TOKEN authenticates in local development and then
    // fails every call in production, where the platform injects the assertion as a header and
    // sets no such variable.
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const fetchMock = stubExchange();

    recordHostIdentityAssertion(request({ "x-vercel-oidc-token": assertion({ sub: "from-the-request" }) }));

    expect(await googleAccessToken()).toBe("impersonated-token");
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get("subject_token")).toBe(assertion({ sub: "from-the-request" }));
  });

  it("prefers the request header over the build-time environment variable", async () => {
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", assertion({ sub: "build-time" }));
    const fetchMock = stubExchange();

    recordHostIdentityAssertion(request({ "x-vercel-oidc-token": assertion({ sub: "invocation" }) }));
    await googleAccessToken();

    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get("subject_token")).toBe(assertion({ sub: "invocation" }));
  });

  it("keeps the last assertion when a request carries none, rather than clearing it", async () => {
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const fetchMock = stubExchange();

    recordHostIdentityAssertion(request({ "x-vercel-oidc-token": assertion({ sub: "invocation" }) }));
    recordHostIdentityAssertion(request({}));

    await expect(googleAccessToken()).resolves.toBe("impersonated-token");
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get("subject_token")).toBe(assertion({ sub: "invocation" }));
  });

  it("ignores an assertion that is not for this workload identity pool", async () => {
    // This header is read before authentication and on /health, so ANY Internet caller can set
    // it. It grants them nothing, but caching it over a working credential would let a loop of
    // junk requests deny every provider-backed route until a real assertion arrived.
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const fetchMock = stubExchange();

    recordHostIdentityAssertion(request({ "x-vercel-oidc-token": assertion({ sub: "real" }) }));
    recordHostIdentityAssertion(request({ "x-vercel-oidc-token": assertion({ aud: "//iam.googleapis.com/projects/9/attacker" }) }));
    recordHostIdentityAssertion(request({ "x-vercel-oidc-token": "not-even-a-jwt" }));

    await expect(googleAccessToken()).resolves.toBe("impersonated-token");
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get("subject_token")).toBe(assertion({ sub: "real" }));
  });

  it("reads the assertion from the env var the host is configured to use", async () => {
    stubFederationEnv();
    vi.stubEnv("HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_TOKEN_ENV", "SOME_OTHER_HOST_OIDC_TOKEN");
    vi.stubEnv("SOME_OTHER_HOST_OIDC_TOKEN", assertion({ sub: "other-host" }));
    const fetchMock = stubExchange();

    await googleAccessToken();

    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get("subject_token")).toBe(assertion({ sub: "other-host" }));
  });

  it("serves a still-valid token without a further exchange", async () => {
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", assertion({ sub: "build-time" }));
    const fetchMock = stubExchange();

    await googleAccessToken();
    await googleAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-reads the assertion on every refresh, because the host reinjects it per invocation", async () => {
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", "first-assertion");
    // Already expired, so the second call cannot be served from cache.
    const fetchMock = stubExchange(-1000);

    await googleAccessToken();
    vi.stubEnv("VERCEL_OIDC_TOKEN", "second-assertion");
    await googleAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2][0]).toBe("https://sts.googleapis.com/v1/token");
    expect(new URLSearchParams(String(fetchMock.mock.calls[2][1]?.body)).get("subject_token")).toBe("second-assertion");
  });

  it("takes precedence over an explicit credential file", async () => {
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", assertion({ sub: "build-time" }));
    // Reordering the chain would read this path and fail with ENOENT instead.
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent/service-account.json");
    const fetchMock = stubExchange();

    await expect(googleAccessToken()).resolves.toBe("impersonated-token");
    expect(fetchMock.mock.calls[0][0]).toBe("https://sts.googleapis.com/v1/token");
  });

  it("fails loudly when neither the header nor the environment carried an assertion", async () => {
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    await expect(googleAccessToken()).rejects.toThrow(/no OIDC assertion is available/);
  });

  it("refuses half-configured federation instead of falling through to the metadata server", async () => {
    vi.stubEnv("HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_AUDIENCE", AUDIENCE);
    vi.stubEnv("HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_SERVICE_ACCOUNT", "");
    await expect(googleAccessToken()).rejects.toThrow(/needs both/);

    vi.stubEnv("HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_AUDIENCE", "");
    vi.stubEnv("HEXCLAVE_MARSHAL_GCP_WORKLOAD_IDENTITY_SERVICE_ACCOUNT", "marshal-controller@platform.iam.gserviceaccount.com");
    await expect(googleAccessToken()).rejects.toThrow(/needs both/);
  });

  it("never serves a token whose expiry it could not parse", async () => {
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", assertion({ sub: "build-time" }));
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.startsWith("https://sts.googleapis.com/")
      ? new Response(JSON.stringify({ access_token: "federated-token" }), { status: 200 })
      : new Response(JSON.stringify({ accessToken: "impersonated-token", expireTime: "whenever" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(googleAccessToken()).rejects.toThrow(/unparseable expiry/);
    // Nothing was cached, so the next caller exchanges again rather than reusing a token whose
    // life is unknown.
    await expect(googleAccessToken()).rejects.toThrow(/unparseable expiry/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not report the STS response body, which can echo the assertion back", async () => {
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", assertion({ sub: "build-time" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", subject_token: "header.payload.signature" }), { status: 400 })));

    await expect(googleAccessToken()).rejects.toThrow(/^Google STS token exchange failed with HTTP 400$/);
  });

  it("does not report the impersonation response body, which can echo the federated token back", async () => {
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", assertion({ sub: "build-time" }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("https://sts.googleapis.com/")
      ? new Response(JSON.stringify({ access_token: "federated-token" }), { status: 200 })
      : new Response(JSON.stringify({ error: { message: "denied for federated-token" } }), { status: 403 })));

    await expect(googleAccessToken()).rejects.toThrow(/^Google service account impersonation failed with HTTP 403$/);
  });

  it("reports a status rather than a parse error when a proxy returns a non-JSON page", async () => {
    stubFederationEnv();
    vi.stubEnv("VERCEL_OIDC_TOKEN", assertion({ sub: "build-time" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })));

    await expect(googleAccessToken()).rejects.toThrow(/^Google STS token exchange failed with HTTP 502$/);
  });
});

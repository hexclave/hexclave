import { describe, expect, it, vi } from "vitest";
import { AccessToken } from "@hexclave/shared/dist/sessions";
import { HexclaveSetupError } from "@hexclave/shared/dist/utils/errors";
import { Store } from "@hexclave/shared/dist/utils/stores";
import { hexclaveAppInternalsSymbol } from "../../common";
import { StackClientApp } from "../interfaces/client-app";
import { planRedirectToHandler } from "./redirect-page-urls";

// Every app in this file is constructed with `devTool: false`. The tests install a mock window and document, which makes
// the SDK believe it is in a browser; mounting the dev tool would then start background requests against a backend that
// does not exist here and leak that work across test cases.
function createAccessTokenString(refreshTokenId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const nowSeconds = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      sub: "user-id",
      exp: nowSeconds + 60,
      iat: nowSeconds,
      iss: "https://api.example.test",
      aud: "project-id",
      project_id: "project-id",
      branch_id: "main",
      refresh_token_id: refreshTokenId,
      role: "authenticated",
      name: null,
      email: null,
      email_verified: false,
      selected_team_id: null,
      signed_up_at: nowSeconds,
      is_anonymous: false,
      is_restricted: false,
      restricted_reason: null,
      requires_totp_mfa: false,
    }),
    "",
  ].join(".");
}

function createMockDocument(): Document {
  const cookieJar = new Map<string, string>();
  return {
    get cookie() {
      return [...cookieJar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
    },
    set cookie(str: string) {
      const [nameValue] = str.split(";");
      const eqIndex = nameValue.indexOf("=");
      if (eqIndex < 0) return;
      cookieJar.set(nameValue.slice(0, eqIndex).trim(), nameValue.slice(eqIndex + 1).trim());
    },
    createElement: () => ({}),
  } as any;
}

/**
 * Installs a stand-in for `window` with only the parts the code under test touches. `globalThis.window` is typed as a
 * full `Window`, which a hand-written stub can never be, so the assignment goes through `Reflect.set` — the stub's own
 * shape stays checked, unlike with a cast on the object literal.
 */
function setMockWindow(mockWindow: {
  location: { href: string, replace?: (url: string) => void },
}): void {
  Reflect.set(globalThis, "window", mockWindow);
}

/**
 * Calls one of the app's `protected` methods, which are part of the flows under test but not of the public SDK surface.
 */
function callProtectedMethod(app: StackClientApp<true>, methodName: string, ...args: unknown[]): Promise<unknown> {
  const method = app[methodName];
  if (typeof method !== "function") {
    throw new Error(`Expected StackClientApp to have a ${methodName} method in tests.`);
  }
  return method.apply(app, args);
}

describe("StackClientApp cross-domain auth", () => {
  it("keeps noRedirectBack same-domain redirects free of redirect-back state", async () => {
    const redirectPlan = await planRedirectToHandler({
      handlerName: "signIn",
      rawHandlerUrl: "/handler/sign-in",
      noRedirectBack: true,
      currentUrl: new URL("https://app.example.test/settings?tab=profile"),
      getLocalOAuthCallbackUrl: () => "/handler/oauth-callback",
      rawAfterSignInUrl: "/home",
      getCrossDomainHandoffParams: async () => {
        throw new Error("Same-domain redirects must not create cross-domain handoff parameters.");
      },
    });

    expect(redirectPlan).toEqual({
      type: "redirect",
      url: "/handler/sign-in",
    });
  });

  it("returns noRedirectBack cross-domain auth to the configured after-sign-in page", async () => {
    const handoffState = "no-redirect-back-state";
    const handoffCodeChallenge = "abcdefghijklmnopqrstuvwxyzABCDEFG_0123456789-._~";
    const currentUrl = new URL("https://app.example.test/settings?tab=profile");
    currentUrl.searchParams.set("hexclave_cross_domain_state", handoffState);
    currentUrl.searchParams.set("hexclave_cross_domain_code_challenge", handoffCodeChallenge);
    currentUrl.searchParams.set(
      "hexclave_cross_domain_after_callback_redirect_url",
      "https://app.example.test/settings?tab=profile",
    );

    const redirectPlan = await planRedirectToHandler({
      handlerName: "signIn",
      rawHandlerUrl: "https://auth.example.test/handler/sign-in",
      noRedirectBack: true,
      currentUrl,
      getLocalOAuthCallbackUrl: () => "/handler/oauth-callback",
      rawAfterSignInUrl: "/home",
      getCrossDomainHandoffParams: async () => {
        throw new Error("Existing cross-domain handoff parameters must be reused.");
      },
    });

    expect(redirectPlan.type).toBe("redirect");
    if (redirectPlan.type !== "redirect") {
      throw new Error("Expected noRedirectBack sign-in to produce a redirect URL.");
    }

    const hostedUrl = new URL(redirectPlan.url);
    expect(hostedUrl.origin).toBe("https://auth.example.test");
    expect(hostedUrl.pathname).toBe("/handler/sign-in");
    expect(hostedUrl.searchParams.get("hexclave_cross_domain_after_callback_redirect_url")).toBe(
      "https://app.example.test/home",
    );

    const rawSourceCallbackUrl = hostedUrl.searchParams.get("after_auth_return_to");
    if (rawSourceCallbackUrl == null) {
      throw new Error("Expected cross-domain noRedirectBack to include its internal source callback URL.");
    }
    const sourceCallbackUrl = new URL(rawSourceCallbackUrl);
    expect(sourceCallbackUrl.origin).toBe("https://app.example.test");
    expect(sourceCallbackUrl.pathname).toBe("/handler/oauth-callback");
    expect(sourceCallbackUrl.searchParams.get("hexclave_cross_domain_auth")).toBe("1");
    expect(sourceCallbackUrl.searchParams.get("hexclave_cross_domain_state")).toBe(handoffState);
    expect(sourceCallbackUrl.searchParams.get("hexclave_cross_domain_code_challenge")).toBe(handoffCodeChallenge);
    expect(sourceCallbackUrl.searchParams.get("hexclave_cross_domain_after_callback_redirect_url")).toBe(
      "https://app.example.test/home",
    );
    expect(sourceCallbackUrl.toString()).not.toContain("/settings");
  });

  it.each(["signUp", "onboarding"] as const)(
    "keeps the source callback when hosted %s uses noRedirectBack",
    async (handlerName) => {
      const currentUrl = new URL("https://app.example.test/settings?tab=profile");
      const redirectPlan = await planRedirectToHandler({
        handlerName,
        rawHandlerUrl: `https://auth.example.test/handler/${handlerName === "signUp" ? "sign-up" : "onboarding"}`,
        noRedirectBack: true,
        currentUrl,
        getLocalOAuthCallbackUrl: () => "/handler/oauth-callback",
        rawAfterSignInUrl: "/signed-in",
        getCrossDomainHandoffParams: async () => ({
          state: "no-redirect-back-state",
          codeChallenge: "no-redirect-back-code-challenge",
        }),
      });

      expect(redirectPlan.type).toBe("redirect");
      if (redirectPlan.type !== "redirect") {
        throw new Error("Expected a direct hosted redirect plan.");
      }
      const hostedUrl = new URL(redirectPlan.url);
      expect(hostedUrl.searchParams.get("hexclave_cross_domain_after_callback_redirect_url")).toBe(
        "https://app.example.test/signed-in",
      );
      expect(hostedUrl.searchParams.get("after_auth_return_to")).not.toBeNull();
    },
  );

  it("exposes redirect-back-aware handler URLs for devtool previews", async () => {
    const previousWindow = globalThis["window"];
    const hadPreviousWindow = Reflect.has(globalThis, "window");
    Reflect.set(globalThis, "window", {
      location: {
        href: "http://localhost/music?track=1#song",
      },
    });

    try {
      const clientApp = new StackClientApp({
        baseUrl: "http://localhost:12345",
        projectId: "00000000-0000-4000-8000-000000000000",
        publishableClientKey: "stack-pk-test",
        tokenStore: "memory",
        redirectMethod: "none",
        urls: {
          signIn: "/handler/sign-in",
        },
        noAutomaticPrefetch: true,
        devTool: false,
      });

      const redirectUrl = await clientApp[hexclaveAppInternalsSymbol].getRedirectToHandlerUrl("signIn");

      const resolved = new URL(redirectUrl, "http://localhost");
      expect(resolved.pathname).toBe("/handler/sign-in");
      expect(resolved.searchParams.get("after_auth_return_to")).toBe("/music?track=1#song");
    } finally {
      if (hadPreviousWindow) {
        Reflect.set(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("rejects hosted sign-in redirects that cannot set the cross-domain verifier cookie", async () => {
    const previousWindow = globalThis["window"];
    const hadPreviousWindow = Reflect.has(globalThis, "window");
    Reflect.deleteProperty(globalThis, "window");

    try {
      const clientApp = new StackClientApp({
        baseUrl: "http://localhost:12345",
        projectId: "00000000-0000-4000-8000-000000000000",
        publishableClientKey: "stack-pk-test",
        tokenStore: "memory",
        redirectMethod: "none",
        urls: {
          default: { type: "hosted" },
        },
        noAutomaticPrefetch: true,
        devTool: false,
      });

      await expect(
        clientApp[hexclaveAppInternalsSymbol].getRedirectToHandlerUrl("signIn"),
      ).rejects.toThrowError(/Cannot redirect to the cross-origin signIn page from a server-rendered context/);
    } finally {
      if (hadPreviousWindow) {
        Reflect.set(globalThis, "window", previousWindow);
      }
    }
  });

  it("rejects custom cross-origin sign-in redirects on the server too", async () => {
    const previousWindow = globalThis["window"];
    const hadPreviousWindow = Reflect.has(globalThis, "window");
    Reflect.deleteProperty(globalThis, "window");

    try {
      const clientApp = new StackClientApp({
        baseUrl: "http://localhost:12345",
        projectId: "00000000-0000-4000-8000-000000000000",
        publishableClientKey: "stack-pk-test",
        tokenStore: "memory",
        redirectMethod: "none",
        urls: {
          signIn: "https://auth.example.test/sign-in",
        },
        noAutomaticPrefetch: true,
        devTool: false,
      });

      await expect(
        clientApp[hexclaveAppInternalsSymbol].getRedirectToHandlerUrl("signIn"),
      ).rejects.toThrowError(/Cannot redirect to the cross-origin signIn page from a server-rendered context/);
    } finally {
      if (hadPreviousWindow) {
        Reflect.set(globalThis, "window", previousWindow);
      }
    }
  });

  it("uses the fresh post-auth refresh token when minting a cross-domain handoff", async () => {
    const freshAccessToken = createAccessTokenString("fresh-refresh-token-id");
    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId: "00000000-0000-4000-8000-000000000000",
      publishableClientKey: "stack-pk-test",
      tokenStore: {
        accessToken: createAccessTokenString("stale-refresh-token-id"),
        refreshToken: "stale-refresh-token",
      },
      redirectMethod: "none",
      noAutomaticPrefetch: true,
      devTool: false,
    });

    const clientInterface = clientApp["_interface"];
    const originalSendClientRequest = clientInterface["sendClientRequest"];
    const originalFetchNewAccessToken = clientInterface["fetchNewAccessToken"];
    const capturedRefreshTokens: string[] = [];
    const capturedAccessTokenRefreshTokenIds: string[] = [];
    const refreshedRawRefreshTokens: string[] = [];

    Reflect.set(clientInterface, "sendClientRequest", async (_path: unknown, _requestOptions: unknown, session: unknown) => {
      const getRefreshToken = session ?? {}["getRefreshToken"];
      const getOrFetchLikelyValidTokens = session ?? {}["getOrFetchLikelyValidTokens"];
      if (typeof getRefreshToken !== "function") {
        throw new Error("Expected cross-domain auth to pass a session to the client interface.");
      }
      if (typeof getOrFetchLikelyValidTokens !== "function") {
        throw new Error("Expected cross-domain auth to pass a session with token accessors.");
      }
      const refreshToken = getRefreshToken.call(session);
      const refreshTokenString = refreshToken ?? {}["token"];
      if (typeof refreshTokenString !== "string") {
        throw new Error("Expected cross-domain auth to pass a refresh-token-backed session.");
      }
      capturedRefreshTokens.push(refreshTokenString);
      const tokens = await getOrFetchLikelyValidTokens.call(session, 0, null);
      capturedAccessTokenRefreshTokenIds.push(tokens.accessToken.payload.refresh_token_id);
      return {
        ok: true,
        json: async () => ({ redirect_url: "https://example.com/handler/oauth-callback?code=handoff-code&state=handoff-state" }),
      };
    });
    Reflect.set(clientInterface, "fetchNewAccessToken", async (refreshToken: unknown) => {
      const refreshTokenString = refreshToken ?? {}["token"];
      if (typeof refreshTokenString !== "string") {
        throw new Error("Expected refresh token while fetching a new access token.");
      }
      refreshedRawRefreshTokens.push(refreshTokenString);
      return AccessToken.createIfValid(freshAccessToken) ?? (() => {
        throw new Error("Expected test access token to be valid");
      })();
    });

    try {
      const createCrossDomainAuthRedirectUrl = clientApp["_createCrossDomainAuthRedirectUrl"];
      if (typeof createCrossDomainAuthRedirectUrl !== "function") {
        throw new Error("Expected StackClientApp to expose _createCrossDomainAuthRedirectUrl in tests.");
      }

      await expect(createCrossDomainAuthRedirectUrl.call(clientApp, {
        redirectUri: "https://example.com/handler/oauth-callback",
        state: "handoff-state",
        codeChallenge: "abcdefghijklmnopqrstuvwxyzABCDEFG_0123456789-._~",
        afterCallbackRedirectUrl: "https://example.com/account-settings",
        overrideTokenStoreInit: {
          accessToken: createAccessTokenString("fresh-stale-refresh-token-id"),
          refreshToken: "fresh-refresh-token",
        },
      })).resolves.toBe("https://example.com/handler/oauth-callback?code=handoff-code&state=handoff-state");
    } finally {
      Reflect.set(clientInterface, "sendClientRequest", originalSendClientRequest);
      Reflect.set(clientInterface, "fetchNewAccessToken", originalFetchNewAccessToken);
    }

    expect(refreshedRawRefreshTokens).toEqual(["fresh-refresh-token"]);
    expect(capturedRefreshTokens).toEqual(["fresh-refresh-token"]);
    expect(capturedAccessTokenRefreshTokenIds).toEqual(["fresh-refresh-token-id"]);
  });

  it("uses a fresh nested OAuth state while preserving the outer cross-domain return state", async () => {
    const projectId = "00000000-0000-4000-8000-000000000002";
    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId,
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "window",
      urls: {
        default: { type: "hosted" },
      },
      noAutomaticPrefetch: true,
      devTool: false,
    });
    const outerState = "outer-cross-domain-state";
    const outerCodeChallenge = "abcdefghijklmnopqrstuvwxyzABCDEFG_0123456789-._~";
    const currentUrl = new URL(`https://${projectId}.example-stack-hosted.test/handler/sign-in`);
    currentUrl.searchParams.set("after_auth_return_to", `https://demo.stack-auth.com/?hexclave_cross_domain_auth=1&hexclave_cross_domain_state=${outerState}`);
    currentUrl.searchParams.set("hexclave_cross_domain_state", outerState);
    currentUrl.searchParams.set("hexclave_cross_domain_code_challenge", outerCodeChallenge);
    currentUrl.searchParams.set("hexclave_cross_domain_after_callback_redirect_url", "https://demo.stack-auth.com/");
    currentUrl.searchParams.set("stack_nested_cross_domain_auth_refresh_token_id", "source-session");
    currentUrl.searchParams.set("stack_nested_cross_domain_auth_callback_url", "https://demo.stack-auth.com/");

    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    let redirectedUrl = "";
    vi.spyOn(clientApp as any, "_fetchCurrentRefreshTokenIdIfSignedIn").mockResolvedValue(null);
    vi.spyOn(clientApp as any, "_getCrossDomainHandoffParamsForRedirect").mockResolvedValue({
      state: "fresh-nested-state",
      codeChallenge: "fresh-nested-code-challenge",
    });
    vi.spyOn(clientApp as any, "_isTrusted").mockResolvedValue(true);

    globalThis.document = createMockDocument();
    globalThis.window = {
      location: {
        href: currentUrl.toString(),
        replace: (url: string) => {
          redirectedUrl = url;
          throw new Error("INTENTIONAL_TEST_ABORT");
        },
      },
    } as any;

    try {
      await expect((clientApp as any)._maybeHandleNestedCrossDomainAuth()).rejects.toThrowError("INTENTIONAL_TEST_ABORT");
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }

    const redirectUrl = new URL(redirectedUrl);
    expect(redirectUrl.searchParams.get("state")).toBe("fresh-nested-state");
    expect(redirectUrl.searchParams.get("code_challenge")).toBe("fresh-nested-code-challenge");
    const redirectUri = new URL(redirectUrl.searchParams.get("redirect_uri") ?? "");
    expect(redirectUri.searchParams.get("hexclave_cross_domain_state")).toBe(outerState);
    expect(redirectUri.searchParams.get("hexclave_cross_domain_code_challenge")).toBe(outerCodeChallenge);
    expect(redirectUri.searchParams.get("hexclave_cross_domain_after_callback_redirect_url")).toBe("https://demo.stack-auth.com/");
  });

  it("clears a stale target-domain session before deferring to the source-domain session", async () => {
    const projectId = "00000000-0000-4000-8000-000000000006";
    const hostedAccessToken = createAccessTokenString("hosted-old-refresh-token-id");
    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId,
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "window",
      urls: {
        default: { type: "hosted" },
      },
      noAutomaticPrefetch: true,
      devTool: false,
    });
    const tokenStore = clientApp["_memoryTokenStore"];
    if (!(tokenStore instanceof Store)) {
      throw new Error("Expected StackClientApp to use a memory token store in this test.");
    }
    tokenStore.set({
      refreshToken: "hosted-old-refresh-token",
      accessToken: hostedAccessToken,
    });

    const currentUrl = new URL(`https://${projectId}.example-stack-hosted.test/handler/sign-in`);
    currentUrl.searchParams.set("stack_nested_cross_domain_auth_refresh_token_id", "source-anonymous-refresh-token-id");
    currentUrl.searchParams.set("stack_nested_cross_domain_auth_callback_url", "https://demo.stack-auth.com/handler/oauth-callback");
    currentUrl.searchParams.set("hexclave_cross_domain_state", "outer-state");
    currentUrl.searchParams.set("hexclave_cross_domain_code_challenge", "outer-code-challenge");
    currentUrl.searchParams.set("hexclave_cross_domain_after_callback_redirect_url", "https://demo.stack-auth.com/app");

    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    let redirectedUrl = "";
    const clientInterface = clientApp["_interface"];
    const originalFetchNewAccessToken = clientInterface["fetchNewAccessToken"];
    Reflect.set(clientInterface, "fetchNewAccessToken", async () => {
      return AccessToken.createIfValid(hostedAccessToken) ?? (() => {
        throw new Error("Expected test access token to be valid");
      })();
    });
    vi.spyOn(clientApp as any, "_isTrusted").mockResolvedValue(true);

    globalThis.document = createMockDocument();
    globalThis.window = {
      location: {
        href: currentUrl.toString(),
        replace: (url: string) => {
          redirectedUrl = url;
          throw new Error("INTENTIONAL_TEST_ABORT");
        },
      },
    } as any;

    try {
      await expect((clientApp as any)._maybeHandleNestedCrossDomainAuth()).rejects.toThrowError("INTENTIONAL_TEST_ABORT");
    } finally {
      Reflect.set(clientInterface, "fetchNewAccessToken", originalFetchNewAccessToken);
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }

    expect(tokenStore.get()).toEqual({
      refreshToken: null,
      accessToken: null,
    });
    expect(new URL(redirectedUrl).origin).toBe("https://demo.stack-auth.com");
  });

  it("uses the latest browser refresh cookie before computing nested cross-domain session IDs", async () => {
    const projectId = "00000000-0000-4000-8000-000000000007";
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;

    globalThis.document = createMockDocument();
    globalThis.window = {
      location: {
        href: "https://demo.stack-auth.com/",
        protocol: "https:",
        hostname: "demo.stack-auth.com",
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as any;

    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId,
      publishableClientKey: "stack-pk-test",
      tokenStore: "cookie",
      redirectMethod: "none",
      noAutomaticPrefetch: true,
      devTool: false,
    });
    const clientInterface = clientApp["_interface"];
    const originalFetchNewAccessToken = clientInterface["fetchNewAccessToken"];
    const refreshedRawRefreshTokens: string[] = [];

    // Cookie-store writes queue a background trusted-parent-domain lookup. Without this stub, that
    // lookup fetches the (unreachable) baseUrl with retries while holding the global store lock,
    // which starves any later test that needs the write lock (e.g. signOut). Not restored on
    // purpose: queued tasks can still run after this test body finishes.
    vi.spyOn(clientApp as any, "_getTrustedParentDomain").mockResolvedValue(null);

    try {
      const getBrowserCookieTokenStore = clientApp["_getBrowserCookieTokenStore"];
      if (typeof getBrowserCookieTokenStore !== "function") {
        throw new Error("Expected StackClientApp to expose _getBrowserCookieTokenStore in tests.");
      }
      const tokenStore = getBrowserCookieTokenStore.call(clientApp);
      tokenStore.set({
        refreshToken: "old-refresh-token",
        accessToken: createAccessTokenString("old-refresh-token-id"),
      });

      document.cookie = `__Host-hexclave-refresh-${projectId}--default=${JSON.stringify({
        refresh_token: "new-refresh-token",
        updated_at_millis: 1,
      })}`;
      Reflect.set(clientInterface, "fetchNewAccessToken", async (refreshToken: unknown) => {
        const refreshTokenString = refreshToken ?? {}["token"];
        if (typeof refreshTokenString !== "string") {
          throw new Error("Expected refresh token while fetching a new access token.");
        }
        refreshedRawRefreshTokens.push(refreshTokenString);
        return AccessToken.createIfValid(createAccessTokenString("new-refresh-token-id")) ?? (() => {
          throw new Error("Expected test access token to be valid");
        })();
      });

      const fetchCurrentRefreshTokenIdIfSignedIn = clientApp["_fetchCurrentRefreshTokenIdIfSignedIn"];
      if (typeof fetchCurrentRefreshTokenIdIfSignedIn !== "function") {
        throw new Error("Expected StackClientApp to expose _fetchCurrentRefreshTokenIdIfSignedIn in tests.");
      }
      await expect(fetchCurrentRefreshTokenIdIfSignedIn.call(clientApp, {
        awaitPendingAuthResolutions: false,
      })).resolves.toBe("new-refresh-token-id");
    } finally {
      Reflect.set(clientInterface, "fetchNewAccessToken", originalFetchNewAccessToken);
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }

    expect(refreshedRawRefreshTokens).toEqual(["new-refresh-token"]);
  });

  it("stops polling the browser cookie store when browser globals are removed", () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;

    globalThis.document = createMockDocument();
    globalThis.window = {
      location: {
        href: "https://demo.stack-auth.com/",
        protocol: "https:",
        hostname: "demo.stack-auth.com",
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as any;

    try {
      const clientApp = new StackClientApp({
        baseUrl: "http://localhost:12345",
        projectId: "00000000-0000-4000-8000-000000000007",
        publishableClientKey: "stack-pk-test",
        tokenStore: "cookie",
        redirectMethod: "none",
        noAutomaticPrefetch: true,
        automaticSideEffects: false,
        devTool: false,
      });
      const getBrowserCookieTokenStore = clientApp["_getBrowserCookieTokenStore"];
      if (typeof getBrowserCookieTokenStore !== "function") {
        throw new Error("Expected StackClientApp to expose _getBrowserCookieTokenStore in tests.");
      }
      getBrowserCookieTokenStore.call(clientApp);

      Reflect.set(globalThis, "window", previousWindow);
      Reflect.set(globalThis, "document", previousDocument);

      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
    } finally {
      Reflect.set(globalThis, "window", previousWindow);
      Reflect.set(globalThis, "document", previousDocument);
      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not re-bounce nested cross-domain auth after the OAuth callback consumed code+state from the URL", async () => {
    const projectId = "00000000-0000-4000-8000-000000000008";
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;

    const strippedUrl = new URL(`https://${projectId}.example-stack-hosted.test/handler/sign-in`);
    strippedUrl.searchParams.set("stack_nested_cross_domain_auth_refresh_token_id", "source-refresh-token-id");
    strippedUrl.searchParams.set("stack_nested_cross_domain_auth_callback_url", "https://demo.stack-auth.com/");
    const urlAtConstructionTime = new URL(strippedUrl);
    urlAtConstructionTime.searchParams.set("code", "one-time-code");
    urlAtConstructionTime.searchParams.set("state", "nested-oauth-state");

    // Construct before installing the window mock so the constructor does not schedule its own
    // nested-auth resolution; the assertions below drive the handler explicitly.
    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId,
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "window",
      noAutomaticPrefetch: true,
      devTool: false,
    });

    globalThis.document = createMockDocument();
    globalThis.window = {
      location: {
        href: strippedUrl.toString(),
        replace: () => {
          throw new Error("INTENTIONAL_TEST_ABORT");
        },
      },
    } as any;

    vi.spyOn(clientApp as any, "_fetchCurrentRefreshTokenIdIfSignedIn").mockResolvedValue(null);
    vi.spyOn(clientApp as any, "_getCrossDomainHandoffParamsForRedirect").mockResolvedValue({
      state: "fresh-nested-state",
      codeChallenge: "fresh-nested-code-challenge",
    });
    vi.spyOn(clientApp as any, "_isTrusted").mockResolvedValue(true);

    try {
      // Without the construction-time URL, the handler re-bounces (location.replace aborts).
      await expect((clientApp as any)._maybeHandleNestedCrossDomainAuth()).rejects.toThrowError("INTENTIONAL_TEST_ABORT");
      // With it, the in-flight OAuth callback wins and the handler stands down.
      await expect((clientApp as any)._maybeHandleNestedCrossDomainAuth(urlAtConstructionTime)).resolves.toBe(false);
      // The live-URL guard must also stand down on its own when code+state are still present.
      (globalThis.window as any).location.href = urlAtConstructionTime.toString();
      await expect((clientApp as any)._maybeHandleNestedCrossDomainAuth()).resolves.toBe(false);
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }
  });

  it("reports malformed nested cross-domain auth URLs as setup errors", async () => {
    const projectId = "00000000-0000-4000-8000-000000000012";
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.document = createMockDocument();

    // A URL the flow cannot even parse is as fatal as an untrusted one, so it has to reach the developer the same way
    // instead of escaping as a bare TypeError from `new URL()`, which the overlay only shows during development.
    // The two branches of the handler want opposite session states: on the provider side (a.com) a query-derived failure
    // only becomes a setup error when the handoff belongs to the current session, while the requesting side (b.com) only
    // bounces when the current session is *not* the one that was asked for.
    const malformedCases = [
      {
        description: "redirect URI",
        currentRefreshTokenId: "source-refresh-token-id",
        params: { redirect_uri: "not-a-url", state: "nested-state", code_challenge: "nested-code-challenge" },
      },
      {
        description: "after-callback redirect URL",
        currentRefreshTokenId: "source-refresh-token-id",
        params: {
          redirect_uri: "https://source.example.test/handler/account-settings",
          state: "nested-state",
          code_challenge: "nested-code-challenge",
          after_callback_redirect_url: "http://[",
        },
      },
      {
        description: "callback URL",
        currentRefreshTokenId: null,
        params: { stack_nested_cross_domain_auth_callback_url: "http://[" },
      },
    ];

    try {
      for (const malformedCase of malformedCases) {
        const currentUrl = new URL("https://target.example.test/nested-provider");
        currentUrl.searchParams.set("stack_nested_cross_domain_auth_refresh_token_id", "source-refresh-token-id");
        for (const [key, value] of Object.entries(malformedCase.params)) {
          currentUrl.searchParams.set(key, value);
        }
        // Each app is constructed with the mock window uninstalled: the constructor's automatic side effects expect a
        // real window, and a construction-time nested-auth URL would also schedule a second, unawaited run of the
        // handler that keeps failing in the background and leaks into whichever test runs next.
        globalThis.window = previousWindow;
        const clientApp = new StackClientApp({
          baseUrl: "http://localhost:12345",
          projectId,
          publishableClientKey: "stack-pk-test",
          tokenStore: "memory",
          redirectMethod: "window",
          noAutomaticPrefetch: true,
          devTool: false,
        });
        setMockWindow({ location: { href: currentUrl.toString() } });
        Reflect.set(clientApp, "_fetchCurrentRefreshTokenIdIfSignedIn", async () => malformedCase.currentRefreshTokenId);
        Reflect.set(clientApp, "_isTrusted", async () => true);

        const nestedAuthPromise = callProtectedMethod(clientApp, "_maybeHandleNestedCrossDomainAuth");
        await expect(nestedAuthPromise).rejects.toThrowError(new RegExp(`${malformedCase.description} .* is not a valid absolute URL`));
        await expect(nestedAuthPromise).rejects.toSatisfy((error: unknown) => HexclaveSetupError.isSetupError(error));
      }
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }
  });

  it("keeps nested cross-domain auth failures off the page for a handoff that does not own the session", async () => {
    const projectId = "00000000-0000-4000-8000-000000000013";
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.document = createMockDocument();

    // Setup errors are shown in production, so a link anybody can craft must not be able to put a card on a healthy
    // app's page: with a refresh-token ID that is not the current session's, every failure below stays an ordinary error
    // that only captureError sees, even though the same URL from the right session would render a card.
    const craftedRedirectUris = [
      "https://evil.example.test/handler/account-settings", // untrusted
      "not-a-url", // malformed
    ];

    try {
      for (const craftedRedirectUri of craftedRedirectUris) {
        const currentUrl = new URL("https://target.example.test/nested-provider");
        currentUrl.searchParams.set("stack_nested_cross_domain_auth_refresh_token_id", "attacker-chosen-refresh-token-id");
        currentUrl.searchParams.set("redirect_uri", craftedRedirectUri);
        currentUrl.searchParams.set("state", "nested-state");
        currentUrl.searchParams.set("code_challenge", "nested-code-challenge");

        globalThis.window = previousWindow;
        const clientApp = new StackClientApp({
          baseUrl: "http://localhost:12345",
          projectId,
          publishableClientKey: "stack-pk-test",
          tokenStore: "memory",
          redirectMethod: "window",
          noAutomaticPrefetch: true,
          devTool: false,
        });
        setMockWindow({ location: { href: currentUrl.toString() } });
        Reflect.set(clientApp, "_fetchCurrentRefreshTokenIdIfSignedIn", async () => "this-apps-refresh-token-id");
        Reflect.set(clientApp, "_isTrusted", async () => false);

        const nestedAuthPromise = callProtectedMethod(clientApp, "_maybeHandleNestedCrossDomainAuth");
        await expect(nestedAuthPromise).rejects.toThrowError(/does not match the requested refresh token ID/);
        await expect(nestedAuthPromise).rejects.toSatisfy(
          (error: unknown) => !HexclaveSetupError.isSetupError(error),
        );
      }
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }
  });

  it("passes the construction-time URL to the nested cross-domain auth handler", async () => {
    const projectId = "00000000-0000-4000-8000-000000000009";
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;

    const callbackUrl = new URL(`https://${projectId}.example-stack-hosted.test/handler/sign-in`);
    callbackUrl.searchParams.set("stack_nested_cross_domain_auth_refresh_token_id", "source-refresh-token-id");
    callbackUrl.searchParams.set("code", "one-time-code");
    callbackUrl.searchParams.set("state", "nested-oauth-state");
    const strippedUrl = new URL(callbackUrl);
    strippedUrl.searchParams.delete("code");
    strippedUrl.searchParams.delete("state");

    globalThis.document = createMockDocument();
    globalThis.window = {
      location: {
        href: callbackUrl.toString(),
      },
    } as any;

    const nestedAuthSpy = vi.spyOn(StackClientApp.prototype as any, "_maybeHandleNestedCrossDomainAuth").mockResolvedValue(false);

    try {
      new StackClientApp({
        baseUrl: "http://localhost:12345",
        projectId,
        publishableClientKey: "stack-pk-test",
        tokenStore: "memory",
        redirectMethod: "window",
        noAutomaticPrefetch: true,
        devTool: false,
      });

      // Simulate consumeOAuthCallbackQueryParams stripping code+state before microtasks run.
      (globalThis.window as any).location.href = strippedUrl.toString();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(nestedAuthSpy).toHaveBeenCalledTimes(1);
      const urlArgument = nestedAuthSpy.mock.calls[0][0] as URL;
      expect(urlArgument).toBeInstanceOf(URL);
      expect(urlArgument.searchParams.get("code")).toBe("one-time-code");
      expect(urlArgument.searchParams.get("state")).toBe("nested-oauth-state");
    } finally {
      nestedAuthSpy.mockRestore();
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }
  });

  it("redirects hosted current-page OAuth callback errors to the hosted error handler during startup", async () => {
    const projectId = "00000000-0000-4000-8000-000000000010";
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const callbackUrl = new URL("https://demo.stack-auth.com/dashboard");
    callbackUrl.searchParams.set("errorCode", "SIGN_UP_REJECTED");
    callbackUrl.searchParams.set("message", "Your sign up was rejected by an administrator's sign-up rule.");
    callbackUrl.searchParams.set("details", JSON.stringify({
      message: "Your sign up was rejected by an administrator's sign-up rule.",
    }));
    callbackUrl.searchParams.set("after_auth_return_to", "/dashboard");
    callbackUrl.searchParams.set("after_callback_redirect_url", "https://customer.example.test/settings?tab=connected-accounts");
    let currentHref = callbackUrl.toString();
    let redirectedUrl = "";
    const redirectSpy = vi.spyOn(StackClientApp.prototype as any, "_redirectTo").mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as { url: string | URL };
      redirectedUrl = options.url.toString();
    });

    globalThis.document = createMockDocument();
    globalThis.window = {
      location: {
        get href() {
          return currentHref;
        },
        set href(value: string) {
          currentHref = value;
        },
        origin: callbackUrl.origin,
      },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          currentHref = new URL(url, currentHref).toString();
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as any;

    try {
      new StackClientApp({
        baseUrl: "http://localhost:12345",
        projectId,
        publishableClientKey: "stack-pk-test",
        tokenStore: "memory",
        redirectMethod: "window",
        urls: {
          default: { type: "hosted" },
        },
        noAutomaticPrefetch: true,
        devTool: false,
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      redirectSpy.mockRestore();
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }

    const errorUrl = new URL(redirectedUrl);
    expect(errorUrl.origin).toBe(`https://${projectId}.built-with-hexclave.com`);
    expect(errorUrl.pathname).toBe("/handler/error");
    expect(errorUrl.searchParams.get("errorCode")).toBe("SIGN_UP_REJECTED");
    expect(errorUrl.searchParams.get("message")).toBe("Your sign up was rejected by an administrator's sign-up rule.");
    expect(errorUrl.searchParams.get("after_auth_return_to")).toBe("/dashboard");
    expect(errorUrl.searchParams.get("after_callback_redirect_url")).toBe("https://customer.example.test/settings?tab=connected-accounts");
    expect(new URL(currentHref).searchParams.has("errorCode")).toBe(false);
  });

  it("uses direct sign-out instead of hosted sign-out redirects when code execution is available", async () => {
    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId: "00000000-0000-4000-8000-000000000003",
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "window",
      urls: {
        handler: "/handler",
        signOut: { type: "hosted" },
      },
      noAutomaticPrefetch: true,
      devTool: false,
    });
    const signOutSpy = vi.spyOn(clientApp, "signOut").mockRejectedValue(new Error("INTENTIONAL_TEST_ABORT"));

    try {
      await expect(clientApp.redirectToSignOut()).rejects.toThrowError("INTENTIONAL_TEST_ABORT");
      expect(signOutSpy).toHaveBeenCalledWith();
    } finally {
      signOutSpy.mockRestore();
    }
  });

  it("throws when public app.urls reads would return hosted component URLs", () => {
    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId: "00000000-0000-4000-8000-000000000003",
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "window",
      urls: {
        default: { type: "hosted" },
      },
      noAutomaticPrefetch: true,
      devTool: false,
    });

    expect(() => clientApp.urls.signIn).toThrowError(/app\.urls\.signIn cannot be used when this app is configured to use hosted components.*Use app\.redirectToSignIn\(\) instead/s);
    expect(() => clientApp.urls.signOut).toThrowError(/app\.urls\.signOut cannot be used when this app is configured to use hosted components.*Use app\.redirectToSignOut\(\) instead/s);
    expect(clientApp.urls.afterSignIn).toBe("/");
  });

  it("keeps public app.urls reads available for non-hosted targets", () => {
    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId: "00000000-0000-4000-8000-000000000003",
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "window",
      urls: {
        handler: "/custom-handler",
      },
      noAutomaticPrefetch: true,
      devTool: false,
    });

    expect(clientApp.urls.signIn).toBe("/custom-handler/sign-in");
  });

  it("keeps default hosted signOut() on the source domain when afterSignOut is not configured", async () => {
    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId: "00000000-0000-4000-8000-000000000004",
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "window",
      urls: {
        default: { type: "hosted" },
      },
      noAutomaticPrefetch: true,
      devTool: false,
    });
    const currentHref = "https://demo.stack-auth.com/settings?tab=profile";

    const clientInterface = clientApp["_interface"];
    const originalSignOut = clientInterface["signOut"];
    Reflect.set(clientInterface, "signOut", async () => {});
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    let redirectedUrl = "";

    globalThis.document = createMockDocument();
    globalThis.window = {
      location: {
        href: currentHref,
        replace: (url: string) => {
          redirectedUrl = url;
          throw new Error("INTENTIONAL_TEST_ABORT");
        },
      },
    } as any;

    try {
      const signOut = clientApp["_signOut"];
      if (typeof signOut !== "function") {
        throw new Error("Expected StackClientApp to expose _signOut in tests.");
      }
      await expect(signOut.call(clientApp, clientInterface["createSession"].call(clientInterface, {
        refreshToken: null,
      }))).rejects.toThrowError("INTENTIONAL_TEST_ABORT");
    } finally {
      Reflect.set(clientInterface, "signOut", originalSignOut);
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }

    expect(redirectedUrl).toBe("/settings?tab=profile");
  });

  it("restores a dropped after_auth_return_to from the sessionStorage mirror when redirecting after sign-in", async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const hadPreviousWindow = Reflect.has(globalThis, "window");
    const sessionStorageMap = new Map<string, string>();
    const windowMock = {
      location: {
        href: "https://demo.example.test/handler/sign-in?after_auth_return_to=%2Fmusic%3Ftrack%3D1",
      },
      sessionStorage: {
        getItem: (key: string) => sessionStorageMap.get(key) ?? null,
        setItem: (key: string, value: string) => {
          sessionStorageMap.set(key, value);
        },
        removeItem: (key: string) => {
          sessionStorageMap.delete(key);
        },
      },
    };
    Reflect.set(globalThis, "window", windowMock);
    globalThis.document = createMockDocument();

    try {
      // The constructor mirrors the redirect-back state from the arrival URL into sessionStorage.
      const clientApp = new StackClientApp({
        baseUrl: "http://localhost:12345",
        projectId: "00000000-0000-4000-8000-000000000011",
        publishableClientKey: "stack-pk-test",
        tokenStore: "memory",
        redirectMethod: "window",
        noAutomaticPrefetch: true,
        devTool: false,
      });

      // Intermediate hops (MFA, magic link, OAuth round-trips, ...) dropped the query params.
      windowMock.location.href = "https://demo.example.test/handler/mfa";

      const redirectUrl = await clientApp[hexclaveAppInternalsSymbol].getRedirectToHandlerUrl("afterSignIn");
      expect(redirectUrl).toBe("/music?track=1");

      // noRedirectBack opts out of the mirror just like it opts out of the query param.
      const noRedirectBackUrl = await clientApp[hexclaveAppInternalsSymbol].getRedirectToHandlerUrl("afterSignIn", { noRedirectBack: true });
      expect(new URL(noRedirectBackUrl, "https://demo.example.test").pathname).toBe("/");
    } finally {
      globalThis.document = previousDocument;
      if (hadPreviousWindow) {
        Reflect.set(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("restores dropped cross-domain handoff state from the sessionStorage mirror when redirecting after sign-in", async () => {
    const projectId = "00000000-0000-4000-8000-000000000012";
    const previousWindow = globalThis.window;
    const hadPreviousWindow = Reflect.has(globalThis, "window");
    const sessionStorageMap = new Map<string, string>();

    const handoffState = "mirror-handoff-state";
    const handoffCodeChallenge = "abcdefghijklmnopqrstuvwxyzABCDEFG_0123456789-._~";
    const handoffAfterCallbackRedirect = "https://demo.example.test/dashboard";
    const redirectBackUrl = new URL("https://demo.example.test/handler/oauth-callback");
    redirectBackUrl.searchParams.set("hexclave_cross_domain_auth", "1");
    redirectBackUrl.searchParams.set("hexclave_cross_domain_state", handoffState);
    redirectBackUrl.searchParams.set("hexclave_cross_domain_code_challenge", handoffCodeChallenge);
    redirectBackUrl.searchParams.set("hexclave_cross_domain_after_callback_redirect_url", handoffAfterCallbackRedirect);

    const arrivalUrl = new URL(`https://${projectId}.built-with-hexclave.com/handler/sign-in`);
    arrivalUrl.searchParams.set("after_auth_return_to", redirectBackUrl.toString());
    arrivalUrl.searchParams.set("hexclave_cross_domain_state", handoffState);
    arrivalUrl.searchParams.set("hexclave_cross_domain_code_challenge", handoffCodeChallenge);
    arrivalUrl.searchParams.set("hexclave_cross_domain_after_callback_redirect_url", handoffAfterCallbackRedirect);

    const previousDocument = globalThis.document;
    const windowMock = {
      location: {
        href: arrivalUrl.toString(),
      },
      sessionStorage: {
        getItem: (key: string) => sessionStorageMap.get(key) ?? null,
        setItem: (key: string, value: string) => {
          sessionStorageMap.set(key, value);
        },
        removeItem: (key: string) => {
          sessionStorageMap.delete(key);
        },
      },
    };
    Reflect.set(globalThis, "window", windowMock);
    globalThis.document = createMockDocument();

    try {
      const clientApp = new StackClientApp({
        baseUrl: "http://localhost:12345",
        projectId,
        publishableClientKey: "stack-pk-test",
        tokenStore: "memory",
        redirectMethod: "window",
        noAutomaticPrefetch: true,
        devTool: false,
      });
      const crossDomainAuthorizeRedirect = "https://demo.example.test/handler/oauth-callback?code=minted-code&state=mirror-handoff-state";
      const createCrossDomainAuthRedirectUrlSpy = vi
        .spyOn(clientApp as any, "_createCrossDomainAuthRedirectUrl")
        .mockResolvedValue(crossDomainAuthorizeRedirect);

      // All redirect-back query params were dropped before the after-sign-in redirect.
      windowMock.location.href = `https://${projectId}.built-with-hexclave.com/handler/sign-in`;

      const redirectUrl = await clientApp[hexclaveAppInternalsSymbol].getRedirectToHandlerUrl("afterSignIn");

      expect(createCrossDomainAuthRedirectUrlSpy).toHaveBeenCalledWith(expect.objectContaining({
        redirectUri: redirectBackUrl.toString(),
        state: handoffState,
        codeChallenge: handoffCodeChallenge,
        afterCallbackRedirectUrl: handoffAfterCallbackRedirect,
      }));
      expect(redirectUrl).toBe(crossDomainAuthorizeRedirect);
    } finally {
      globalThis.document = previousDocument;
      if (hadPreviousWindow) {
        Reflect.set(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("ignores stale session callbacks after a newer refresh token owns the token store", async () => {
    const clientApp = new StackClientApp({
      baseUrl: "http://localhost:12345",
      projectId: "00000000-0000-4000-8000-000000000005",
      publishableClientKey: "stack-pk-test",
      tokenStore: "memory",
      redirectMethod: "none",
      noAutomaticPrefetch: true,
      devTool: false,
    });
    const oldAccessToken = createAccessTokenString("old-refresh-token-id");
    const refreshedOldAccessToken = createAccessTokenString("refreshed-old-refresh-token-id");
    const newAccessToken = createAccessTokenString("new-refresh-token-id");
    const tokenStore = new Store({
      refreshToken: "old-refresh-token",
      accessToken: oldAccessToken,
    });
    const clientInterface = clientApp["_interface"];
    const originalFetchNewAccessToken = clientInterface["fetchNewAccessToken"];
    Reflect.set(clientInterface, "fetchNewAccessToken", async () => {
      return AccessToken.createIfValid(refreshedOldAccessToken) ?? (() => {
        throw new Error("Expected test access token to be valid");
      })();
    });

    try {
      const getSessionFromTokenStore = clientApp["_getSessionFromTokenStore"];
      if (typeof getSessionFromTokenStore !== "function") {
        throw new Error("Expected StackClientApp to expose _getSessionFromTokenStore in tests.");
      }
      const oldSession = getSessionFromTokenStore.call(clientApp, tokenStore);
      tokenStore.set({
        refreshToken: "new-refresh-token",
        accessToken: newAccessToken,
      });

      await oldSession.fetchNewTokens();
      expect(tokenStore.get()).toEqual({
        refreshToken: "new-refresh-token",
        accessToken: newAccessToken,
      });

      oldSession.markInvalid();
      expect(tokenStore.get()).toEqual({
        refreshToken: "new-refresh-token",
        accessToken: newAccessToken,
      });
    } finally {
      Reflect.set(clientInterface, "fetchNewAccessToken", originalFetchNewAccessToken);
    }
  });
});

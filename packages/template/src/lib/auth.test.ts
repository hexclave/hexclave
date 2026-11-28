// @vitest-environment jsdom

import { HexclaveClientInterface, KnownErrors } from "@hexclave/shared";
import { describe, expect, it, vi } from "vitest";
import { callOAuthCallback, getNewOAuthProviderOrScopeUrl } from "./auth";

vi.mock("./cookie", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cookie")>();
  return {
    ...actual,
    saveVerifierAndState: async () => ({
      codeChallenge: "<stripped code challenge>",
      state: "<stripped state>",
    }),
    consumeVerifierAndStateCookie: (state: string) => (
      state === "TESTSTATE123"
        ? { codeVerifier: "verifier123" }
        : actual.consumeVerifierAndStateCookie(state)
    ),
  };
});

function createTestInterface() {
  return new HexclaveClientInterface({
    clientVersion: "test",
    getBaseUrl: () => "https://api.example.com",
    getApiUrls: () => ["https://api.example.com"],
    extraRequestHeaders: {},
    projectId: "00000000-0000-4000-8000-000000000000",
    publishableClientKey: "pck_test",
  });
}

describe("getNewOAuthProviderOrScopeUrl", () => {
  it("returns the OAuth URL without performing navigation", async () => {
    window.history.replaceState({}, "", "/account?after_auth_return_to=%2Fsettings#connected-accounts");

    const iface = createTestInterface();
    const session = iface.createSession({ refreshToken: null, accessToken: null });

    const location = await getNewOAuthProviderOrScopeUrl(
      iface,
      {
        provider: "github",
        redirectUrl: "/handler/oauth-callback",
        errorRedirectUrl: "/handler/error",
        providerScope: "repo user",
      },
      session,
    );

    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.example.com/api/v1/auth/oauth/authorize/github");
    expect(Object.fromEntries(url.searchParams.entries())).toMatchInlineSnapshot(`
      {
        "after_callback_redirect_url": "http://localhost:3000/account?after_auth_return_to=%2Fsettings#connected-accounts",
        "client_id": "00000000-0000-4000-8000-000000000000",
        "client_secret": "pck_test",
        "code_challenge": "<stripped code challenge>",
        "code_challenge_method": "S256",
        "error_redirect_url": "http://localhost:3000/handler/error?after_auth_return_to=%2Fsettings",
        "grant_type": "authorization_code",
        "provider_scope": "repo user",
        "redirect_uri": "http://localhost:3000/handler/oauth-callback?after_auth_return_to=%2Fsettings",
        "response_type": "code",
        "scope": "legacy",
        "state": "<stripped state>",
        "type": "link",
      }
    `);
  });
});

describe("callOAuthCallback", () => {
  it("turns provider access denial callback params into a known error", async () => {
    window.history.replaceState({}, "", "/handler/oauth-callback?error=access_denied&error_description=User+cancelled");

    await expect(callOAuthCallback(createTestInterface(), "/handler/oauth-callback"))
      .rejects.toSatisfy((error: unknown) => KnownErrors.OAuthProviderAccessDenied.isInstance(error));
    expect(window.location.href).toBe("http://localhost:3000/handler/oauth-callback");
  });

  it("turns generic provider error callback params into a known error", async () => {
    window.history.replaceState({}, "", "/handler/oauth-callback?error=server_error&error_description=Provider+failed");

    await expect(callOAuthCallback(createTestInterface(), "/handler/oauth-callback"))
      .rejects.toSatisfy((error: unknown) => KnownErrors.OAuthProviderTemporarilyUnavailable.isInstance(error));
    expect(window.location.href).toBe("http://localhost:3000/handler/oauth-callback");
  });

  it("clears stale code/state when consuming a provider error (cancel then retry, #1059)", async () => {
    window.history.replaceState(
      { routerKey: "keep-me" },
      "",
      "/handler/oauth-callback?error=access_denied&error_description=User+cancelled&errorCode=STALE_ERR&details=%7B%7D&state=STALE123",
    );

    await expect(callOAuthCallback(createTestInterface(), "/handler/oauth-callback"))
      .rejects.toSatisfy((error: unknown) => KnownErrors.OAuthProviderAccessDenied.isInstance(error));
    expect(window.history.state).toEqual({ routerKey: "keep-me" });
    let url = new URL(window.location.href);
    for (const param of ["code", "state", "error", "error_description", "errorCode", "message", "details"]) {
      expect(url.searchParams.has(param)).toBe(false);
    }

    // Also exercise stale `code` (without `state`) on the provider-error path, since having both
    // `code` and `state` routes to the token-exchange path instead of the provider-error branch.
    window.history.replaceState({}, "", "/handler/oauth-callback?error=access_denied&error_description=User+cancelled&code=STALECODE");

    await expect(callOAuthCallback(createTestInterface(), "/handler/oauth-callback"))
      .rejects.toSatisfy((error: unknown) => KnownErrors.OAuthProviderAccessDenied.isInstance(error));
    url = new URL(window.location.href);
    for (const param of ["code", "state", "error", "error_description", "errorCode", "message", "details"]) {
      expect(url.searchParams.has(param)).toBe(false);
    }
  });

  it("clears stale error params after a successful callback (cancel then success, #1059)", async () => {
    const state = "TESTSTATE123";
    // Note: errorCode + message together would route to the known-error branch, so exercise them
    // separately on the success path (details/errorCode here, message below).
    window.history.replaceState(
      { routerKey: "keep-me" },
      "",
      `/handler/oauth-callback?code=CODE123&state=${encodeURIComponent(state)}&error=access_denied&error_description=stale&errorCode=ERR&details=%7B%7D`,
    );

    const iface = createTestInterface();
    const spy = vi.spyOn(iface, "callOAuthCallback").mockResolvedValue({ newUser: false, accessToken: "a", refreshToken: "r" });
    await callOAuthCallback(iface, "/handler/oauth-callback");
    expect(spy).toHaveBeenCalledOnce();
    expect(window.history.state).toEqual({ routerKey: "keep-me" });
    let url = new URL(window.location.href);
    for (const param of ["code", "state", "error", "error_description", "errorCode", "message", "details"]) {
      expect(url.searchParams.has(param)).toBe(false);
    }

    window.history.replaceState(
      {},
      "",
      `/handler/oauth-callback?code=CODE123&state=${encodeURIComponent(state)}&message=stale_msg&details=%7B%7D`,
    );
    await callOAuthCallback(iface, "/handler/oauth-callback");
    url = new URL(window.location.href);
    for (const param of ["code", "state", "error", "error_description", "errorCode", "message", "details"]) {
      expect(url.searchParams.has(param)).toBe(false);
    }
  });

  it("clears all callback params and preserves history state on known-error callbacks (#1059)", async () => {
    window.history.replaceState(
      { routerKey: "keep-me" },
      "",
      "/handler/oauth-callback?errorCode=OAUTH_PROVIDER_ACCESS_DENIED&message=Denied&details=%7B%7D&code=STALECODE&state=STALE123&error=access_denied&error_description=stale",
    );

    await expect(callOAuthCallback(createTestInterface(), "/handler/oauth-callback"))
      .rejects.toSatisfy((error: unknown) => KnownErrors.OAuthProviderAccessDenied.isInstance(error));
    expect(window.history.state).toEqual({ routerKey: "keep-me" });
    const url = new URL(window.location.href);
    for (const param of ["code", "state", "error", "error_description", "errorCode", "message", "details"]) {
      expect(url.searchParams.has(param)).toBe(false);
    }
  });
});

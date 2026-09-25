import { describe, expect, it } from "vitest";
import { crossDomainAuthQueryParams, planRedirectToHandler } from "./redirect-page-urls";

const localOAuthCallbackUrl = "https://hosted.example.test/handler/oauth-callback";

async function plan(options: {
  handlerName: "signIn" | "forgotPassword" | "passwordReset" | "afterSignIn" | "afterSignUp",
  rawHandlerUrl: string,
  currentUrl: URL,
  noRedirectBack?: boolean,
}) {
  return await planRedirectToHandler({
    ...options,
    noRedirectBack: options.noRedirectBack === true,
    getLocalOAuthCallbackUrl: () => localOAuthCallbackUrl,
    rawAfterSignInUrl: "/",
    getCrossDomainHandoffParams: async () => {
      throw new Error("Continuation-only redirects must not mint a new cross-domain handoff");
    },
  });
}

function expectRedirectUrl(planResult: Awaited<ReturnType<typeof plan>>, baseUrl: URL): URL {
  if (planResult.type !== "redirect") {
    throw new Error("Expected a direct redirect plan");
  }
  return new URL(planResult.url, baseUrl);
}

function expectContinuation(url: URL, expectedReturnTo: string): void {
  expect(url.searchParams.get("after_auth_return_to")).toBe(expectedReturnTo);
  expect(url.searchParams.get(crossDomainAuthQueryParams.state)).toBe("outer-state");
  expect(url.searchParams.get(crossDomainAuthQueryParams.codeChallenge)).toBe("outer-challenge");
  expect(url.searchParams.get(crossDomainAuthQueryParams.afterCallbackRedirectUrl)).toBe("https://customer.example.test/dashboard");
}

describe("server-side redirect planning", () => {
  it("does not resolve a browser-only callback URL without a current URL", async () => {
    const result = await planRedirectToHandler({
      handlerName: "signIn",
      rawHandlerUrl: "/handler/sign-in",
      noRedirectBack: false,
      currentUrl: null,
      getLocalOAuthCallbackUrl: () => {
        throw new Error("Server-side redirect planning must not resolve the browser callback URL");
      },
      rawAfterSignInUrl: "/",
      getCrossDomainHandoffParams: async () => {
        throw new Error("Server-side redirect planning must not mint cross-domain handoff parameters");
      },
    });

    expect(result).toEqual({
      type: "redirect",
      url: "/handler/sign-in",
    });
  });
});

describe("password-flow redirect continuation", () => {
  it("carries the complete customer return state through forgot-password and a reset-email new tab", async () => {
    const customerReturnTo = "https://customer.example.test/handler/oauth-callback?hexclave_cross_domain_auth=1";
    const signInUrl = new URL("https://hosted.example.test/handler/sign-in");
    signInUrl.searchParams.set("after_auth_return_to", customerReturnTo);
    signInUrl.searchParams.set(crossDomainAuthQueryParams.state, "outer-state");
    signInUrl.searchParams.set(crossDomainAuthQueryParams.codeChallenge, "outer-challenge");
    signInUrl.searchParams.set(crossDomainAuthQueryParams.afterCallbackRedirectUrl, "https://customer.example.test/dashboard");

    const forgotPlan = await plan({
      handlerName: "forgotPassword",
      rawHandlerUrl: "/handler/forgot-password",
      currentUrl: signInUrl,
    });
    const forgotUrl = expectRedirectUrl(forgotPlan, signInUrl);
    expectContinuation(forgotUrl, customerReturnTo);

    const callbackPlan = await plan({
      handlerName: "passwordReset",
      rawHandlerUrl: "/handler/password-reset",
      currentUrl: forgotUrl,
    });
    const resetEmailCallbackUrl = expectRedirectUrl(callbackPlan, forgotUrl);
    expectContinuation(resetEmailCallbackUrl, customerReturnTo);

    // Model opening the callback in a new tab: only URL state is available.
    resetEmailCallbackUrl.searchParams.set("code", "reset-code");
    const signInPlan = await plan({
      handlerName: "signIn",
      rawHandlerUrl: "/handler/sign-in",
      currentUrl: resetEmailCallbackUrl,
      noRedirectBack: true,
    });
    const finalSignInUrl = expectRedirectUrl(signInPlan, resetEmailCallbackUrl);
    expectContinuation(finalSignInUrl, customerReturnTo);
    expect(finalSignInUrl.searchParams.has("code")).toBe(false);
  });

  it.each([
    ["forgotPassword", "/handler/forgot-password"],
    ["passwordReset", "/handler/password-reset"],
  ] as const)("never synthesizes the current %s page as a return target", async (handlerName, rawHandlerUrl) => {
    const currentUrl = new URL(`https://hosted.example.test${rawHandlerUrl}?code=reset-code`);
    const result = expectRedirectUrl(await plan({
      handlerName,
      rawHandlerUrl,
      currentUrl,
    }), currentUrl);

    expect(result.searchParams.has("after_auth_return_to")).toBe(false);
    expect(result.searchParams.has("code")).toBe(false);
  });

  it("makes sign-in noRedirectBack suppress capture while preserving only inherited state", async () => {
    const resetUrlWithoutContinuation = new URL("https://hosted.example.test/handler/password-reset?code=reset-code");
    const result = expectRedirectUrl(await plan({
      handlerName: "signIn",
      rawHandlerUrl: "/handler/sign-in",
      currentUrl: resetUrlWithoutContinuation,
      noRedirectBack: true,
    }), resetUrlWithoutContinuation);

    expect(result.toString()).toBe("https://hosted.example.test/handler/sign-in");
  });

  it.each(["afterSignIn", "afterSignUp"] as const)(
    "keeps existing %s noRedirectBack semantics",
    async (handlerName) => {
      const currentUrl = new URL("https://hosted.example.test/handler/sign-in?after_auth_return_to=%2Fcustomer");
      const result = expectRedirectUrl(await plan({
        handlerName,
        rawHandlerUrl: "/default-after-auth",
        currentUrl,
        noRedirectBack: true,
      }), currentUrl);

      expect(result.toString()).toBe("https://hosted.example.test/default-after-auth");
    },
  );
});

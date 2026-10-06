import { describe, expect, it } from "vitest";
import {
  createAuthFlowEmailVerificationUrl,
  hostedAuthFlowQueryParam,
  requiresAfterAuthReturn,
} from "./after-auth-return-policy";

const alwaysGuardedPaths = [
  "sign-in",
  "log-in",
  "sign-up",
  "register",
  "forgot-password",
  "password-reset",
  "mfa",
  "onboarding",
  "oauth-callback",
  "magic-link-callback",
  "sign-out",
];

describe("hosted after-auth return policy", () => {
  it.each(alwaysGuardedPaths)("requires a return URL on %s", (handlerPath) => {
    expect(requiresAfterAuthReturn({
      handlerPath,
      searchParams: new URLSearchParams(),
    })).toBe(true);
  });

  it.each([
    "account-settings",
    "team-invitation",
    "cli-auth-confirm",
    "agent-auth-confirm",
    "unknown",
  ])("does not guard the standalone %s page", (handlerPath) => {
    expect(requiresAfterAuthReturn({
      handlerPath,
      searchParams: new URLSearchParams(),
    })).toBe(false);
  });

  it("only guards email verification when it belongs to an auth flow", () => {
    expect(requiresAfterAuthReturn({
      handlerPath: "email-verification",
      searchParams: new URLSearchParams(),
    })).toBe(false);
    expect(requiresAfterAuthReturn({
      handlerPath: "email-verification",
      searchParams: new URLSearchParams([[hostedAuthFlowQueryParam, "1"]]),
    })).toBe(true);
  });

  it.each([
    "OAUTH_CONNECTION_ALREADY_CONNECTED_TO_ANOTHER_USER",
    "USER_ALREADY_CONNECTED_TO_ANOTHER_OAUTH_CONNECTION",
  ])("does not guard account-linking error %s", (errorCode) => {
    expect(requiresAfterAuthReturn({
      handlerPath: "error",
      searchParams: new URLSearchParams({ errorCode }),
    })).toBe(false);
  });

  it("guards auth and unknown error pages", () => {
    expect(requiresAfterAuthReturn({
      handlerPath: "error",
      searchParams: new URLSearchParams({ errorCode: "OAUTH_PROVIDER_ACCESS_DENIED" }),
    })).toBe(true);
    expect(requiresAfterAuthReturn({
      handlerPath: "error",
      searchParams: new URLSearchParams(),
    })).toBe(true);
  });

  it("marks auth-flow verification URLs and preserves the raw return target", () => {
    const result = new URL(createAuthFlowEmailVerificationUrl({
      emailVerificationUrl: "/handler/email-verification#ignored",
      currentUrl: new URL("https://project.hosted.test/handler/onboarding"),
      rawAfterAuthReturnTo: "https://app.example.test/handler/oauth-callback?state=return-state",
    }));

    expect(result.toString()).toBe(
      "https://project.hosted.test/handler/email-verification"
      + "?after_auth_return_to=https%3A%2F%2Fapp.example.test%2Fhandler%2Foauth-callback%3Fstate%3Dreturn-state"
      + "&hexclave_auth_flow=1",
    );
  });
});

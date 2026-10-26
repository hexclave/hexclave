import { describe, expect, it, vi } from "vitest";

vi.mock("openid-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("openid-client")>();
  const OriginalIssuer = original.Issuer;

  class MockIssuer extends OriginalIssuer {
    static discover() {
      return Promise.resolve(new OriginalIssuer({
        issuer: "https://idp.example.com",
        authorization_endpoint: "https://idp.example.com/authorize",
        token_endpoint: "https://idp.example.com/token",
        userinfo_endpoint: "https://idp.example.com/userinfo",
        jwks_uri: "https://idp.example.com/jwks",
      }));
    }
  }

  return {
    ...original,
    Issuer: MockIssuer,
  };
});

import { CustomOidcProvider } from "./custom-oidc";

describe("CustomOidcProvider authorization URL", () => {
  it("does not force a consent prompt", async () => {
    const provider = await CustomOidcProvider.create({
      clientId: "x",
      clientSecret: "y",
      redirectUri: "http://localhost/cb",
      issuerUrl: "https://idp.example.com",
    });
    const url = new URL(provider.getAuthorizationUrl({ codeVerifier: "v", state: "s" }));

    expect(url.searchParams.has("prompt")).toBe(false);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });
});

describe("CustomOidcProvider email_verified claim", () => {
  async function emailVerifiedFor(emailVerifiedClaim: unknown) {
    const provider = await CustomOidcProvider.create({
      clientId: "x",
      clientSecret: "y",
      redirectUri: "http://localhost/cb",
      issuerUrl: "https://idp.example.com",
    });
    vi.spyOn(provider.oauthClient, "userinfo").mockResolvedValue({
      sub: "account-123",
      email: "victim@example.com",
      // openid-client types `email_verified` as the spec's boolean, but real IdPs
      // send other shapes; going through an untyped entry lets us test those.
      ...Object.fromEntries([["email_verified", emailVerifiedClaim]]),
    });
    const userInfo = await provider.postProcessUserInfo({ accessToken: "token", accessTokenExpiredAt: null });
    return userInfo.emailVerified;
  }

  it.each([true, "true"])("treats %j as verified", async (claim) => {
    expect(await emailVerifiedFor(claim)).toBe(true);
  });

  // Regression: `!!claim` used to turn non-spec string claims like "false" into
  // `true`, letting an unverified email link into an existing account.
  it.each([false, "false", "0", "no", "", "True", 1, null, undefined])("treats %j as unverified", async (claim) => {
    expect(await emailVerifiedFor(claim)).toBe(false);
  });
});

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

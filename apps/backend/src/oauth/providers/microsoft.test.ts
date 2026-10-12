import { describe, expect, it } from "vitest";
import { GithubProvider } from "./github";
import { MicrosoftProvider } from "./microsoft";

describe("MicrosoftProvider authorization URL", () => {
  it("does not force a consent prompt", async () => {
    const provider = await MicrosoftProvider.create({
      clientId: "x",
      clientSecret: "y",
      microsoftTenantId: "tenant",
      redirectUri: "http://localhost/cb",
    });
    const url = new URL(provider.getAuthorizationUrl({ codeVerifier: "v", state: "s" }));

    expect(url.searchParams.has("prompt")).toBe(false);
    expect(url.searchParams.has("access_type")).toBe(true);
    expect(url.searchParams.has("scope")).toBe(true);
  });
});

describe("GithubProvider authorization URL", () => {
  it("still requests a consent prompt", async () => {
    const provider = await GithubProvider.create({
      clientId: "x",
      clientSecret: "y",
      redirectUri: "http://localhost/cb",
    });
    const url = new URL(provider.getAuthorizationUrl({ codeVerifier: "v", state: "s" }));

    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

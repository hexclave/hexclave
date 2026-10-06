import { describe, expect, it } from "vitest";
import { getWorkOSVerificationUrls } from "./external-auth";

describe("getWorkOSVerificationUrls", () => {
  it("derives the issuer and JWKS URL from one encoded client ID", () => {
    expect(getWorkOSVerificationUrls("client_123")).toMatchInlineSnapshot(`
      {
        "issuer": "https://api.workos.com/user_management/client_123",
        "jwksUrl": "https://api.workos.com/sso/jwks/client_123",
      }
    `);
  });

  it("preserves an explicit issuer override", () => {
    expect(getWorkOSVerificationUrls("client_123", "https://custom.example.com")).toMatchInlineSnapshot(`
      {
        "issuer": "https://custom.example.com",
        "jwksUrl": "https://api.workos.com/sso/jwks/client_123",
      }
    `);
  });
});

import { describe, expect, it } from "vitest";
import { branchConfigSchema } from "./schema";

describe("better-auth-integration jwksUrl", () => {
  const validate = (jwksUrl: string) => branchConfigSchema.validateAt("better-auth-integration.jwksUrl", {
    "better-auth-integration": { jwksUrl },
  });

  it.each([
    "https://auth.example.com/api/auth/jwks",
    "http://localhost:8114/api/auth/jwks",
  ])("accepts HTTP(S) URL %s", async (jwksUrl) => {
    await expect(validate(jwksUrl)).resolves.toBe(jwksUrl);
  });

  it.each([
    "ftp://auth.example.com/jwks",
    "file:///etc/jwks.json",
  ])("rejects non-HTTP(S) URL %s", async (jwksUrl) => {
    await expect(validate(jwksUrl)).rejects.toThrow("must use HTTP or HTTPS");
  });
});

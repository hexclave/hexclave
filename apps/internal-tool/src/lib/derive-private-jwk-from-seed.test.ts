import * as jose from "jose";
import { describe, expect, it } from "vitest";
import { derivePrivateJwkFromSeed } from "./derive-private-jwk-from-seed";

describe("derivePrivateJwkFromSeed", () => {
  it("is deterministic: same purpose + seed yields the identical JWK", () => {
    const first = derivePrivateJwkFromSeed("test-purpose", "test-seed");
    const second = derivePrivateJwkFromSeed("test-purpose", "test-seed");
    expect(second).toEqual(first);
  });

  it("namespaces by purpose: same seed with a different purpose yields a different key", () => {
    const first = derivePrivateJwkFromSeed("purpose-a", "test-seed");
    const second = derivePrivateJwkFromSeed("purpose-b", "test-seed");
    expect(second.d).not.toBe(first.d);
    expect(second.kid).not.toBe(first.kid);
  });

  it("yields a different key for a different seed", () => {
    const first = derivePrivateJwkFromSeed("test-purpose", "seed-a");
    const second = derivePrivateJwkFromSeed("test-purpose", "seed-b");
    expect(second.d).not.toBe(first.d);
    expect(second.kid).not.toBe(first.kid);
  });

  it("produces a valid ES256 keypair that signs and verifies", async () => {
    const jwk = derivePrivateJwkFromSeed("test-purpose", "test-seed");
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(jwk.alg).toBe("ES256");
    expect(jwk.kid).toHaveLength(12);

    const privateKey = await jose.importJWK(jwk, "ES256");
    const token = await new jose.SignJWT({ hello: "world" })
      .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
      .setIssuer("https://issuer.example.com")
      .setAudience("test-audience")
      .setExpirationTime("5m")
      .sign(privateKey);

    const { d: _d, ...publicJwk } = jwk;
    const publicKey = await jose.importJWK(publicJwk, "ES256");
    const { payload } = await jose.jwtVerify(token, publicKey, {
      issuer: "https://issuer.example.com",
      audience: "test-audience",
    });
    expect(payload.hello).toBe("world");
  });
});

import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import * as jose from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internalToolBaseUrl, publicJwks, signSpacetimeToken } from "./spacetimedb-token";

// The module under test imports the `server-only` marker package, which throws
// when loaded outside a React Server Components bundler context.
vi.mock("server-only", () => ({}));

function stubDefaultEnv() {
  vi.stubEnv("HEXCLAVE_INTERNAL_TOOL_BASE_URL", "https://internal.example.com");
  vi.stubEnv("HEXCLAVE_SPACETIMEDB_SIGNING_SEED", "test-seed");
  // getEnvVariable also reads the legacy STACK_-prefixed twins; stub them to
  // empty (= unset) so a stray var in the runner's environment can't interfere.
  vi.stubEnv("STACK_SPACETIMEDB_SIGNING_SEED", "");
  vi.stubEnv("STACK_INTERNAL_TOOL_BASE_URL", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publicJwks", () => {
  it("serves only the allowlisted public members, never `d`", async () => {
    stubDefaultEnv();

    const jwks = await publicJwks();
    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0];
    expect(Object.keys(key).sort()).toMatchInlineSnapshot(`
      [
        "alg",
        "crv",
        "kid",
        "kty",
        "x",
        "y",
      ]
    `);
    expect(key.kty).toBe("EC");
    expect(key.crv).toBe("P-256");
    expect(key.alg).toBe("ES256");
  });

  it("is deterministic for a given seed", async () => {
    stubDefaultEnv();
    const first = await publicJwks();

    vi.unstubAllEnvs();
    stubDefaultEnv();
    const second = await publicJwks();

    expect(second).toEqual(first);
  });

  it("derives a different keypair (and kid) for a different seed", async () => {
    stubDefaultEnv();
    const first = await publicJwks();

    vi.stubEnv("HEXCLAVE_SPACETIMEDB_SIGNING_SEED", "another-seed");
    const second = await publicJwks();

    expect(second.keys[0].x).not.toBe(first.keys[0].x);
    expect(second.keys[0].kid).not.toBe(first.keys[0].kid);
  });

  it("throws when the seed env var is not configured", async () => {
    stubDefaultEnv();
    vi.stubEnv("HEXCLAVE_SPACETIMEDB_SIGNING_SEED", "");

    await expect(publicJwks()).rejects.toThrow("HEXCLAVE_SPACETIMEDB_SIGNING_SEED is not configured");
  });

  it("treats the REPLACE_ME placeholder as unconfigured", async () => {
    stubDefaultEnv();
    vi.stubEnv("HEXCLAVE_SPACETIMEDB_SIGNING_SEED", "REPLACE_ME");

    await expect(publicJwks()).rejects.toThrow(HexclaveAssertionError);
  });
});

describe("signSpacetimeToken", () => {
  it("mints a token that verifies against the published JWKS", async () => {
    stubDefaultEnv();

    const token = await signSpacetimeToken({ subject: "user-123", name: "Ada Lovelace" });
    // Verifying with the JWKS output (not the private key) also proves the
    // allowlisted public members are sufficient for verification.
    const publicKey = await jose.importJWK((await publicJwks()).keys[0], "ES256");
    const { payload, protectedHeader } = await jose.jwtVerify(token, publicKey, {
      issuer: "https://internal.example.com",
      audience: "spacetimedb",
    });

    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.kid).toBe((await publicJwks()).keys[0].kid);
    expect(payload.sub).toBe("user-123");
    expect(payload.name).toBe("Ada Lovelace");
    expect(payload.iat).toBeDefined();
    expect(payload.exp).toBeDefined();
    // Default TTL is 30 minutes (see USER_TOKEN_TTL for why it's much longer
    // than the frontend's 8-minute refresh interval).
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(30 * 60);
  });

  it("does not verify against the JWKS of a different seed", async () => {
    stubDefaultEnv();
    const token = await signSpacetimeToken({ subject: "user-123" });

    vi.stubEnv("HEXCLAVE_SPACETIMEDB_SIGNING_SEED", "another-seed");
    const foreignKey = await jose.importJWK((await publicJwks()).keys[0], "ES256");

    await expect(jose.jwtVerify(token, foreignKey)).rejects.toThrow();
  });

  it("omits the name claim when name is not provided or empty", async () => {
    stubDefaultEnv();

    for (const options of [{ subject: "user-123" }, { subject: "user-123", name: "" }]) {
      const token = await signSpacetimeToken(options);
      const payload = jose.decodeJwt(token);
      expect("name" in payload).toBe(false);
    }
  });

  it("respects a custom expiresIn", async () => {
    stubDefaultEnv();

    const token = await signSpacetimeToken({ subject: "svc", expiresIn: "3600s" });
    const payload = jose.decodeJwt(token);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(3600);
  });
});

describe("internalToolBaseUrl", () => {
  it("strips trailing slashes", () => {
    stubDefaultEnv();
    vi.stubEnv("HEXCLAVE_INTERNAL_TOOL_BASE_URL", "https://internal.example.com///");

    expect(internalToolBaseUrl()).toBe("https://internal.example.com");
  });

  it.each(["", "   ", "REPLACE_ME", "REPLACE_ME///"])("throws when the base URL is unconfigured (%j)", (baseUrl) => {
    stubDefaultEnv();
    vi.stubEnv("HEXCLAVE_INTERNAL_TOOL_BASE_URL", baseUrl);

    expect(() => internalToolBaseUrl()).toThrow("HEXCLAVE_INTERNAL_TOOL_BASE_URL is not configured");
  });
});

import crypto from "crypto";
import { readFileSync } from "node:fs";
import * as jose from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globalVar } from "./globals";
import { getPrivateJwks, getPublicJwkSet, signJWT, verifyJWT } from "./jwt";

// Public/synthetic vectors captured from elliptic 6.5.7, not service credentials.
const fixtures = JSON.parse(readFileSync(new URL("./jwt.native-crypto.fixtures.json", import.meta.url), "utf8")) as {
  audience: string; kids: string[]; endToEndHash: string; aggregateHash: string;
  vectors: { label: string; scalar: string; x: string; y: string }[];
};
const testSecret = crypto.createHash("sha256").update("Hexclave native P-256 compatibility test only").digest("base64url");
const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function forceScalar(bytes: Uint8Array) {
  vi.spyOn(globalVar.crypto.subtle, "digest").mockImplementation(async () => Uint8Array.from(bytes).buffer);
}
beforeEach(() => { vi.stubEnv("STACK_SERVER_SECRET", testSecret); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("native P-256 JWT key compatibility", () => {
  it.each(fixtures.vectors)("preserves legacy $label coordinates and original d", async (vector) => {
    const scalar = Buffer.from(vector.scalar, "hex");
    forceScalar(scalar);
    const keys = await getPrivateJwks({ audience: fixtures.audience });
    expect(keys.map(key => key.kid)).toEqual(fixtures.kids);
    for (const key of keys) {
      expect(key.d).toBe(scalar.toString("base64url"));
      expect(key.x).toBe(vector.x);
      expect(key.y).toBe(vector.y);
      expect(Object.keys(key)).toEqual(["kty", "crv", "alg", "kid", "d", "x", "y"]);
    }
  });
  it.each(["0".repeat(64), "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"])("rejects a degenerate scalar", async (scalar) => {
    forceScalar(Buffer.from(scalar, "hex"));
    await expect(getPrivateJwks({ audience: fixtures.audience })).rejects.toThrow();
  });
  it("preserves both secret derivations, key identifiers and key ordering", async () => {
    expect(hash(await getPrivateJwks({ audience: fixtures.audience }))).toBe(fixtures.endToEndHash);
  });
  it("matches the frozen aggregate of 1024 legacy synthetic-key results", async () => {
    const aggregate = crypto.createHash("sha256");
    for (let i = 0; i < 1024; i++) {
      forceScalar(crypto.createHash("sha256").update("hexclave-native-p256-vector:" + i).digest());
      aggregate.update(JSON.stringify(await getPrivateJwks({ audience: fixtures.audience })) + "\n");
    }
    expect(aggregate.digest("hex")).toBe(fixtures.aggregateHash);
  });
  it("projects only public JWK fields", async () => {
    forceScalar(Buffer.from(fixtures.vectors[0].scalar, "hex"));
    const keys = await getPrivateJwks({ audience: fixtures.audience });
    const publicSet = await getPublicJwkSet(keys);
    expect(publicSet.keys).toHaveLength(2);
    for (const key of publicSet.keys) expect(key).not.toHaveProperty("d");
  });
  it("cross-verifies JOSE tokens using a frozen legacy key", async () => {
    const vector = fixtures.vectors.find(item => item.label === "one")!;
    forceScalar(Buffer.from(vector.scalar, "hex"));
    const issuer = "urn:hexclave:native-p256:test";
    const legacyKey = { kty: "EC", crv: "P-256", alg: "ES256", kid: fixtures.kids[0], d: Buffer.from(vector.scalar, "hex").toString("base64url"), x: vector.x, y: vector.y };
    const legacyToken = await new jose.SignJWT({ compatibility: true }).setProtectedHeader({ alg: "ES256", kid: legacyKey.kid }).setIssuer(issuer).setAudience(fixtures.audience).setIssuedAt().setExpirationTime("5m").sign(await jose.importJWK(legacyKey));
    expect((await verifyJWT({ jwt: legacyToken, allowedIssuers: [issuer] })).compatibility).toBe(true);
    const token = await signJWT({ issuer, audience: fixtures.audience, payload: { compatibility: true } });
    const { d, ...publicLegacyKey } = legacyKey;
    expect((await jose.jwtVerify(token, jose.createLocalJWKSet({ keys: [publicLegacyKey] }), { issuer, audience: fixtures.audience })).payload.compatibility).toBe(true);
    await expect(verifyJWT({ jwt: token, allowedIssuers: [issuer + ":rejected"] })).rejects.toThrow();
    const pieces = token.split(".");
    pieces[2] = (pieces[2][0] === "A" ? "B" : "A") + pieces[2].slice(1);
    await expect(verifyJWT({ jwt: pieces.join("."), allowedIssuers: [issuer] })).rejects.toThrow();
  });
});

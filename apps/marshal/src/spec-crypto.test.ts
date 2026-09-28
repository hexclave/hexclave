import { describe, expect, it } from "vitest";
import { computeRevision } from "./revision.js";
import { DEVELOPMENT_DATA_ENCRYPTION_KEY, assertDataEncryptionKeyIsSafe, decryptString, encryptString, parseDataEncryptionRootKey } from "./spec-crypto.js";
import type { ServiceSpec } from "./types.js";

const FIRST_KEY = parseDataEncryptionRootKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const SECOND_KEY = parseDataEncryptionRootKey("101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f");

describe("stored spec cryptography", () => {
  it("rejects the public development key unless mocks are explicitly enabled", () => {
    expect(() => assertDataEncryptionKeyIsSafe(DEVELOPMENT_DATA_ENCRYPTION_KEY, false)).toThrow(/MARSHAL_ALLOW_MOCKS=1/);
    expect(() => assertDataEncryptionKeyIsSafe(DEVELOPMENT_DATA_ENCRYPTION_KEY.toUpperCase(), false)).toThrow(/MARSHAL_ALLOW_MOCKS=1/);
    expect(() => assertDataEncryptionKeyIsSafe(DEVELOPMENT_DATA_ENCRYPTION_KEY, true)).not.toThrow();
  });

  it("round-trips only with the same object identity", () => {
    const encrypted = encryptString('{"TOKEN":{"value":"secret"}}', "specs/ns/web.json#env", FIRST_KEY);
    expect(JSON.stringify(encrypted)).not.toContain("secret");
    expect(decryptString(encrypted, "specs/ns/web.json#env", FIRST_KEY)).toBe('{"TOKEN":{"value":"secret"}}');
    expect(() => decryptString(encrypted, "specs/other/web.json#env", FIRST_KEY)).toThrow();
    expect(() => decryptString(encrypted, "specs/ns/web.json#env", SECOND_KEY)).toThrow();
  });

  it("rejects malformed root keys", () => {
    expect(() => parseDataEncryptionRootKey("too-short")).toThrow("exactly 64 hexadecimal characters");
    expect(() => parseDataEncryptionRootKey("z".repeat(64))).toThrow("exactly 64 hexadecimal characters");
  });

  it("keys revisions so the public revision is not a dictionary oracle", () => {
    const spec = {
      config: { type: "serverless", public: false, min_instances: 0, max_instances: 1, ports: { "3000": { protocol: "http" } } },
      source: { image: "example/image" },
      env: { PASSWORD: { value: "guessable-password" } },
    } satisfies ServiceSpec;
    expect(computeRevision(spec, FIRST_KEY)).not.toBe(computeRevision(spec, SECOND_KEY));
    expect(computeRevision(spec, FIRST_KEY)).toBe(computeRevision(spec, FIRST_KEY));
  });
});

import { HexclaveAssertionError } from "../utils/errors";
import type { FeatureFlagsBootstrap, FeatureFlagsConfig } from "./types";

const SHA_256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA_256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

// Config revisions are cache validators and exposure-token inputs. A 32-bit
// checksum can alias ordinary configurations, so use a self-contained SHA-256
// implementation that works in every JS runtime without a Node-only import.
function sha256(value: string): string {
  const bytes = [...new TextEncoder().encode(value)];
  const bitLength = bytes.length * 8;
  if (!Number.isSafeInteger(bitLength)) throw new HexclaveAssertionError("Feature flag config is too large to hash safely.");
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const highLength = Math.floor(bitLength / 0x1_0000_0000);
  const lowLength = bitLength >>> 0;
  for (const shift of [24, 16, 8, 0]) bytes.push((highLength >>> shift) & 0xff);
  for (const shift of [24, 16, 8, 0]) bytes.push((lowLength >>> shift) & 0xff);

  const hash: number[] = [...SHA_256_INITIAL_STATE];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64).fill(0);
    for (let index = 0; index < 16; index++) {
      const wordOffset = offset + index * 4;
      words[index] = (
        (bytes[wordOffset] << 24)
        | (bytes[wordOffset + 1] << 16)
        | (bytes[wordOffset + 2] << 8)
        | bytes[wordOffset + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index++) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA_256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, nestedValue]) => nestedValue !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${canonicalJson(nestedValue)}`)
    .join(",")}}`;
}

export function getFeatureFlagsConfigVersion(config: FeatureFlagsConfig): string {
  return sha256(canonicalJson(config));
}

export function createFeatureFlagsBootstrap(config: FeatureFlagsConfig): FeatureFlagsBootstrap {
  return {
    config,
    flagIdsByKey: Object.fromEntries(
      Object.entries(config.flags ?? {})
        .filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1]?.key !== undefined)
        .map(([flagId, flag]) => [flag.key ?? flagId, flagId]),
    ),
    configVersion: getFeatureFlagsConfigVersion(config),
  };
}

import.meta.vitest?.test("canonical versions ignore record insertion order", ({ expect }) => {
  const left: FeatureFlagsConfig = { flags: { a: { key: "a" }, b: { key: "b" } } };
  const right: FeatureFlagsConfig = { flags: { b: { key: "b" }, a: { key: "a" } } };
  expect(getFeatureFlagsConfigVersion(left)).toBe(getFeatureFlagsConfigVersion(right));
  expect(getFeatureFlagsConfigVersion({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
});

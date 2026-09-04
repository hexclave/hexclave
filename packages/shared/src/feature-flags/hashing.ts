// MurmurHash3 x86 32-bit. This is part of the assignment contract: changing it would move users
// between variants, so reference vectors below deliberately pin every implementation detail.
export function murmur3_32(input: string, seed: number = 0): number {
  const data = new TextEncoder().encode(input);
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let hash = seed >>> 0;
  const blockCount = data.length >>> 2;

  for (let index = 0; index < blockCount; index++) {
    const offset = index * 4;
    let block =
      (data[offset] & 0xff) |
      ((data[offset + 1] & 0xff) << 8) |
      ((data[offset + 2] & 0xff) << 16) |
      ((data[offset + 3] & 0xff) << 24);
    block = Math.imul(block, c1);
    block = (block << 15) | (block >>> 17);
    block = Math.imul(block, c2);
    hash ^= block;
    hash = (hash << 13) | (hash >>> 19);
    hash = (Math.imul(hash, 5) + 0xe6546b64) | 0;
  }

  let tail = 0;
  const tailOffset = blockCount * 4;
  const tailLength = data.length & 3;
  if (tailLength >= 3) tail ^= (data[tailOffset + 2] & 0xff) << 16;
  if (tailLength >= 2) tail ^= (data[tailOffset + 1] & 0xff) << 8;
  if (tailLength >= 1) {
    tail ^= data[tailOffset] & 0xff;
    tail = Math.imul(tail, c1);
    tail = (tail << 15) | (tail >>> 17);
    tail = Math.imul(tail, c2);
    hash ^= tail;
  }

  hash ^= data.length;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

const BUCKET_SEPARATOR = "\x01";

export function featureFlagBucket(subjectId: string, salt: string): number {
  return murmur3_32(`${subjectId}${BUCKET_SEPARATOR}${salt}`) / 0x1_0000_0000;
}

export function chooseFeatureFlagVariant(
  subjectId: string,
  salt: string,
  variantWeights: ReadonlyArray<{ key: string, weight: number }>,
): string | undefined {
  let total = 0;
  for (const variant of variantWeights) total += variant.weight;
  if (total !== 10_000) return undefined;

  const target = Math.floor(featureFlagBucket(subjectId, salt) * 10_000);
  let cumulative = 0;
  for (const variant of variantWeights) {
    cumulative += variant.weight;
    if (target < cumulative) return variant.key;
  }
  return undefined;
}

import.meta.vitest?.test("Murmur3 matches stable reference vectors", ({ expect }) => {
  expect(murmur3_32("")).toBe(0);
  expect(murmur3_32("a")).toBe(0x3c2569b2);
  expect(murmur3_32("abc")).toBe(0xb3dd93fa);
  expect(murmur3_32("abcd")).toBe(0x43ed676a);
  expect(murmur3_32("Hello, world!")).toBe(0xc0363e43);
});

import.meta.vitest?.test("basis-point bucketing is deterministic and distributed", ({ expect }) => {
  let selected = 0;
  for (let index = 0; index < 100_000; index++) {
    const first = featureFlagBucket(`user-${index}`, "flag.salt");
    expect(first).toBe(featureFlagBucket(`user-${index}`, "flag.salt"));
    if (first < 0.3) selected++;
  }
  expect(Math.abs(selected / 100_000 - 0.3)).toBeLessThan(0.015);
});

import.meta.vitest?.test("weighted variants require exactly 10,000 basis points", ({ expect }) => {
  expect(chooseFeatureFlagVariant("user", "salt", [{ key: "a", weight: 5_000 }, { key: "b", weight: 5_000 }])).toMatch(/^[ab]$/);
  expect(chooseFeatureFlagVariant("user", "salt", [{ key: "a", weight: 1 }])).toBeUndefined();
});

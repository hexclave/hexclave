import { generateRandomValues } from "./crypto";

export function generateUuid() {
  // crypto.randomUuid is not supported in all browsers, so this is a polyfill
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
    (+c ^ generateRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16)
  );
}

const uuidV7RandomBits = 74n;
const uuidV7RandomMask = (1n << uuidV7RandomBits) - 1n;

export function createUuidV7Generator() {
  let lastTimestampMs = -1;
  let randomValue = 0n;
  return () => {
    // UUIDv7 puts the millisecond timestamp first so generated values cluster
    // in an advancing range; its trailing random portion preserves uniqueness.
    let timestampMs = Date.now();
    if (timestampMs > lastTimestampMs) {
      lastTimestampMs = timestampMs;
      const randomBytes = generateRandomValues(new Uint8Array(10));
      randomValue = 0n;
      for (const byte of randomBytes) randomValue = (randomValue << 8n) | BigInt(byte);
      randomValue &= uuidV7RandomMask;
    } else {
      timestampMs = lastTimestampMs;
      randomValue++;
      if (randomValue > uuidV7RandomMask) {
        lastTimestampMs++;
        timestampMs = lastTimestampMs;
        randomValue = 0n;
      }
    }

    const uuid = new Uint8Array(16);
    let timestamp = BigInt(timestampMs);
    for (let index = 5; index >= 0; index--) {
      uuid[index] = Number(timestamp & 0xffn);
      timestamp >>= 8n;
    }
    const randomA = Number((randomValue >> 62n) & 0xfffn);
    uuid[6] = 0x70 | (randomA >> 8);
    uuid[7] = randomA & 0xff;
    let randomB = randomValue & ((1n << 62n) - 1n);
    uuid[8] = 0x80 | Number(randomB >> 56n);
    for (let index = 15; index >= 9; index--) {
      uuid[index] = Number(randomB & 0xffn);
      randomB >>= 8n;
    }
    return uuid;
  };
}

import.meta.vitest?.test("createUuidV7Generator", ({ expect }) => {
  const generate = createUuidV7Generator();
  const values = Array.from({ length: 450 }, () => generate());
  const compare = (a: Uint8Array, b: Uint8Array) => {
    for (let index = 0; index < a.length; index++) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  };

  expect(values.every(value => value.byteLength === 16)).toBe(true);
  expect(values.every(value => (value[6] & 0xf0) === 0x70)).toBe(true);
  expect(values.every(value => (value[8] & 0xc0) === 0x80)).toBe(true);
  for (let index = 1; index < values.length; index++) {
    expect(compare(values[index - 1], values[index])).toBeLessThan(0);
  }
  expect(new Set(values.map(value => Array.from(value).join(","))).size).toBe(values.length);
});
import.meta.vitest?.test("generateUuid", ({ expect }) => {
  // Test that the function returns a valid UUID
  const uuid = generateUuid();
  expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // Test that multiple calls generate different UUIDs
  const uuid2 = generateUuid();
  expect(uuid).not.toBe(uuid2);

  // Test that the UUID is version 4 (random)
  expect(uuid.charAt(14)).toBe('4');

  // Test that the UUID has the correct variant (8, 9, a, or b in position 19)
  expect('89ab').toContain(uuid.charAt(19));
});

export function isUuid(str: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(str);
}

// Accepts any RFC 9562 version (1–8) with the standard variant. Unlike
// `isUuid`, this does not pin the version nibble to `4` — observability IDs are
// generated with different UUID versions depending on the source, so callers
// that only care about well-formedness use this pattern instead.
export const anyVersionUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAnyVersionUuid(str: string) {
  return anyVersionUuidPattern.test(str);
}
import.meta.vitest?.test("isAnyVersionUuid", ({ expect }) => {
  expect(isAnyVersionUuid("123e4567-e89b-42d3-a456-426614174000")).toBe(true); // v4
  expect(isAnyVersionUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true); // v1
  expect(isAnyVersionUuid("123e4567-e89b-72d3-a456-426614174000")).toBe(true); // v7
  expect(isAnyVersionUuid("123e4567-e89b-82d3-a456-426614174000")).toBe(true); // v8
  expect(isAnyVersionUuid("123E4567-E89B-42D3-A456-426614174000")).toBe(true); // case-insensitive
  expect(isAnyVersionUuid("not-a-uuid")).toBe(false);
  expect(isAnyVersionUuid("123e4567-e89b-02d3-a456-426614174000")).toBe(false); // version 0
  expect(isAnyVersionUuid("123e4567-e89b-92d3-a456-426614174000")).toBe(false); // version 9
  expect(isAnyVersionUuid("123e4567-e89b-42d3-c456-426614174000")).toBe(false); // wrong variant
});
import.meta.vitest?.test("isUuid", ({ expect }) => {
  // Test with valid UUIDs
  expect(isUuid("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
  expect(isUuid("123e4567-e89b-42d3-8456-426614174000")).toBe(true);
  expect(isUuid("123e4567-e89b-42d3-9456-426614174000")).toBe(true);
  expect(isUuid("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
  expect(isUuid("123e4567-e89b-42d3-b456-426614174000")).toBe(true);

  // Test with invalid UUIDs
  expect(isUuid("")).toBe(false);
  expect(isUuid("not-a-uuid")).toBe(false);
  expect(isUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(false); // Wrong version (not 4)
  expect(isUuid("123e4567-e89b-42d3-c456-426614174000")).toBe(false); // Wrong variant (not 8, 9, a, or b)
  expect(isUuid("123e4567-e89b-42d3-a456-42661417400")).toBe(false); // Too short
  expect(isUuid("123e4567-e89b-42d3-a456-4266141740000")).toBe(false); // Too long
  expect(isUuid("123e4567-e89b-42d3-a456_426614174000")).toBe(false); // Wrong format (underscore instead of dash)

  // Test with uppercase letters (should fail as UUID should be lowercase)
  expect(isUuid("123E4567-E89B-42D3-A456-426614174000")).toBe(false);
});

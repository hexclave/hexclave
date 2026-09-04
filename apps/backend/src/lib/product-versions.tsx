import { PrismaClientTransaction } from "@/prisma-client";
import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import crypto from "crypto";

/**
 * Deterministically serializes an object to JSON with sorted keys.
 * This ensures the same object always produces the same string regardless of property order.
 */
export function canonicalJsonStringify(obj: unknown): string {
  return JSON.stringify(obj, (_, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce((sorted: Record<string, unknown>, key) => {
          sorted[key] = value[key];
          return sorted;
        }, {});
    }
    return value;
  });
}

/**
 * Computes a deterministic version ID from a productId and product JSON object.
 * Uses SHA-256 hash of the canonical JSON representation.
 *
 * Including productId ensures different products with identical JSON get separate rows.
 * Inline products (null productId) with identical JSON will still share a row,
 * which is acceptable since if they have the same productJson, semantically they are the same product.
 */
export function computeProductVersionId(productId: string | null, productJson: Json): string {
  const canonical = canonicalJsonStringify({ productId, productJson });
  const hash = crypto.createHash("sha256").update(canonical).digest();
  return encodeBase64(hash);
}

/**
 * Upserts a ProductVersion record and returns the productVersionId.
 * If a record with the same (tenancyId, productVersionId) exists, it's a no-op.
 */
export async function upsertProductVersion(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  productId: string | null,
  productJson: Json,
}): Promise<string> {
  const productVersionId = computeProductVersionId(options.productId, options.productJson);

  await options.prisma.productVersion.upsert({
    where: {
      tenancyId_productVersionId: {
        tenancyId: options.tenancyId,
        productVersionId,
      },
    },
    create: {
      tenancyId: options.tenancyId,
      productVersionId,
      productId: options.productId,
      productJson: options.productJson,
    },
    update: {},
  });

  return productVersionId;
}

/**
 * Retrieves a ProductVersion by tenancyId and productVersionId.
 * Throws if not found.
 */
export async function getProductVersion(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  productVersionId: string,
}): Promise<{ productId: string | null, productJson: Json }> {
  const version = await options.prisma.productVersion.findUnique({
    where: {
      tenancyId_productVersionId: {
        tenancyId: options.tenancyId,
        productVersionId: options.productVersionId,
      },
    },
  });

  if (!version) {
    throw new HexclaveAssertionError(
      "ProductVersion not found. This may indicate a race condition or deleted record.",
      {
        tenancyId: options.tenancyId,
        productVersionId: options.productVersionId,
      }
    );
  }

  return {
    productId: version.productId,
    productJson: version.productJson,
  };
}

import.meta.vitest?.describe("canonicalJsonStringify", (test) => {
  test("produces same output regardless of key order", ({ expect }) => {
    const obj1 = { b: 2, a: 1, c: 3 };
    const obj2 = { a: 1, b: 2, c: 3 };
    const obj3 = { c: 3, b: 2, a: 1 };

    expect(canonicalJsonStringify(obj1)).toBe(canonicalJsonStringify(obj2));
    expect(canonicalJsonStringify(obj2)).toBe(canonicalJsonStringify(obj3));
  });

  test("handles nested objects", ({ expect }) => {
    const obj1 = { outer: { b: 2, a: 1 }, z: 1 };
    const obj2 = { z: 1, outer: { a: 1, b: 2 } };

    expect(canonicalJsonStringify(obj1)).toBe(canonicalJsonStringify(obj2));
  });

  test("preserves array order", ({ expect }) => {
    const obj1 = { arr: [1, 2, 3] };
    const obj2 = { arr: [3, 2, 1] };

    expect(canonicalJsonStringify(obj1)).not.toBe(canonicalJsonStringify(obj2));
  });

  test("different objects produce different output", ({ expect }) => {
    const obj1 = { a: 1 };
    const obj2 = { a: 2 };

    expect(canonicalJsonStringify(obj1)).not.toBe(canonicalJsonStringify(obj2));
  });
});

import.meta.vitest?.describe("computeProductVersionId", (test) => {
  test("produces same hash for same productId and object with different key order", ({ expect }) => {
    const obj1 = { b: 2, a: 1, c: 3 };
    const obj2 = { a: 1, b: 2, c: 3 };

    expect(computeProductVersionId("prod-1", obj1)).toBe(computeProductVersionId("prod-1", obj2));
  });

  test("produces different hash for different objects", ({ expect }) => {
    const obj1 = { a: 1 };
    const obj2 = { a: 2 };

    expect(computeProductVersionId("prod-1", obj1)).not.toBe(computeProductVersionId("prod-1", obj2));
  });

  test("produces different hash for different productIds with same object", ({ expect }) => {
    const obj = { a: 1 };

    expect(computeProductVersionId("prod-1", obj)).not.toBe(computeProductVersionId("prod-2", obj));
  });

  test("produces same hash for null productIds with same object", ({ expect }) => {
    const obj = { a: 1 };

    expect(computeProductVersionId(null, obj)).toBe(computeProductVersionId(null, obj));
  });

  test("produces different hash for null productIds with different objects", ({ expect }) => {
    const obj1 = { a: 1 };
    const obj2 = { a: 2 };

    expect(computeProductVersionId(null, obj1)).not.toBe(computeProductVersionId(null, obj2));
  });

  test("hash is deterministic", ({ expect }) => {
    const obj = { foo: "bar", nested: { x: 1, y: 2 } };

    const hash1 = computeProductVersionId("prod-1", obj);
    const hash2 = computeProductVersionId("prod-1", obj);

    expect(hash1).toBe(hash2);
  });
});

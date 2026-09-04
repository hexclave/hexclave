import { Prisma } from "@/generated/prisma/client";
import { PrismaClientTransaction } from "@/prisma-client";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

export type CacheGetOrSetOptions<T> = {
  namespace: string,
  cacheKey: string,
  ttlMs: number,
  prisma: PrismaClientTransaction,
  loader: () => Promise<T>,
}

function computeExpiry(ttlMs: number): Date {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Cache TTL must be a positive number.");
  }
  return new Date(Date.now() + ttlMs);
}

export async function getOrSetCacheValue<T>(options: CacheGetOrSetOptions<T>): Promise<T> {
  if (!options.namespace) {
    throw new HexclaveAssertionError("Cache namespace must be a non-empty string.");
  }
  if (!options.cacheKey) {
    throw new HexclaveAssertionError("Cache key must be a non-empty string.");
  }

  const existing = await options.prisma.cacheEntry.findUnique({
    where: {
      namespace_cacheKey: {
        namespace: options.namespace,
        cacheKey: options.cacheKey,
      },
    },
  });

  if (existing && existing.expiresAt.getTime() > Date.now()) {
    // SAFETY: Cache entries are namespaced by the caller's key and are only
    // read through the same generic loader contract that wrote the payload.
    return existing.payload as T;
  }

  const value = await options.loader();
  const expiresAt = computeExpiry(options.ttlMs);
  const payload = value as Prisma.InputJsonValue;

  await options.prisma.cacheEntry.upsert({
    where: {
      namespace_cacheKey: {
        namespace: options.namespace,
        cacheKey: options.cacheKey,
      },
    },
    create: {
      namespace: options.namespace,
      cacheKey: options.cacheKey,
      payload,
      expiresAt,
    },
    update: {
      payload,
      expiresAt,
    },
  });

  return value;
}

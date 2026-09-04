import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { traceSpanHot } from "../../../otel.js";
import { createDatabaseSeq, Database, DatabaseSeq } from "../../index.js";
import { LowLevelDatabase, LowLevelDatabaseDebugEntry, LowLevelKvDump, LowLevelKvStore } from "../index.js";

const inMemoryLowLevelKvStores = new Map<`${"store" | "dump"}-${string}`, LowLevelKvStore & LowLevelKvDump>();
function arrayBuffersAreEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const aUint8Array = new Uint8Array(a);
  const bUint8Array = new Uint8Array(b);
  for (let i = 0; i < aUint8Array.length; i++) {
    if (aUint8Array[i] !== bUint8Array[i]) return false;
  }
  return true;
}
function arrayBufferFromUint8Array(value: Uint8Array) {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function compareArrayBuffers(a: ArrayBuffer, b: ArrayBuffer) {
  const aBytes = new Uint8Array(a);
  const bBytes = new Uint8Array(b);
  const commonLength = Math.min(aBytes.length, bBytes.length);
  for (let index = 0; index < commonLength; index++) {
    if (aBytes[index] !== bBytes[index]) return aBytes[index] - bBytes[index];
  }
  return aBytes.length - bBytes.length;
}

function encodeHex(value: Uint8Array) {
  return [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function decodeUtf8(buffer: ArrayBuffer) {
  try {
    return new TextDecoder("utf8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

export function declareInMemoryLowLevelDatabase(dbId: string): LowLevelDatabase {
  const debugEntriesByStoreId = new Map<`${"store" | "dump"}-${string}`, () => Promise<LowLevelDatabaseDebugEntry[]>>();
  const declareInMemoryLowLevelKvStoreOrDump = (storeOrDump: "store" | "dump", id: string): LowLevelKvStore & LowLevelKvDump => {
    const debugStoreId = `${storeOrDump}-${id}` as const;
    const attributes = { "bulldozer.low_level.backend": "in-memory", "bulldozer.low_level.kind": storeOrDump, "bulldozer.low_level.id": id };
    const existing = inMemoryLowLevelKvStores.get(debugStoreId);
    if (existing) {
      if (existing.debugEntries) debugEntriesByStoreId.set(debugStoreId, () => existing.debugEntries!());
      return existing;
    }

    const base64KeyToValue = new Map<string, ArrayBuffer>;
    const seqSentinel: DatabaseSeq = [] as unknown as DatabaseSeq;
    const reserveKeys = (count: number) => {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("KV dump reservation count must be a non-negative safe integer");
      return Array.from({ length: count }, () => crypto.getRandomValues(new Uint8Array(48)).buffer);
    };
    const result: LowLevelKvStore & LowLevelKvDump = {
      reserveKeys,
      async get(key: ArrayBuffer) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.get", attributes }, async () => {
          if (key.byteLength > 64) throw new Error("KV store key must be <= 64 bytes");
          return {
            buffer: base64KeyToValue.get(encodeBase64(new Uint8Array(key)))?.slice(0) ?? null,
            seq: seqSentinel,
          };
        });
      },
      async listEntries(options) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.listEntries", attributes }, async () => {
          const limit = options?.limit ?? 1000;
          if (!Number.isInteger(limit) || limit <= 0) throw new Error("KV store list limit must be a positive integer");
          if (options?.startAfter !== undefined && options.startAfter.byteLength > 64) throw new Error("KV store key must be <= 64 bytes");
          const matchingEntries = [...base64KeyToValue.entries()]
            .map(([keyBase64, value]) => ({
              key: arrayBufferFromUint8Array(Buffer.from(keyBase64, "base64")),
              value,
            }))
            .filter(entry => options?.startAfter === undefined || compareArrayBuffers(entry.key, options.startAfter) > 0)
            .sort((a, b) => compareArrayBuffers(a.key, b.key));
          return {
            entries: matchingEntries.slice(0, limit).map(({ key, value }) => ({ key, value: value.slice(0) })),
            hasMore: matchingEntries.length > limit,
          };
        });
      },
      async setAll(entries: Array<{ key: ArrayBuffer, value: ArrayBuffer }>) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.setAll", attributes: { ...attributes, "bulldozer.low_level.entry_count": entries.length } }, async () => {
          for (const { key, value } of entries) {
            if (key.byteLength > 64) throw new Error("KV store key must be <= 64 bytes");
            if (value.byteLength > 2_000_000_000) throw new Error("KV store value must be <= 2GB");
            base64KeyToValue.set(encodeBase64(new Uint8Array(key)), value.slice(0));
          }
          return {
            seq: seqSentinel,
          };
        });
      },
      async deleteAll(keys: ArrayBuffer[]) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.deleteAll", attributes: { ...attributes, "bulldozer.low_level.key_count": keys.length } }, async () => {
          for (const key of keys) {
            if (key.byteLength > 64) throw new Error("KV store key must be <= 64 bytes");
            base64KeyToValue.delete(encodeBase64(new Uint8Array(key)));
          }
          return {
            seq: seqSentinel,
          };
        });
      },
      async insertAll(values, options) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.insertAll", attributes: { ...attributes, "bulldozer.low_level.value_count": values.length } }, async () => {
          for (const value of values) {
            if (value.byteLength > 2_000_000_000) throw new Error("KV store value must be <= 2GB");
          }
          const keys = options?.keys ?? reserveKeys(values.length);
          if (keys.length !== values.length) throw new Error("KV dump insertion must provide exactly one key per value");
          if (new Set(keys.map(key => encodeBase64(new Uint8Array(key)))).size !== keys.length) {
            throw new Error("KV dump insertion keys must be unique");
          }
          return {
            keys,
            ...await result.setAll(keys.map((key, index) => ({ key, value: values[index] })), options),
          };
        });
      },
      async compareAndSetAll(entries, options) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.compareAndSetAll", attributes: { ...attributes, "bulldozer.low_level.entry_count": entries.length } }, async () => {
          for (const { key, compare, value } of entries) {
            if (key.byteLength > 64) throw new Error("KV store key must be <= 64 bytes");
            if (compare !== null && compare.byteLength > 2_000_000_000) throw new Error("KV store compare must be <= 2GB");
            if (value.byteLength > 2_000_000_000) throw new Error("KV store value must be <= 2GB");
          }
          const keys = new Set<string>();
          for (const { key } of entries) {
            const keyBase64 = encodeBase64(new Uint8Array(key));
            const previousSize = keys.size;
            keys.add(keyBase64);
            if (keys.size === previousSize) throw new Error("compareAndSetAll entries must not contain duplicate keys");
          }
          const results = entries.map(({ key, compare }) => {
            const existingValue = base64KeyToValue.get(encodeBase64(new Uint8Array(key)));
            return compare === null
              ? existingValue === undefined
              : existingValue !== undefined && arrayBuffersAreEqual(existingValue, compare);
          });
          const matchingEntries = entries.filter((_, index) => results[index]);
          const write = matchingEntries.length === 0
            ? { seq: options?.requiresSeq ?? seqSentinel }
            : await result.setAll(matchingEntries.map(({ key, value }) => ({ key, value })), options);
          return {
            results: results.map(wasSet => wasSet ? { wasSet: true, seq: write.seq } : { wasSet: false, seq: null }),
            seq: write.seq,
          };
        });
      },
      async debugEntries() {
        return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.debugEntries", attributes }, async () => [...base64KeyToValue.entries()]
          .sort(([a], [b]) => stringCompare(a, b))
          .map(([keyBase64, value]) => {
            const keyBytes = Buffer.from(keyBase64, "base64");
            return {
              keyBase64,
              keyUtf8: decodeUtf8(arrayBufferFromUint8Array(keyBytes)),
              keyHex: encodeHex(keyBytes),
              valueBase64: encodeBase64(new Uint8Array(value)),
              valueUtf8: decodeUtf8(value),
              valueByteLength: value.byteLength,
            };
          }));
      },
    };
    inMemoryLowLevelKvStores.set(debugStoreId, result);
    debugEntriesByStoreId.set(debugStoreId, () => result.debugEntries!());
    return result;
  };

  return {
    getDebugInfo() {
      return {
        backend: "in-memory",
        constructorArguments: { dbId },
        inMemoryLowLevelKvStores,
        debugEntriesByStoreId,
      };
    },
    declareKvDump(dumpId) {
      return declareInMemoryLowLevelKvStoreOrDump("dump", JSON.stringify([dbId, dumpId]));
    },
    declareKvStore(storeId) {
      return declareInMemoryLowLevelKvStoreOrDump("store", JSON.stringify([dbId, storeId]));
    },
    async waitUntilAvailable() {
      return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.waitUntilAvailable", attributes: { "bulldozer.low_level.backend": "in-memory" } }, async () => {});
    },
    async waitUntilDurable() {
      return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.waitUntilDurable", attributes: { "bulldozer.low_level.backend": "in-memory" } }, async () => {});
    },
    async waitUntilReplicated() {
      return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.waitUntilReplicated", attributes: { "bulldozer.low_level.backend": "in-memory" } }, async () => {});
    },
    async waitUntilConsistent() {
      return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.waitUntilConsistent", attributes: { "bulldozer.low_level.backend": "in-memory" } }, async () => {});
    },
    combineSeqs(...seqs) {
      return this.initialSeq;
    },
    async close() {
      // In-memory databases have no external resources to release.
    },
    async debugSnapshot() {
      return await traceSpanHot({ description: "bulldozer-js.low-level.in-memory.debugSnapshot", attributes: { "bulldozer.low_level.backend": "in-memory" } }, async () => {
        const stores: Record<string, LowLevelDatabaseDebugEntry[]> = {};
        const dumps: Record<string, LowLevelDatabaseDebugEntry[]> = {};
        for (const [storeId, entries] of debugEntriesByStoreId.entries()) {
          if (storeId.startsWith("store-")) {
            stores[String(JSON.parse(storeId.slice("store-".length))[1])] = await entries();
          } else {
            dumps[String(JSON.parse(storeId.slice("dump-".length))[1])] = await entries();
          }
        }
        return { stores, dumps };
      });
    },
    initialSeq: createDatabaseSeq(),
  };
}

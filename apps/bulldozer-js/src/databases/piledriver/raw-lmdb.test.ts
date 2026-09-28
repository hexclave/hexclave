import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, afterEach, describe, it } from "vitest";
import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import type { DatabaseSeq } from "../index.js";
import type { LowLevelDatabase, LowLevelKvStore } from "../low-level/index.js";
import { declareLmdbLowLevelDatabase } from "../low-level/implementations/lmdb.js";
import { asHeapObject, isPiledriverHeapObjectSymbol } from "./index.js";
import { declareBasePiledriverDatabase } from "./implementations/base.js";

const tempPaths: string[] = [];

type PendingWrite = {
  seq: DatabaseSeq,
  buffer: ArrayBuffer | null,
  resolved: boolean,
};

function wrapDelayedStoreVisibility(lowLevel: LowLevelDatabase, storeId: string): LowLevelDatabase {
  return {
    ...lowLevel,
    declareKvStore(id) {
      const store = lowLevel.declareKvStore(id);
      if (id !== storeId) return store;
      const availableBuffers = new Map<string, ArrayBuffer | null>();
      const pendingWrites = new Map<string, PendingWrite[]>();
      const pendingWritesBySeq = new Map<string, PendingWrite[]>();
      const availabilityPromises = new Map<string, Promise<void>>();
      const keyId = (key: ArrayBuffer) => encodeBase64(new Uint8Array(key));
      const seqId = (seq: DatabaseSeq) => JSON.stringify(seq);
      const clone = (buffer: ArrayBuffer | null) => buffer === null ? null : buffer.slice(0);
      const flushAvailableWrites = (key: string) => {
        const writes = pendingWrites.get(key);
        if (writes === undefined) return;
        while (writes[0]?.resolved === true) {
          const write = writes.shift();
          if (write === undefined) throw new Error("Pending low-level visibility write disappeared");
          availableBuffers.set(key, clone(write.buffer));
        }
        if (writes.length === 0) pendingWrites.delete(key);
      };
      const trackAvailability = (seq: DatabaseSeq) => {
        const id = seqId(seq);
        let availability = availabilityPromises.get(id);
        if (availability === undefined) {
          availability = lowLevel.waitUntilAvailable(seq).then(() => {
            const writes = pendingWritesBySeq.get(id) ?? [];
            for (const write of writes) write.resolved = true;
            pendingWritesBySeq.delete(id);
            for (const [key] of pendingWrites) flushAvailableWrites(key);
          });
          availabilityPromises.set(id, availability);
        }
      };
      const getAvailable = async (key: ArrayBuffer) => {
        const id = keyId(key);
        flushAvailableWrites(id);
        const pending = pendingWrites.get(id);
        if (pending !== undefined && pending.length > 0) {
          return { buffer: clone(availableBuffers.get(id) ?? null), seq: lowLevel.initialSeq };
        }
        const existing = await store.get(key);
        const buffer = clone(existing.buffer);
        availableBuffers.set(id, buffer);
        return { buffer, seq: existing.seq };
      };
      const wrapped: LowLevelKvStore = {
        ...store,
        get: getAvailable,
        async setAll(entries, options) {
          const previous = await Promise.all(entries.map(async ({ key }) => ({ key, existing: await getAvailable(key) })));
          const result = await store.setAll(entries, options);
          for (const [{ key, existing }, entry] of previous.map((value, index) => [value, entries[index]] as const)) {
            const id = keyId(key);
            const writes = pendingWrites.get(id) ?? [];
            if (writes.length === 0 && !availableBuffers.has(id)) availableBuffers.set(id, existing.buffer);
            const write = { seq: result.seq, buffer: entry.value.slice(0), resolved: false };
            writes.push(write);
            pendingWrites.set(id, writes);
            const seqWrites = pendingWritesBySeq.get(seqId(result.seq)) ?? [];
            seqWrites.push(write);
            pendingWritesBySeq.set(seqId(result.seq), seqWrites);
          }
          trackAvailability(result.seq);
          return result;
        },
        async deleteAll(keys, options) {
          const previous = await Promise.all(keys.map(async key => ({ key, existing: await getAvailable(key) })));
          const result = await store.deleteAll(keys, options);
          for (const { key, existing } of previous) {
            const id = keyId(key);
            const writes = pendingWrites.get(id) ?? [];
            if (writes.length === 0 && !availableBuffers.has(id)) availableBuffers.set(id, existing.buffer);
            const write = { seq: result.seq, buffer: null, resolved: false };
            writes.push(write);
            pendingWrites.set(id, writes);
            const seqWrites = pendingWritesBySeq.get(seqId(result.seq)) ?? [];
            seqWrites.push(write);
            pendingWritesBySeq.set(seqId(result.seq), seqWrites);
          }
          trackAvailability(result.seq);
          return result;
        },
      };
      return wrapped;
    },
  };
}

async function expectRootChildren(
  database: ReturnType<typeof declareBasePiledriverDatabase>,
  rootKey: ArrayBuffer,
  expected: unknown[],
) {
  const { object } = await database.getRootObject(rootKey);
  if (typeof object !== "object" || object === null || Array.isArray(object) || !("children" in object) || !Array.isArray(object.children)) {
    throw new Error("Expected root object with a children array");
  }
  const children = await Promise.all(object.children.map(async child => {
    if (typeof child === "object" && child !== null && !Array.isArray(child) && isPiledriverHeapObjectSymbol in child) return await child.get();
    return child;
  }));
  expect(children).toEqual(expected);
}

async function withDatabase(
  declareDatabase: typeof declareBasePiledriverDatabase,
  storeId: string,
  test: (database: ReturnType<typeof declareBasePiledriverDatabase>, lowLevel: LowLevelDatabase) => Promise<void>,
) {
  const path = await mkdtemp(join(tmpdir(), "piledriver-raw-lmdb-"));
  tempPaths.push(path);
  const lowLevel = wrapDelayedStoreVisibility(declareLmdbLowLevelDatabase({ path }), storeId);
  try {
    await test(declareDatabase(lowLevel), lowLevel);
  } finally {
    await lowLevel.close();
  }
}

async function countNonZeroReferenceMetadata(lowLevel: LowLevelDatabase) {
  const { entries } = await lowLevel.declareKvStore("piledriver-gc-reference-metadata-v3").listEntries();
  return entries.filter(({ value }) => {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
    return typeof parsed === "object"
      && parsed !== null
      && "referenceCount" in parsed
      && typeof parsed.referenceCount === "number"
      && parsed.referenceCount !== 0;
  }).length;
}

describe.each([
  { name: "base", declareDatabase: declareBasePiledriverDatabase },
])("Piledriver over raw LMDB ($name)", ({ declareDatabase }) => {
  it("preserves heap references when metadata visibility is delayed", { timeout: 30_000 }, async () => {
    await withDatabase(declareDatabase, "piledriver-gc-reference-metadata-v3", async (database, lowLevel) => {
      const rootKey = new TextEncoder().encode("metadata-root").buffer;
      const firstWrite = await database.setRootObject(rootKey, { children: [asHeapObject({ value: "first" })] });
      await lowLevel.waitUntilAvailable(firstWrite.seq);
      const secondWrite = await database.setRootObject(rootKey, { children: [asHeapObject({ value: "second" })] });
      await database.waitUntilAvailable(secondWrite.seq);
      await expectRootChildren(database, rootKey, [{ value: "second" }]);
    });
  });

  it("does not leak heap references when the first root write is still pending", { timeout: 30_000 }, async () => {
    await withDatabase(declareDatabase, "root", async (database, lowLevel) => {
      const rootKey = new TextEncoder().encode("root-first-write").buffer;
      const firstChildren = [asHeapObject({ value: "first-1" }), asHeapObject({ value: "first-2" })];
      const secondChildren = [asHeapObject({ value: "second-1" }), asHeapObject({ value: "second-2" }), asHeapObject({ value: "second-3" })];
      const firstWrite = await database.setRootObject(rootKey, { children: firstChildren });
      const secondWrite = await database.setRootObject(rootKey, { children: secondChildren });
      await database.waitUntilAvailable(secondWrite.seq);
      await expectRootChildren(database, rootKey, [{ value: "second-1" }, { value: "second-2" }, { value: "second-3" }]);
      expect(await countNonZeroReferenceMetadata(lowLevel)).toBe(secondChildren.length);
      await lowLevel.waitUntilAvailable(firstWrite.seq);
    });
  });

  it("dereferences heap references when deleting a pending root write", { timeout: 30_000 }, async () => {
    await withDatabase(declareDatabase, "root", async (database, lowLevel) => {
      const rootKey = new TextEncoder().encode("root-delete-pending").buffer;
      const firstChildren = [asHeapObject({ value: "first-1" }), asHeapObject({ value: "first-2" })];
      const firstWrite = await database.setRootObject(rootKey, { children: firstChildren });
      const deleteWrite = await database.deleteRootObject(rootKey);
      await database.waitUntilAvailable(deleteWrite.seq);
      expect(await countNonZeroReferenceMetadata(lowLevel)).toBe(0);
      await lowLevel.waitUntilAvailable(firstWrite.seq);
    });
  });
});

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

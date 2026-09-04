import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { declareLmdbLowLevelDatabase } from "../../../low-level/implementations/lmdb.js";
import type { LowLevelKvStore } from "../../../low-level/index.js";
import { asHeapObject, isPiledriverHeapObjectSymbol, type PiledriverDatabase } from "../../index.js";
import { declareBreezyPiledriverDatabase } from "./index.js";

const parseJson = (value: ArrayBuffer) => JSON.parse(new TextDecoder().decode(value));
const listEntries = async (store: LowLevelKvStore) => (await store.listEntries()).entries;
const debugSnapshot = async (database: PiledriverDatabase) => {
  if (database.debugSnapshot === undefined) throw new Error("Expected Breezy debug snapshot support");
  return await database.debugSnapshot();
};

describe("Breezy Piledriver", () => {
  it("atomically publishes shared references and revives zero-reference metadata", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const database = declareBreezyPiledriverDatabase(lmdbOptions);
    const inspector = declareLmdbLowLevelDatabase(lmdbOptions);
    try {
      const rootKey = new TextEncoder().encode("root").buffer;
      const child = asHeapObject({ value: "child" });
      await database.setRootObject(rootKey, child);
      const deleted = await database.deleteRootObject(rootKey);
      await database.waitUntilAvailable(deleted.seq);

      const candidates = inspector.declareKvStore("piledriver-gc-zero-reference-candidates-v3");
      expect(await listEntries(candidates)).toHaveLength(1);

      const parent = asHeapObject({ first: child, second: child });
      const written = await database.setRootObject(rootKey, parent);
      await database.waitUntilAvailable(written.seq);

      const metadata = inspector.declareKvStore("piledriver-gc-reference-metadata-v3");
      const referenceCounts = (await listEntries(metadata))
        .map(entry => parseJson(entry.value)["referenceCount"])
        .sort((a, b) => a - b);
      expect(referenceCounts).toEqual([1, 2]);
      expect(await listEntries(candidates)).toHaveLength(0);
      expect((await debugSnapshot(database)).heap).toHaveLength(2);

      const { object } = await database.getRootObject(rootKey);
      if (typeof object !== "object" || object === null || !(isPiledriverHeapObjectSymbol in object)) {
        throw new Error("Expected a heap object root");
      }
      const value = await object.get();
      expect(value).toEqual({ first: child, second: child });
    } finally {
      await inspector.close();
      await database.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("rolls back the heap insert when referenced metadata cannot be incremented", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const database = declareBreezyPiledriverDatabase(lmdbOptions);
    const inspector = declareLmdbLowLevelDatabase(lmdbOptions);
    try {
      const rootKey = new TextEncoder().encode("root").buffer;
      const failedRootKey = new TextEncoder().encode("failed-root").buffer;
      const child = asHeapObject({ value: "child" });
      await database.setRootObject(rootKey, child);
      const heapBefore = await debugSnapshot(database);
      expect(heapBefore.heap).toHaveLength(1);
      const childKeyBase64 = heapBefore.heap[0].keyBase64;

      const metadata = inspector.declareKvStore("piledriver-gc-reference-metadata-v3");
      const metadataEntries = await listEntries(metadata);
      const childMetadata = metadataEntries.find(entry => encodeBase64(new Uint8Array(entry.key)) === childKeyBase64);
      if (childMetadata === undefined) throw new Error("Expected metadata for the child heap object");
      const parsed = parseJson(childMetadata.value);
      const corrupted = await metadata.setAll([{
        key: childMetadata.key,
        value: new TextEncoder().encode(JSON.stringify({
          ...parsed,
          deletion: { nextReferenceIndex: 0, totalReferences: 1 },
        })).buffer,
      }]);
      await inspector.waitUntilAvailable(corrupted.seq);

      const innocent = asHeapObject({ value: "must also roll back" });
      await expect(database.setRootObject(failedRootKey, asHeapObject({ child, innocent }))).rejects.toThrow("deleting");
      expect((await debugSnapshot(database)).heap).toHaveLength(heapBefore.heap.length);
      await expect(database.getRootObject(failedRootKey)).rejects.toThrow("Root object not found");
    } finally {
      await inspector.close();
      await database.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("rolls back root replacement and deletion when the old reference cannot be decremented", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const database = declareBreezyPiledriverDatabase(lmdbOptions);
    const inspector = declareLmdbLowLevelDatabase(lmdbOptions);
    try {
      const rootKey = new TextEncoder().encode("root").buffer;
      const child = asHeapObject({ value: "still visible" });
      const written = await database.setRootObject(rootKey, child);
      await database.waitUntilAvailable(written.seq);

      const metadata = inspector.declareKvStore("piledriver-gc-reference-metadata-v3");
      const entries = await listEntries(metadata);
      expect(entries).toHaveLength(1);
      const removed = await metadata.deleteAll([entries[0].key]);
      await inspector.waitUntilAvailable(removed.seq);

      await expect(database.setRootObject(rootKey, { replacement: true })).rejects.toThrow("without reference metadata");
      await expect(database.deleteRootObject(rootKey)).rejects.toThrow("without reference metadata");
      const { object } = await database.getRootObject(rootKey);
      if (typeof object !== "object" || object === null || !(isPiledriverHeapObjectSymbol in object)) {
        throw new Error("Expected the original heap object root");
      }
      expect(await object.get()).toEqual({ value: "still visible" });
    } finally {
      await inspector.close();
      await database.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("persists directly published heap objects before reporting the root consistent", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    const writer = declareBreezyPiledriverDatabase(lmdbOptions);
    try {
      const written = await writer.setRootObject(rootKey, asHeapObject({ value: "persisted" }));
      await writer.waitUntilConsistent(written.seq);
    } finally {
      await writer.close();
    }

    const reader = declareBreezyPiledriverDatabase(lmdbOptions);
    try {
      const { object } = await reader.getRootObject(rootKey);
      if (typeof object !== "object" || object === null || !(isPiledriverHeapObjectSymbol in object)) {
        throw new Error("Expected a heap object root");
      }
      expect(await object.get()).toEqual({ value: "persisted" });
    } finally {
      await reader.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("atomically collects an unreachable graph and follows its cascade", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    const writer = declareBreezyPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(rootKey, asHeapObject({ child: asHeapObject({ value: "child" }) }));
    await writer.deleteRootObject(rootKey);
    await writer.close();

    const cutoff = Date.now() + 1;
    const collector = declareBreezyPiledriverDatabase(lmdbOptions, {
      garbageCollectionProcessStartedAtMillis: cutoff + 1,
    });
    try {
      const first = await collector.collectGarbage(cutoff, 1);
      expect(first.objects.deleted).toBe(1);
      expect(first.limits.moreEligibleWorkMayRemain).toBe(true);
      expect((await debugSnapshot(collector)).heap).toHaveLength(1);

      const second = await collector.collectGarbage(cutoff);
      expect(second.objects.deleted).toBe(1);
      expect(second.objects.childObjectsBecameUnreferenced).toBe(0);
      expect((await debugSnapshot(collector)).heap).toHaveLength(0);
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });
});

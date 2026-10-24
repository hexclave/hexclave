import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import * as lmdb from "lmdb";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { declareLmdbLowLevelDatabase } from "../../../low-level/implementations/lmdb.js";
import type { LowLevelKvStore } from "../../../low-level/index.js";
import { asHeapObject, isPiledriverHeapObjectSymbol, type PiledriverDatabase, type PiledriverObject } from "../../index.js";
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
        .map(entry => Reflect.get(parseJson(entry.value), "referenceCount"))
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

  it("leaves no partial writes behind when LMDB throws midway through a root write", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    // LMDB rejects keys over 1978 bytes, but only when the root itself is written, which is after
    // the write has already bumped `child`'s reference count. If that bump survived the failure,
    // `child` would look referenced forever (or, in the mirror case, unreferenced while still live).
    const tooLongRootKey = new Uint8Array(2000).fill(1).buffer;
    const writer = declareBreezyPiledriverDatabase(lmdbOptions);
    const child = asHeapObject({ value: "child" });
    await writer.setRootObject(rootKey, { child });
    // Matching LMDB's message makes sure the write got as far as the root put; an earlier
    // validation error would make this test pass without exercising the rollback.
    await expect(writer.setRootObject(tooLongRootKey, { child })).rejects.toThrow("maximum key size");
    await writer.deleteRootObject(rootKey);
    await writer.close();

    // GC only collects garbage from before the current process started, so "restart" first.
    const cutoff = Date.now() + 1;
    const collector = declareBreezyPiledriverDatabase(lmdbOptions, {
      garbageCollectionProcessStartedAtMillis: cutoff + 1,
    });
    try {
      // Nothing references `child` anymore, so it must be collected.
      const result = await collector.collectGarbage(cutoff);
      expect(result.objects.deleted).toBe(1);
      expect((await debugSnapshot(collector)).heap).toHaveLength(0);
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("saves heap objects containing very wide arrays and objects", async () => {
    // A million items is far past the ~130k elements that once overflowed the stack on Node's main
    // thread, and still past the limit inside vitest's worker threads, which have a larger stack.
    const width = 1_000_000;
    const wideArray = new Array<number>(width).fill(0);
    const wideObject = Object.fromEntries(wideArray.map((value, index) => [`k${index}`, value]));
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const database = declareBreezyPiledriverDatabase({ path, dbId: crypto.randomUUID() });
    try {
      for (const wide of [wideArray, wideObject]) {
        const rootKey = new TextEncoder().encode("root").buffer;
        await database.setRootObject(rootKey, asHeapObject({ wide }));
        const { object } = await database.getRootObject(rootKey);
        if (typeof object !== "object" || object === null || !(isPiledriverHeapObjectSymbol in object)) {
          throw new Error("Expected a heap object root");
        }
        expect(await object.get()).toEqual({ wide });
      }
    } finally {
      await database.close();
      await rm(path, { recursive: true, force: true });
    }
  }, 60_000);

  it("saves a deep chain of new heap objects created in one write", async () => {
    // Recursive planning overflowed at ~750 levels on Node's main thread and ~5.6k inside vitest.
    const depth = 20_000;
    let chain = asHeapObject({ leaf: true });
    for (let i = 0; i < depth; i++) chain = asHeapObject({ next: chain });
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    const writer = declareBreezyPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(rootKey, chain);
    await writer.close();

    // Read back from a fresh instance so the values come from LMDB, not the writer's heap cache.
    const reader = declareBreezyPiledriverDatabase(lmdbOptions);
    try {
      let node = (await reader.getRootObject(rootKey)).object;
      let levels = 0;
      while (typeof node === "object" && node !== null && isPiledriverHeapObjectSymbol in node) {
        const value = await node.get();
        if (typeof value !== "object" || value === null || !("next" in value)) {
          expect(value).toEqual({ leaf: true });
          break;
        }
        node = value.next;
        levels++;
      }
      expect(levels).toBe(depth);
    } finally {
      await reader.close();
      await rm(path, { recursive: true, force: true });
    }
  }, 60_000);

  it("packs newly written heap objects densely into LMDB pages", async () => {
    // LMDB keeps keys sorted in fixed-size pages. Inserting a key that belongs in the middle of a full
    // page splits it into two half-empty pages, so out-of-order inserts waste disk on prod's ~300 GiB
    // file. A tree with fanout 4 has parents and children interleaved in key order, like real writes.
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const dbId = crypto.randomUUID();
    const rootKey = new TextEncoder().encode("root").buffer;
    const tree = (depth: number): PiledriverObject => asHeapObject(depth === 0
      ? { leaf: "x".repeat(40) }
      : { children: Array.from({ length: 4 }, () => tree(depth - 1)) });
    const writer = declareBreezyPiledriverDatabase({ path, dbId });
    await writer.setRootObject(rootKey, tree(6));
    await writer.close();

    const environment = lmdb.open({ path, maxDbs: 1024 });
    try {
      const heapStore = environment.openDB<Buffer, Buffer>({ name: `${dbId}:dump:heap`, encoding: "binary", keyEncoding: "binary", useVersions: true });
      const stats = heapStore.getStats();
      const numberStat = (name: string) => {
        const value: unknown = Reflect.get(stats, name);
        return typeof value === "number" ? value : throwErr(`LMDB stats are missing ${name}`);
      };
      // Each LMDB entry also takes an 8-byte node header and a 2-byte slot, and each page a 16-byte
      // header, so a perfectly packed page is 100% full by this measure.
      let usedBytes = 0;
      for (const { key, value } of heapStore.getRange()) usedBytes += key.byteLength + value.byteLength + 10;
      expect(numberStat("entryCount")).toBe(5461);
      const leafPageFill = usedBytes / (numberStat("treeLeafPageCount") * (numberStat("pageSize") - 16));
      // Measured: ~0.50 when inserting in planner order, ~0.91 when inserting in key order.
      expect(leafPageFill).toBeGreaterThan(0.75);
    } finally {
      await environment.close();
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

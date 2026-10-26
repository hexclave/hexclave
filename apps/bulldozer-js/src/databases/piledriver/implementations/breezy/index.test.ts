import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import * as lmdb from "lmdb";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { declareLmdbLowLevelDatabase } from "../../../low-level/implementations/lmdb.js";
import type { LowLevelKvStore } from "../../../low-level/index.js";
import { ConcatTreeList } from "../../data-structures/concat-tree-list.js";
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

  it("keeps writing past heap objects saved before refcounts existed, and never deletes them", async () => {
    // Objects saved before refcount-based GC existed have no reference-metadata record, and their
    // true reference count is unknown. Like base, Breezy must treat them as "never delete": skip
    // their count changes and never start a count for them (a count started at zero could later
    // reach zero while older parents still point at them, and GC would delete live data).
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    const otherRootKey = new TextEncoder().encode("other").buffer;
    const database = declareBreezyPiledriverDatabase(lmdbOptions);
    const inspector = declareLmdbLowLevelDatabase(lmdbOptions);
    const metadata = inspector.declareKvStore("piledriver-gc-reference-metadata-v3");
    let legacyKeyBase64: string;
    try {
      await database.setRootObject(rootKey, asHeapObject({ value: "legacy" }));
      const entries = await listEntries(metadata);
      expect(entries).toHaveLength(1);
      legacyKeyBase64 = encodeBase64(new Uint8Array(entries[0].key));
      const removed = await metadata.deleteAll([entries[0].key]);
      await inspector.waitUntilAvailable(removed.seq);

      // Point at the legacy object from a second root, both directly and through a new (refcounted)
      // parent, then drop both roots' pointers to it.
      const legacyObject = (await database.getRootObject(rootKey)).object;
      await database.setRootObject(otherRootKey, { legacy: legacyObject, parent: asHeapObject({ child: legacyObject }) });
      await database.setRootObject(rootKey, { replacement: true });
      await database.deleteRootObject(otherRootKey);
      const legacyMetadata = (await listEntries(metadata)).filter(entry => encodeBase64(new Uint8Array(entry.key)) === legacyKeyBase64);
      expect(legacyMetadata).toEqual([]);
    } finally {
      await inspector.close();
      await database.close();
    }

    const cutoff = Date.now() + 1;
    const collector = declareBreezyPiledriverDatabase(lmdbOptions, { garbageCollectionProcessStartedAtMillis: cutoff + 1 });
    try {
      // The new parent is normal garbage and gets collected; deleting it skips the legacy child's
      // (missing) count, so the legacy object is all that remains.
      const result = await collector.collectGarbage(cutoff);
      expect(result.objects.deleted).toBe(1);
      expect((await debugSnapshot(collector)).heap.map(entry => entry.keyBase64)).toEqual([legacyKeyBase64]);
      expect((await collector.getRootObject(rootKey)).object).toEqual({ replacement: true });
    } finally {
      await collector.close();
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

  it("reads deeply nested values back after a restart", async () => {
    // A process that has been running a while optimizes its code and uses less stack per call, so it
    // could save nesting that a freshly started process then overflowed on while reading it back.
    const depth = 5_000;
    let value: PiledriverObject = "leaf";
    for (let i = 0; i < depth; i++) value = { m: value };
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    const writer = declareBreezyPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(rootKey, { deep: asHeapObject(value) });
    await writer.close();

    const reader = declareBreezyPiledriverDatabase(lmdbOptions);
    try {
      const root = (await reader.getRootObject(rootKey)).object;
      if (typeof root !== "object" || root === null || Array.isArray(root) || isPiledriverHeapObjectSymbol in root) throw new Error("Expected a plain root");
      const deep = root.deep;
      if (typeof deep !== "object" || deep === null || !(isPiledriverHeapObjectSymbol in deep)) throw new Error("Expected a heap object");
      let node = await deep.get();
      let levels = 0;
      while (typeof node === "object" && node !== null && !Array.isArray(node) && !(isPiledriverHeapObjectSymbol in node) && "m" in node) {
        node = node.m;
        levels++;
      }
      expect({ levels, leaf: node }).toEqual({ levels: depth, leaf: "leaf" });
    } finally {
      await reader.close();
      await rm(path, { recursive: true, force: true });
    }
  });

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

  it("rejects values that can't be saved as JSON instead of silently changing them", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const database = declareBreezyPiledriverDatabase({ path, dbId: crypto.randomUUID() });
    const rootKey = new TextEncoder().encode("root").buffer;
    // Callers can pass these despite the types (e.g. through a cast or untyped JSON handling). Each
    // one used to be silently dropped, saved as `{}`, or fail later with a confusing TypeError.
    const invalidValues = new Map<string, unknown>([
      ["a function", () => "f"],
      ["undefined", undefined],
      ["a bigint", 1n],
      ["a symbol", Symbol("s")],
      ["an array with a hole", [1, , 3]],
      ["a Date", new Date(0)],
      ["a Map", new Map([["k", 1]])],
      ["a class instance", new (class Point { x = 1; })()],
    ]);
    try {
      for (const [description, invalid] of invalidValues) {
        // Reflect.set stores the value without the type checker seeing it, like a cast would.
        const value: { [key: string]: PiledriverObject } = {};
        Reflect.set(value, "field", invalid);
        await expect(database.setRootObject(rootKey, asHeapObject(value)), description).rejects.toThrow("Cannot save");
        await expect(database.getRootObject(rootKey), description).rejects.toThrow("Root object not found");
      }

      // Objects without a prototype are still plain JSON-like data.
      const withoutPrototype: { [key: string]: PiledriverObject } = Object.create(null);
      withoutPrototype.field = "ok";
      await database.setRootObject(rootKey, asHeapObject(withoutPrototype));
      const { object } = await database.getRootObject(rootKey);
      if (typeof object !== "object" || object === null || !(isPiledriverHeapObjectSymbol in object)) {
        throw new Error("Expected a heap object root");
      }
      expect(await object.get()).toEqual({ field: "ok" });
    } finally {
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

  it("collects the new heap objects of a root write that failed after saving them", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const keptRootKey = new TextEncoder().encode("kept").buffer;
    const reusedRootKey = new TextEncoder().encode("reused").buffer;
    // Too long for LMDB, so the write fails only at the root put, after its new heap objects are saved.
    const tooLongRootKey = new Uint8Array(2000).fill(1).buffer;
    const writer = declareBreezyPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(keptRootKey, { kept: asHeapObject({ value: "kept" }) });
    const orphan = asHeapObject({ child: asHeapObject({ value: "orphaned child" }) });
    await expect(writer.setRootObject(tooLongRootKey, { orphan })).rejects.toThrow("maximum key size");
    // A heap object from a failed write can still be reused by a later write that succeeds.
    const reused = asHeapObject({ value: "reused" });
    await expect(writer.setRootObject(tooLongRootKey, { reused })).rejects.toThrow("maximum key size");
    await writer.setRootObject(reusedRootKey, { reused });
    await writer.close();

    const cutoff = Date.now() + 1;
    const collector = declareBreezyPiledriverDatabase(lmdbOptions, { garbageCollectionProcessStartedAtMillis: cutoff + 1 });
    try {
      const result = await collector.collectGarbage(cutoff);
      expect(result.objects.deleted).toBe(2);
      expect((await debugSnapshot(collector)).heap.map(entry => entry.serializedJson)).toEqual(expect.arrayContaining([{ value: "kept" }, { value: "reused" }]));
      expect((await debugSnapshot(collector)).heap).toHaveLength(2);
      const reusedRoot = (await collector.getRootObject(reusedRootKey)).object;
      expect(reusedRoot).toEqual({ reused: expect.anything() });
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("finishes writes and garbage collection already in progress before closing", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    const garbageRootKey = new TextEncoder().encode("garbage").buffer;
    const setup = declareBreezyPiledriverDatabase(lmdbOptions);
    await setup.setRootObject(garbageRootKey, { garbage: asHeapObject({ value: "garbage" }) });
    await setup.deleteRootObject(garbageRootKey);
    await setup.close();

    const cutoff = Date.now() + 1;
    const database = declareBreezyPiledriverDatabase(lmdbOptions, { garbageCollectionProcessStartedAtMillis: cutoff + 1 });
    const write = database.setRootObject(rootKey, { child: asHeapObject({ value: "written while closing" }) });
    const garbageCollection = database.collectGarbage(cutoff);
    // Not awaited before closing: close() itself must wait for both. Closing twice is allowed.
    await Promise.all([database.close(), database.close()]);
    await write;
    expect((await garbageCollection).objects.deleted).toBe(1);

    const reopened = declareBreezyPiledriverDatabase(lmdbOptions);
    try {
      expect((await debugSnapshot(reopened)).heap.map(entry => entry.serializedJson)).toEqual([{ value: "written while closing" }]);
    } finally {
      await reopened.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("lets other work run during a long read instead of holding the event loop until it ends", async () => {
    // LMDB reads are synchronous, so a read walking many heap objects never waits on real IO. Until the
    // event loop gets a turn, other requests can't run and JavaScript can't free the objects the read
    // already passed (WeakRef targets stay alive until the current task ends), so memory grows with
    // everything the read touches.
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    const valueCount = 20_000;
    const writer = declareBreezyPiledriverDatabase(lmdbOptions);
    const list = ConcatTreeList.concat(Array.from({ length: valueCount }, (_, i) => ConcatTreeList.fromEntries<PiledriverObject>([[`id${i}`, { i }]])), { arity: 2 });
    await writer.setRootObject(rootKey, { list: list.toPiledriverObject() });
    await writer.close();

    const reader = declareBreezyPiledriverDatabase(lmdbOptions);
    try {
      const root = (await reader.getRootObject(rootKey)).object;
      if (typeof root !== "object" || root === null || Array.isArray(root) || isPiledriverHeapObjectSymbol in root) throw new Error("Expected the root to be a plain object");
      const storedList = ConcatTreeList.fromPiledriverObject<PiledriverObject>(root.list ?? throwErr("Expected the root to contain the list"), { arity: 2 });
      let valuesRead = 0;
      let valuesReadWhenOtherWorkRan: number | null = null;
      setImmediate(() => {
        valuesReadWhenOtherWorkRan = valuesRead;
      });
      for await (const _ of storedList.values()) valuesRead++;
      expect(valuesRead).toBe(valueCount);
      expect(valuesReadWhenOtherWorkRan).not.toBeNull();
      expect(valuesReadWhenOtherWorkRan).toBeLessThan(valueCount / 2);
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

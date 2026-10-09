import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { registerErrorSink, throwErr, unregisterErrorSink } from "@hexclave/shared/dist/utils/errors";
import * as lmdb from "lmdb";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { declareLmdbLowLevelDatabase } from "../../../low-level/implementations/lmdb.js";
import type { LowLevelKvStore } from "../../../low-level/index.js";
import { ConcatTreeList } from "../../data-structures/concat-tree-list.js";
import { asHeapObject, isPiledriverHeapObjectSymbol, type PiledriverDatabase, type PiledriverObject } from "../../index.js";
import { declareBreezyLMDBPiledriverDatabase } from "./index.js";

const parseJson = (value: ArrayBuffer) => JSON.parse(new TextDecoder().decode(value));
const listEntries = async (store: LowLevelKvStore) => (await store.listEntries()).entries;
const debugSnapshot = async (database: PiledriverDatabase) => {
  if (database.debugSnapshot === undefined) throw new Error("Expected Breezy debug snapshot support");
  return await database.debugSnapshot();
};

describe("BreezyLMDB Piledriver", () => {
  it("atomically publishes shared references and revives zero-reference metadata", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const database = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
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
    const database = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
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
    const database = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
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
    const collector = declareBreezyLMDBPiledriverDatabase(lmdbOptions, { garbageCollectionProcessStartedAtMillis: cutoff + 1 });
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
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    const child = asHeapObject({ value: "child" });
    await writer.setRootObject(rootKey, { child });
    // Matching LMDB's message makes sure the write got as far as the root put; an earlier
    // validation error would make this test pass without exercising the rollback.
    await expect(writer.setRootObject(tooLongRootKey, { child })).rejects.toThrow("maximum key size");
    await writer.deleteRootObject(rootKey);
    await writer.close();

    // GC only collects garbage from before the current process started, so "restart" first.
    const cutoff = Date.now() + 1;
    const collector = declareBreezyLMDBPiledriverDatabase(lmdbOptions, {
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
    const database = declareBreezyLMDBPiledriverDatabase({ path, dbId: crypto.randomUUID() });
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
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(rootKey, chain);
    await writer.close();

    // Read back from a fresh instance so the values come from LMDB, not the writer's heap cache.
    const reader = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
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
    const depth = 20_000;
    let value: PiledriverObject = "leaf";
    for (let i = 0; i < depth; i++) value = { m: value };
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(rootKey, { deep: asHeapObject(value) });
    await writer.close();

    const reader = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
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
    const writer = declareBreezyLMDBPiledriverDatabase({ path, dbId });
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
    const database = declareBreezyLMDBPiledriverDatabase({ path, dbId: crypto.randomUUID() });
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
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    try {
      const written = await writer.setRootObject(rootKey, asHeapObject({ value: "persisted" }));
      await writer.waitUntilConsistent(written.seq);
    } finally {
      await writer.close();
    }

    const reader = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
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
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(keptRootKey, { kept: asHeapObject({ value: "kept" }) });
    const orphan = asHeapObject({ child: asHeapObject({ value: "orphaned child" }) });
    await expect(writer.setRootObject(tooLongRootKey, { orphan })).rejects.toThrow("maximum key size");
    // A heap object from a failed write can still be reused by a later write that succeeds.
    const reused = asHeapObject({ value: "reused" });
    await expect(writer.setRootObject(tooLongRootKey, { reused })).rejects.toThrow("maximum key size");
    await writer.setRootObject(reusedRootKey, { reused });
    await writer.close();

    const cutoff = Date.now() + 1;
    const collector = declareBreezyLMDBPiledriverDatabase(lmdbOptions, { garbageCollectionProcessStartedAtMillis: cutoff + 1 });
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
    const setup = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await setup.setRootObject(garbageRootKey, { garbage: asHeapObject({ value: "garbage" }) });
    await setup.deleteRootObject(garbageRootKey);
    await setup.close();

    const cutoff = Date.now() + 1;
    const database = declareBreezyLMDBPiledriverDatabase(lmdbOptions, { garbageCollectionProcessStartedAtMillis: cutoff + 1 });
    const write = database.setRootObject(rootKey, { child: asHeapObject({ value: "written while closing" }) });
    const garbageCollection = database.collectGarbage(cutoff);
    // Not awaited before closing: close() itself must wait for both. Closing twice is allowed.
    await Promise.all([database.close(), database.close()]);
    await write;
    expect((await garbageCollection).objects.deleted).toBe(1);

    const reopened = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    try {
      expect((await debugSnapshot(reopened)).heap.map(entry => entry.serializedJson)).toEqual([{ value: "written while closing" }]);
    } finally {
      await reopened.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("finishes heap reads already in progress before closing, and rejects ones started after", async () => {
    // Reads pause every so often to let other requests run (see the next test). Closing LMDB during a
    // pause made the read fail when it resumed.
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    const valueCount = 2_500;
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(rootKey, { items: Array.from({ length: valueCount + 1 }, (_, i) => asHeapObject({ i })) });
    await writer.close();

    const reader = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    try {
      const root = (await reader.getRootObject(rootKey)).object;
      if (typeof root !== "object" || root === null || Array.isArray(root) || isPiledriverHeapObjectSymbol in root || !Array.isArray(root.items)) throw new Error("Expected the root to hold the items");
      const heapObjects = root.items.map(item => typeof item === "object" && item !== null && isPiledriverHeapObjectSymbol in item ? item : throwErr("Expected a heap object"));
      const unreadHeapObject = heapObjects.pop() ?? throwErr("Expected one heap object kept unread");
      const reads = heapObjects.map(heapObject => heapObject.get());
      const closing = reader.close();
      await expect(unreadHeapObject.get()).rejects.toThrow("Breezy Piledriver database is closed");
      await expect(reader.getRootObject(rootKey)).rejects.toThrow("Breezy Piledriver database is closed");
      await closing;
      expect(await Promise.all(reads)).toEqual(Array.from({ length: valueCount }, (_, i) => ({ i })));
    } finally {
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
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    const list = ConcatTreeList.concat(Array.from({ length: valueCount }, (_, i) => ConcatTreeList.fromEntries<PiledriverObject>([[`id${i}`, { i }]])), { arity: 2 });
    await writer.setRootObject(rootKey, { list: list.toPiledriverObject() });
    await writer.close();

    const reader = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
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

  it("reports stored bytes that aren't valid UTF-8 and keeps serving the value", async () => {
    // Piledriver only writes valid UTF-8, so invalid bytes mean the value was damaged after it was
    // written (disk, filesystem or LMDB). Reads keep working, with the bad bytes shown as U+FFFD, and
    // the report says where the value is and how to repair it.
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const dbId = crypto.randomUUID();
    const rootKey = new TextEncoder().encode("root").buffer;
    const writer = declareBreezyLMDBPiledriverDatabase({ path, dbId });
    await writer.setRootObject(rootKey, { value: asHeapObject({ secret: "SECRET-VALUE", name: "café" }) });
    await writer.close();

    // Damage one byte inside the stored string, directly in LMDB.
    const lmdbRoot = lmdb.open({ path, maxDbs: 1024 });
    const heap = lmdbRoot.openDB<Buffer, Uint8Array>({ name: `${dbId}:dump:heap`, encoding: "binary", keyEncoding: "binary", useVersions: true });
    let damagedKeyBase64: string | null = null;
    for (const { key, value, version } of [...heap.getRange({ versions: true })]) {
      const bytes = Buffer.from(value);
      const index = bytes.indexOf("SECRET-VALUE");
      if (index === -1) continue;
      bytes[index + 3] = 0xff;
      damagedKeyBase64 = encodeBase64(new Uint8Array(key));
      await heap.put(key, bytes, version ?? throwErr("Breezy heap entries are versioned"));
    }
    await lmdbRoot.close();
    if (damagedKeyBase64 === null) throw new Error("Expected to find the stored value");

    const reports: { location: string, error: unknown }[] = [];
    const recordReport = (location: string, error: unknown) => {
      reports.push({ location, error });
    };
    registerErrorSink(recordReport);
    const reader = declareBreezyLMDBPiledriverDatabase({ path, dbId });
    try {
      const root = (await reader.getRootObject(rootKey)).object;
      if (typeof root !== "object" || root === null || Array.isArray(root) || isPiledriverHeapObjectSymbol in root) throw new Error("Expected a plain root");
      const value = root.value;
      if (typeof value !== "object" || value === null || !(isPiledriverHeapObjectSymbol in value)) throw new Error("Expected a heap object");
      expect(await value.get()).toEqual({ secret: "SEC\uFFFDET-VALUE", name: "café" });
      const damageReports = reports.filter(report => report.location === "bulldozer-js:piledriver-damaged-stored-value");
      expect(damageReports).toHaveLength(1);
      expect(damageReports[0].error).toMatchObject({
        message: expect.stringContaining("not valid UTF-8"),
        extraData: { storedAt: `heap object ${damagedKeyBase64}`, howToFix: expect.arrayContaining([expect.stringContaining("bulldozer-payments-init")]) },
      });
    } finally {
      unregisterErrorSink(recordReport);
      await reader.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("fails with the likely cause when a value was written with LMDB compression and read without it", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    const writer = declareBreezyLMDBPiledriverDatabase({ ...lmdbOptions, compression: true });
    // lmdb-js only compresses values over 1,000 bytes.
    await writer.setRootObject(rootKey, { value: asHeapObject({ metadata: "plan-".repeat(400) }) });
    await writer.close();

    const reader = declareBreezyLMDBPiledriverDatabase({ ...lmdbOptions, compression: false });
    try {
      const root = (await reader.getRootObject(rootKey)).object;
      if (typeof root !== "object" || root === null || Array.isArray(root) || isPiledriverHeapObjectSymbol in root) throw new Error("Expected a plain root");
      const value = root.value;
      if (typeof value !== "object" || value === null || !(isPiledriverHeapObjectSymbol in value)) throw new Error("Expected a heap object");
      await expect(value.get()).rejects.toThrow(/heap object .* is not valid JSON.*compression/s);
    } finally {
      await reader.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("atomically collects an unreachable graph and follows its cascade", async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const rootKey = new TextEncoder().encode("root").buffer;
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(rootKey, asHeapObject({ child: asHeapObject({ value: "child" }) }));
    await writer.deleteRootObject(rootKey);
    await writer.close();

    const cutoff = Date.now() + 1;
    const collector = declareBreezyLMDBPiledriverDatabase(lmdbOptions, {
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

  it("decrements a child once per parent when both parents are deleted in the same GC transaction", async () => {
    // GC deletes several objects per transaction. When two of them point at the same child, the
    // second decrement must start from the first one's result, or the child is left at a count of
    // 1 with nothing pointing at it and is never collected.
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    const firstRootKey = new TextEncoder().encode("first").buffer;
    const secondRootKey = new TextEncoder().encode("second").buffer;
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    const sharedChild = asHeapObject({ value: "shared" });
    await writer.setRootObject(firstRootKey, asHeapObject({ child: sharedChild }));
    await writer.setRootObject(secondRootKey, asHeapObject({ child: sharedChild }));
    expect((await debugSnapshot(writer)).heap).toHaveLength(3);
    await writer.deleteRootObject(firstRootKey);
    await writer.deleteRootObject(secondRootKey);
    await writer.close();

    const cutoff = Date.now() + 1;
    const collector = declareBreezyLMDBPiledriverDatabase(lmdbOptions, { garbageCollectionProcessStartedAtMillis: cutoff + 1 });
    const inspector = declareLmdbLowLevelDatabase(lmdbOptions);
    try {
      // A limit of 2 makes exactly the two parents one batch.
      const parents = await collector.collectGarbage(cutoff, 2);
      expect(parents.objects.deleted).toBe(2);
      expect(parents.objects.childObjectsBecameUnreferenced).toBe(1);
      expect(parents.limits.moreEligibleWorkMayRemain).toBe(true);

      const child = await collector.collectGarbage(cutoff);
      expect(child.objects.deleted).toBe(1);
      expect(child.limits.moreEligibleWorkMayRemain).toBe(false);
      expect((await debugSnapshot(collector)).heap).toHaveLength(0);
      expect(await listEntries(inspector.declareKvStore("piledriver-gc-reference-metadata-v3"))).toEqual([]);
      expect(await listEntries(inspector.declareKvStore("piledriver-gc-zero-reference-candidates-v3"))).toEqual([]);
    } finally {
      await inspector.close();
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("collects garbage spanning several GC transactions and stops at the requested limit", { timeout: 30_000 }, async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    const lmdbOptions = { path, dbId: crypto.randomUUID() };
    // More than one transaction's worth of deletions (64), so the limit lands mid-batch.
    const garbageCount = 150;
    const rootKeys = Array.from({ length: garbageCount }, (_, index) => new TextEncoder().encode(`root-${index}`).buffer);
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    for (const [index, rootKey] of rootKeys.entries()) await writer.setRootObject(rootKey, asHeapObject({ index }));
    const keptRootKey = new TextEncoder().encode("kept").buffer;
    await writer.setRootObject(keptRootKey, asHeapObject({ kept: true }));
    for (const rootKey of rootKeys) await writer.deleteRootObject(rootKey);
    await writer.close();

    const cutoff = Date.now() + 1;
    const collector = declareBreezyLMDBPiledriverDatabase(lmdbOptions, { garbageCollectionProcessStartedAtMillis: cutoff + 1 });
    try {
      const first = await collector.collectGarbage(cutoff, 100);
      expect(first.objects.deleted).toBe(100);
      expect(first.limits.limitReached).toBe(true);
      expect(first.limits.moreEligibleWorkMayRemain).toBe(true);
      expect((await debugSnapshot(collector)).heap).toHaveLength(garbageCount - 100 + 1);

      const rest = await collector.collectGarbage(cutoff);
      expect(rest.objects.deleted).toBe(garbageCount - 100);
      expect(rest.limits.moreEligibleWorkMayRemain).toBe(false);
      expect((await debugSnapshot(collector)).heap).toHaveLength(1);
      const kept = (await collector.getRootObject(keptRootKey)).object;
      if (typeof kept !== "object" || kept === null || !(isPiledriverHeapObjectSymbol in kept)) throw new Error("Expected the kept root to be a heap object");
      expect(await kept.get()).toEqual({ kept: true });
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });
});

// These tests write hundreds of objects one awaited write at a time; the slowest take ~4 s locally,
// too close to Vitest's 5 s default for slower CI machines.
describe("Breezy Piledriver garbage collection in batches", { timeout: 30_000 }, () => {
  const rootKey = (name: string) => new TextEncoder().encode(name).buffer;
  const openTemporary = async () => {
    const path = await mkdtemp(join(tmpdir(), "piledriver-breezy-"));
    return { path, lmdbOptions: { path, dbId: crypto.randomUUID() } };
  };
  // GC only collects garbage from before the current process started, so tests "restart" by opening
  // a second database whose process start is after everything written so far.
  const openCollector = (lmdbOptions: { path: string, dbId: string }) => {
    const cutoff = Date.now() + 1;
    return { cutoff, collector: declareBreezyLMDBPiledriverDatabase(lmdbOptions, { garbageCollectionProcessStartedAtMillis: cutoff + 1 }) };
  };
  /** Writes `count` roots, each pointing at its own heap object, then deletes them all. */
  const writeGarbage = async (database: PiledriverDatabase, count: number, valueOf: (index: number) => PiledriverObject = index => asHeapObject({ index })) => {
    for (let index = 0; index < count; index++) await database.setRootObject(rootKey(`garbage-${index}`), valueOf(index));
    for (let index = 0; index < count; index++) await database.deleteRootObject(rootKey(`garbage-${index}`));
  };
  /**
   * Gives the GC candidate at `candidateIndex` (in collection order) a live reference count while it
   * stays in the candidate index, as if a write had raced in. GC then fails when it reaches it.
   */
  const giveCandidateALiveReferenceCount = async (lmdbOptions: { path: string, dbId: string }, options: { candidateIndex: number, expectedCandidates: number }) => {
    const inspector = declareLmdbLowLevelDatabase(lmdbOptions);
    try {
      const metadataStore = inspector.declareKvStore("piledriver-gc-reference-metadata-v3");
      const candidates = await listEntries(inspector.declareKvStore("piledriver-gc-zero-reference-candidates-v3"));
      expect(candidates).toHaveLength(options.expectedCandidates);
      const heapKey = new Uint8Array(candidates[options.candidateIndex].key).slice(8).buffer;
      const metadata = (await metadataStore.get(heapKey)).buffer ?? throwErr("Expected metadata for a GC candidate");
      const written = await metadataStore.setAll([{ key: heapKey, value: new TextEncoder().encode(JSON.stringify({ ...parseJson(metadata), referenceCount: 1 })).buffer }]);
      await inspector.waitUntilAvailable(written.seq);
    } finally {
      await inspector.close();
    }
  };
  const expectHeapObject = (value: PiledriverObject) => {
    if (typeof value !== "object" || value === null || !(isPiledriverHeapObjectSymbol in value)) throw new Error("Expected a heap object");
    return value;
  };
  const expectPlainObject = (value: PiledriverObject) => {
    if (typeof value !== "object" || value === null || Array.isArray(value) || isPiledriverHeapObjectSymbol in value) throw new Error("Expected a plain object");
    return value;
  };

  // The batch size is 64, so these sit on either side of one and two full batches.
  it.each([1, 63, 64, 65, 128, 129])("collects all of %i garbage objects in one call", async (garbageCount) => {
    const { path, lmdbOptions } = await openTemporary();
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(rootKey("kept"), asHeapObject({ kept: true }));
    await writeGarbage(writer, garbageCount);
    await writer.close();

    const { cutoff, collector } = openCollector(lmdbOptions);
    try {
      const result = await collector.collectGarbage(cutoff, 10_000);
      expect(result.objects.deleted).toBe(garbageCount);
      expect(result.objects.candidatesExamined).toBe(garbageCount);
      expect(result.limits.limitReached).toBe(false);
      expect(result.limits.moreEligibleWorkMayRemain).toBe(false);
      expect((await debugSnapshot(collector)).heap).toHaveLength(1);
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it.each([
    { garbageCount: 65, maxObjects: 64, expectedDeleted: 64, limitReached: true, moreEligibleWorkMayRemain: true },
    { garbageCount: 64, maxObjects: 64, expectedDeleted: 64, limitReached: true, moreEligibleWorkMayRemain: false },
    { garbageCount: 130, maxObjects: 129, expectedDeleted: 129, limitReached: true, moreEligibleWorkMayRemain: true },
    { garbageCount: 0, maxObjects: 10, expectedDeleted: 0, limitReached: false, moreEligibleWorkMayRemain: false },
  ])("stops at maxObjects $maxObjects with $garbageCount garbage objects", async ({ garbageCount, maxObjects, expectedDeleted, limitReached, moreEligibleWorkMayRemain }) => {
    const { path, lmdbOptions } = await openTemporary();
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(rootKey("kept"), asHeapObject({ kept: true }));
    await writeGarbage(writer, garbageCount);
    await writer.close();

    const { cutoff, collector } = openCollector(lmdbOptions);
    try {
      const result = await collector.collectGarbage(cutoff, maxObjects);
      expect(result.objects.deleted).toBe(expectedDeleted);
      expect(result.limits.limitReached).toBe(limitReached);
      expect(result.limits.moreEligibleWorkMayRemain).toBe(moreEligibleWorkMayRemain);
      expect((await debugSnapshot(collector)).heap).toHaveLength(1 + garbageCount - expectedDeleted);
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("collects a child shared by parents that land in different batches", async () => {
    // 65 parents fill one batch and spill one into the next, so the shared child's count is
    // decremented by two different transactions and only reaches zero in the second.
    const { path, lmdbOptions } = await openTemporary();
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    const sharedChild = asHeapObject({ value: "shared" });
    await writer.setRootObject(rootKey("kept"), asHeapObject({ kept: true }));
    await writeGarbage(writer, 65, index => asHeapObject({ index, child: sharedChild }));
    await writer.close();

    const { cutoff, collector } = openCollector(lmdbOptions);
    const inspector = declareLmdbLowLevelDatabase(lmdbOptions);
    try {
      const result = await collector.collectGarbage(cutoff, 10_000);
      expect(result.objects.deleted).toBe(66);
      expect(result.objects.childObjectsBecameUnreferenced).toBe(1);
      expect((await debugSnapshot(collector)).heap).toHaveLength(1);
      expect(await listEntries(inspector.declareKvStore("piledriver-gc-reference-metadata-v3"))).toHaveLength(1);
      expect(await listEntries(inspector.declareKvStore("piledriver-gc-zero-reference-candidates-v3"))).toEqual([]);
    } finally {
      await inspector.close();
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("collects a child that one parent references several times alongside another parent in the same batch", async () => {
    const { path, lmdbOptions } = await openTemporary();
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    const child = asHeapObject({ value: "child" });
    await writeGarbage(writer, 2, index => asHeapObject(index === 0 ? { a: child, b: child, list: [child, child] } : { child }));
    await writer.close();

    const { cutoff, collector } = openCollector(lmdbOptions);
    try {
      const result = await collector.collectGarbage(cutoff, 10_000);
      expect(result.objects.deleted).toBe(3);
      expect(result.references.outgoingEdgesProcessed).toBe(5);
      expect((await debugSnapshot(collector)).heap).toHaveLength(0);
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("follows a cascade much deeper than one batch within a single call", async () => {
    // Each link only becomes a candidate once its parent is deleted, so every batch holds one object
    // and the loop has to keep picking up candidates that earlier batches created.
    const { path, lmdbOptions } = await openTemporary();
    const depth = 150;
    let chain = asHeapObject({ leaf: true });
    for (let index = 0; index < depth; index++) chain = asHeapObject({ index, next: chain });
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(rootKey("chain"), chain);
    await writer.deleteRootObject(rootKey("chain"));
    await writer.close();

    const { cutoff, collector } = openCollector(lmdbOptions);
    try {
      const partial = await collector.collectGarbage(cutoff, 10);
      expect(partial.objects.deleted).toBe(10);
      expect(partial.limits.moreEligibleWorkMayRemain).toBe(true);
      const rest = await collector.collectGarbage(cutoff, 10_000);
      expect(rest.objects.deleted).toBe(depth + 1 - 10);
      expect(rest.limits.moreEligibleWorkMayRemain).toBe(false);
      expect((await debugSnapshot(collector)).heap).toHaveLength(0);
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("rolls back a whole batch when one of its objects fails a safety check", async () => {
    // If a batch were applied object by object, the objects before the bad one would stay deleted
    // while the error reported that the GC call failed. The batch must be all-or-nothing.
    const { path, lmdbOptions } = await openTemporary();
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writeGarbage(writer, 40);
    await writer.close();
    await giveCandidateALiveReferenceCount(lmdbOptions, { candidateIndex: 19, expectedCandidates: 40 });

    const { cutoff, collector } = openCollector(lmdbOptions);
    try {
      await expect(collector.collectGarbage(cutoff, 10_000)).rejects.toThrow("still has live references");
      expect((await debugSnapshot(collector)).heap).toHaveLength(40);
      // The failed call must not leave GC marked as running.
      await expect(collector.collectGarbage(cutoff, 10_000)).rejects.toThrow("still has live references");
      // A limit that ends the first batch before the bad object deletes exactly that many.
      const beforeCorrupted = await collector.collectGarbage(cutoff, 19);
      expect(beforeCorrupted.objects.deleted).toBe(19);
      expect((await debugSnapshot(collector)).heap).toHaveLength(21);
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("starts a new GC transaction once a batch has made enough child refcount updates", async () => {
    // Three garbage parents with 3,000 children each fit in one 64-object batch, but the first two
    // already make 6,000 refcount updates, past the per-transaction budget, so the third must be in a
    // later transaction. Making the third fail shows where the split is: the two before it stay
    // deleted. In a single transaction, all three would have rolled back.
    const { path, lmdbOptions } = await openTemporary();
    const childrenPerParent = 3000;
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writeGarbage(writer, 3, index => asHeapObject({ children: Array.from({ length: childrenPerParent }, (_, child) => asHeapObject({ index, child })) }));
    await writer.close();
    await giveCandidateALiveReferenceCount(lmdbOptions, { candidateIndex: 2, expectedCandidates: 3 });

    const { cutoff, collector } = openCollector(lmdbOptions);
    try {
      await expect(collector.collectGarbage(cutoff, 100_000)).rejects.toThrow("still has live references");
      const parentsLeft = (await debugSnapshot(collector)).heap.filter(entry => JSON.stringify(entry.serializedJson).includes("\"children\""));
      expect(parentsLeft).toHaveLength(1);
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("counts candidates the budget leaves out as read again by the next batch", async () => {
    // The first batch reads all three parents, but the first two use up the budget, so the third is
    // read again by a later batch. Children reference nothing, so nothing else is read twice.
    const { path, lmdbOptions } = await openTemporary();
    const childrenPerParent = 3000;
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writeGarbage(writer, 3, index => asHeapObject({ children: Array.from({ length: childrenPerParent }, (_, child) => asHeapObject({ index, child })) }));
    await writer.close();

    const { cutoff, collector } = openCollector(lmdbOptions);
    try {
      const result = await collector.collectGarbage(cutoff, 100_000);
      const objectCount = 3 + 3 * childrenPerParent;
      expect(result.objects.deleted).toBe(objectCount);
      expect(result.objects.candidatesExamined).toBe(objectCount);
      expect(result.scanning.candidateIndexEntriesRead).toBe(objectCount + 1);
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("rejects a maxObjects of 0 without deleting anything", async () => {
    const { path, lmdbOptions } = await openTemporary();
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writeGarbage(writer, 5);
    await writer.close();

    const { cutoff, collector } = openCollector(lmdbOptions);
    try {
      await expect(collector.collectGarbage(cutoff, 0)).rejects.toThrow("maxObjects must be a positive safe integer");
      expect((await debugSnapshot(collector)).heap).toHaveLength(5);
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("runs only one of two GC calls started together, and that one completes", async () => {
    const { path, lmdbOptions } = await openTemporary();
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writeGarbage(writer, 200);
    await writer.close();

    const { cutoff, collector } = openCollector(lmdbOptions);
    try {
      // The running check comes after GC initialization awaits, so either call may be the one that runs.
      const results = await Promise.allSettled([collector.collectGarbage(cutoff, 10_000), collector.collectGarbage(cutoff, 10_000)]);
      const completed = results.flatMap(result => result.status === "fulfilled" ? [result.value.objects.deleted] : []);
      const rejected = results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
      expect(completed).toEqual([200]);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toContain("already running");
      expect((await debugSnapshot(collector)).heap).toHaveLength(0);
    } finally {
      await collector.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("keeps a shared child alive when writes re-reference it while GC deletes its old parents", async () => {
    // GC batches decrement the shared child while concurrent writes increment it and delete the root
    // that kept it alive. Whatever the interleaving, the copies that survive must still read it,
    // and once everything is collected again only those copies and the child may remain.
    const { path, lmdbOptions } = await openTemporary();
    const writer = declareBreezyLMDBPiledriverDatabase(lmdbOptions);
    await writer.setRootObject(rootKey("live"), asHeapObject({ child: asHeapObject({ value: "shared" }) }));
    const liveParent = expectHeapObject((await writer.getRootObject(rootKey("live"))).object);
    const sharedChild = expectPlainObject(await liveParent.get()).child;
    await writeGarbage(writer, 300, index => asHeapObject({ index, child: sharedChild }));
    await writer.close();

    const { cutoff, collector } = openCollector(lmdbOptions);
    const copyCount = 30;
    try {
      const garbageCollection = collector.collectGarbage(cutoff, 10_000);
      const parent = expectHeapObject((await collector.getRootObject(rootKey("live"))).object);
      const child = expectPlainObject(await parent.get()).child;
      for (let index = 0; index < copyCount; index++) {
        await collector.setRootObject(rootKey(`copy-${index}`), asHeapObject({ index, child }));
        if (index === copyCount / 2) await collector.deleteRootObject(rootKey("live"));
        if (index % 2 === 0) await collector.deleteRootObject(rootKey(`copy-${index}`));
      }
      expect((await garbageCollection).objects.deleted).toBe(300);
    } finally {
      await collector.close();
    }

    const { cutoff: finalCutoff, collector: finalCollector } = openCollector(lmdbOptions);
    try {
      await finalCollector.collectGarbage(finalCutoff, 10_000);
      // 15 surviving copies, plus the shared child they all point at.
      expect((await debugSnapshot(finalCollector)).heap).toHaveLength(copyCount / 2 + 1);
      for (let index = 1; index < copyCount; index += 2) {
        const copy = expectPlainObject(await expectHeapObject((await finalCollector.getRootObject(rootKey(`copy-${index}`))).object).get());
        expect(await expectHeapObject(copy.child).get()).toEqual({ value: "shared" });
      }
    } finally {
      await finalCollector.close();
      await rm(path, { recursive: true, force: true });
    }
  });
});

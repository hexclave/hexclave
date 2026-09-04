import { decodeBase64, encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { shouldSuppressPeriodicBulldozerLogs } from "../../../logging.js";
import { traceSpan, traceSpanHot } from "../../../otel.js";
import { DatabaseSeq } from "../../index.js";
import { LowLevelDatabase } from "../../low-level/index.js";
import { declarePiledriverGarbageCollector } from "../gc.js";
import { heapObjectsByObject, isPiledriverHeapObjectSymbol, PiledriverDatabase, PiledriverObject, PiledriverHeapObject } from "../index.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const piledriverProcessStartedAtMillis = Date.now();

export type PiledriverDatabaseOptions = {
  disableHeapReadCache?: boolean,
  /**
   * Overrides the process-lifetime GC barrier for isolated tests and embedders that supervise
   * Piledriver in a longer-lived host process. Production Bulldozer uses the module-load time.
   */
  garbageCollectionProcessStartedAtMillis?: number,
};

// Tracks the chain of *heap objects* currently being serialized, so heap cycles fail fast with
// a clear error instead of deadlocking on their own memoized promise. Sibling/DAG sharing is
// fine: only true ancestors are in the path. Plain-object cycles are detected separately with a
// push/pop set during the synchronous payload walk.
type HeapSerializationPath = ReadonlySet<PiledriverHeapObject>;
type PiledriverSerializationTimingStats = {
  primitiveNodes: number,
  arrayNodes: number,
  arrayItems: number,
  objectNodes: number,
  objectEntries: number,
  heapReferenceNodes: number,
  serializeToJsonableTotalMs: number,
  jsonStringifyTotalMs: number,
  textEncodeTotalMs: number,
  heapObjectCacheHits: number,
  heapObjectCacheMisses: number,
  heapObjectCacheHitAwaitTotalMs: number,
  heapObjectCacheMissAwaitTotalMs: number,
  heapObjectGetTotalMs: number,
  heapObjectSerializeTotalMs: number,
  heapObjectInsertAwaitTotalMs: number,
  branchStats: Map<string, PiledriverSerializationBranchStats>,
  heapObjectCacheMissesByShape: Map<string, number>,
  heapObjectCacheMissInlineNodeCountsByShape: Map<string, number>,
};
type PiledriverSerializationBranchStats = {
  primitiveNodes: number,
  arrayNodes: number,
  objectNodes: number,
  objectEntries: number,
  heapReferenceNodes: number,
  heapObjectCacheHits: number,
  heapObjectCacheMisses: number,
  heapObjectCacheMissesByShape: Map<string, number>,
  heapObjectCacheMissInlineNodeCountsByShape: Map<string, number>,
};
type PiledriverInlineNodeCounts = {
  primitiveNodes: number,
  arrayNodes: number,
  objectNodes: number,
  heapReferenceNodes: number,
};

function emptyPiledriverSerializationBranchStats(): PiledriverSerializationBranchStats {
  return {
    primitiveNodes: 0,
    arrayNodes: 0,
    objectNodes: 0,
    objectEntries: 0,
    heapReferenceNodes: 0,
    heapObjectCacheHits: 0,
    heapObjectCacheMisses: 0,
    heapObjectCacheMissesByShape: new Map(),
    heapObjectCacheMissInlineNodeCountsByShape: new Map(),
  };
}

function emptyPiledriverSerializationTimingStats(): PiledriverSerializationTimingStats {
  return {
    primitiveNodes: 0,
    arrayNodes: 0,
    arrayItems: 0,
    objectNodes: 0,
    objectEntries: 0,
    heapReferenceNodes: 0,
    serializeToJsonableTotalMs: 0,
    jsonStringifyTotalMs: 0,
    textEncodeTotalMs: 0,
    heapObjectCacheHits: 0,
    heapObjectCacheMisses: 0,
    heapObjectCacheHitAwaitTotalMs: 0,
    heapObjectCacheMissAwaitTotalMs: 0,
    heapObjectGetTotalMs: 0,
    heapObjectSerializeTotalMs: 0,
    heapObjectInsertAwaitTotalMs: 0,
    branchStats: new Map(),
    heapObjectCacheMissesByShape: new Map(),
    heapObjectCacheMissInlineNodeCountsByShape: new Map(),
  };
}

function incrementMapCount(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function addMapCount(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) ?? 0) + value);
}

function emptyPiledriverInlineNodeCounts(): PiledriverInlineNodeCounts {
  return {
    primitiveNodes: 0,
    arrayNodes: 0,
    objectNodes: 0,
    heapReferenceNodes: 0,
  };
}

function addPiledriverInlineNodeCounts(target: PiledriverInlineNodeCounts, source: PiledriverInlineNodeCounts) {
  target.primitiveNodes += source.primitiveNodes;
  target.arrayNodes += source.arrayNodes;
  target.objectNodes += source.objectNodes;
  target.heapReferenceNodes += source.heapReferenceNodes;
}

function totalInlineNodes(counts: PiledriverInlineNodeCounts) {
  return counts.primitiveNodes + counts.arrayNodes + counts.objectNodes + counts.heapReferenceNodes;
}

function countPiledriverInlineNodes(obj: PiledriverObject, path: Set<object> = new Set()): PiledriverInlineNodeCounts {
  switch (typeof obj) {
    case "number":
    case "string":
    case "boolean": {
      return { ...emptyPiledriverInlineNodeCounts(), primitiveNodes: 1 };
    }
    case "object": {
      if (obj === null) return { ...emptyPiledriverInlineNodeCounts(), primitiveNodes: 1 };
      if (isPiledriverHeapObjectSymbol in obj) return { ...emptyPiledriverInlineNodeCounts(), heapReferenceNodes: 1 };
      if (path.has(obj)) throw new Error("Piledriver objects must not contain cycles");
      path.add(obj);
      const counts = emptyPiledriverInlineNodeCounts();
      if (Array.isArray(obj)) {
        counts.arrayNodes++;
        for (const item of obj) addPiledriverInlineNodeCounts(counts, countPiledriverInlineNodes(item, path));
      } else {
        counts.objectNodes++;
        for (const value of Object.values(obj)) addPiledriverInlineNodeCounts(counts, countPiledriverInlineNodes(value, path));
      }
      path.delete(obj);
      return counts;
    }
    default: {
      throw new Error("Assertion error: Unknown type of Piledriver object " + typeof obj);
    }
  }
}

function classifyHeapObjectPayload(obj: PiledriverObject): string {
  if (obj === null) return "null";
  if (Array.isArray(obj)) return `array:${obj.length}`;
  if (typeof obj !== "object") return typeof obj;
  const keys = Object.keys(obj).sort();
  if (keys.includes("entries") && keys.includes("children") && keys.includes("augmentation") && keys.includes("size") && keys.includes("minKey") && keys.includes("maxKey")) {
    const entries = obj["entries"];
    const children = obj["children"];
    return `btree-node:entries=${Array.isArray(entries) ? entries.length : "?"}:children=${Array.isArray(children) ? children.length : "?"}`;
  }
  if (keys.includes("key") && keys.includes("id") && keys.length === 2) return "multi-key";
  if (keys.includes("groupKey") && keys.includes("rows") && keys.length === 2) return "group-with-rows";
  if (keys.includes("inputRowData") && keys.includes("outputRowData") && keys.includes("stateAfter")) return "left-fold-row";
  if (keys.includes("state") && keys.includes("nextTriggerTimeMs") && keys.includes("emittedRows")) return "time-fold-row";
  if (keys.includes("outputRows") && keys.length === 1) return "time-fold-group";
  if (keys.includes("rowData") && keys.includes("rowIdentifier") && keys.includes("rowSortKey") && keys.includes("groupKey")) return "row-object";
  return `object:${keys.slice(0, 6).join(",")}${keys.length > 6 ? ",..." : ""}`;
}

function serializationBranchKey(path: readonly string[]): string {
  if (path[0] === "snapshot" && path[1] === "serializedTables") return `table:${path[2]}`;
  return path[0] ?? "<root>";
}

function serializationBranchStatsByKey(stats: PiledriverSerializationTimingStats | undefined, branchKey: string) {
  if (stats === undefined) return undefined;
  let result = stats.branchStats.get(branchKey);
  if (result === undefined) {
    result = emptyPiledriverSerializationBranchStats();
    stats.branchStats.set(branchKey, result);
  }
  return result;
}

export function declareBasePiledriverDatabase(lowLevelDb: LowLevelDatabase, options: PiledriverDatabaseOptions = {}): PiledriverDatabase {
  // TODO actually support cycles both for heap and non-heap objects (right now they are detected and rejected)

  const processStartedAtMillis = options.garbageCollectionProcessStartedAtMillis ?? piledriverProcessStartedAtMillis;
  if (!Number.isSafeInteger(processStartedAtMillis) || processStartedAtMillis < 0) {
    throw new Error("Piledriver garbageCollectionProcessStartedAtMillis must be a non-negative safe integer");
  }
  const rootStore = lowLevelDb.declareKvStore("root");
  const heapDump = lowLevelDb.declareKvDump("heap");
  const garbageCollector = declarePiledriverGarbageCollector({
    lowLevelDb,
    heapDump,
    processStartedAtMillis,
  });
  const rootMutationByKey = new Map<string, Promise<unknown>>();
  const rootWriteSeqByKey = new Map<string, DatabaseSeq>();
  const readPreviousRoot = async (key: ArrayBuffer) => {
    const keyBase64 = encodeBase64(new Uint8Array(key));
    const previousRootWriteSeq = rootWriteSeqByKey.get(keyBase64);
    // rootStore.get carries no requiresSeq. Awaiting this process's prior write prevents raw
    // LMDB from returning an older root; concurrent writers in another process are out of scope.
    if (previousRootWriteSeq !== undefined) {
      try {
        await lowLevelDb.waitUntilAvailable(previousRootWriteSeq);
      } catch (error) {
        if (rootWriteSeqByKey.get(keyBase64) === previousRootWriteSeq) rootWriteSeqByKey.delete(keyBase64);
        throw error;
      }
    }
    return { keyBase64, previousRoot: await rootStore.get(key) };
  };
  const withRootMutationLock = async <T>(key: ArrayBuffer, operation: () => Promise<T>) => {
    const keyBase64 = encodeBase64(new Uint8Array(key));
    const previous = rootMutationByKey.get(keyBase64) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    rootMutationByKey.set(keyBase64, current);
    try {
      return await current;
    } finally {
      if (rootMutationByKey.get(keyBase64) === current) rootMutationByKey.delete(keyBase64);
    }
  };

  const heapObjectsByHeapKeyBase64 = new Map<string, { refIdentity: string, object: WeakRef<PiledriverHeapObject>, seq: DatabaseSeq }>();
  const heapObjectsByHeapKeyFinalizer = new FinalizationRegistry(([keyBase64, refIdentity]: [string, string]) => heapObjectsByHeapKeyBase64.get(keyBase64)?.refIdentity === refIdentity && heapObjectsByHeapKeyBase64.delete(keyBase64));
  const heapKeysAndSeqByHeapObjects = new WeakMap<PiledriverHeapObject, Promise<{ key: ArrayBuffer, seq: DatabaseSeq }>>();
  const heapSerializationEntryByHeapObjects = new WeakMap<PiledriverHeapObject, HeapSerializationEntry>();
  const heapSerializationDependencies = new WeakMap<PiledriverHeapObject, Set<PiledriverHeapObject>>();
  type HeapSerializationEntry = {
    heapObj: PiledriverHeapObject,
    key: ArrayBuffer,
    requiresSeq: DatabaseSeq,
    promise: Promise<{ key: ArrayBuffer, seq: DatabaseSeq }>,
    serializedBuffer: ArrayBuffer,
    batch: HeapSerializationBatch,
    publicationStatus: "unpublished" | "publishing" | "published" | "failed",
    publicationPromise?: Promise<DatabaseSeq>,
    publicationSeq?: DatabaseSeq,
    publicationError?: unknown,
  };
  type HeapSerializationBatch = {
    createdObjects: HeapSerializationEntry[],
    serializedBuffers: ArrayBuffer[],
  };
  const createHeapSerializationBatch = (): HeapSerializationBatch => {
    return { createdObjects: [], serializedBuffers: [] };
  };

  const addHeapSerializationDependency = (parent: PiledriverHeapObject, child: PiledriverHeapObject) => {
    // Backfills can produce dependency graphs deep enough to overflow a recursive reachability
    // walk. Keep cycle failures deterministic with an explicit stack.
    const visited = new Set<PiledriverHeapObject>();
    const pending = [child];
    while (pending.length > 0) {
      const current = pending.pop() ?? throwErr("Piledriver heap dependency stack unexpectedly became empty");
      if (current === parent) throw new Error("Piledriver objects must not contain cycles (found a cycle of heap objects)");
      if (visited.has(current)) continue;
      visited.add(current);
      for (const dependency of heapSerializationDependencies.get(current) ?? []) pending.push(dependency);
    }
    const dependencies = heapSerializationDependencies.get(parent);
    if (dependencies === undefined) heapSerializationDependencies.set(parent, new Set([child]));
    else dependencies.add(child);
  };

  const cacheHeapObjectByKey = (key: ArrayBuffer, heapObj: PiledriverHeapObject, seq: DatabaseSeq) => {
    const keyBase64 = encodeBase64(new Uint8Array(key));
    const refIdentity = crypto.randomUUID();
    heapObjectsByHeapKeyBase64.set(keyBase64, { refIdentity, object: new WeakRef(heapObj), seq });
    heapObjectsByHeapKeyFinalizer.register(heapObj, [keyBase64, refIdentity]);
  };

  // Deduplicates and drops initial seqs before delegating to the low-level combineSeqs. This is
  // important for performance: each low-level combined seq allocates promises/map entries, so we
  // only want to create one when there are actually ≥2 distinct non-initial seqs to combine.
  // (Identity comparison against initialSeq is safe because initialSeq is a singleton object.)
  const combineSeqsDeduped = (seqs: Iterable<DatabaseSeq>): DatabaseSeq => {
    const unique = [...new Set(seqs)].filter(seq => seq !== lowLevelDb.initialSeq);
    if (unique.length === 0) return lowLevelDb.initialSeq;
    if (unique.length === 1) return unique[0];
    return lowLevelDb.combineSeqs(...unique);
  };

  const getHeapKeyAndSeq = async (heapObj: PiledriverHeapObject, heapPath: HeapSerializationPath, serializationTimingStats: PiledriverSerializationTimingStats | undefined, branchKey: string | undefined, batch: HeapSerializationBatch): Promise<{ key: ArrayBuffer, seq: DatabaseSeq }> => {
    // Must be checked before the memo lookup: awaiting the memoized promise of an ancestor
    // that is still being serialized would deadlock.
    if (heapPath.has(heapObj)) throw new Error("Piledriver objects must not contain cycles (found a cycle of heap objects)");

    const existing = heapKeysAndSeqByHeapObjects.get(heapObj);
    if (existing) {
      if (serializationTimingStats !== undefined) {
        serializationTimingStats.heapObjectCacheHits++;
        const branch = branchKey === undefined ? undefined : serializationBranchStatsByKey(serializationTimingStats, branchKey);
        if (branch !== undefined) branch.heapObjectCacheHits++;
      }
      const cacheHitAwaitStartedAt = performance.now();
      try {
        const creatingEntry = heapSerializationEntryByHeapObjects.get(heapObj);
        if (creatingEntry !== undefined && creatingEntry.batch !== batch) {
          // Publish only this object's metadata; waiting on the producer batch could
          // deadlock when two in-flight batches cross-reference each other.
          await publishCreatedHeapObject(creatingEntry);
        }
        return await existing;
      } finally {
        if (serializationTimingStats !== undefined) serializationTimingStats.heapObjectCacheHitAwaitTotalMs += performance.now() - cacheHitAwaitStartedAt;
      }
    }
    if (serializationTimingStats !== undefined) {
      serializationTimingStats.heapObjectCacheMisses++;
      const branch = branchKey === undefined ? undefined : serializationBranchStatsByKey(serializationTimingStats, branchKey);
      if (branch !== undefined) branch.heapObjectCacheMisses++;
    }

    const promise = (async () => {
      // Keep this copy: pending heap references resolve concurrently, so sibling branches cannot
      // share a mutable path set.
      const childHeapPath = new Set(heapPath).add(heapObj);
      return await traceSpanHot("bulldozer-js.piledriver.heap.serializeAndInsert", async () => {
        const heapObjectGetStartedAt = performance.now();
        const heapObject = await heapObj.get();
        if (serializationTimingStats !== undefined) {
          const objectKind = classifyHeapObjectPayload(heapObject);
          const inlineNodeCount = totalInlineNodes(countPiledriverInlineNodes(heapObject));
          incrementMapCount(serializationTimingStats.heapObjectCacheMissesByShape, objectKind);
          addMapCount(serializationTimingStats.heapObjectCacheMissInlineNodeCountsByShape, objectKind, inlineNodeCount);
          const branch = branchKey === undefined ? undefined : serializationBranchStatsByKey(serializationTimingStats, branchKey);
          if (branch !== undefined) {
            incrementMapCount(branch.heapObjectCacheMissesByShape, objectKind);
            addMapCount(branch.heapObjectCacheMissInlineNodeCountsByShape, objectKind, inlineNodeCount);
          }
          serializationTimingStats.heapObjectGetTotalMs += performance.now() - heapObjectGetStartedAt;
        }
        const heapObjectSerializeStartedAt = performance.now();
        const serialized = await serializePiledriverObject(heapObject, childHeapPath, serializationTimingStats, branchKey, heapObj, batch);
        if (serializationTimingStats !== undefined) serializationTimingStats.heapObjectSerializeTotalMs += performance.now() - heapObjectSerializeStartedAt;
        const heapObjectInsertStartedAt = performance.now();
        const inserted = await heapDump.insertAll([serialized.buffer], { requiresSeq: serialized.seq });
        const entry: HeapSerializationEntry = {
          heapObj,
          key: inserted.keys[0],
          requiresSeq: inserted.seq,
          promise,
          serializedBuffer: serialized.buffer,
          batch,
          publicationStatus: "unpublished",
        };
        batch.createdObjects.push(entry);
        heapSerializationEntryByHeapObjects.set(heapObj, entry);
        batch.serializedBuffers.push(serialized.buffer);
        if (serializationTimingStats !== undefined) serializationTimingStats.heapObjectInsertAwaitTotalMs += performance.now() - heapObjectInsertStartedAt;
        return { key: inserted.keys[0], seq: inserted.seq };
      });
    })();
    heapKeysAndSeqByHeapObjects.set(heapObj, promise);
    let result;
    const cacheMissAwaitStartedAt = performance.now();
    try {
      result = await promise;
    } catch (error) {
      // Don't leave a poisoned rejected promise in the cache; a later retry may succeed.
      if (heapKeysAndSeqByHeapObjects.get(heapObj) === promise) {
        heapKeysAndSeqByHeapObjects.delete(heapObj);
        heapSerializationDependencies.delete(heapObj);
      }
      if (heapSerializationEntryByHeapObjects.get(heapObj)?.promise === promise) heapSerializationEntryByHeapObjects.delete(heapObj);
      throw error;
    } finally {
      if (serializationTimingStats !== undefined) serializationTimingStats.heapObjectCacheMissAwaitTotalMs += performance.now() - cacheMissAwaitStartedAt;
    }
    cacheHeapObjectByKey(result.key, heapObj, result.seq);
    return result;
  };

  const getHeapObjectByKey = (key: ArrayBuffer, seq: DatabaseSeq): { object: PiledriverHeapObject, seq: DatabaseSeq } => {
    const keyBase64 = encodeBase64(new Uint8Array(key));
    const existingEntry = heapObjectsByHeapKeyBase64.get(keyBase64);
    if (!options.disableHeapReadCache && existingEntry) {
      const existingObject = existingEntry.object.deref();
      if (existingObject) {
        return {
          object: existingObject,
          seq: existingEntry.seq,
        };
      } else {
        // object has been gc'd, let's not return it from cache and just fetch it again below
      }
    }

    let loadPromise: Promise<PiledriverObject> | undefined;
    const heapObj: PiledriverHeapObject = {
      async get() {
        loadPromise ??= traceSpanHot({ description: "bulldozer-js.piledriver.heap.get", attributes: { "bulldozer.piledriver.heap_read_cache_disabled": options.disableHeapReadCache === true } }, async () => {
          const { buffer, seq: heapSeq } = await heapDump.get(key);
          if (buffer === null) throw new Error(`Assertion error: Heap object with base64 key "${keyBase64}" not found`);
          const deserialized = await deserializePiledriverObject(buffer, heapSeq);
          return deserialized.object;
        });
        try {
          return await loadPromise;
        } catch (error) {
          loadPromise = undefined;
          throw error;
        }
      },
      getValueIfLocallyCreated() {
        return { status: "database-reference" };
      },
      [isPiledriverHeapObjectSymbol]: true,
    };
    heapKeysAndSeqByHeapObjects.set(heapObj, Promise.resolve({ key, seq }));
    if (!options.disableHeapReadCache) {
      cacheHeapObjectByKey(key, heapObj, seq);
    }
    return { object: heapObj, seq };
  };

  // A heap reference discovered during the synchronous payload walk. The jsonable slot is
  // created immediately (as ["heap-reference", null]) and patched with the base64 key once the
  // referenced heap object has been resolved/inserted.
  type PendingHeapReferenceSlot = {
    slot: [string, string | null],
    heapObj: PiledriverHeapObject,
    branchKey: string | undefined,
  };

  // Serializes a Piledriver object in two phases:
  //  1. A fully SYNCHRONOUS walk that builds the jsonable structure, detects plain-object
  //     cycles (push/pop set — safe because nothing interleaves during a sync walk), counts
  //     stats, and records one slot per heap reference.
  //  2. Resolution of the (deduplicated) referenced heap objects in parallel, then patching
  //     their base64 keys into the recorded slots.
  // This replaces a previous fully-async recursive serializer that allocated promises for every
  // node and called lowLevelDb.combineSeqs once per array/object node (each combined seq
  // allocates a UUID, tracking promises, and map entries). Profiling showed that overhead — not
  // LMDB — dominated CPU during backfills, so seqs are now combined exactly once per heap
  // object/root, and only heap references involve async work at all.
  const serializePiledriverObject = async (obj: PiledriverObject, heapPath: HeapSerializationPath, serializationTimingStats: PiledriverSerializationTimingStats | undefined, inheritedBranchKey: string | undefined, serializingHeapObject: PiledriverHeapObject | undefined, batch: HeapSerializationBatch): Promise<{ buffer: ArrayBuffer, seq: DatabaseSeq }> => {
    const stats = serializationTimingStats;
    const pendingSlots: PendingHeapReferenceSlot[] = [];
    const objectPath = new Set<object>();
    // Branch keys only depend on the first 3 path segments (see serializationBranchKey), so we
    // stop tracking the key path once the branch is determined. Nested heap objects inherit the
    // branch key of their reference site, which is equivalent to the old logicalPath threading
    // because heap references only occur at depth >= 3 in the root snapshot.
    const keyPath: string[] = [];

    const build = (node: PiledriverObject, branch: PiledriverSerializationBranchStats | undefined, branchKey: string | undefined, branchDetermined: boolean): unknown => {
      switch (typeof node) {
        case "number": {
          if (stats !== undefined) {
            stats.primitiveNodes++;
            if (branch !== undefined) branch.primitiveNodes++;
          }
          if (!Number.isFinite(node)) return [node.toString()];
          if (Object.is(node, -0)) return ["-0"];
          return node;
        }
        case "string":
        case "boolean": {
          if (stats !== undefined) {
            stats.primitiveNodes++;
            if (branch !== undefined) branch.primitiveNodes++;
          }
          return node;
        }
        case "object": {
          if (node === null) {
            if (stats !== undefined) {
              stats.primitiveNodes++;
              if (branch !== undefined) branch.primitiveNodes++;
            }
            return node;
          } else if (Array.isArray(node)) {
            if (stats !== undefined) {
              stats.arrayNodes++;
              stats.arrayItems += node.length;
              if (branch !== undefined) branch.arrayNodes++;
            }
            if (objectPath.has(node)) throw new Error("Piledriver objects must not contain cycles");
            objectPath.add(node);
            const items = node.map(item => build(item, branch, branchKey, branchDetermined));
            objectPath.delete(node);
            return ["array", items];
          } else if (isPiledriverHeapObjectSymbol in node) {
            if (stats !== undefined) {
              stats.heapReferenceNodes++;
              if (branch !== undefined) branch.heapReferenceNodes++;
            }
            // Fail fast on heap cycles at walk time (resolution would deadlock on the ancestor's
            // own memoized promise otherwise).
            if (heapPath.has(node)) throw new Error("Piledriver objects must not contain cycles (found a cycle of heap objects)");
            if (serializingHeapObject !== undefined) addHeapSerializationDependency(serializingHeapObject, node);
            const slot: [string, string | null] = ["heap-reference", null];
            pendingSlots.push({ slot, heapObj: node, branchKey });
            return slot;
          } else {
            // "normal" object
            // TODO: assert this is a POJO

            if (objectPath.has(node)) throw new Error("Piledriver objects must not contain cycles");
            objectPath.add(node);
            const entries = Object.entries(node);
            if (stats !== undefined) {
              stats.objectNodes++;
              stats.objectEntries += entries.length;
              if (branch !== undefined) {
                branch.objectNodes++;
                branch.objectEntries += entries.length;
              }
            }
            const result: Record<string, unknown> = {};
            for (const [k, v] of entries) {
              let childBranch = branch;
              let childBranchKey = branchKey;
              let childBranchDetermined = branchDetermined;
              if (!branchDetermined) {
                keyPath.push(k);
                childBranchKey = serializationBranchKey(keyPath);
                childBranch = stats === undefined ? undefined : serializationBranchStatsByKey(stats, childBranchKey);
                childBranchDetermined = keyPath.length >= 3;
              }
              Object.defineProperty(result, k, {
                value: build(v, childBranch, childBranchKey, childBranchDetermined),
                enumerable: true,
                configurable: true,
                writable: true,
              });
              if (!branchDetermined) keyPath.pop();
            }
            objectPath.delete(node);
            return result;
          }
        }
        default: {
          throw new Error("Assertion error: Unknown type of Piledriver object " + typeof node);
        }
      }
    };

    const toJsonableStartedAt = performance.now();
    const inheritedBranch = inheritedBranchKey === undefined ? undefined : serializationBranchStatsByKey(stats, inheritedBranchKey);
    const jsonableObject = build(obj, inheritedBranch, inheritedBranchKey, inheritedBranchKey !== undefined);
    if (stats !== undefined) stats.serializeToJsonableTotalMs += performance.now() - toJsonableStartedAt;

    let seq = lowLevelDb.initialSeq;
    if (pendingSlots.length > 0) {
      // Resolve each distinct heap object once, even if it is referenced from multiple slots.
      const slotsByHeapObj = new Map<PiledriverHeapObject, PendingHeapReferenceSlot[]>();
      for (const pendingSlot of pendingSlots) {
        const existing = slotsByHeapObj.get(pendingSlot.heapObj);
        if (existing === undefined) slotsByHeapObj.set(pendingSlot.heapObj, [pendingSlot]);
        else existing.push(pendingSlot);
      }
      const resolvedSeqs = await Promise.all([...slotsByHeapObj.entries()].map(async ([heapObj, slots]) => {
        const heapKeyAndSeq = await getHeapKeyAndSeq(heapObj, heapPath, stats, slots[0].branchKey, batch);
        const keyBase64 = encodeBase64(new Uint8Array(heapKeyAndSeq.key));
        for (const { slot } of slots) slot[1] = keyBase64;
        return heapKeyAndSeq.seq;
      }));
      seq = combineSeqsDeduped(resolvedSeqs);
    }

    const jsonStringifyStartedAt = performance.now();
    const json = JSON.stringify(jsonableObject);
    if (stats !== undefined) stats.jsonStringifyTotalMs += performance.now() - jsonStringifyStartedAt;
    const textEncodeStartedAt = performance.now();
    const buffer = textEncoder.encode(json).buffer;
    if (stats !== undefined) stats.textEncodeTotalMs += performance.now() - textEncodeStartedAt;
    return { buffer, seq };
  };

  // Fully synchronous (getHeapObjectByKey is sync; heap payloads are only fetched lazily on
  // .get()). Seqs are collected into one array and combined once per buffer instead of once per
  // node — see serializePiledriverObject for why this matters.
  const deserializePiledriverObjectFromJsonableObject = (jsonableObject: unknown, enclosingSeq: DatabaseSeq, seqs: DatabaseSeq[]): PiledriverObject => {
    switch (typeof jsonableObject) {
      case "string":
      case "number":
      case "boolean": {
        return jsonableObject;
      }
      case "object": {
        if (jsonableObject === null) {
          return jsonableObject;
        } else if (Array.isArray(jsonableObject)) {
          switch (jsonableObject[0]) {
            case "array": {
              // any: JSON.parse output is structurally validated by the surrounding switch; a malformed
              // payload would throw in the recursive call rather than silently passing through.
              return jsonableObject[1].map((o: any) => deserializePiledriverObjectFromJsonableObject(o, enclosingSeq, seqs));
            }
            case "heap-reference": {
              const heapObjAndSeq = getHeapObjectByKey(decodeBase64(jsonableObject[1]).buffer, enclosingSeq);
              seqs.push(heapObjAndSeq.seq);
              return heapObjAndSeq.object;
            }
            case "NaN": {
              return NaN;
            }
            case "Infinity": {
              return Infinity;
            }
            case "-Infinity": {
              return -Infinity;
            }
            case "-0": {
              return -0;
            }
            default: {
              throw new Error("Assertion error: Serialized Piledriver JSONable object array has unknown type " + jsonableObject[0]);
            }
          }
        } else {
          const result: Record<string, PiledriverObject> = {};
          for (const [k, v] of Object.entries(jsonableObject)) {
            Object.defineProperty(result, k, {
              value: deserializePiledriverObjectFromJsonableObject(v, enclosingSeq, seqs),
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
          return result;
        }
      }
      default: {
        throw new Error("Assertion error: Unknown type of serialized Piledriver JSONable object " + typeof jsonableObject);
      }
    }
  };

  const deserializePiledriverObject = async (buffer: ArrayBuffer, enclosingSeq: DatabaseSeq): Promise<{ object: PiledriverObject, seq: DatabaseSeq }> => {
    const seqs: DatabaseSeq[] = [];
    const object = deserializePiledriverObjectFromJsonableObject(JSON.parse(textDecoder.decode(buffer)), enclosingSeq, seqs);
    return { object, seq: combineSeqsDeduped(seqs) };
  };

  const flushHeapSerializationBatch = async (batch: HeapSerializationBatch) => {
    if (batch.createdObjects.length === 0) return lowLevelDb.initialSeq;
    // Heap payloads are not reachable from any visible root until the root mutation below.
    // We can therefore insert them first, then publish creation metadata/candidates for all
    // of them, then apply every outgoing positive edge before publishing that root.
    try {
      const unpublished = batch.createdObjects.filter(entry => entry.publicationStatus === "unpublished");
      if (unpublished.length > 0) await startHeapObjectPublication(unpublished);
      const publicationSeqs = await Promise.all(batch.createdObjects.map(entry =>
        entry.publicationPromise ?? throwErr("Piledriver heap serialization entry has no publication promise")));
      return combineSeqsDeduped(publicationSeqs);
    } catch (error) {
      abortHeapSerializationBatch(batch);
      throw error;
    }
  };

  const startHeapObjectPublication = (requestedEntries: HeapSerializationEntry[]): Promise<DatabaseSeq> => {
    const entries: HeapSerializationEntry[] = [];
    const visited = new Set<PiledriverHeapObject>();
    const stack = requestedEntries.map(entry => ({ entry, expanded: false }));
    while (stack.length > 0) {
      const current = stack.pop() ?? throwErr("Piledriver heap publication stack unexpectedly empty");
      if (current.expanded) {
        entries.push(current.entry);
        continue;
      }
      if (visited.has(current.entry.heapObj)) continue;
      visited.add(current.entry.heapObj);
      stack.push({ entry: current.entry, expanded: true });
      for (const dependency of heapSerializationDependencies.get(current.entry.heapObj) ?? []) {
        const dependencyEntry = heapSerializationEntryByHeapObjects.get(dependency);
        // Edges are pruned when their owner publishes, so the graph only spans objects still in
        // flight. An individual edge can outlive its target's entry when the target publishes
        // first; that target is already durable and needs no further publication ordering.
        if (dependencyEntry !== undefined && !visited.has(dependencyEntry.heapObj)) {
          stack.push({ entry: dependencyEntry, expanded: false });
        }
      }
    }

    const claimedEntries = entries.filter(entry => entry.publicationStatus === "unpublished");
    const claimedEntrySet = new Set(claimedEntries);
    const failedEntry = entries.find(entry => entry.publicationStatus === "failed");
    for (const entry of claimedEntries) entry.publicationStatus = "publishing";
    const waitingPromises = entries
      .filter(entry => entry.publicationStatus === "publishing" && !claimedEntrySet.has(entry))
      .map(entry => entry.publicationPromise ?? throwErr("Piledriver heap object publication promise is missing"));
    const publicationPromise = (async () => {
      try {
        if (failedEntry !== undefined) throw failedEntry.publicationError;
        const waitingSeqs = await Promise.all(waitingPromises);
        const publicationSeqs = [...waitingSeqs];
        if (claimedEntries.length > 0) {
          const created = await garbageCollector.recordHeapObjectCreations(claimedEntries.map(entry => ({ key: entry.key, requiresSeq: entry.requiresSeq })));
          const references = await garbageCollector.beforeSerializedHeapObjectsBecomeVisible(claimedEntries.map(entry => entry.serializedBuffer), created.seq);
          publicationSeqs.push(combineSeqsDeduped([created.seq, references.seq]));
        }
        const seq = combineSeqsDeduped(publicationSeqs);
        for (const entry of claimedEntries) {
          entry.publicationStatus = "published";
          entry.publicationSeq = seq;
          if (heapSerializationEntryByHeapObjects.get(entry.heapObj) !== entry) continue;
          // Once an object is published, its outgoing edges are immutable and no longer needed for
          // publication ordering or cycle detection, so prune them with the entry.
          heapSerializationEntryByHeapObjects.delete(entry.heapObj);
          heapSerializationDependencies.delete(entry.heapObj);
        }
        return seq;
      } catch (error) {
        for (const entry of claimedEntries) {
          entry.publicationStatus = "failed";
          entry.publicationError = error;
          if (heapSerializationEntryByHeapObjects.get(entry.heapObj) === entry) {
            // Publication failure is terminal for this entry, so nothing will publish through its
            // edges; if abort drops it, a fresh serialization registers fresh edges.
            heapSerializationDependencies.delete(entry.heapObj);
          }
        }
        throw error;
      }
    })();
    for (const entry of claimedEntries) entry.publicationPromise = publicationPromise;
    return publicationPromise;
  };

  const publishCreatedHeapObject = async (entry: HeapSerializationEntry): Promise<DatabaseSeq> => {
    if (entry.publicationStatus === "unpublished") await startHeapObjectPublication([entry]);
    if (entry.publicationStatus === "failed") throw entry.publicationError;
    if (entry.publicationSeq !== undefined) return entry.publicationSeq;
    if (entry.publicationPromise === undefined) throwErr("Piledriver heap object publication promise is missing");
    return await entry.publicationPromise;
  };

  const abortHeapSerializationBatch = (batch: HeapSerializationBatch) => {
    for (const { heapObj, promise } of batch.createdObjects) {
      if (heapKeysAndSeqByHeapObjects.get(heapObj) === promise) heapKeysAndSeqByHeapObjects.delete(heapObj);
      const entry = heapSerializationEntryByHeapObjects.get(heapObj);
      // Objects still publishing keep their entry because concurrent publications resolve through
      // it; everything else is either durable or gone, so nothing needs its dependency edges.
      if (entry?.batch === batch && entry.publicationStatus !== "publishing") {
        heapSerializationEntryByHeapObjects.delete(heapObj);
        heapSerializationDependencies.delete(heapObj);
      }
    }
  };

  const parseDebugEntryValue = (valueUtf8: string | null) => {
    if (valueUtf8 === null) return null;
    try {
      return JSON.parse(valueUtf8);
    } catch {
      return valueUtf8;
    }
  };

  return {
    getDebugInfo() {
      return {
        backend: "piledriver",
        constructorArguments: { lowLevelDb, options },
        lowLevelDb,
        rootStore,
        heapDump,
        garbageCollector,
        processStartedAtMillis,
        rootMutationByKey,
        heapObjectsByObject,
        heapObjectsByHeapKeyBase64,
        heapObjectsByHeapKeyFinalizer,
        heapKeysAndSeqByHeapObjects,
        heapSerializationDependencies,
        heapReadCacheDisabled: options.disableHeapReadCache === true,
      };
    },
    async getRootObject(key): Promise<{ object: PiledriverObject, seq: DatabaseSeq }> {
      return await traceSpan("bulldozer-js.piledriver.getRootObject", async () => {
        await garbageCollector.initialize();
        const { buffer, seq: rootSeq } = await rootStore.get(key);
        if (buffer === null) throw new Error("Root object not found");
        const { object, seq: deserializeSeq } = await deserializePiledriverObject(buffer, rootSeq);
        return { object, seq: lowLevelDb.combineSeqs(deserializeSeq, rootSeq) };
      });
    },
    async setRootObject(key, value): Promise<{ seq: DatabaseSeq }> {
      return await traceSpan("bulldozer-js.piledriver.setRootObject", async () => await withRootMutationLock(key, async () => {
        await garbageCollector.initialize();
        const { keyBase64, previousRoot } = await readPreviousRoot(key);
        const timingStats = emptyPiledriverSerializationTimingStats();
        const startedAt = performance.now();
        const serializeStartedAt = performance.now();
        const serializeCpuStartedAt = process.cpuUsage();
        const heapSerializationBatch = createHeapSerializationBatch();
        let buffer: ArrayBuffer;
        let seq: DatabaseSeq;
        try {
          ({ buffer, seq } = await serializePiledriverObject(value, new Set(), timingStats, undefined, undefined, heapSerializationBatch));
        } catch (error) {
          abortHeapSerializationBatch(heapSerializationBatch);
          throw error;
        }
        const serializeCpuUsage = process.cpuUsage(serializeCpuStartedAt);
        const serializePiledriverObjectMs = performance.now() - serializeStartedAt;
        const serializeCpuMs = (serializeCpuUsage.user + serializeCpuUsage.system) / 1000;
        const heapFlushStartedAt = performance.now();
        const heapBatchSeq = await flushHeapSerializationBatch(heapSerializationBatch);
        const heapSerializationFlushMs = performance.now() - heapFlushStartedAt;
        const visibilityStartedAt = performance.now();
        const references = await garbageCollector.beforeSerializedObjectBecomesVisible(buffer, combineSeqsDeduped([seq, heapBatchSeq]));
        const heapReferenceVisibilityMs = performance.now() - visibilityStartedAt;
        const rootStoreSetAllStartedAt = performance.now();
        const { seq: rootSeq } = await rootStore.setAll([{ key, value: buffer }], { requiresSeq: references.seq });
        rootWriteSeqByKey.set(keyBase64, rootSeq);
        const dereferenced = previousRoot.buffer === null
          ? { seq: rootSeq }
          : await garbageCollector.afterSerializedObjectBecameInvisible(
            previousRoot.buffer,
            Math.max(Date.now(), processStartedAtMillis),
            rootSeq,
          );
        const rootStoreSetAllMs = performance.now() - rootStoreSetAllStartedAt;
        const topSerializationBranches = [...timingStats.branchStats.entries()]
          .map(([branch, stats]) => ({
            branch,
            totalNodes: stats.primitiveNodes + stats.arrayNodes + stats.objectNodes + stats.heapReferenceNodes,
            primitiveNodes: stats.primitiveNodes,
            arrayNodes: stats.arrayNodes,
            objectNodes: stats.objectNodes,
            objectEntries: stats.objectEntries,
            heapReferenceNodes: stats.heapReferenceNodes,
            heapObjectCacheHits: stats.heapObjectCacheHits,
            heapObjectCacheMisses: stats.heapObjectCacheMisses,
            topHeapObjectCacheMissShapes: [...stats.heapObjectCacheMissesByShape.entries()]
              .map(([objectKind, count]) => {
                const totalInlineNodeCount = stats.heapObjectCacheMissInlineNodeCountsByShape.get(objectKind) ?? 0;
                return { "shape": objectKind, count, totalInlineNodeCount, averageInlineNodeCount: count === 0 ? 0 : totalInlineNodeCount / count };
              })
              .sort((a, b) => b.count - a.count)
              .slice(0, 5),
          }))
          .sort((a, b) => b.totalNodes - a.totalNodes)
          .slice(0, 5);
        const topHeapObjectCacheMissShapes = [...timingStats.heapObjectCacheMissesByShape.entries()]
          .map(([objectKind, count]) => {
            const totalInlineNodeCount = timingStats.heapObjectCacheMissInlineNodeCountsByShape.get(objectKind) ?? 0;
            return { "shape": objectKind, count, totalInlineNodeCount, averageInlineNodeCount: count === 0 ? 0 : totalInlineNodeCount / count };
          })
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
        if (!shouldSuppressPeriodicBulldozerLogs) {
          console.debug("bulldozer-js piledriver setRootObject timing", {
            elapsedMs: performance.now() - startedAt,
            serializePiledriverObjectMs,
            heapSerializationFlushMs,
            heapReferenceVisibilityMs,
            serializeCpuMs,
            serializeCpuToWallRatio: serializePiledriverObjectMs === 0 ? 0 : serializeCpuMs / serializePiledriverObjectMs,
            rootStoreSetAllMs,
            rootValueBytes: buffer.byteLength,
            primitiveNodes: timingStats.primitiveNodes,
            arrayNodes: timingStats.arrayNodes,
            arrayItems: timingStats.arrayItems,
            objectNodes: timingStats.objectNodes,
            objectEntries: timingStats.objectEntries,
            heapReferenceNodes: timingStats.heapReferenceNodes,
            serializeToJsonableTotalMs: timingStats.serializeToJsonableTotalMs,
            jsonStringifyTotalMs: timingStats.jsonStringifyTotalMs,
            textEncodeTotalMs: timingStats.textEncodeTotalMs,
            heapObjectCacheHits: timingStats.heapObjectCacheHits,
            heapObjectCacheMisses: timingStats.heapObjectCacheMisses,
            heapObjectCacheHitAwaitTotalMs: timingStats.heapObjectCacheHitAwaitTotalMs,
            heapObjectCacheMissAwaitTotalMs: timingStats.heapObjectCacheMissAwaitTotalMs,
            heapObjectGetTotalMs: timingStats.heapObjectGetTotalMs,
            heapObjectSerializeTotalMs: timingStats.heapObjectSerializeTotalMs,
            heapObjectInsertAwaitTotalMs: timingStats.heapObjectInsertAwaitTotalMs,
            topHeapObjectCacheMissShapes,
            topSerializationBranches,
          });
        }
        return { seq: dereferenced.seq };
      }));
    },
    async deleteRootObject(key): Promise<{ seq: DatabaseSeq }> {
      return await traceSpan("bulldozer-js.piledriver.deleteRootObject", async () => await withRootMutationLock(key, async () => {
        await garbageCollector.initialize();
        const { keyBase64, previousRoot } = await readPreviousRoot(key);
        const deleted = await rootStore.deleteAll([key]);
        rootWriteSeqByKey.set(keyBase64, deleted.seq);
        if (previousRoot.buffer === null) return deleted;
        const dereferenced = await garbageCollector.afterSerializedObjectBecameInvisible(
          previousRoot.buffer,
          Math.max(Date.now(), processStartedAtMillis),
          deleted.seq,
        );
        return { seq: dereferenced.seq };
      }));
    },
    getGarbageCollectionProcessStartedAtMillis() {
      return processStartedAtMillis;
    },
    async collectGarbage(cutoffTimestampMillis, maxObjects) {
      return await traceSpan("bulldozer-js.piledriver.collectGarbage", async () => {
        return await garbageCollector.collectGarbage(cutoffTimestampMillis, maxObjects);
      });
    },
    combineSeqs(...seqs) {
      return lowLevelDb.combineSeqs(...seqs);
    },
    async close() {
      await lowLevelDb.close();
    },
    waitUntilAvailable(seq) {
      return traceSpan("bulldozer-js.piledriver.waitUntilAvailable", async () => await lowLevelDb.waitUntilAvailable(seq));
    },
    waitUntilDurable(seq) {
      return traceSpan("bulldozer-js.piledriver.waitUntilDurable", async () => await lowLevelDb.waitUntilDurable(seq));
    },
    waitUntilReplicated(seq) {
      return traceSpan("bulldozer-js.piledriver.waitUntilReplicated", async () => await lowLevelDb.waitUntilReplicated(seq));
    },
    waitUntilConsistent(seq) {
      return traceSpan("bulldozer-js.piledriver.waitUntilConsistent", async () => await lowLevelDb.waitUntilConsistent(seq));
    },
    async debugSnapshot() {
      return await traceSpan("bulldozer-js.piledriver.debugSnapshot", async () => ({
        roots: (await rootStore.debugEntries?.() ?? []).map(entry => ({
          keyBase64: entry.keyBase64,
          keyUtf8: entry.keyUtf8,
          keyHex: entry.keyHex,
          serializedJson: parseDebugEntryValue(entry.valueUtf8),
          valueByteLength: entry.valueByteLength,
        })),
        heap: (await heapDump.debugEntries?.() ?? []).map(entry => ({
          keyBase64: entry.keyBase64,
          keyUtf8: entry.keyUtf8,
          keyHex: entry.keyHex,
          serializedJson: parseDebugEntryValue(entry.valueUtf8),
          valueByteLength: entry.valueByteLength,
        })),
      }));
    },
    async debugLowLevelSnapshot() {
      return await traceSpan("bulldozer-js.piledriver.debugLowLevelSnapshot", async () => await lowLevelDb.debugSnapshot?.() ?? { stores: {}, dumps: {} });
    },
    initialSeq: lowLevelDb.initialSeq,
  };
}

import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { createUuidV7Generator } from "@hexclave/shared/dist/utils/uuids";
import * as lmdb from "lmdb";
import { createDatabaseSeq, DatabaseSeq } from "../../../index.js";
import { aggregateSerializedReferences, zeroPiledriverGarbageCollectionResult } from "../../gc.js";
import { heapObjectsByObject, PiledriverDatabase, PiledriverObject } from "../../index.js";
import { decodePiledriverObject, encodePiledriverObject, plannedHeapReferenceKeys, PlannedPiledriverObject } from "./codec.js";
import { createPiledriverHeapCache } from "./heap-cache.js";
import { planHeapObjects } from "./heap-plan.js";

const breezyPiledriverProcessStartedAtMillis = Date.now();
const gcSchemaVersion = 3;

/**
 * Returns `items` sorted by their LMDB key, for writing in that order.
 *
 * LMDB keeps keys sorted in fixed-size pages. A key that belongs in the middle of a full page splits
 * it into two half-empty pages, while keys arriving in ascending order just fill the last page. The
 * planner reserves keys parents-first but saves children first, so unsorted writes left heap pages
 * about half empty. Write order inside one transaction doesn't change what is committed.
 */
const ascendingByKey = <T>(items: T[], keyOf: (item: T) => Uint8Array) => {
  return [...items].sort((a, b) => Buffer.compare(keyOf(a), keyOf(b)));
};

export type BreezyPiledriverLmdbOptions = { path: string, dbId?: string, compression?: boolean };
export type BreezyPiledriverDatabaseOptions = { disableHeapReadCache?: boolean, garbageCollectionProcessStartedAtMillis?: number };

export function declareBreezyPiledriverDatabase(
  lmdbOptions: BreezyPiledriverLmdbOptions,
  options: BreezyPiledriverDatabaseOptions = {},
): PiledriverDatabase {
  const processStartedAtMillis = options.garbageCollectionProcessStartedAtMillis ?? breezyPiledriverProcessStartedAtMillis;
  if (!Number.isSafeInteger(processStartedAtMillis) || processStartedAtMillis < 0) throw new Error("Piledriver garbageCollectionProcessStartedAtMillis must be a non-negative safe integer");
  const dbId = lmdbOptions.dbId ?? "default";
  const lmdbRoot = lmdb.open({
    path: lmdbOptions.path,
    maxDbs: 1024,
    compression: lmdbOptions.compression === true,
    separateFlushed: true,
  });
  const openLmdbStore = (name: string) => lmdbRoot.openDB<Buffer, Uint8Array>({
    name: `${dbId}:${name}`,
    encoding: "binary",
    keyEncoding: "binary",
    useVersions: true,
  });
  const lmdbHeap = openLmdbStore("dump:heap");
  const lmdbRoots = openLmdbStore("store:root");
  const lmdbMetadata = openLmdbStore("store:piledriver-gc-reference-metadata-v3");
  const lmdbCandidates = openLmdbStore("store:piledriver-gc-zero-reference-candidates-v3");
  const lmdbGcState = openLmdbStore("store:piledriver-gc-state-v3");
  const generateHeapUuid = createUuidV7Generator();
  const initialSeq = createDatabaseSeq(dbId, 0);
  const toSeq = (transactionId: number) => createDatabaseSeq(dbId, transactionId);
  const transactionId = (seq: DatabaseSeq) => {
    const value = seq[1];
    if (seq[0] !== dbId || seq.length !== 2 || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Breezy sequence");
    return value;
  };
  const lastTransactionId = () => {
    const value = Reflect.get(lmdbRoot.getStats(), "lastTxnId");
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("LMDB returned an invalid transaction ID");
    return value;
  };
  const waitUntilAvailable = async (seq: DatabaseSeq) => {
    const required = transactionId(seq);
    while (lastTransactionId() < required) await wait(1);
    lmdbRoot.resetReadTxn();
  };
  const arrayBuffer = (value: Uint8Array) => Uint8Array.from(value).buffer;
  const reserveHeapKey = () => {
    const key = new Uint8Array(17);
    key[0] = 1;
    key.set(generateHeapUuid(), 1);
    return key.buffer;
  };
  const read = (database: lmdb.Database<Buffer, Uint8Array>, key: ArrayBuffer) => {
    const entry = database.getEntry(Buffer.from(key));
    if (entry === undefined) return { buffer: null, seq: initialSeq };
    return { buffer: arrayBuffer(entry.value), seq: toSeq(entry.version ?? throwErr("Versioned LMDB entry has no transaction ID")) };
  };
  // Node runs one piece of JavaScript at a time. LMDB reads are synchronous (they never wait on IO),
  // so a read that loads thousands of heap objects would otherwise keep running until it's done,
  // and every other request would wait behind it. So every 1,000 loads, counted across all reads,
  // the read that hits the count pauses: it goes to the back of the queue, the requests already
  // waiting run, then it continues exactly where it stopped. Heap objects never change once saved,
  // so the pause can't make a read see different data. 1,000 loads take a few milliseconds.
  const heapLoadsBetweenPauses = 1000;
  let heapLoadsSinceLastPause = 0;
  const letWaitingRequestsRun = () => new Promise<void>(resolve => setImmediate(resolve));
  const loadHeapObject = async (key: ArrayBuffer, keyBase64: string) => {
    if (++heapLoadsSinceLastPause >= heapLoadsBetweenPauses) {
      heapLoadsSinceLastPause = 0;
      await letWaitingRequestsRun();
    }
    const stored = read(lmdbHeap, key);
    if (stored.buffer === null) throw new Error(`Assertion error: Heap object with base64 key "${keyBase64}" not found`);
    return decodePiledriverObject(stored.buffer, childKey => heapCache.resolve(childKey, stored.seq));
  };
  const heapCache = createPiledriverHeapCache({ disabled: options.disableHeapReadCache === true, load: loadHeapObject });
  let lastRootWriteSeq = initialSeq;
  let mutations: Promise<unknown> = Promise.resolve();
  let gcGeneration: string | null = null;

  type ReferenceMetadata = {
    schemaVersion: typeof gcSchemaVersion,
    generation: string,
    referenceCount: number,
    createdAtMillis: number,
    lastDereferencedAtMillis: number | null,
    deletion: null,
  };

  const nonNegativeInteger = (value: unknown, name: string) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid Piledriver GC ${name}`);
    }
    return value;
  };
  const parseMetadata = (value: Uint8Array): ReferenceMetadata => {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid Piledriver GC reference metadata");
    const generation = Reflect.get(parsed, "generation");
    const lastDereferencedAtMillis = Reflect.get(parsed, "lastDereferencedAtMillis");
    const deletion = Reflect.get(parsed, "deletion");
    if (Reflect.get(parsed, "schemaVersion") !== gcSchemaVersion || typeof generation !== "string" || deletion !== null) {
      throw new Error("Cannot reference invalid or deleting Piledriver GC metadata");
    }
    return {
      schemaVersion: gcSchemaVersion,
      generation,
      referenceCount: nonNegativeInteger(Reflect.get(parsed, "referenceCount"), "referenceCount"),
      createdAtMillis: nonNegativeInteger(Reflect.get(parsed, "createdAtMillis"), "createdAtMillis"),
      lastDereferencedAtMillis: lastDereferencedAtMillis === null
        ? null
        : nonNegativeInteger(lastDereferencedAtMillis, "lastDereferencedAtMillis"),
      deletion,
    };
  };
  const activeGcGeneration = () => {
    if (gcGeneration !== null) return gcGeneration;
    const value = lmdbGcState.get(Buffer.from("state"));
    if (value === undefined) throw new Error("Piledriver GC must be initialized before heap publication");
    const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
    if (typeof parsed !== "object" || parsed === null || Reflect.get(parsed, "schemaVersion") !== gcSchemaVersion || Reflect.get(parsed, "status") !== "ready") {
      throw new Error("Invalid Piledriver GC state");
    }
    const generation = Reflect.get(parsed, "generation");
    if (typeof generation !== "string") throw new Error("Invalid Piledriver GC generation");
    gcGeneration = generation;
    return generation;
  };
  const candidateKey = (key: ArrayBuffer, eligibleAtMillis: number) => {
    if (key.byteLength + 8 > 64) throw new Error("Piledriver heap key is too large for the GC candidate index");
    const result = Buffer.allocUnsafe(key.byteLength + 8);
    result.writeBigUInt64BE(BigInt(eligibleAtMillis));
    Buffer.from(key).copy(result, 8);
    return result;
  };
  type ReferenceDelta = { key: ArrayBuffer, count: number };
  const noHeapKeysCreated: ReadonlySet<string> = new Set();
  const addReferenceDelta = (deltas: Map<string, ReferenceDelta>, key: ArrayBuffer, count: number) => {
    const id = encodeBase64(new Uint8Array(key));
    const existing = deltas.get(id);
    if (existing === undefined) deltas.set(id, { key, count });
    else existing.count += count;
  };
  /**
   * Runs `action` as one all-or-nothing LMDB transaction.
   *
   * We use `childTransaction` because it is the only async lmdb-js transaction that rolls back when
   * the callback throws. Plain `transaction()` keeps every write made before the throw, so an error
   * after a refcount write but before the root write would leave refcounts that disagree with the
   * root, and GC could later delete live data. `transactionSync()` also rolls back, but it commits on
   * the main thread and stalled the server for seconds under load.
   *
   * lmdb-js disables `childTransaction` when `useWritemap` or caching is on, so Breezy can't enable
   * either without replacing this rollback guarantee.
   */
  const transact = async (action: (version: number, writes: Promise<boolean>[]) => void) => {
    const transaction = await lmdbRoot.childTransaction(() => {
      const version = lmdbRoot.getWriteTxnId();
      const pending: Promise<boolean>[] = [];
      action(version, pending);
      return { version, pending };
    });
    await Promise.all(transaction.pending);
    return transaction.version;
  };
  let gcInitialization: Promise<void> | null = null;
  const initializeGc = async () => {
    if (gcGeneration !== null) return;
    gcInitialization ??= (async () => {
      if (lmdbGcState.get(Buffer.from("state")) === undefined) {
        await transact((version, writes) => writes.push(lmdbGcState.put(Buffer.from("state"), Buffer.from(JSON.stringify({
          schemaVersion: gcSchemaVersion,
          generation: `schema-v${gcSchemaVersion}`,
          status: "ready",
          repairCursorBase64: null,
        })), version)));
        await lmdbRoot.flushed;
      }
      activeGcGeneration();
    })();
    try {
      await gcInitialization;
    } catch (error) {
      gcInitialization = null;
      throw error;
    }
  };
  const changeReferenceDeltas = (
    deltas: Iterable<ReferenceDelta>,
    dereferencedAtMillis: number | null,
    version: number,
    writes: Promise<boolean>[],
    heapKeysCreatedByThisWrite: ReadonlySet<string>,
  ) => {
    const createdAtMillis = Math.max(Date.now(), processStartedAtMillis);
    let becameZero = 0;
    const changes: Array<{ key: Buffer, value: Buffer, candidateToAdd: Buffer | null, candidateToRemove: Buffer | null }> = [];
    for (const { key, count } of deltas) {
      const isCreatedByThisWrite = heapKeysCreatedByThisWrite.has(encodeBase64(new Uint8Array(key)));
      // A zero delta changes nothing, except for a new object: it still needs its record.
      if (count === 0 && !isCreatedByThisWrite) continue;
      const metadataKey = Buffer.from(key);
      const stored = lmdbMetadata.get(metadataKey);
      const previous = stored === undefined ? null : parseMetadata(stored);
      // Breezy creates a record in the same transaction that saves a new object, so a missing record
      // is expected only for objects this write created. Any other object without a record (or with
      // one from an older GC generation) was saved before refcount GC existed and its true count is
      // unknown. Like base's "legacy-immortal" rule, skip it so it's never deleted: a count started
      // here could reach zero while older parents still point at it.
      const isLegacyObject = previous === null
        ? !isCreatedByThisWrite
        : previous.generation !== activeGcGeneration();
      if (isLegacyObject) continue;
      if (previous === null && count < 0) throw new Error("Assertion error: Piledriver GC cannot decrement a heap object created by the same write");
      const referenceCount = (previous?.referenceCount ?? 0) + count;
      if (!Number.isSafeInteger(referenceCount) || referenceCount < 0) throw new Error("Piledriver GC reference count would become invalid");
      const lastDereferencedAtMillis = count < 0
        ? Math.max(previous?.lastDereferencedAtMillis ?? 0, dereferencedAtMillis ?? throwErr("Missing Piledriver GC dereference timestamp"))
        : previous?.lastDereferencedAtMillis ?? null;
      const replacement: ReferenceMetadata = previous === null
        ? { schemaVersion: gcSchemaVersion, generation: activeGcGeneration(), referenceCount, createdAtMillis, lastDereferencedAtMillis, deletion: null }
        : { ...previous, referenceCount, lastDereferencedAtMillis };
      // A new object that starts at zero is one only the root will point at. It becomes a GC
      // candidate right away, so if the root write fails it's collected like any other garbage.
      const becomesCandidate = referenceCount === 0 && (previous === null || previous.referenceCount !== 0);
      changes.push({
        key: metadataKey,
        value: Buffer.from(JSON.stringify(replacement)),
        candidateToAdd: becomesCandidate ? candidateKey(key, lastDereferencedAtMillis ?? replacement.createdAtMillis) : null,
        candidateToRemove: previous?.referenceCount === 0 && referenceCount !== 0 ? candidateKey(key, previous.lastDereferencedAtMillis ?? previous.createdAtMillis) : null,
      });
      if (previous !== null && previous.referenceCount !== 0 && referenceCount === 0) becameZero++;
    }
    for (const change of ascendingByKey(changes, change => change.key)) {
      writes.push(lmdbMetadata.put(change.key, change.value, version));
      if (change.candidateToAdd !== null) writes.push(lmdbCandidates.put(change.candidateToAdd, Buffer.alloc(0), version));
      if (change.candidateToRemove !== null) writes.push(lmdbCandidates.remove(change.candidateToRemove));
    }
    return becameZero;
  };
  const publishHeapObjects = async (objects: Array<{ key: ArrayBuffer, buffer: ArrayBuffer, referenceKeys: ArrayBuffer[] }>) => {
    if (objects.length === 0) return initialSeq;
    const deltas = new Map<string, ReferenceDelta>();
    // Every new object gets its record here, in the same transaction that saves it. A zero delta
    // creates the record for objects nothing new points at; the root write then adds its reference.
    for (const object of objects) addReferenceDelta(deltas, object.key, 0);
    for (const object of objects) for (const key of object.referenceKeys) addReferenceDelta(deltas, key, 1);
    const version = await transact((transactionVersion, writes) => {
      const heapKeys = new Set<string>();
      for (const object of objects) {
        const heapKeyBase64 = encodeBase64(new Uint8Array(object.key));
        if (heapKeys.has(heapKeyBase64)) throw new Error("Duplicate reserved Piledriver heap key");
        heapKeys.add(heapKeyBase64);
        if (lmdbHeap.doesExist(Buffer.from(object.key))) throw new Error("Reserved Piledriver heap key already exists");
      }
      changeReferenceDeltas(deltas.values(), null, transactionVersion, writes, heapKeys);
      for (const object of ascendingByKey(objects, object => new Uint8Array(object.key))) {
        writes.push(lmdbHeap.put(Buffer.from(object.key), Buffer.from(object.buffer), transactionVersion));
      }
    });
    return toSeq(version);
  };
  const mutateRoot = async (key: ArrayBuffer, next: ArrayBuffer | null, previous: ArrayBuffer | null, dereferencedAtMillis: number) => {
    const deltas = new Map<string, ReferenceDelta>();
    for (const [id, reference] of aggregateSerializedReferences(next)) deltas.set(id, { ...reference });
    for (const reference of aggregateSerializedReferences(previous).values()) addReferenceDelta(deltas, reference.key, -reference.count);
    const version = await transact((transactionVersion, writes) => {
      changeReferenceDeltas(deltas.values(), dereferencedAtMillis, transactionVersion, writes, noHeapKeysCreated);
      writes.push(next === null ? lmdbRoots.remove(Buffer.from(key)) : lmdbRoots.put(Buffer.from(key), Buffer.from(next), transactionVersion));
    });
    return { seq: toSeq(version) };
  };

  const combineSeqs = (seqs: Iterable<DatabaseSeq>) => {
    let combined = 0;
    for (const seq of seqs) combined = Math.max(combined, transactionId(seq));
    return toSeq(combined);
  };
  const withMutationLock = async <T>(operation: () => Promise<T>) => {
    const current = mutations.then(operation, operation);
    mutations = current;
    return await current;
  };

  const serializeKnown = (value: PlannedPiledriverObject) => encodePiledriverObject(value);

  /**
   * Plans the complete graph, then publishes every newly created heap object atomically.
   *
   * Planning replaces heap objects with key-only references, so serialization performs no cache
   * lookups or IO. If the root write then fails, the new objects are already GC candidates, so the
   * next GC after a restart collects them.
   */
  const serializeAndPublish = async (value: PiledriverObject) => {
    const plan = planHeapObjects(
      value,
      object => {
        const location = heapCache.getLocation(object);
        return location === undefined ? undefined : { key: location.key, dependency: location.seq };
      },
      reserveHeapKey,
    );
    const publications = [];
    for (const item of plan.heapObjects) {
      const buffer = serializeKnown(item.value);
      publications.push({ key: item.key, buffer, referenceKeys: plannedHeapReferenceKeys(item.value) });
    }
    const publicationSeq = await publishHeapObjects(publications);

    const publishedSeq = combineSeqs([publicationSeq, ...plan.dependencies]);
    for (const item of plan.heapObjects) {
      heapCache.remember(item.object, { key: item.key, seq: publishedSeq });
    }
    return serializeKnown(plan.root);
  };

  const readPreviousRoot = async (key: ArrayBuffer) => {
    const pendingWrite = lastRootWriteSeq;
    try {
      await waitUntilAvailable(pendingWrite);
    } catch (error) {
      if (lastRootWriteSeq === pendingWrite) lastRootWriteSeq = initialSeq;
      throw error;
    }
    return read(lmdbRoots, key);
  };
  let garbageCollectionRunning = false;
  const garbageCollectionsInProgress = new Set<Promise<unknown>>();
  let closing: Promise<void> | null = null;
  const throwIfClosing = () => {
    if (closing !== null) throw new Error("Breezy Piledriver database is closed");
  };
  const collectGarbageUntracked = async (cutoffTimestampMillis: number, maxObjects = 1000) => {
    const startedAtMillis = Date.now();
    const startedAt = performance.now();
    const initializationStartedAt = performance.now();
    await initializeGc();
    const initializationMillis = performance.now() - initializationStartedAt;
    const result = zeroPiledriverGarbageCollectionResult(cutoffTimestampMillis, processStartedAtMillis, maxObjects, startedAtMillis);
    if (cutoffTimestampMillis >= processStartedAtMillis) throw new Error("Piledriver GC cutoff must be older than this process; restart the Bulldozer service after recording the cutoff");
    if (garbageCollectionRunning) throw new Error("Piledriver garbage collection is already running");
    garbageCollectionRunning = true;

    const rangeEnd = Buffer.alloc(8);
    rangeEnd.writeBigUInt64BE(BigInt(cutoffTimestampMillis));
    const nextCandidate = () => {
      lmdbRoot.resetReadTxn();
      for (const { key } of lmdbCandidates.getRange({ end: rangeEnd, limit: 1 })) return Buffer.from(key);
      return null;
    };

    try {
      let candidate = nextCandidate();
      while (candidate !== null && result.objects.deleted < maxObjects) {
        if (candidate.byteLength <= 8) throw new Error("Invalid Piledriver GC candidate key");
        const indexedCandidate = candidate;
        const heapKeyBuffer = Buffer.from(candidate.subarray(8));
        const heapKey = arrayBuffer(heapKeyBuffer);
        result.objects.candidatesExamined++;
        result.objects.candidatesQueuedFromIndex = result.objects.candidatesExamined;
        result.scanning.candidateIndexEntriesRead++;

        await transact((version, writes) => {
          if (!lmdbCandidates.doesExist(indexedCandidate)) {
            result.objects.candidatesSkipped++;
            return;
          }
          const storedMetadata = lmdbMetadata.get(heapKeyBuffer) ?? throwErr("Piledriver GC candidate has no reference metadata");
          const metadata = parseMetadata(storedMetadata);
          const eligibleAtMillis = metadata.lastDereferencedAtMillis ?? metadata.createdAtMillis;
          const expectedCandidate = candidateKey(heapKey, eligibleAtMillis);
          if (metadata.generation !== activeGcGeneration()) throw new Error("Piledriver GC candidate belongs to an inactive generation");
          if (metadata.referenceCount !== 0) throw new Error("Piledriver GC candidate still has live references");
          if (!indexedCandidate.equals(expectedCandidate)) throw new Error("Piledriver GC candidate index is inconsistent with its metadata");

          const heapValue = lmdbHeap.get(heapKeyBuffer) ?? throwErr("Piledriver GC found metadata for a missing heap object");
          const references = [...aggregateSerializedReferences(arrayBuffer(heapValue)).values()];
          const deltas = references.map(reference => ({ key: reference.key, count: -reference.count }));
          result.objects.childObjectsBecameUnreferenced += changeReferenceDeltas(deltas, eligibleAtMillis, version, writes, noHeapKeysCreated);
          result.references.outgoingEdgesProcessed += references.reduce((sum, reference) => sum + reference.count, 0);
          writes.push(lmdbHeap.remove(heapKeyBuffer), lmdbMetadata.remove(heapKeyBuffer), lmdbCandidates.remove(indexedCandidate));

          result.objects.deleted++;
          result.reclaimed.heapPayloadBytes += heapValue.byteLength;
          result.reclaimed.heapKeyBytes += heapKeyBuffer.byteLength;
          result.reclaimed.metadataValueBytes += storedMetadata.byteLength;
          result.reclaimed.metadataKeyBytes += heapKeyBuffer.byteLength;
          result.reclaimed.candidateKeyBytes += indexedCandidate.byteLength;
          if (result.samples.deletedObjectKeysBase64.length < result.samples.limitPerCategory) result.samples.deletedObjectKeysBase64.push(encodeBase64(heapKeyBuffer));
          result.reclaimed.smallestHeapPayloadBytes = Math.min(result.reclaimed.smallestHeapPayloadBytes ?? Infinity, heapValue.byteLength);
          result.reclaimed.largestHeapPayloadBytes = Math.max(result.reclaimed.largestHeapPayloadBytes ?? 0, heapValue.byteLength);
        });
        candidate = nextCandidate();
      }

      const moreEligibleWorkMayRemain = candidate !== null;
      result.limits.limitReached = result.objects.deleted === maxObjects;
      result.limits.moreEligibleWorkMayRemain = moreEligibleWorkMayRemain;
      result.scanning.candidateIndexPagesRead = result.objects.candidatesExamined === 0 ? 0 : 1;
      result.scanning.candidateIndexReachedCutoff = !moreEligibleWorkMayRemain;
      result.scanning.candidateIndexScanComplete = !moreEligibleWorkMayRemain;

      const durabilityStartedAt = performance.now();
      await lmdbRoot.flushed;
      result.timing.durabilityWaitMillis = performance.now() - durabilityStartedAt;
      result.reclaimed.knownLogicalBytes = result.reclaimed.heapPayloadBytes + result.reclaimed.heapKeyBytes + result.reclaimed.metadataValueBytes + result.reclaimed.metadataKeyBytes + result.reclaimed.candidateKeyBytes;
      result.reclaimed.heapPayloadMiB = result.reclaimed.heapPayloadBytes / 1024 / 1024;
      result.reclaimed.knownLogicalMiB = result.reclaimed.knownLogicalBytes / 1024 / 1024;
      result.reclaimed.averageHeapPayloadBytes = result.objects.deleted === 0 ? null : result.reclaimed.heapPayloadBytes / result.objects.deleted;

      result.timing.initializationMillis = initializationMillis;
      result.timing.completedAtMillis = Date.now();
      result.timing.elapsedMillis = performance.now() - startedAt;
      result.timing.activeCollectionMillis = result.timing.elapsedMillis - result.timing.initializationMillis - result.timing.durabilityWaitMillis;
      result.timing.deletedObjectsPerSecond = result.timing.activeCollectionMillis === 0 ? 0 : result.objects.deleted * 1000 / result.timing.activeCollectionMillis;
      result.timing.reclaimedHeapMiBPerSecond = result.timing.activeCollectionMillis === 0 ? 0 : result.reclaimed.heapPayloadMiB * 1000 / result.timing.activeCollectionMillis;
      result.gcGeneration = activeGcGeneration();
      return result;
    } finally {
      garbageCollectionRunning = false;
    }
  };

  const collectGarbage = async (cutoffTimestampMillis: number, maxObjects?: number) => {
    throwIfClosing();
    const collection = collectGarbageUntracked(cutoffTimestampMillis, maxObjects);
    garbageCollectionsInProgress.add(collection);
    try {
      return await collection;
    } finally {
      garbageCollectionsInProgress.delete(collection);
    }
  };
  /**
   * Waits for writes and garbage collections already in progress, then closes LMDB. Closing LMDB
   * under them made them fail midway. New operations started after this is called throw.
   */
  const close = async () => {
    closing ??= withMutationLock(async () => {
      // Each collection's own caller gets its result or error; here we only wait for it to stop.
      await Promise.allSettled(garbageCollectionsInProgress);
      await lmdbRoot.close();
    });
    await closing;
  };

  return {
    getDebugInfo: () => ({ backend: "piledriver-breezy", constructorArguments: { lmdbOptions, options }, lmdbRoot, lmdbRoots, lmdbHeap, lmdbMetadata, lmdbCandidates, lmdbGcState, processStartedAtMillis, heapObjectsByObject, heapObjectsByHeapKeyBase64: heapCache.objectsByKey, heapKeysAndSeqByHeapObjects: heapCache.locations, heapReadCacheDisabled: options.disableHeapReadCache === true }),
    async getRootObject(key) {
      const stored = read(lmdbRoots, key);
      if (stored.buffer === null) throw new Error("Root object not found");
      return { object: decodePiledriverObject(stored.buffer, heapKey => heapCache.resolve(heapKey, stored.seq)), seq: stored.seq };
    },
    async setRootObject(key, value) {
      throwIfClosing();
      return await withMutationLock(async () => {
        await initializeGc();
        const previous = await readPreviousRoot(key);
        const serializedRoot = await serializeAndPublish(value);
        const written = await mutateRoot(
          key,
          serializedRoot,
          previous.buffer,
          Math.max(Date.now(), processStartedAtMillis),
        );
        lastRootWriteSeq = written.seq;
        return written;
      });
    },
    async deleteRootObject(key) {
      throwIfClosing();
      return await withMutationLock(async () => {
        await initializeGc();
        const previous = await readPreviousRoot(key);
        const deleted = await mutateRoot(
          key,
          null,
          previous.buffer,
          Math.max(Date.now(), processStartedAtMillis),
        );
        lastRootWriteSeq = deleted.seq;
        return deleted;
      });
    },
    getGarbageCollectionProcessStartedAtMillis: () => processStartedAtMillis,
    collectGarbage,
    combineSeqs: (...seqs) => combineSeqs(seqs),
    close,
    waitUntilAvailable,
    async waitUntilDurable(seq) {
      await waitUntilAvailable(seq);
      await lmdbRoot.flushed;
    },
    waitUntilReplicated: waitUntilAvailable,
    async waitUntilConsistent(seq) {
      await Promise.all([this.waitUntilReplicated(seq), this.waitUntilDurable(seq)]);
    },
    async debugSnapshot() {
      const entries = (database: lmdb.Database<Buffer, Uint8Array>) => [...database.getRange()].map(({ key, value }) => {
        const keyBuffer = Buffer.from(key);
        let keyUtf8: string | null;
        try {
          keyUtf8 = new TextDecoder("utf8", { fatal: true }).decode(keyBuffer);
        } catch {
          keyUtf8 = null;
        }
        return {
          keyBase64: encodeBase64(keyBuffer),
          keyUtf8,
          keyHex: keyBuffer.toString("hex"),
          serializedJson: JSON.parse(new TextDecoder().decode(value)),
          valueByteLength: value.byteLength,
        };
      });
      return { roots: entries(lmdbRoots), heap: entries(lmdbHeap) };
    },
    initialSeq,
  };
}

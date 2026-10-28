import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously, wait } from "@hexclave/shared/dist/utils/promises";
import { createUuidV7Generator } from "@hexclave/shared/dist/utils/uuids";
import type { BreezyFreePages, BreezyFreePageStats, BreezyStorage, BreezyStore } from "./storage.js";
import { shouldSuppressPeriodicBulldozerLogs } from "../../../../logging.js";
import { traceSpan } from "../../../../otel.js";
import { createDatabaseSeq, DatabaseSeq } from "../../../index.js";
import { aggregateSerializedReferences, zeroPiledriverGarbageCollectionResult } from "../../gc.js";
import { heapObjectsByObject, PiledriverDatabase, PiledriverObject } from "../../index.js";
import { decodePiledriverObject, encodePiledriverObject, plannedHeapReferenceKeys, PlannedPiledriverObject } from "./codec.js";
import { createPiledriverHeapCache } from "./heap-cache.js";
import { planHeapObjects } from "./heap-plan.js";

const breezyPiledriverProcessStartedAtMillis = Date.now();
const gcSchemaVersion = 3;
/**
 * How many garbage objects GC deletes per LMDB transaction.
 *
 * GC waits for each commit before starting the next, and a commit takes ~4 ms, so deleting one
 * object per transaction capped GC at ~200 objects/s (base, which lets its writes share commits,
 * did ~1,500/s). Each transaction holds LMDB's single write lock, so a bigger batch also delays
 * normal writes that arrive during GC; 256 per transaction raised write p50 from ~18 to ~78 ms.
 */
const gcDeletionsPerTransaction = 64;
/**
 * How many child refcount updates one GC transaction may make before it stops taking more objects.
 *
 * The object limit alone doesn't bound the work: each deleted object decrements every child it
 * references. Bulldozer's trees have at most 32 children per node, so a normal batch stays far below
 * this, but a caller-made heap object can reference thousands of children. 64 objects with 5,000
 * children each held the write lock for ~1.9 s in one transaction, stalling every write behind it.
 */
const gcReferenceUpdatesPerTransaction = 4096;

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

export type BreezyPiledriverDatabaseOptions = { disableHeapReadCache?: boolean, garbageCollectionProcessStartedAtMillis?: number };

/** What the service's /diagnostics endpoint shows for a Breezy backend. */
export type BreezyDiagnostics = {
  backend: string,
  dbId: string,
  /** Every write transaction since the database was opened, including failed ones. */
  writeTransactions: { count: number, averageMs: number, maxMs: number },
  fileSizesInBytes: Record<string, number>,
  /** Null when the storage engine can't release free pages. */
  freePages: BreezyFreePageStats | null,
};

/**
 * A release that can't run in the database's current state. Callers branch on `reason`; the message is
 * for logs only, and the HTTP boundary picks its own client-facing text per reason.
 */
export class FreePageReleaseConflictError extends Error {
  constructor(readonly reason: "already-running" | "cannot-release") {
    super(reason === "already-running"
      ? "A free page release is already running"
      : "This SQLite file was created without auto_vacuum=INCREMENTAL, so its free pages can't be released incrementally");
  }
}

type FreePageSnapshot = BreezyFreePageStats & { fileSizesInBytes: Record<string, number> };

export type FreePageReleaseResult = {
  /**
   * Why the release stopped, decided at the moment it stopped:
   * "limit": it released maxBytes, so free pages may remain; run it again.
   * "no-free-pages": the free list was empty when it last checked.
   * "no-progress": a chunk released nothing although free pages remained; running again won't help now.
   */
  stoppedBecause: "limit" | "no-free-pages" | "no-progress" | "dry-run",
  dryRun: boolean,
  before: FreePageSnapshot,
  after: FreePageSnapshot,
  released: { pages: number, bytes: number },
  chunks: { count: number, largestPages: number, maxMs: number, totalMs: number },
  /** Null on a dry run, which doesn't checkpoint. */
  checkpoint: ReturnType<BreezyFreePages["checkpoint"]> | null,
  elapsedMs: number,
};

/**
 * How long one chunk of a release may block the event loop. Chunks are sized by time, not by a fixed
 * page count, because the cost of a page grows with the file: SQLite searches its free-page list to
 * find a slot for every page it moves (allocateBtreePage, which dominated a native profile). Measured
 * on a Mac: ~7 µs per page on a 50 MiB file; on a 5 GiB one, ~55 µs with the small chunks this loop
 * uses and ~80–135 µs in fixed chunks of 250–8,000 pages (the cost per page grows with chunk size).
 * A fixed count small enough for big files would make releases needlessly slow on small ones.
 */
const freePageReleaseChunkBudgetMs = 5;
/** The first chunk is a small probe that measures the cost per page on this file. */
const freePageReleaseFirstChunkPages = 16;
/** Caps a chunk even when pages are cheap, so one chunk never adds more than 16 MiB to the WAL. */
const freePageReleaseMaxChunkPages = 4096;

/** Shared codec, heap cache, publication and GC logic for all Breezy storage engines. */
export function declareBreezyDatabaseWithStorage(
  storage: BreezyStorage,
  dbId = "default",
  options: BreezyPiledriverDatabaseOptions = {},
): PiledriverDatabase & {
  getDiagnostics(): BreezyDiagnostics,
  releaseFreePages(options: { maxBytes: number, dryRun: boolean }): Promise<FreePageReleaseResult>,
} {
  const processStartedAtMillis = options.garbageCollectionProcessStartedAtMillis ?? breezyPiledriverProcessStartedAtMillis;
  if (!Number.isSafeInteger(processStartedAtMillis) || processStartedAtMillis < 0) throw new Error("Piledriver garbageCollectionProcessStartedAtMillis must be a non-negative safe integer");
  const heapStore = storage.openStore(`${dbId}:dump:heap`);
  const rootsStore = storage.openStore(`${dbId}:store:root`);
  const metadataStore = storage.openStore(`${dbId}:store:piledriver-gc-reference-metadata-v3`);
  const candidatesStore = storage.openStore(`${dbId}:store:piledriver-gc-zero-reference-candidates-v3`);
  const gcStateStore = storage.openStore(`${dbId}:store:piledriver-gc-state-v3`);
  const generateHeapUuid = createUuidV7Generator();
  const initialSeq = createDatabaseSeq(dbId, 0);
  const toSeq = (transactionId: number) => createDatabaseSeq(dbId, transactionId);
  const transactionId = (seq: DatabaseSeq) => {
    const value = seq[1];
    if (seq[0] !== dbId || seq.length !== 2 || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Breezy sequence");
    return value;
  };
  const waitUntilAvailable = async (seq: DatabaseSeq) => {
    const required = transactionId(seq);
    while (storage.lastTransactionId() < required) await wait(1);
    storage.refreshReads();
  };
  const waitUntilDurable = async (seq: DatabaseSeq) => {
    await waitUntilAvailable(seq);
    await storage.flush();
  };
  const arrayBuffer =(value: Uint8Array) => Uint8Array.from(value).buffer;
  const reserveHeapKey = () => {
    const key = new Uint8Array(17);
    key[0] = 1;
    key.set(generateHeapUuid(), 1);
    return key.buffer;
  };
  const read = (database: BreezyStore, key: ArrayBuffer) => {
    const entry = database.getEntry(Buffer.from(key));
    if (entry === undefined) return { buffer: null, seq: initialSeq };
    return { buffer: arrayBuffer(entry.value), seq: toSeq(entry.version) };
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
  const readHeapObject = (key: ArrayBuffer, keyBase64: string) => {
    const stored = read(heapStore, key);
    if (stored.buffer === null) throw new Error(`Assertion error: Heap object with base64 key "${keyBase64}" not found`);
    return decodePiledriverObject(stored.buffer, childKey => heapCache.resolve(childKey, stored.seq), `heap object ${keyBase64}`);
  };
  // close() waits for these, so a paused load never resumes after storage is closed. A load that
  // doesn't pause runs start to finish without letting anything else run, so close() can't happen during it.
  const pausedHeapLoads = new Set<Promise<PiledriverObject>>();
  const loadHeapObject = async (key: ArrayBuffer, keyBase64: string) => {
    throwIfClosing();
    if (++heapLoadsSinceLastPause < heapLoadsBetweenPauses) return readHeapObject(key, keyBase64);
    heapLoadsSinceLastPause = 0;
    const pausedLoad = letWaitingRequestsRun().then(() => readHeapObject(key, keyBase64));
    pausedHeapLoads.add(pausedLoad);
    try {
      return await pausedLoad;
    } finally {
      pausedHeapLoads.delete(pausedLoad);
    }
  };
  const heapCache = createPiledriverHeapCache({ disabled: options.disableHeapReadCache === true, load: loadHeapObject });
  type WriteTransactionStats = { count: number, totalMs: number, maxMs: number };
  const noWriteTransactions = (): WriteTransactionStats => ({ count: 0, totalMs: 0, maxMs: 0 });
  const summarizeWriteTransactions = (stats: WriteTransactionStats) => ({
    count: stats.count,
    averageMs: stats.count === 0 ? 0 : stats.totalMs / stats.count,
    maxMs: stats.maxMs,
  });
  const writeTransactionsSinceOpen = noWriteTransactions();
  let writeTransactionsThisActivityWindow = noWriteTransactions();
  const activityLogIntervalMs = 5_000;
  // The same cadence as LMDB's "low-level lmdb activity" log, and like it, silent while idle.
  // An error thrown in a timer callback has no caller to catch it and would crash the process, so
  // report it to Sentry instead: a broken diagnostics log must not take the service down.
  const activityLogInterval = setInterval(() => runAsynchronously(async () => {
    const window = writeTransactionsThisActivityWindow;
    writeTransactionsThisActivityWindow = noWriteTransactions();
    if (window.count === 0 || shouldSuppressPeriodicBulldozerLogs) return;
    console.debug("bulldozer-js breezy activity", {
      backend: storage.backend,
      dbId,
      writeTransactionsPerSecond: window.count / (activityLogIntervalMs / 1000),
      writeTransactions: summarizeWriteTransactions(window),
      fileSizesInBytes: storage.fileSizesInBytes(),
    });
  }), activityLogIntervalMs);
  activityLogInterval.unref();
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
    const value = gcStateStore.get(Buffer.from("state"));
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
   * Runs `action` as one all-or-nothing storage transaction.
   *
   * Every storage engine must roll back all of the callback's writes when it throws (see
   * storage.test.ts). Otherwise an error after a refcount write but before the root write would
   * leave refcounts that disagree with the root, and GC could later delete live data.
   */
  const transact = async (action: (version: number, writes: Promise<boolean>[]) => void) => {
    const startedAt = performance.now();
    try {
      const transaction = await storage.transaction(version => {
        const pending: Promise<boolean>[] = [];
        action(version, pending);
        return { version, pending };
      });
      await Promise.all(transaction.pending);
      return transaction.version;
    } finally {
      // Failed transactions count too: they held the write lock (and, on SQLite, the main thread).
      const elapsedMs = performance.now() - startedAt;
      for (const stats of [writeTransactionsSinceOpen, writeTransactionsThisActivityWindow]) {
        stats.count++;
        stats.totalMs += elapsedMs;
        stats.maxMs = Math.max(stats.maxMs, elapsedMs);
      }
    }
  };
  let gcInitialization: Promise<void> | null = null;
  const initializeGc = async () => {
    if (gcGeneration !== null) return;
    gcInitialization ??= (async () => {
      if (gcStateStore.get(Buffer.from("state")) === undefined) {
        await transact((version, writes) => writes.push(gcStateStore.put(Buffer.from("state"), Buffer.from(JSON.stringify({
          schemaVersion: gcSchemaVersion,
          generation: `schema-v${gcSchemaVersion}`,
          status: "ready",
          repairCursorBase64: null,
        })), version)));
        await storage.flush();
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
      const stored = metadataStore.get(metadataKey);
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
      writes.push(metadataStore.put(change.key, change.value, version));
      if (change.candidateToAdd !== null) writes.push(candidatesStore.put(change.candidateToAdd, Buffer.alloc(0), version));
      if (change.candidateToRemove !== null) writes.push(candidatesStore.remove(change.candidateToRemove));
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
        if (heapStore.doesExist(Buffer.from(object.key))) throw new Error("Reserved Piledriver heap key already exists");
      }
      changeReferenceDeltas(deltas.values(), null, transactionVersion, writes, heapKeys);
      for (const object of ascendingByKey(objects, object => new Uint8Array(object.key))) {
        writes.push(heapStore.put(Buffer.from(object.key), Buffer.from(object.buffer), transactionVersion));
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
      writes.push(next === null ? rootsStore.remove(Buffer.from(key)) : rootsStore.put(Buffer.from(key), Buffer.from(next), transactionVersion));
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
    const planStartedAt = performance.now();
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
    const planMs = performance.now() - planStartedAt;
    const publishStartedAt = performance.now();
    const publicationSeq = await publishHeapObjects(publications);
    const publishMs = performance.now() - publishStartedAt;

    const publishedSeq = combineSeqs([publicationSeq, ...plan.dependencies]);
    for (const item of plan.heapObjects) {
      heapCache.remember(item.object, { key: item.key, seq: publishedSeq });
    }
    return { serializedRoot: serializeKnown(plan.root), heapObjectsPublished: publications.length, planMs, publishMs };
  };

  const readPreviousRoot = async (key: ArrayBuffer) => {
    const pendingWrite = lastRootWriteSeq;
    try {
      await waitUntilAvailable(pendingWrite);
    } catch (error) {
      if (lastRootWriteSeq === pendingWrite) lastRootWriteSeq = initialSeq;
      throw error;
    }
    return read(rootsStore, key);
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
    const readCandidates = (limit: number) => {
      storage.refreshReads();
      const candidates: Buffer[] = [];
      for (const { key } of candidatesStore.getRange({ end: rangeEnd, limit })) candidates.push(Buffer.from(key));
      return candidates;
    };

    /**
     * Deletes one zero-reference heap object and decrements its children. Must run inside `transact`.
     * Returns how many child refcounts it updated.
     */
    const deleteCandidate = (indexedCandidate: Buffer, version: number, writes: Promise<boolean>[]) => {
      const heapKeyBuffer = Buffer.from(indexedCandidate.subarray(8));
      const heapKey = arrayBuffer(heapKeyBuffer);
      if (!candidatesStore.doesExist(indexedCandidate)) {
        result.objects.candidatesSkipped++;
        return 0;
      }
      const storedMetadata = metadataStore.get(heapKeyBuffer) ?? throwErr("Piledriver GC candidate has no reference metadata");
      const metadata = parseMetadata(storedMetadata);
      const eligibleAtMillis = metadata.lastDereferencedAtMillis ?? metadata.createdAtMillis;
      const expectedCandidate = candidateKey(heapKey, eligibleAtMillis);
      if (metadata.generation !== activeGcGeneration()) throw new Error("Piledriver GC candidate belongs to an inactive generation");
      if (metadata.referenceCount !== 0) throw new Error("Piledriver GC candidate still has live references");
      if (!indexedCandidate.equals(expectedCandidate)) throw new Error("Piledriver GC candidate index is inconsistent with its metadata");

      const heapValue = heapStore.get(heapKeyBuffer) ?? throwErr("Piledriver GC found metadata for a missing heap object");
      const references = [...aggregateSerializedReferences(arrayBuffer(heapValue)).values()];
      const deltas = references.map(reference => ({ key: reference.key, count: -reference.count }));
      result.objects.childObjectsBecameUnreferenced += changeReferenceDeltas(deltas, eligibleAtMillis, version, writes, noHeapKeysCreated);
      result.references.outgoingEdgesProcessed += references.reduce((sum, reference) => sum + reference.count, 0);
      writes.push(heapStore.remove(heapKeyBuffer), metadataStore.remove(heapKeyBuffer), candidatesStore.remove(indexedCandidate));

      result.objects.deleted++;
      result.reclaimed.heapPayloadBytes += heapValue.byteLength;
      result.reclaimed.heapKeyBytes += heapKeyBuffer.byteLength;
      result.reclaimed.metadataValueBytes += storedMetadata.byteLength;
      result.reclaimed.metadataKeyBytes += heapKeyBuffer.byteLength;
      result.reclaimed.candidateKeyBytes += indexedCandidate.byteLength;
      if (result.samples.deletedObjectKeysBase64.length < result.samples.limitPerCategory) result.samples.deletedObjectKeysBase64.push(encodeBase64(heapKeyBuffer));
      result.reclaimed.smallestHeapPayloadBytes = Math.min(result.reclaimed.smallestHeapPayloadBytes ?? Infinity, heapValue.byteLength);
      result.reclaimed.largestHeapPayloadBytes = Math.max(result.reclaimed.largestHeapPayloadBytes ?? 0, heapValue.byteLength);
      return references.length;
    };

    try {
      while (result.objects.deleted < maxObjects) {
        const batch = readCandidates(Math.min(gcDeletionsPerTransaction, maxObjects - result.objects.deleted));
        if (batch.length === 0) break;
        for (const candidate of batch) {
          if (candidate.byteLength <= 8) throw new Error("Invalid Piledriver GC candidate key");
        }
        // Counted when read, not when processed: candidates the budget leaves out are read again by
        // the next batch, and that rereading is real scan work.
        result.scanning.candidateIndexEntriesRead += batch.length;

        // Two objects in one batch can point at the same child. That's safe because reads inside a
        // transaction see its own earlier writes, so the second decrement starts from the first's
        // result. A child that reaches zero becomes a candidate here and is deleted by a later batch.
        await transact((version, writes) => {
          let referenceUpdates = 0;
          for (const candidate of batch) {
            // Checked before each object rather than after, so one object over the budget is still
            // deleted on its own. Candidates left out stay in the index for the next batch.
            if (referenceUpdates >= gcReferenceUpdatesPerTransaction) break;
            result.objects.candidatesExamined++;
            referenceUpdates += deleteCandidate(candidate, version, writes);
          }
        });
        result.objects.candidatesQueuedFromIndex = result.objects.candidatesExamined;
        // Engines whose transactions finish synchronously (SQLite) resolve `transact` without ever
        // giving queued I/O a turn, so without this a long GC froze every request until it finished.
        await letWaitingRequestsRun();
      }

      const moreEligibleWorkMayRemain = readCandidates(1).length > 0;
      result.limits.limitReached = result.objects.deleted === maxObjects;
      result.limits.moreEligibleWorkMayRemain = moreEligibleWorkMayRemain;
      result.scanning.candidateIndexPagesRead = result.objects.candidatesExamined === 0 ? 0 : 1;
      result.scanning.candidateIndexReachedCutoff = !moreEligibleWorkMayRemain;
      result.scanning.candidateIndexScanComplete = !moreEligibleWorkMayRemain;

      const durabilityStartedAt = performance.now();
      await storage.flush();
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
  let freePageReleaseRunning = false;
  const freePageReleasesInProgress = new Set<Promise<unknown>>();
  const freePageSnapshot = (freePages: BreezyFreePages): FreePageSnapshot => ({ ...freePages.stats(), fileSizesInBytes: storage.fileSizesInBytes() });
  /**
   * Gives free pages (space GC already emptied) back to the operating system, which shrinks the file.
   * It never deletes data. Each chunk is one synchronous write on the service's only connection, then
   * waiting requests get a turn, so writers wait at most one chunk and never fight for SQLite's lock.
   * No mutation lock: a chunk can't interleave with a write transaction, since both run synchronously.
   */
  const releaseFreePagesUntracked = async ({ maxBytes, dryRun }: { maxBytes: number, dryRun: boolean }): Promise<FreePageReleaseResult> => {
    const startedAt = performance.now();
    const freePages = storage.freePages ?? throwErr(`The ${storage.backend} storage engine can't release free pages`);
    const before = freePageSnapshot(freePages);
    const chunks = { count: 0, largestPages: 0, maxMs: 0, totalMs: 0 };
    if (dryRun) {
      return { stoppedBecause: "dry-run", dryRun, before, after: before, released: { pages: 0, bytes: 0 }, chunks, checkpoint: null, elapsedMs: performance.now() - startedAt };
    }
    if (!before.canRelease) {
      throw new FreePageReleaseConflictError("cannot-release");
    }
    if (freePageReleaseRunning) throw new FreePageReleaseConflictError("already-running");
    freePageReleaseRunning = true;
    try {
      const maxPages = Math.floor(maxBytes / before.pageSizeBytes);
      let releasedPages = 0;
      let nextChunkPages = freePageReleaseFirstChunkPages;
      // Decided where the loop stops, not afterwards from the free-page count: writes during the
      // yields can free new pages, and deriving the reason from a later count reported "limit" for a
      // release that never reached its limit, which made `--all` keep going.
      let stoppedBecause: "limit" | "no-free-pages" | "no-progress";
      for (;;) {
        if (releasedPages >= maxPages) {
          stoppedBecause = "limit";
          break;
        }
        // Read after the previous yield, so pages freed during it are released too. Nothing awaits
        // between the last read and the snapshot below, so a "no-free-pages" result is still true then.
        if (freePages.stats().freePages === 0) {
          stoppedBecause = "no-free-pages";
          break;
        }
        const chunkPages = Math.min(nextChunkPages, maxPages - releasedPages);
        const chunkStartedAt = performance.now();
        const released = freePages.release(chunkPages);
        const chunkMs = performance.now() - chunkStartedAt;
        chunks.count++;
        chunks.totalMs += chunkMs;
        chunks.maxMs = Math.max(chunks.maxMs, chunkMs);
        chunks.largestPages = Math.max(chunks.largestPages, chunkPages);
        releasedPages += released;
        if (released === 0) {
          stoppedBecause = "no-progress";
          break;
        }
        const msPerPage = chunkMs / chunkPages;
        nextChunkPages = msPerPage === 0
          ? freePageReleaseMaxChunkPages
          : Math.max(1, Math.min(freePageReleaseMaxChunkPages, Math.floor(freePageReleaseChunkBudgetMs / msPerPage)));
        await letWaitingRequestsRun();
      }
      // The released pages only leave the main file once the WAL is applied to it.
      const checkpoint = freePages.checkpoint();
      const after = freePageSnapshot(freePages);
      const result: FreePageReleaseResult = {
        stoppedBecause,
        dryRun,
        before,
        after,
        released: { pages: releasedPages, bytes: releasedPages * before.pageSizeBytes },
        chunks,
        checkpoint,
        elapsedMs: performance.now() - startedAt,
      };
      console.log("bulldozer-js breezy releaseFreePages", { backend: storage.backend, dbId, ...result });
      return result;
    } finally {
      freePageReleaseRunning = false;
    }
  };
  const releaseFreePages = async (options: { maxBytes: number, dryRun: boolean }) => {
    throwIfClosing();
    const release = releaseFreePagesUntracked(options);
    freePageReleasesInProgress.add(release);
    try {
      return await release;
    } finally {
      freePageReleasesInProgress.delete(release);
    }
  };
  /**
   * Waits for writes, garbage collections, free page releases and heap reads already in progress, then closes storage.
   * Closing storage under them made them fail midway. New operations started after this is called
   * throw, so nothing new can start while this waits.
   */
  const close = async () => {
    closing ??= withMutationLock(async () => {
      // Each operation's own caller gets its result or error; here we only wait for it to stop.
      await Promise.allSettled([...garbageCollectionsInProgress, ...freePageReleasesInProgress, ...pausedHeapLoads]);
      clearInterval(activityLogInterval);
      await storage.close();
    });
    await closing;
  };

  return {
    getDebugInfo: () => ({ backend: storage.backend, storage, heapStore, rootsStore, metadataStore, candidatesStore, gcStateStore, options, processStartedAtMillis, heapObjectsByObject, heapObjectsByHeapKeyBase64: heapCache.objectsByKey, heapKeysAndSeqByHeapObjects: heapCache.locations, heapReadCacheDisabled: options.disableHeapReadCache === true }),
    getDiagnostics: () => ({
      backend: storage.backend,
      dbId,
      writeTransactions: summarizeWriteTransactions(writeTransactionsSinceOpen),
      fileSizesInBytes: storage.fileSizesInBytes(),
      freePages: storage.freePages?.stats() ?? null,
    }),
    releaseFreePages: async options => await traceSpan("bulldozer-js.piledriver.releaseFreePages", async () => await releaseFreePages(options)),
    // Span names (including the doubled "bulldozer-js." that traceSpan adds) match base.ts, so the
    // same trace queries and dashboards work on every backend.
    getRootObject: async key => await traceSpan("bulldozer-js.piledriver.getRootObject", async () => {
      throwIfClosing();
      const stored = read(rootsStore, key);
      if (stored.buffer === null) throw new Error("Root object not found");
      return { object: decodePiledriverObject(stored.buffer, heapKey => heapCache.resolve(heapKey, stored.seq), `root ${encodeBase64(new Uint8Array(key))}`), seq: stored.seq };
    }),
    setRootObject: async (key, value) => await traceSpan("bulldozer-js.piledriver.setRootObject", async () => {
      throwIfClosing();
      const startedAt = performance.now();
      return await withMutationLock(async () => {
        const mutationLockWaitMs = performance.now() - startedAt;
        await initializeGc();
        const readPreviousRootStartedAt = performance.now();
        const previous = await readPreviousRoot(key);
        const readPreviousRootMs = performance.now() - readPreviousRootStartedAt;
        const { serializedRoot, heapObjectsPublished, planMs, publishMs } = await serializeAndPublish(value);
        const rootWriteStartedAt = performance.now();
        const written = await mutateRoot(
          key,
          serializedRoot,
          previous.buffer,
          Math.max(Date.now(), processStartedAtMillis),
        );
        const rootWriteMs = performance.now() - rootWriteStartedAt;
        lastRootWriteSeq = written.seq;
        if (!shouldSuppressPeriodicBulldozerLogs) {
          // Same message as base.ts, so existing log queries find it; elapsedMs and rootValueBytes
          // mean the same thing there. The other fields are Breezy's own phases.
          console.debug("bulldozer-js piledriver setRootObject timing", {
            backend: storage.backend,
            elapsedMs: performance.now() - startedAt,
            mutationLockWaitMs,
            readPreviousRootMs,
            planHeapObjectsMs: planMs,
            publishHeapObjectsMs: publishMs,
            heapObjectsPublished,
            rootWriteMs,
            rootValueBytes: serializedRoot.byteLength,
          });
        }
        return written;
      });
    }),
    deleteRootObject: async key => await traceSpan("bulldozer-js.piledriver.deleteRootObject", async () => {
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
    }),
    getGarbageCollectionProcessStartedAtMillis: () => processStartedAtMillis,
    collectGarbage: async (cutoffTimestampMillis, maxObjects) => await traceSpan("bulldozer-js.piledriver.collectGarbage", async () => await collectGarbage(cutoffTimestampMillis, maxObjects)),
    combineSeqs: (...seqs) => combineSeqs(seqs),
    close,
    waitUntilAvailable: async seq => await traceSpan("bulldozer-js.piledriver.waitUntilAvailable", async () => await waitUntilAvailable(seq)),
    waitUntilDurable: async seq => await traceSpan("bulldozer-js.piledriver.waitUntilDurable", async () => await waitUntilDurable(seq)),
    waitUntilReplicated: async seq => await traceSpan("bulldozer-js.piledriver.waitUntilReplicated", async () => await waitUntilAvailable(seq)),
    waitUntilConsistent: async seq => await traceSpan("bulldozer-js.piledriver.waitUntilConsistent", async () => await waitUntilDurable(seq)),
    debugSnapshot: async () => await traceSpan("bulldozer-js.piledriver.debugSnapshot", async () => {
      const entries = (database: BreezyStore) => [...database.getRange()].map(({ key, value }) => {
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
      return { roots: entries(rootsStore), heap: entries(heapStore) };
    }),
    initialSeq,
  };
}

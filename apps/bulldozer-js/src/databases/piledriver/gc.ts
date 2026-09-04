import { decodeBase64, encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { DatabaseSeq } from "../index.js";
import { LowLevelDatabase, LowLevelKvDump } from "../low-level/index.js";

// A version bump creates new stores and leaves the previous stores orphaned. Before the next
// bump, add an explicit cleanup path for those stores and diagnostics for objects moved into the
// legacy-immortal set, so the rollout's retained storage is both bounded and visible.
const GC_SCHEMA_VERSION = 3;
const INITIAL_GC_GENERATION = `schema-v${GC_SCHEMA_VERSION}`;
const GC_SCAN_PAGE_SIZE = 1000;
const GC_DIAGNOSTIC_SAMPLE_LIMIT = 25;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const gcStateKey = textEncoder.encode("state").buffer;

type ReferenceMetadata = {
  schemaVersion: typeof GC_SCHEMA_VERSION,
  generation: string,
  referenceCount: number,
  createdAtMillis: number,
  lastDereferencedAtMillis: number | null,
  deletion: {
    nextReferenceIndex: number,
    totalReferences: number,
  } | null,
};

type GarbageCollectionState = {
  schemaVersion: typeof GC_SCHEMA_VERSION,
  generation: string,
  status: "ready",
  repairCursorBase64: string | null,
};

export type PiledriverGarbageCollectionResult = {
  cutoff: {
    timestampMillis: number,
    timestampIso: string,
    processStartedAtMillis: number,
    processStartedAtIso: string,
    ageAtCollectionStartMillis: number,
    restartBarrierMarginMillis: number,
    collectionStartedMillisAfterProcessStart: number,
  },
  limits: {
    maxObjects: number,
    limitReached: boolean,
    moreEligibleWorkMayRemain: boolean,
    queuedCandidatesRemaining: number,
  },
  objects: {
    deleted: number,
    candidatesExamined: number,
    candidatesQueuedFromIndex: number,
    candidatesQueuedFromMetadataRepair: number,
    candidatesSkipped: number,
    metadataEntriesExaminedForRepair: number,
    resumedDeletions: number,
    childObjectsBecameUnreferenced: number,
    maxCascadeDepth: number,
    duplicateQueueAttemptsIgnored: number,
  },
  references: {
    outgoingEdgesProcessed: number,
    legacyImmortalEdgesIgnored: number,
    referenceCountCompareAndSetAttempts: number,
    referenceCountCompareAndSetConflicts: number,
  },
  recovery: {
    missingCandidateEntriesRepaired: number,
    staleCandidatesWithoutMetadataRemoved: number,
    staleCandidatesFromInactiveGenerationsRemoved: number,
    staleCandidatesWithLiveReferencesRemoved: number,
    staleCandidateKeysCorrected: number,
    candidatesNoLongerOldEnough: number,
    deletionClaimConflicts: number,
    deletionProgressCompareAndSetConflicts: number,
  },
  reclaimed: {
    heapPayloadBytes: number,
    heapPayloadMiB: number,
    heapKeyBytes: number,
    metadataValueBytes: number,
    metadataKeyBytes: number,
    candidateKeyBytes: number,
    knownLogicalBytes: number,
    knownLogicalMiB: number,
    smallestHeapPayloadBytes: number | null,
    largestHeapPayloadBytes: number | null,
    averageHeapPayloadBytes: number | null,
    physicalFileBytesReduced: null,
    physicalStorageNote: string,
  },
  scanning: {
    candidateIndexPagesRead: number,
    candidateIndexEntriesRead: number,
    candidateIndexReachedCutoff: boolean,
    candidateIndexScanComplete: boolean,
    metadataRepairPagesRead: number,
    metadataRepairPassComplete: boolean,
  },
  samples: {
    limitPerCategory: number,
    deletedObjectKeysBase64: string[],
    resumedDeletionObjectKeysBase64: string[],
    repairedMissingCandidateObjectKeysBase64: string[],
    staleCandidateObjectKeysBase64: string[],
    legacyImmortalReferencedObjectKeysBase64: string[],
  },
  timing: {
    startedAtMillis: number,
    completedAtMillis: number,
    elapsedMillis: number,
    initializationMillis: number,
    candidateIndexReadMillis: number,
    metadataRepairMillis: number,
    durabilityWaitMillis: number,
    activeCollectionMillis: number,
    deletedObjectsPerSecond: number,
    reclaimedHeapMiBPerSecond: number,
  },
  gcGeneration: string,
};

export function zeroPiledriverGarbageCollectionResult(
  cutoffTimestampMillis: number,
  processStartedAtMillis: number,
  maxObjects: number,
  startedAtMillis: number,
): PiledriverGarbageCollectionResult {
  parseNonNegativeInteger(cutoffTimestampMillis, "cutoffTimestampMillis");
  parseNonNegativeInteger(processStartedAtMillis, "processStartedAtMillis");
  parseNonNegativeInteger(startedAtMillis, "startedAtMillis");
  if (!Number.isSafeInteger(maxObjects) || maxObjects <= 0) throw new Error("Piledriver GC maxObjects must be a positive safe integer");
  const completedAtMillis = startedAtMillis;
  const elapsedMillis = 0;
  return {
    cutoff: {
      timestampMillis: cutoffTimestampMillis,
      timestampIso: new Date(cutoffTimestampMillis).toISOString(),
      processStartedAtMillis,
      processStartedAtIso: new Date(processStartedAtMillis).toISOString(),
      ageAtCollectionStartMillis: Math.max(0, startedAtMillis - cutoffTimestampMillis),
      restartBarrierMarginMillis: processStartedAtMillis - cutoffTimestampMillis,
      collectionStartedMillisAfterProcessStart: Math.max(0, startedAtMillis - processStartedAtMillis),
    },
    limits: { maxObjects, limitReached: false, moreEligibleWorkMayRemain: false, queuedCandidatesRemaining: 0 },
    objects: {
      deleted: 0,
      candidatesExamined: 0,
      candidatesQueuedFromIndex: 0,
      candidatesQueuedFromMetadataRepair: 0,
      candidatesSkipped: 0,
      metadataEntriesExaminedForRepair: 0,
      resumedDeletions: 0,
      childObjectsBecameUnreferenced: 0,
      maxCascadeDepth: 0,
      duplicateQueueAttemptsIgnored: 0,
    },
    references: {
      outgoingEdgesProcessed: 0,
      legacyImmortalEdgesIgnored: 0,
      referenceCountCompareAndSetAttempts: 0,
      referenceCountCompareAndSetConflicts: 0,
    },
    recovery: {
      missingCandidateEntriesRepaired: 0,
      staleCandidatesWithoutMetadataRemoved: 0,
      staleCandidatesFromInactiveGenerationsRemoved: 0,
      staleCandidatesWithLiveReferencesRemoved: 0,
      staleCandidateKeysCorrected: 0,
      candidatesNoLongerOldEnough: 0,
      deletionClaimConflicts: 0,
      deletionProgressCompareAndSetConflicts: 0,
    },
    reclaimed: {
      heapPayloadBytes: 0,
      heapPayloadMiB: 0,
      heapKeyBytes: 0,
      metadataValueBytes: 0,
      metadataKeyBytes: 0,
      candidateKeyBytes: 0,
      knownLogicalBytes: 0,
      knownLogicalMiB: 0,
      smallestHeapPayloadBytes: null,
      largestHeapPayloadBytes: null,
      averageHeapPayloadBytes: null,
      physicalFileBytesReduced: null,
      physicalStorageNote: "In-memory storage has no persistent file to reclaim.",
    },
    scanning: {
      candidateIndexPagesRead: 0,
      candidateIndexEntriesRead: 0,
      candidateIndexReachedCutoff: false,
      candidateIndexScanComplete: true,
      metadataRepairPagesRead: 0,
      metadataRepairPassComplete: true,
    },
    samples: {
      limitPerCategory: GC_DIAGNOSTIC_SAMPLE_LIMIT,
      deletedObjectKeysBase64: [],
      resumedDeletionObjectKeysBase64: [],
      repairedMissingCandidateObjectKeysBase64: [],
      staleCandidateObjectKeysBase64: [],
      legacyImmortalReferencedObjectKeysBase64: [],
    },
    timing: {
      startedAtMillis,
      completedAtMillis,
      elapsedMillis,
      initializationMillis: 0,
      candidateIndexReadMillis: 0,
      metadataRepairMillis: 0,
      durabilityWaitMillis: 0,
      activeCollectionMillis: 0,
      deletedObjectsPerSecond: 0,
      reclaimedHeapMiBPerSecond: 0,
    },
    gcGeneration: "none",
  };
}

function encodeJson(value: unknown) {
  return textEncoder.encode(JSON.stringify(value)).buffer;
}

function parseJson(buffer: ArrayBuffer): unknown {
  return JSON.parse(textDecoder.decode(buffer));
}

function parseNonNegativeInteger(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid Piledriver GC ${name}`);
  }
  return value;
}

function parseReferenceMetadata(buffer: ArrayBuffer): ReferenceMetadata {
  const parsed = parseJson(buffer);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid Piledriver GC reference metadata");
  const schemaVersion = parsed["schemaVersion"];
  const generation = parsed["generation"];
  const lastDereferencedAtMillis = parsed["lastDereferencedAtMillis"];
  const deletionValue = parsed["deletion"];
  if (schemaVersion !== GC_SCHEMA_VERSION || typeof generation !== "string") {
    throw new Error("Invalid Piledriver GC reference metadata header");
  }
  const parsedLastDereferencedAtMillis = lastDereferencedAtMillis === null
    ? null
    : parseNonNegativeInteger(lastDereferencedAtMillis, "lastDereferencedAtMillis");

  let deletion: ReferenceMetadata["deletion"] = null;
  if (deletionValue !== null) {
    if (typeof deletionValue !== "object" || Array.isArray(deletionValue)) throw new Error("Invalid Piledriver GC deletion metadata");
    deletion = {
      nextReferenceIndex: parseNonNegativeInteger(deletionValue["nextReferenceIndex"], "nextReferenceIndex"),
      totalReferences: parseNonNegativeInteger(deletionValue["totalReferences"], "totalReferences"),
    };
    if (deletion.nextReferenceIndex > deletion.totalReferences) throw new Error("Invalid Piledriver GC deletion progress");
  }

  return {
    schemaVersion,
    generation,
    referenceCount: parseNonNegativeInteger(parsed["referenceCount"], "referenceCount"),
    createdAtMillis: parseNonNegativeInteger(parsed["createdAtMillis"], "createdAtMillis"),
    lastDereferencedAtMillis: parsedLastDereferencedAtMillis,
    deletion,
  };
}

function parseGarbageCollectionState(buffer: ArrayBuffer): GarbageCollectionState {
  const parsed = parseJson(buffer);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Invalid Piledriver GC state");
  const schemaVersion = parsed["schemaVersion"];
  const generation = parsed["generation"];
  const status = parsed["status"];
  const repairCursorBase64 = parsed["repairCursorBase64"];
  if (
    schemaVersion !== GC_SCHEMA_VERSION
    || typeof generation !== "string"
    || status !== "ready"
    || (repairCursorBase64 !== null && typeof repairCursorBase64 !== "string")
  ) {
    throw new Error("Unsupported Piledriver GC state");
  }
  return { schemaVersion, generation, status, repairCursorBase64 };
}

function serializedHeapReferenceKeys(buffer: ArrayBuffer): ArrayBuffer[] {
  const result: ArrayBuffer[] = [];
  const pending: unknown[] = [parseJson(buffer)];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") continue;
    if (Array.isArray(value)) {
      const tag = value[0];
      if (tag === "heap-reference") {
        if (value.length !== 2 || typeof value[1] !== "string") throw new Error("Invalid serialized Piledriver heap reference");
        result.push(decodeBase64(value[1]).buffer);
        continue;
      }
      if (tag === "array") {
        if (value.length !== 2 || !Array.isArray(value[1])) throw new Error("Invalid serialized Piledriver array");
        for (const item of value[1]) pending.push(item);
        continue;
      }
      if ((tag === "NaN" || tag === "Infinity" || tag === "-Infinity" || tag === "-0") && value.length === 1) continue;
      throw new Error("Invalid serialized Piledriver tagged value");
    }
    if (typeof value === "object") {
      for (const child of Object.values(value)) pending.push(child);
      continue;
    }
    throw new Error("Invalid serialized Piledriver value");
  }
  return result;
}

function aggregateKeys(keys: ArrayBuffer[]) {
  const result = new Map<string, { key: ArrayBuffer, count: number }>();
  for (const key of keys) {
    const keyBase64 = encodeBase64(new Uint8Array(key));
    const existing = result.get(keyBase64);
    if (existing === undefined) result.set(keyBase64, { key, count: 1 });
    else existing.count++;
  }
  return result;
}

export function aggregateSerializedReferences(buffer: ArrayBuffer | null) {
  return aggregateKeys(buffer === null ? [] : serializedHeapReferenceKeys(buffer));
}

function candidateKey(heapKey: ArrayBuffer, eligibleAtMillis: number) {
  parseNonNegativeInteger(eligibleAtMillis, "candidate eligibleAtMillis");
  if (heapKey.byteLength + 8 > 64) throw new Error("Piledriver heap key is too large for the GC candidate index");
  const result = new Uint8Array(heapKey.byteLength + 8);
  new DataView(result.buffer).setBigUint64(0, BigInt(eligibleAtMillis));
  result.set(new Uint8Array(heapKey), 8);
  return result.buffer;
}

function parseCandidateKey(key: ArrayBuffer) {
  if (key.byteLength <= 8) throw new Error("Invalid Piledriver GC candidate key");
  const eligibleAtBigInt = new DataView(key).getBigUint64(0);
  const eligibleAtMillis = Number(eligibleAtBigInt);
  if (!Number.isSafeInteger(eligibleAtMillis)) throw new Error("Piledriver GC candidate timestamp is too large");
  return {
    eligibleAtMillis,
    heapKey: key.slice(8),
  };
}

function arrayBuffersAreEqual(a: ArrayBuffer, b: ArrayBuffer) {
  if (a.byteLength !== b.byteLength) return false;
  const aBytes = new Uint8Array(a);
  const bBytes = new Uint8Array(b);
  return aBytes.every((byte, index) => byte === bBytes[index]);
}

export function declarePiledriverGarbageCollector(options: {
  lowLevelDb: LowLevelDatabase,
  heapDump: LowLevelKvDump,
  processStartedAtMillis: number,
  missingMetadataBehavior?: "legacy-immortal" | "initialize-on-positive-reference",
}) {
  const missingMetadataBehavior = options.missingMetadataBehavior ?? "legacy-immortal";
  const metadataStore = options.lowLevelDb.declareKvStore("piledriver-gc-reference-metadata-v3");
  const candidateStore = options.lowLevelDb.declareKvStore("piledriver-gc-zero-reference-candidates-v3");
  const stateStore = options.lowLevelDb.declareKvStore("piledriver-gc-state-v3");
  let generation: string | null = null;
  let initializationPromise: Promise<void> | null = null;
  let garbageCollectionRunning = false;

  const readyGeneration = () => {
    if (generation === null) throw new Error("Piledriver GC used before initialization");
    return generation;
  };

  const newMetadata = (metadataGeneration: string, createdAtMillis: number): ReferenceMetadata => ({
    schemaVersion: GC_SCHEMA_VERSION,
    generation: metadataGeneration,
    referenceCount: 0,
    createdAtMillis,
    lastDereferencedAtMillis: null,
    deletion: null,
  });

  const initialize = async () => {
    if (initializationPromise !== null) return await initializationPromise;
    initializationPromise = (async () => {
      const existingState = await stateStore.get(gcStateKey);
      if (existingState.buffer !== null) {
        // A visible state is not necessarily durable under the low-level contract. Do not let
        // new metadata depend on its generation until that generation survives a crash.
        await options.lowLevelDb.waitUntilDurable(existingState.seq);
        generation = parseGarbageCollectionState(existingState.buffer).generation;
        return;
      }

      // The default mode treats objects without metadata as predating reference-counting GC. The
      // opt-in mode initializes metadata on the first positive reference to a reserved heap key.
      // First-time initialization may race across processes. A deterministic initial generation
      // ensures every contender tags metadata identically even though the state write is
      // last-write-wins; existing databases continue to use their persisted random generation.
      const newGeneration = INITIAL_GC_GENERATION;
      const state: GarbageCollectionState = {
        schemaVersion: GC_SCHEMA_VERSION,
        generation: newGeneration,
        status: "ready",
        repairCursorBase64: null,
      };
      const stateWrite = await stateStore.setAll([{ key: gcStateKey, value: encodeJson(state) }]);
      await options.lowLevelDb.waitUntilAvailable(stateWrite.seq);
      // The state must be durable before metadata can reference its generation. Otherwise a crash
      // could preserve metadata while losing the only state that makes that metadata collectable.
      await options.lowLevelDb.waitUntilDurable(stateWrite.seq);
      const persistedState = await stateStore.get(gcStateKey);
      if (persistedState.buffer === null) throw new Error("Piledriver GC state disappeared immediately after initialization");
      generation = parseGarbageCollectionState(persistedState.buffer).generation;
    })();
    try {
      await initializationPromise;
    } catch (error) {
      initializationPromise = null;
      throw error;
    }
  };

  const replaceMetadata = async (key: ArrayBuffer, existingBuffer: ArrayBuffer, replacement: ReferenceMetadata, requiresSeq: DatabaseSeq) => {
    const result = await metadataStore.compareAndSetAll(
      [{ key, compare: existingBuffer, value: encodeJson(replacement) }],
      { requiresSeq },
    );
    const entry = result.results[0];
    return entry.wasSet ? entry.seq : null;
  };

  const combineSeqsDeduped = (seqs: Iterable<DatabaseSeq>): DatabaseSeq => {
    const unique = [...new Set(seqs)].filter(seq => seq !== options.lowLevelDb.initialSeq);
    if (unique.length === 0) return options.lowLevelDb.initialSeq;
    if (unique.length === 1) return unique[0];
    return options.lowLevelDb.combineSeqs(...unique);
  };

  // get carries no requiresSeq, so wait before deciding whether metadata must be initialized.
  const readReferenceMetadata = async (key: ArrayBuffer, requiresSeq: DatabaseSeq) => {
    await options.lowLevelDb.waitUntilAvailable(requiresSeq);
    return await metadataStore.get(key);
  };

  const changeReferenceCount = async (
    key: ArrayBuffer,
    delta: number,
    dereferencedAtMillis: number | null,
    requiresSeq: DatabaseSeq,
  ): Promise<{
    seq: DatabaseSeq,
    becameZero: boolean,
    eligibleAtMillis: number,
    legacyImmortal: boolean,
    compareAndSetAttempts: number,
    compareAndSetConflicts: number,
  }> => {
    if (!Number.isSafeInteger(delta) || delta === 0) throw new Error("Piledriver GC reference-count delta must be a non-zero safe integer");
    let compareAndSetAttempts = 0;
    let compareAndSetConflicts = 0;
    while (true) {
      const existing = await readReferenceMetadata(key, requiresSeq);
      if (existing.buffer === null) {
        if (missingMetadataBehavior === "legacy-immortal") {
          return {
            seq: requiresSeq,
            becameZero: false,
            eligibleAtMillis: dereferencedAtMillis ?? 0,
            legacyImmortal: true,
            compareAndSetAttempts,
            compareAndSetConflicts,
          };
        }
        throw new Error(`Piledriver GC cannot decrement heap object ${encodeBase64(new Uint8Array(key))} without reference metadata`);
      }
      const metadata = parseReferenceMetadata(existing.buffer);
      if (metadata.generation !== readyGeneration()) {
        if (missingMetadataBehavior === "legacy-immortal") {
          return {
            seq: requiresSeq,
            becameZero: false,
            eligibleAtMillis: dereferencedAtMillis ?? metadata.createdAtMillis,
            legacyImmortal: true,
            compareAndSetAttempts,
            compareAndSetConflicts,
          };
        }
        throw new Error(`Piledriver GC reference metadata belongs to an inactive generation for heap object ${encodeBase64(new Uint8Array(key))}`);
      }
      // The restart cutoff predates this process, so a claimed object was last dereferenced
      // before any live handle in this process could observe it. Reaching this means that
      // invariant was violated rather than that GC merely raced a normal write.
      if (metadata.deletion !== null) throw new Error("Piledriver GC attempted to reference an object that is being deleted");
      const nextReferenceCount = metadata.referenceCount + delta;
      if (!Number.isSafeInteger(nextReferenceCount) || nextReferenceCount < 0) {
        throw new Error(`Piledriver GC reference count would become invalid for heap object ${encodeBase64(new Uint8Array(key))}`);
      }
      const nextLastDereferencedAtMillis = dereferencedAtMillis === null
        ? metadata.lastDereferencedAtMillis
        : Math.max(metadata.lastDereferencedAtMillis ?? 0, dereferencedAtMillis);
      const replacement: ReferenceMetadata = {
        ...metadata,
        referenceCount: nextReferenceCount,
        lastDereferencedAtMillis: nextLastDereferencedAtMillis,
      };
      compareAndSetAttempts++;
      const metadataSeq = await replaceMetadata(key, existing.buffer, replacement, requiresSeq);
      if (metadataSeq === null) {
        compareAndSetConflicts++;
        continue;
      }

      const becameZero = metadata.referenceCount !== 0 && nextReferenceCount === 0;
      const stoppedBeingZero = metadata.referenceCount === 0 && nextReferenceCount !== 0;
      const eligibleAtMillis = nextLastDereferencedAtMillis ?? metadata.createdAtMillis;
      if (becameZero) {
        const candidate = await candidateStore.setAll([{ key: candidateKey(key, eligibleAtMillis), value: new ArrayBuffer(0) }], { requiresSeq: metadataSeq });
        return {
          seq: candidate.seq,
          becameZero: true,
          eligibleAtMillis,
          legacyImmortal: false,
          compareAndSetAttempts,
          compareAndSetConflicts,
        };
      }
      if (stoppedBeingZero) {
        const previousEligibleAtMillis = metadata.lastDereferencedAtMillis ?? metadata.createdAtMillis;
        const candidate = await candidateStore.deleteAll([candidateKey(key, previousEligibleAtMillis)], { requiresSeq: metadataSeq });
        return {
          seq: candidate.seq,
          becameZero: false,
          eligibleAtMillis,
          legacyImmortal: false,
          compareAndSetAttempts,
          compareAndSetConflicts,
        };
      }
      return {
        seq: metadataSeq,
        becameZero: false,
        eligibleAtMillis,
        legacyImmortal: false,
        compareAndSetAttempts,
        compareAndSetConflicts,
      };
    }
  };

  const changeSerializedReferenceDeltas = async (
    deltas: Iterable<{ key: ArrayBuffer, count: number }>,
    dereferencedAtMillis: number | null,
    requiresSeq: DatabaseSeq,
  ) => {
    const pending = [...deltas];
    const createdAtMillis = Math.max(Date.now(), options.processStartedAtMillis);
    const changes: Array<{
      key: ArrayBuffer,
      becameZero: boolean,
      stoppedBeingZero: boolean,
      previousEligibleAtMillis: number,
      eligibleAtMillis: number,
    }> = [];
    const metadataSequences: DatabaseSeq[] = [requiresSeq];
    while (pending.length > 0) {
      const reads = await Promise.all(
        pending.map(async delta => ({
          ...delta,
          existing: await readReferenceMetadata(delta.key, requiresSeq),
        })),
      );
      const retry: typeof pending = [];
      const newMetadataEntries: Array<{ key: ArrayBuffer, value: ArrayBuffer, delta: number }> = [];
      const compareAndSetEntries: Array<{
        key: ArrayBuffer,
        compare: ArrayBuffer,
        value: ArrayBuffer,
        delta: number,
        previousEligibleAtMillis: number,
        eligibleAtMillis: number,
        becameZero: boolean,
        stoppedBeingZero: boolean,
      }> = [];
      for (const { key, count, existing } of reads) {
        if (existing.buffer === null) {
          if (missingMetadataBehavior === "legacy-immortal") {
            changes.push({ key, becameZero: false, stoppedBeingZero: false, previousEligibleAtMillis: dereferencedAtMillis ?? 0, eligibleAtMillis: dereferencedAtMillis ?? 0 });
            continue;
          }
          if (count < 0) {
            throw new Error(`Piledriver GC cannot decrement heap object ${encodeBase64(new Uint8Array(key))} without reference metadata`);
          }
          // A missing entry can only be a newly inserted object whose reserved key is not yet
          // reachable. Compare against absence below: concurrent first edges must not overwrite
          // each other's counts, so every loser retries through the normal increment path.
          newMetadataEntries.push({
            key,
            value: encodeJson({
              ...newMetadata(readyGeneration(), createdAtMillis),
              referenceCount: count,
            }),
            delta: count,
          });
          continue;
        }
        const metadata = parseReferenceMetadata(existing.buffer);
        if (metadata.generation !== readyGeneration()) {
          if (missingMetadataBehavior === "legacy-immortal") {
            changes.push({ key, becameZero: false, stoppedBeingZero: false, previousEligibleAtMillis: metadata.createdAtMillis, eligibleAtMillis: dereferencedAtMillis ?? metadata.createdAtMillis });
            continue;
          }
          throw new Error(`Piledriver GC reference metadata belongs to an inactive generation for heap object ${encodeBase64(new Uint8Array(key))}`);
        }
        if (metadata.deletion !== null) throw new Error("Piledriver GC attempted to reference an object that is being deleted");
        const nextReferenceCount = metadata.referenceCount + count;
        if (!Number.isSafeInteger(nextReferenceCount) || nextReferenceCount < 0) {
          throw new Error(`Piledriver GC reference count would become invalid for heap object ${encodeBase64(new Uint8Array(key))}`);
        }
        const nextLastDereferencedAtMillis = dereferencedAtMillis === null
          ? metadata.lastDereferencedAtMillis
          : Math.max(metadata.lastDereferencedAtMillis ?? 0, dereferencedAtMillis);
        const previousEligibleAtMillis = metadata.lastDereferencedAtMillis ?? metadata.createdAtMillis;
        const replacement: ReferenceMetadata = {
          ...metadata,
          referenceCount: nextReferenceCount,
          lastDereferencedAtMillis: nextLastDereferencedAtMillis,
        };
        compareAndSetEntries.push({
          key,
          compare: existing.buffer,
          value: encodeJson(replacement),
          delta: count,
          previousEligibleAtMillis,
          eligibleAtMillis: nextLastDereferencedAtMillis ?? metadata.createdAtMillis,
          becameZero: metadata.referenceCount !== 0 && nextReferenceCount === 0,
          stoppedBeingZero: metadata.referenceCount === 0 && nextReferenceCount !== 0,
        });
      }
      const newMetadataWrite = newMetadataEntries.length === 0
        ? null
        : metadataStore.compareAndSetAll(
          newMetadataEntries.map(({ key, value }) => ({ key, compare: null, value })),
          { requiresSeq },
        );
      const compareAndSetWrite = compareAndSetEntries.length === 0
        ? null
        : metadataStore.compareAndSetAll(
          compareAndSetEntries.map(({ key, compare, value }) => ({ key, compare, value })),
          { requiresSeq },
        );
      const [newMetadataResult, compareAndSetResult] = await Promise.all([newMetadataWrite, compareAndSetWrite]);
      if (newMetadataResult !== null) {
        metadataSequences.push(newMetadataResult.seq);
        for (const [index, entry] of newMetadataEntries.entries()) {
          if (newMetadataResult.results[index].wasSet === false) retry.push({ key: entry.key, count: entry.delta });
        }
      }
      pending.length = 0;
      if (compareAndSetResult === null) {
        pending.push(...retry);
        continue;
      }
      for (const [index, entry] of compareAndSetEntries.entries()) {
        const changed = compareAndSetResult.results[index];
        if (changed.wasSet === false) {
          retry.push({ key: entry.key, count: entry.delta });
          continue;
        }
        metadataSequences.push(changed.seq);
        changes.push({
          key: entry.key,
          becameZero: entry.becameZero,
          stoppedBeingZero: entry.stoppedBeingZero,
          previousEligibleAtMillis: entry.previousEligibleAtMillis,
          eligibleAtMillis: entry.eligibleAtMillis,
        });
      }
      pending.push(...retry);
    }
    const becameZero = changes.filter(change => change.becameZero);
    const stoppedBeingZero = changes.filter(change => change.stoppedBeingZero);
    const [candidateWrites, candidateDeletes] = await Promise.all([
      becameZero.length === 0
        ? Promise.resolve({ seq: requiresSeq })
        : candidateStore.setAll(
          becameZero.map(({ key, eligibleAtMillis }) => ({
            key: candidateKey(key, eligibleAtMillis),
            value: new ArrayBuffer(0),
          })),
          { requiresSeq: combineSeqsDeduped(metadataSequences) },
        ),
      stoppedBeingZero.length === 0
        ? Promise.resolve({ seq: requiresSeq })
        : candidateStore.deleteAll(
          // The delete key must use the timestamp that was used when the candidate was written.
          stoppedBeingZero.map(({ key, previousEligibleAtMillis }) => candidateKey(key, previousEligibleAtMillis)),
          { requiresSeq: combineSeqsDeduped(metadataSequences) },
        ),
    ]);
    return {
      seq: combineSeqsDeduped([
        requiresSeq,
        ...metadataSequences,
        candidateWrites.seq,
        candidateDeletes.seq,
      ]),
      becameZero: becameZero.map(({ key, eligibleAtMillis }) => ({ key, eligibleAtMillis })),
    };
  };

  const recordHeapObjectCreations = async (entries: Array<{ key: ArrayBuffer, requiresSeq: DatabaseSeq }>) => {
    await initialize();
    if (entries.length === 0) return { seq: options.lowLevelDb.initialSeq };
    // Clamp backward clock jumps to the process start. Every valid collection cutoff predates
    // that barrier, so a newly created object can never accidentally become eligible.
    const createdAtMillis = Math.max(Date.now(), options.processStartedAtMillis);
    const metadata = newMetadata(readyGeneration(), createdAtMillis);
    // Explicit registration before positive edges leaves a collectable zero-reference candidate
    // when publication is interrupted, instead of an untracked leak.
    const metadataWrite = await metadataStore.setAll(
      entries.map(({ key }) => ({ key, value: encodeJson(metadata) })),
      { requiresSeq: combineSeqsDeduped(entries.map(entry => entry.requiresSeq)) },
    );
    const candidateWrite = await candidateStore.setAll(
      entries.map(({ key }) => ({ key: candidateKey(key, createdAtMillis), value: new ArrayBuffer(0) })),
      { requiresSeq: metadataWrite.seq },
    );
    return { seq: candidateWrite.seq };
  };

  const beforeSerializedHeapObjectsBecomeVisible = async (buffers: ArrayBuffer[], requiresSeq: DatabaseSeq) => {
    await initialize();
    return await changeSerializedReferenceDeltas(
      aggregateKeys(buffers.flatMap(buffer => serializedHeapReferenceKeys(buffer))).values(),
      null,
      requiresSeq,
    );
  };

  const beforeSerializedObjectBecomesVisible = async (
    buffer: ArrayBuffer,
    requiresSeq: DatabaseSeq,
  ) => {
    await initialize();
    // Increments must be available before the buffer referencing them is visible, so a crash can never
    // expose a root whose children are still eligible for collection.
    return await changeSerializedReferenceDeltas(aggregateSerializedReferences(buffer).values(), null, requiresSeq);
  };

  const afterSerializedObjectBecameInvisible = async (
    buffer: ArrayBuffer,
    dereferencedAtMillis: number,
    requiresSeq: DatabaseSeq,
  ) => {
    await initialize();
    parseNonNegativeInteger(dereferencedAtMillis, "dereferencedAtMillis");
    // The mirror image of the increment ordering: decrements are applied only once the replacement is
    // visible. A crash in between leaks an over-counted object, but can never free one that the visible
    // root still reaches.
    return await changeSerializedReferenceDeltas(
      [...aggregateSerializedReferences(buffer).values()].map(({ key, count }) => ({ key, count: -count })),
      dereferencedAtMillis,
      requiresSeq,
    );
  };

  const claimDeletion = async (key: ArrayBuffer, existingBuffer: ArrayBuffer, metadata: ReferenceMetadata, totalReferences: number) => {
    const replacement: ReferenceMetadata = {
      ...metadata,
      deletion: { nextReferenceIndex: 0, totalReferences },
    };
    return await replaceMetadata(key, existingBuffer, replacement, options.lowLevelDb.initialSeq);
  };

  const advanceDeletion = async (key: ArrayBuffer, expectedIndex: number, requiresSeq: DatabaseSeq) => {
    let compareAndSetConflicts = 0;
    await options.lowLevelDb.waitUntilAvailable(requiresSeq);
    while (true) {
      const existing = await metadataStore.get(key);
      if (existing.buffer === null) throw new Error("Piledriver GC deletion metadata disappeared");
      const metadata = parseReferenceMetadata(existing.buffer);
      if (metadata.deletion === null) throw new Error("Piledriver GC object lost its deletion state");
      if (metadata.deletion.nextReferenceIndex !== expectedIndex) {
        throw new Error("Piledriver GC deletion progress changed concurrently");
      }
      const replacement: ReferenceMetadata = {
        ...metadata,
        deletion: {
          ...metadata.deletion,
          nextReferenceIndex: expectedIndex + 1,
        },
      };
      const seq = await replaceMetadata(key, existing.buffer, replacement, options.lowLevelDb.initialSeq);
      if (seq !== null) return { seq, metadata: replacement, compareAndSetConflicts };
      compareAndSetConflicts++;
    }
  };

  const collectGarbage = async (cutoffTimestampMillis: number, maxObjects = 1000): Promise<PiledriverGarbageCollectionResult> => {
    const startedAtMillis = Date.now();
    const startedAt = performance.now();
    const initializationStartedAt = performance.now();
    await initialize();
    const initializationMillis = performance.now() - initializationStartedAt;
    parseNonNegativeInteger(cutoffTimestampMillis, "cutoffTimestampMillis");
    if (!Number.isSafeInteger(maxObjects) || maxObjects <= 0) throw new Error("Piledriver GC maxObjects must be a positive safe integer");
    if (cutoffTimestampMillis >= options.processStartedAtMillis) {
      throw new Error("Piledriver GC cutoff must be older than this process; restart the Bulldozer service after recording the cutoff");
    }
    if (garbageCollectionRunning) throw new Error("Piledriver garbage collection is already running");
    garbageCollectionRunning = true;
    try {
      type Candidate = { candidateKey: ArrayBuffer, heapKey: ArrayBuffer, cascadeDepth: number };
      const queue: Candidate[] = [];
      const queuedKeys = new Set<string>();
      const enqueue = (candidate: Candidate) => {
        const keyBase64 = encodeBase64(new Uint8Array(candidate.heapKey));
        if (queuedKeys.has(keyBase64)) return false;
        queuedKeys.add(keyBase64);
        queue.push(candidate);
        return true;
      };
      let queueIndex = 0;
      let candidateCursor: ArrayBuffer | undefined;
      let initialCandidateScanComplete = false;
      let candidateIndexReachedCutoff = false;
      let metadataRepairPassComplete = false;
      let deletedObjects = 0;
      let examinedCandidates = 0;
      let examinedMetadataEntries = 0;
      let skippedCandidates = 0;
      let candidatesQueuedFromIndex = 0;
      let candidatesQueuedFromMetadataRepair = 0;
      let candidateIndexPagesRead = 0;
      let candidateIndexEntriesRead = 0;
      let candidateIndexReadMillis = 0;
      let metadataRepairPagesRead = 0;
      let metadataRepairMillis = 0;
      let resumedDeletions = 0;
      let childObjectsBecameUnreferenced = 0;
      let maxCascadeDepth = 0;
      let duplicateQueueAttemptsIgnored = 0;
      let outgoingEdgesProcessed = 0;
      let legacyImmortalEdgesIgnored = 0;
      let referenceCountCompareAndSetAttempts = 0;
      let referenceCountCompareAndSetConflicts = 0;
      let missingCandidateEntriesRepaired = 0;
      let staleCandidatesWithoutMetadataRemoved = 0;
      let staleCandidatesFromInactiveGenerationsRemoved = 0;
      let staleCandidatesWithLiveReferencesRemoved = 0;
      let staleCandidateKeysCorrected = 0;
      let candidatesNoLongerOldEnough = 0;
      let deletionClaimConflicts = 0;
      let deletionProgressCompareAndSetConflicts = 0;
      let heapPayloadBytes = 0;
      let heapPayloadRecordsDeleted = 0;
      let heapKeyBytes = 0;
      let metadataValueBytes = 0;
      let metadataKeyBytes = 0;
      let candidateKeyBytes = 0;
      let smallestHeapPayloadBytes: number | null = null;
      let largestHeapPayloadBytes: number | null = null;
      const deletedObjectKeysBase64: string[] = [];
      const resumedDeletionObjectKeysBase64: string[] = [];
      const repairedMissingCandidateObjectKeysBase64: string[] = [];
      const staleCandidateObjectKeysBase64: string[] = [];
      const legacyImmortalReferencedObjectKeysBase64: string[] = [];
      const addKeySample = (samples: string[], key: ArrayBuffer) => {
        if (samples.length >= GC_DIAGNOSTIC_SAMPLE_LIMIT) return;
        const keyBase64 = encodeBase64(new Uint8Array(key));
        if (!samples.includes(keyBase64)) samples.push(keyBase64);
      };
      let latestMutationSeq = options.lowLevelDb.initialSeq;
      const recordMutation = (seq: DatabaseSeq) => {
        // The final durability barrier must cover every mutation across the independent stores,
        // not merely whichever write happened to be recorded last.
        latestMutationSeq = options.lowLevelDb.combineSeqs(latestMutationSeq, seq);
      };
      while (deletedObjects < maxObjects && examinedCandidates + examinedMetadataEntries < maxObjects) {
        if (queueIndex >= queue.length) {
          if (queuedKeys.size !== 0) throw new Error("Piledriver GC candidate dedupe set was not drained with the queue");
          queue.length = 0;
          queueIndex = 0;
          if (!initialCandidateScanComplete) {
            const candidateIndexReadStartedAt = performance.now();
            const page = await candidateStore.listEntries({ startAfter: candidateCursor, limit: GC_SCAN_PAGE_SIZE });
            candidateIndexReadMillis += performance.now() - candidateIndexReadStartedAt;
            candidateIndexPagesRead++;
            candidateIndexEntriesRead += page.entries.length;
            for (const { key } of page.entries) {
              const parsed = parseCandidateKey(key);
              if (parsed.eligibleAtMillis >= cutoffTimestampMillis) {
                initialCandidateScanComplete = true;
                candidateIndexReachedCutoff = true;
                break;
              }
              if (enqueue({ candidateKey: key, heapKey: parsed.heapKey, cascadeDepth: 0 })) {
                candidatesQueuedFromIndex++;
              } else {
                duplicateQueueAttemptsIgnored++;
              }
            }
            const lastEntry = page.entries.at(-1);
            if (page.hasMore && lastEntry === undefined) throw new Error("Piledriver GC candidate scan reported more entries without returning a cursor");
            candidateCursor = lastEntry?.key;
            if (!page.hasMore) initialCandidateScanComplete = true;
          }
          if (queue.length === 0 && initialCandidateScanComplete && !metadataRepairPassComplete) {
            const metadataRepairStartedAt = performance.now();
            const stateRead = await stateStore.get(gcStateKey);
            if (stateRead.buffer === null) throw new Error("Piledriver GC state disappeared during candidate repair");
            const state = parseGarbageCollectionState(stateRead.buffer);
            if (state.generation !== readyGeneration()) throw new Error("Piledriver GC repair state belongs to an inactive generation");
            const remainingBudget = maxObjects - examinedCandidates - examinedMetadataEntries;
            const repairCursor = state.repairCursorBase64 === null ? undefined : decodeBase64(state.repairCursorBase64).buffer;
            const page = await metadataStore.listEntries({
              startAfter: repairCursor,
              limit: Math.min(GC_SCAN_PAGE_SIZE, remainingBudget),
            });
            metadataRepairPagesRead++;
            for (const { key, value } of page.entries) {
              examinedMetadataEntries++;
              const metadata = parseReferenceMetadata(value);
              if (metadata.generation !== readyGeneration() || metadata.referenceCount !== 0) continue;
              const eligibleAtMillis = metadata.lastDereferencedAtMillis ?? metadata.createdAtMillis;
              const expectedCandidateKey = candidateKey(key, eligibleAtMillis);
              const existingCandidate = await candidateStore.get(expectedCandidateKey);
              if (existingCandidate.buffer === null) {
                recordMutation((await candidateStore.setAll(
                  [{ key: expectedCandidateKey, value: new ArrayBuffer(0) }],
                  { requiresSeq: latestMutationSeq },
                )).seq);
                missingCandidateEntriesRepaired++;
                addKeySample(repairedMissingCandidateObjectKeysBase64, key);
              }
              if (eligibleAtMillis < cutoffTimestampMillis) {
                if (enqueue({ candidateKey: expectedCandidateKey, heapKey: key, cascadeDepth: 0 })) {
                  candidatesQueuedFromMetadataRepair++;
                } else {
                  duplicateQueueAttemptsIgnored++;
                }
              }
            }
            const lastEntry = page.entries.at(-1);
            if (page.hasMore && lastEntry === undefined) throw new Error("Piledriver GC metadata repair reported more entries without returning a cursor");
            state.repairCursorBase64 = page.hasMore && lastEntry !== undefined
              ? encodeBase64(new Uint8Array(lastEntry.key))
              : null;
            metadataRepairPassComplete = !page.hasMore;
            recordMutation((await stateStore.setAll(
              [{ key: gcStateKey, value: encodeJson(state) }],
              { requiresSeq: latestMutationSeq },
            )).seq);
            metadataRepairMillis += performance.now() - metadataRepairStartedAt;
          }
          if (queue.length === 0) break;
        }
        const candidate = queue[queueIndex];
        queueIndex++;
        const key = candidate.heapKey;
        queuedKeys.delete(encodeBase64(new Uint8Array(key)));
        maxCascadeDepth = Math.max(maxCascadeDepth, candidate.cascadeDepth);
        examinedCandidates++;
        let metadataRead = await metadataStore.get(key);
        if (metadataRead.buffer === null) {
          recordMutation((await candidateStore.deleteAll(
            [candidate.candidateKey],
            { requiresSeq: latestMutationSeq },
          )).seq);
          staleCandidatesWithoutMetadataRemoved++;
          addKeySample(staleCandidateObjectKeysBase64, key);
          skippedCandidates++;
          continue;
        }
        let metadata = parseReferenceMetadata(metadataRead.buffer);
        if (metadata.generation !== readyGeneration()) {
          recordMutation((await candidateStore.deleteAll(
            [candidate.candidateKey],
            { requiresSeq: latestMutationSeq },
          )).seq);
          staleCandidatesFromInactiveGenerationsRemoved++;
          addKeySample(staleCandidateObjectKeysBase64, key);
          skippedCandidates++;
          continue;
        }
        if (metadata.referenceCount !== 0) {
          recordMutation((await candidateStore.deleteAll(
            [candidate.candidateKey],
            { requiresSeq: latestMutationSeq },
          )).seq);
          staleCandidatesWithLiveReferencesRemoved++;
          addKeySample(staleCandidateObjectKeysBase64, key);
          skippedCandidates++;
          continue;
        }
        const eligibleAtMillis = metadata.lastDereferencedAtMillis ?? metadata.createdAtMillis;
        const expectedCandidateKey = candidateKey(key, eligibleAtMillis);
        if (!arrayBuffersAreEqual(candidate.candidateKey, expectedCandidateKey)) {
          const removed = await candidateStore.deleteAll([candidate.candidateKey], { requiresSeq: latestMutationSeq });
          recordMutation((await candidateStore.setAll(
            [{ key: expectedCandidateKey, value: new ArrayBuffer(0) }],
            { requiresSeq: removed.seq },
          )).seq);
          staleCandidateKeysCorrected++;
          skippedCandidates++;
          continue;
        }
        if (eligibleAtMillis >= cutoffTimestampMillis) {
          candidatesNoLongerOldEnough++;
          skippedCandidates++;
          continue;
        }

        let heapRead = await options.heapDump.get(key);
        let references: ArrayBuffer[];
        if (metadata.deletion === null) {
          if (heapRead.buffer === null) throw new Error("Piledriver GC found metadata for a missing heap object");
          references = serializedHeapReferenceKeys(heapRead.buffer);
          const claimSeq = await claimDeletion(key, metadataRead.buffer, metadata, references.length);
          if (claimSeq === null) {
            deletionClaimConflicts++;
            if (!enqueue(candidate)) duplicateQueueAttemptsIgnored++;
            continue;
          }
          recordMutation(claimSeq);
          metadataRead = await readReferenceMetadata(key, latestMutationSeq);
          if (metadataRead.buffer === null) throw new Error("Piledriver GC deletion claim disappeared");
          metadata = parseReferenceMetadata(metadataRead.buffer);
        } else {
          resumedDeletions++;
          addKeySample(resumedDeletionObjectKeysBase64, key);
          if (heapRead.buffer === null && metadata.deletion.nextReferenceIndex !== metadata.deletion.totalReferences) {
            throw new Error("Piledriver GC heap object disappeared before its outgoing references were processed");
          }
          references = heapRead.buffer === null ? [] : serializedHeapReferenceKeys(heapRead.buffer);
        }
        if (metadata.deletion === null) throw new Error("Piledriver GC deletion was not claimed");
        const deletion = metadata.deletion;
        if (heapRead.buffer !== null && references.length !== deletion.totalReferences) {
          throw new Error("Piledriver GC heap object changed while it was being deleted");
        }

        for (let referenceIndex = deletion.nextReferenceIndex; referenceIndex < deletion.totalReferences; referenceIndex++) {
          // Persist progress first. A crash between this write and the decrement can leak one
          // reference, but can never undercount and delete live data when the job is resumed.
          const progress = await advanceDeletion(key, referenceIndex, latestMutationSeq);
          recordMutation(progress.seq);
          deletionProgressCompareAndSetConflicts += progress.compareAndSetConflicts;
          metadata = progress.metadata;
          const child = references[referenceIndex];
          const changed = await changeReferenceCount(child, -1, eligibleAtMillis, progress.seq);
          recordMutation(changed.seq);
          outgoingEdgesProcessed++;
          referenceCountCompareAndSetAttempts += changed.compareAndSetAttempts;
          referenceCountCompareAndSetConflicts += changed.compareAndSetConflicts;
          if (changed.legacyImmortal) {
            legacyImmortalEdgesIgnored++;
            addKeySample(legacyImmortalReferencedObjectKeysBase64, child);
          }
          if (changed.becameZero && changed.eligibleAtMillis < cutoffTimestampMillis) {
            childObjectsBecameUnreferenced++;
            if (!enqueue({
              candidateKey: candidateKey(child, changed.eligibleAtMillis),
              heapKey: child,
              cascadeDepth: candidate.cascadeDepth + 1,
            })) duplicateQueueAttemptsIgnored++;
          }
        }

        const deletedHeapPayloadBytes = heapRead.buffer?.byteLength ?? 0;
        heapPayloadBytes += deletedHeapPayloadBytes;
        heapKeyBytes += key.byteLength;
        metadataValueBytes += encodeJson(metadata).byteLength;
        metadataKeyBytes += key.byteLength;
        candidateKeyBytes += candidate.candidateKey.byteLength;
        addKeySample(deletedObjectKeysBase64, key);
        if (heapRead.buffer !== null) {
          heapPayloadRecordsDeleted++;
          smallestHeapPayloadBytes = smallestHeapPayloadBytes === null
            ? deletedHeapPayloadBytes
            : Math.min(smallestHeapPayloadBytes, deletedHeapPayloadBytes);
          largestHeapPayloadBytes = largestHeapPayloadBytes === null
            ? deletedHeapPayloadBytes
            : Math.max(largestHeapPayloadBytes, deletedHeapPayloadBytes);
        }
        const heapDeletion = await options.heapDump.deleteAll([key], { requiresSeq: latestMutationSeq });
        const metadataDeletion = await metadataStore.deleteAll([key], { requiresSeq: heapDeletion.seq });
        recordMutation((await candidateStore.deleteAll([candidate.candidateKey], { requiresSeq: metadataDeletion.seq })).seq);
        deletedObjects++;
      }
      const durabilityWaitStartedAt = performance.now();
      await options.lowLevelDb.waitUntilDurable(latestMutationSeq);
      const durabilityWaitMillis = performance.now() - durabilityWaitStartedAt;
      const completedAtMillis = Date.now();
      const elapsedMillis = performance.now() - startedAt;
      const elapsedSeconds = elapsedMillis / 1000;
      const knownLogicalBytes = heapPayloadBytes + heapKeyBytes + metadataValueBytes + metadataKeyBytes + candidateKeyBytes;
      const limitReached = deletedObjects >= maxObjects || examinedCandidates + examinedMetadataEntries >= maxObjects;
      const queuedCandidatesRemaining = Math.max(0, queue.length - queueIndex);
      return {
        cutoff: {
          timestampMillis: cutoffTimestampMillis,
          timestampIso: new Date(cutoffTimestampMillis).toISOString(),
          processStartedAtMillis: options.processStartedAtMillis,
          processStartedAtIso: new Date(options.processStartedAtMillis).toISOString(),
          ageAtCollectionStartMillis: Math.max(0, startedAtMillis - cutoffTimestampMillis),
          restartBarrierMarginMillis: options.processStartedAtMillis - cutoffTimestampMillis,
          collectionStartedMillisAfterProcessStart: Math.max(0, startedAtMillis - options.processStartedAtMillis),
        },
        limits: {
          maxObjects,
          limitReached,
          moreEligibleWorkMayRemain: limitReached
            || queuedCandidatesRemaining > 0
            || !initialCandidateScanComplete
            || !metadataRepairPassComplete,
          queuedCandidatesRemaining,
        },
        objects: {
          deleted: deletedObjects,
          candidatesExamined: examinedCandidates,
          candidatesQueuedFromIndex,
          candidatesQueuedFromMetadataRepair,
          candidatesSkipped: skippedCandidates,
          metadataEntriesExaminedForRepair: examinedMetadataEntries,
          resumedDeletions,
          childObjectsBecameUnreferenced,
          maxCascadeDepth,
          duplicateQueueAttemptsIgnored,
        },
        references: {
          outgoingEdgesProcessed,
          legacyImmortalEdgesIgnored,
          referenceCountCompareAndSetAttempts,
          referenceCountCompareAndSetConflicts,
        },
        recovery: {
          missingCandidateEntriesRepaired,
          staleCandidatesWithoutMetadataRemoved,
          staleCandidatesFromInactiveGenerationsRemoved,
          staleCandidatesWithLiveReferencesRemoved,
          staleCandidateKeysCorrected,
          candidatesNoLongerOldEnough,
          deletionClaimConflicts,
          deletionProgressCompareAndSetConflicts,
        },
        reclaimed: {
          heapPayloadBytes,
          heapPayloadMiB: heapPayloadBytes / 1024 / 1024,
          heapKeyBytes,
          metadataValueBytes,
          metadataKeyBytes,
          candidateKeyBytes,
          knownLogicalBytes,
          knownLogicalMiB: knownLogicalBytes / 1024 / 1024,
          smallestHeapPayloadBytes,
          largestHeapPayloadBytes,
          averageHeapPayloadBytes: heapPayloadRecordsDeleted === 0 ? null : heapPayloadBytes / heapPayloadRecordsDeleted,
          physicalFileBytesReduced: null,
          physicalStorageNote: "LMDB deletions make pages reusable but do not normally shrink the database file; offline compaction is required to reduce its physical size.",
        },
        scanning: {
          candidateIndexPagesRead,
          candidateIndexEntriesRead,
          candidateIndexReachedCutoff,
          candidateIndexScanComplete: initialCandidateScanComplete,
          metadataRepairPagesRead,
          metadataRepairPassComplete,
        },
        samples: {
          limitPerCategory: GC_DIAGNOSTIC_SAMPLE_LIMIT,
          deletedObjectKeysBase64,
          resumedDeletionObjectKeysBase64,
          repairedMissingCandidateObjectKeysBase64,
          staleCandidateObjectKeysBase64,
          legacyImmortalReferencedObjectKeysBase64,
        },
        timing: {
          startedAtMillis,
          completedAtMillis,
          elapsedMillis,
          initializationMillis,
          candidateIndexReadMillis,
          metadataRepairMillis,
          durabilityWaitMillis,
          activeCollectionMillis: Math.max(0, elapsedMillis - initializationMillis - durabilityWaitMillis),
          deletedObjectsPerSecond: elapsedSeconds === 0 ? 0 : deletedObjects / elapsedSeconds,
          reclaimedHeapMiBPerSecond: elapsedSeconds === 0 ? 0 : (heapPayloadBytes / 1024 / 1024) / elapsedSeconds,
        },
        gcGeneration: readyGeneration(),
      };
    } finally {
      garbageCollectionRunning = false;
    }
  };

  return {
    initialize,
    recordHeapObjectCreations,
    beforeSerializedHeapObjectsBecomeVisible,
    beforeSerializedObjectBecomesVisible,
    afterSerializedObjectBecameInvisible,
    collectGarbage,
  };
}

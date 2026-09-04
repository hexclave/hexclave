import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { createUuidV7Generator } from "@hexclave/shared/dist/utils/uuids";
import * as lmdb from "lmdb";
import { readdirSync, statSync } from "node:fs";
import { shouldSuppressPeriodicBulldozerLogs } from "../../../logging.js";
import { traceSpanHot } from "../../../otel.js";
import { createDatabaseSeq, DatabaseSeq } from "../../index.js";
import { LowLevelDatabase, LowLevelDatabaseDebugEntry, LowLevelKvDump, LowLevelKvStore } from "../index.js";
import { unwrapLmdbCommitError } from "../unwrap-commit-error.js";

type BinaryDatabase = lmdb.Database<Buffer, Uint8Array>;
type VersionedBinaryDatabase = BinaryDatabase & {
  getEntry(key: Buffer): { value: Buffer, version?: number } | undefined,
};

function createDumpKeyGenerator() {
  const generateUuidV7 = createUuidV7Generator();
  return () => {
    const key = new Uint8Array(17);
    // Timestamp-first UUIDv7 keys cluster dump writes in an advancing range,
    // reducing LMDB page scatter. The leading byte is a layout-version marker
    // so future dump-key formats can coexist without migrating legacy 48-byte keys.
    key[0] = 0x01;
    key.set(generateUuidV7(), 1);
    return key.buffer;
  };
}

type PendingCommitOperation = {
  seqId: string,
  requiresSeq: DatabaseSeq,
  action: (version: number) => Promise<void>,
  resolve: () => void,
  reject: (error: unknown) => void,
};

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

function bufferFromArrayBuffer(value: ArrayBuffer) {
  return Buffer.from(value);
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

function validateKey(key: ArrayBuffer) {
  if (key.byteLength > 64) throw new Error("KV store key must be <= 64 bytes");
}

function validateValue(name: string, value: ArrayBuffer) {
  if (value.byteLength > 2_000_000_000) throw new Error(`KV store ${name} must be <= 2GB`);
}

function createVoidDeferred() {
  let resolveOperation: () => void = () => {
    throw new Error("Deferred promise resolved before initialization");
  };
  let rejectOperation: (error: unknown) => void = (_error) => {
    throw new Error("Deferred promise rejected before initialization");
  };
  const promise = new Promise<void>((resolve, reject) => {
    resolveOperation = () => resolve();
    rejectOperation = error => reject(error);
  });
  return { promise, resolve: resolveOperation, reject: rejectOperation };
}

type LmdbActivityStats = {
  puts: number,
  putBytes: number,
  putAwaitTotalMs: number,
  transactions: number,
  transactionTotalMs: number,
  transactionQueueWaitTotalMs: number,
  transactionActionTotalMs: number,
  metaPutTotalMs: number,
  transactionCommitTailTotalMs: number,
  requiredSeqWaits: number,
  requiredSeqWaitTotalMs: number,
  waitUntilAvailableResolves: number,
  waitUntilDurableResolves: number,
  waitUntilAvailableResolveTotalMs: number,
  waitUntilDurableResolveTotalMs: number,
  combinedSeqAvailabilityResolves: number,
  combinedSeqDurabilityResolves: number,
  combinedSeqAvailabilityResolveTotalMs: number,
  combinedSeqDurabilityResolveTotalMs: number,
};

export type LmdbDiagnostics = {
  dbId: string,
  storeSizeBytes?: number,
  elapsedMs: number,
  putsPerSecond: number,
  averagePutBytes: number,
  averagePutAwaitMs: number,
  transactionsPerSecond: number,
  averageTransactionMs: number,
  averageTransactionQueueWaitMs: number,
  averageTransactionActionMs: number,
  averageMetaPutMs: number,
  averageTransactionCommitTailMs: number,
  requiredSeqWaitsPerSecond: number,
  averageRequiredSeqWaitMs: number,
  waitUntilAvailableResolvesPerSecond: number,
  waitUntilDurableResolvesPerSecond: number,
  averageSeqToAvailabilityResolveMs: number,
  averageSeqToDurabilityResolveMs: number,
  combinedSeqAvailabilityResolvesPerSecond: number,
  combinedSeqDurabilityResolvesPerSecond: number,
  averageCombinedSeqAvailabilityResolveMs: number,
  averageCombinedSeqDurabilityResolveMs: number,
  mapSizes: {
    seqToAvailability: number,
    seqToDurability: number,
    combinedSeqToAvailability: number,
    combinedSeqToDurability: number,
    combinedSeqDependencies: number,
    debugEntriesByStoreId: number,
  },
  currentVersion: number,
};

let latestLmdbDiagnostics: LmdbDiagnostics | null = null;
const bulldozerDiagnosticsEnabled = process.env.HEXCLAVE_BULLDOZER_DIAGNOSTICS === "true";

function isExpectedStoreSizeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR";
}

function getStoreSizeBytes(path: string): number | undefined {
  try {
    let total = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const entryPath = `${path}/${entry.name}`;
      if (entry.isDirectory()) {
        const nestedSize = getStoreSizeBytes(entryPath);
        if (nestedSize === undefined) return undefined;
        total += nestedSize;
      } else {
        total += statSync(entryPath).size;
      }
    }
    return total;
  } catch (error) {
    if (isExpectedStoreSizeError(error)) return undefined;
    throw error;
  }
}

export function getLmdbDiagnostics(): LmdbDiagnostics | null {
  return latestLmdbDiagnostics == null ? null : { ...latestLmdbDiagnostics };
}

function emptyActivityStats(): LmdbActivityStats {
  return {
    puts: 0,
    putBytes: 0,
    putAwaitTotalMs: 0,
    transactions: 0,
    transactionTotalMs: 0,
    transactionQueueWaitTotalMs: 0,
    transactionActionTotalMs: 0,
    metaPutTotalMs: 0,
    transactionCommitTailTotalMs: 0,
    requiredSeqWaits: 0,
    requiredSeqWaitTotalMs: 0,
    waitUntilAvailableResolves: 0,
    waitUntilDurableResolves: 0,
    waitUntilAvailableResolveTotalMs: 0,
    waitUntilDurableResolveTotalMs: 0,
    combinedSeqAvailabilityResolves: 0,
    combinedSeqDurabilityResolves: 0,
    combinedSeqAvailabilityResolveTotalMs: 0,
    combinedSeqDurabilityResolveTotalMs: 0,
  };
}

function hasActivity(stats: LmdbActivityStats): boolean {
  return stats.puts > 0
    || stats.transactions > 0
    || stats.waitUntilAvailableResolves > 0
    || stats.waitUntilDurableResolves > 0
    || stats.combinedSeqAvailabilityResolves > 0
    || stats.combinedSeqDurabilityResolves > 0;
}

export function declareLmdbLowLevelDatabase(options: {
  path: string,
  dbId?: string,
  simulateReadMissDelayMs?: number,
  /**
   * When true, enable lmdb-js LZ4 compression on values (threshold 1000 bytes by default).
   * Sticky per on-disk path: once values are written compressed, every subsequent open of
   * that path must keep compression on (or reads of those values will fail).
   * Turning this on against an existing uncompressed store does NOT rewrite old values —
   * new writes compress, old ones stay uncompressed and remain readable.
   * To ship a fully-compressed store in prod: point HEXCLAVE_BULLDOZER_JS_LMDB_PATH at a
   * fresh empty directory, set HEXCLAVE_BULLDOZER_JS_LMDB_COMPRESSION=1, start bulldozer-js,
   * then run db:backfill-bulldozer-from-prisma (after ManualTransaction is in Postgres).
   */
  compression?: boolean,
}): LowLevelDatabase {
  const dbId = options.dbId ?? "default";
  const simulateReadMissDelayMs = options.simulateReadMissDelayMs ?? 0;
  if (!Number.isFinite(simulateReadMissDelayMs) || simulateReadMissDelayMs < 0) throw new Error("simulateReadMissDelayMs must be a non-negative finite number");
  const compression = options.compression === true;
  const root = lmdb.open({ path: options.path, maxDbs: 1024, separateFlushed: true, compression });
  const meta = root.openDB<number, string>({ name: `${dbId}:meta`, encoding: "json" });
  let currentVersion = meta.get("seq") ?? 0;
  const initialSeqId = "initial";
  const debugEntriesByStoreId = new Map<`${"store" | "dump"}-${string}`, () => Promise<LowLevelDatabaseDebugEntry[]>>();
  const seqToAvailability = new Map<string, Promise<void>>();
  const seqToDurability = new Map<string, Promise<void>>();
  const combinedSeqToAvailability = new Map<string, Promise<void>>();
  const combinedSeqToDurability = new Map<string, Promise<void>>();
  const combinedSeqDependencies = new Map<string, string[]>();
  let pendingCommitOperations: PendingCommitOperation[] = [];
  let pendingCommitFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCommitFlushPromise: Promise<void> | null = null;
  let isClosing = false;
  let storeSizeDiagnosticsDisabled = false;
  let closePromise: Promise<void> | null = null;
  const inFlightReads = new Set<Promise<unknown>>();
  let readErrorDuringClose: unknown | undefined;
  const trackRead = <T>(read: Promise<T>) => {
    let trackedRead: Promise<T>;
    trackedRead = read.catch(error => {
      if (isClosing && readErrorDuringClose === undefined) readErrorDuringClose = error;
      throw error;
    }).finally(() => inFlightReads.delete(trackedRead));
    inFlightReads.add(trackedRead);
    return trackedRead;
  };
  const assertReadAllowed = () => {
    if (isClosing) throw new Error("LMDB database is closing");
  };
  // A read that rejects after close begins removes itself from inFlightReads in its own `finally`, which can run
  // before the drain snapshots the set; the retained slot above keeps that error observable so close still surfaces it.
  const drainInFlightReads = async () => {
    const results = await Promise.allSettled(inFlightReads);
    const rejected = results.find(result => result.status === "rejected");
    const readError = readErrorDuringClose;
    readErrorDuringClose = undefined;
    if (rejected?.status === "rejected") throw rejected.reason;
    if (readError !== undefined) throw readError;
  };
  let activityStats = emptyActivityStats();
  let activityWindowStartedAt = performance.now();
  const activityInterval = setInterval(() => {
    if (!hasActivity(activityStats)) return;
    const now = performance.now();
    const elapsedMs = now - activityWindowStartedAt;
    const elapsedSeconds = elapsedMs / 1000;
    let storeSizeBytes: number | undefined;
    if (bulldozerDiagnosticsEnabled && !storeSizeDiagnosticsDisabled) {
      try {
        storeSizeBytes = getStoreSizeBytes(options.path);
      } catch (error) {
        // Disable sizing after the first unexpected failure so a persistent error cannot flood CI logs every 5 seconds.
        storeSizeDiagnosticsDisabled = true;
        captureError("bulldozer-js:lmdb-diagnostics-store-size", error);
      }
    }
    const diagnostics: LmdbDiagnostics = {
      dbId,
      ...(storeSizeBytes === undefined ? {} : { storeSizeBytes }),
      elapsedMs,
      putsPerSecond: activityStats.puts / elapsedSeconds,
      averagePutBytes: activityStats.puts === 0 ? 0 : activityStats.putBytes / activityStats.puts,
      averagePutAwaitMs: activityStats.puts === 0 ? 0 : activityStats.putAwaitTotalMs / activityStats.puts,
      transactionsPerSecond: activityStats.transactions / elapsedSeconds,
      averageTransactionMs: activityStats.transactions === 0 ? 0 : activityStats.transactionTotalMs / activityStats.transactions,
      averageTransactionQueueWaitMs: activityStats.transactions === 0 ? 0 : activityStats.transactionQueueWaitTotalMs / activityStats.transactions,
      averageTransactionActionMs: activityStats.transactions === 0 ? 0 : activityStats.transactionActionTotalMs / activityStats.transactions,
      averageMetaPutMs: activityStats.transactions === 0 ? 0 : activityStats.metaPutTotalMs / activityStats.transactions,
      averageTransactionCommitTailMs: activityStats.transactions === 0 ? 0 : activityStats.transactionCommitTailTotalMs / activityStats.transactions,
      requiredSeqWaitsPerSecond: activityStats.requiredSeqWaits / elapsedSeconds,
      averageRequiredSeqWaitMs: activityStats.requiredSeqWaits === 0 ? 0 : activityStats.requiredSeqWaitTotalMs / activityStats.requiredSeqWaits,
      waitUntilAvailableResolvesPerSecond: activityStats.waitUntilAvailableResolves / elapsedSeconds,
      waitUntilDurableResolvesPerSecond: activityStats.waitUntilDurableResolves / elapsedSeconds,
      averageSeqToAvailabilityResolveMs: activityStats.waitUntilAvailableResolves === 0 ? 0 : activityStats.waitUntilAvailableResolveTotalMs / activityStats.waitUntilAvailableResolves,
      averageSeqToDurabilityResolveMs: activityStats.waitUntilDurableResolves === 0 ? 0 : activityStats.waitUntilDurableResolveTotalMs / activityStats.waitUntilDurableResolves,
      combinedSeqAvailabilityResolvesPerSecond: activityStats.combinedSeqAvailabilityResolves / elapsedSeconds,
      combinedSeqDurabilityResolvesPerSecond: activityStats.combinedSeqDurabilityResolves / elapsedSeconds,
      averageCombinedSeqAvailabilityResolveMs: activityStats.combinedSeqAvailabilityResolves === 0 ? 0 : activityStats.combinedSeqAvailabilityResolveTotalMs / activityStats.combinedSeqAvailabilityResolves,
      averageCombinedSeqDurabilityResolveMs: activityStats.combinedSeqDurabilityResolves === 0 ? 0 : activityStats.combinedSeqDurabilityResolveTotalMs / activityStats.combinedSeqDurabilityResolves,
      mapSizes: {
        seqToAvailability: seqToAvailability.size,
        seqToDurability: seqToDurability.size,
        combinedSeqToAvailability: combinedSeqToAvailability.size,
        combinedSeqToDurability: combinedSeqToDurability.size,
        combinedSeqDependencies: combinedSeqDependencies.size,
        debugEntriesByStoreId: debugEntriesByStoreId.size,
      },
      currentVersion,
    };
    latestLmdbDiagnostics = diagnostics;
    if (!shouldSuppressPeriodicBulldozerLogs) {
      console.debug("bulldozer-js low-level lmdb activity", diagnostics);
    }
    activityStats = emptyActivityStats();
    activityWindowStartedAt = now;
  }, 5_000);
  activityInterval.unref();
  const initialSeq = createDatabaseSeq(dbId, initialSeqId);
  const toSeq = (seqId: string) => createDatabaseSeq(dbId, seqId);

  const nextVersion = () => ++currentVersion;
  const nextSeqId = () => crypto.randomUUID();
  const getSeqId = (seq: DatabaseSeq | undefined) => {
    if (seq === undefined) return initialSeqId;
    if (seq[0] !== dbId || typeof seq[1] !== "string") throw new Error("LMDB sequence does not belong to this database");
    return seq[1];
  };
  const getAvailabilityPromise = (seqId: string) => {
    return seqToAvailability.get(seqId) ?? combinedSeqToAvailability.get(seqId) ?? Promise.resolve();
  };
  const getDurabilityPromise = (seqId: string) => {
    return seqToDurability.get(seqId) ?? combinedSeqToDurability.get(seqId) ?? Promise.resolve();
  };
  const combineSeqsForStore = (...seqs: DatabaseSeq[]) => {
    if (seqs.length === 0) return initialSeq;
    if (seqs.length === 1) return seqs[0];
    const seqId = nextSeqId();
    combinedSeqDependencies.set(seqId, seqs.map(seq => getSeqId(seq)));
    rememberCombinedAvailability(seqId, Promise.all(seqs.map(seq => getAvailabilityPromise(getSeqId(seq)))));
    rememberCombinedDurability(seqId, Promise.all(seqs.map(seq => getDurabilityPromise(getSeqId(seq)))));
    return toSeq(seqId);
  };
  // LMDB may reject with an opaque "Commit failed" wrapper whose real status
  // lives on `.commitError` (a Promise). LMDB's `committed` value is only a
  // PromiseLike, so normalize it before using native Promise methods.
  const awaitLmdbPromise = (promise: PromiseLike<unknown>) => Promise.resolve(promise).catch(async (error) => {
    throw await unwrapLmdbCommitError(error);
  });
  const rememberAvailability = (seqId: string, promise: PromiseLike<unknown>) => {
    const insertedAt = performance.now();
    const availability = traceSpanHot({ description: "bulldozer-js.low-level.lmdb.availability", attributes: { "bulldozer.low_level.backend": "lmdb" } }, async () => {
      await awaitLmdbPromise(promise);
      activityStats.waitUntilAvailableResolveTotalMs += performance.now() - insertedAt;
      activityStats.waitUntilAvailableResolves++;
      seqToAvailability.delete(seqId);
    });
    availability.catch(() => {});
    seqToAvailability.set(seqId, availability);
  };
  const rememberDurability = (seqId: string, promise: PromiseLike<unknown>) => {
    const insertedAt = performance.now();
    const durability = traceSpanHot({ description: "bulldozer-js.low-level.lmdb.durability", attributes: { "bulldozer.low_level.backend": "lmdb" } }, async () => {
      await awaitLmdbPromise(promise);
      await root.flushed;
      activityStats.waitUntilDurableResolveTotalMs += performance.now() - insertedAt;
      activityStats.waitUntilDurableResolves++;
      seqToDurability.delete(seqId);
    });
    durability.catch(() => {});
    seqToDurability.set(seqId, durability);
  };
  const rememberCombinedAvailability = (seqId: string, promise: PromiseLike<unknown>) => {
    const insertedAt = performance.now();
    const availability = traceSpanHot({ description: "bulldozer-js.low-level.lmdb.combinedAvailability", attributes: { "bulldozer.low_level.backend": "lmdb" } }, async () => {
      await awaitLmdbPromise(promise);
      activityStats.combinedSeqAvailabilityResolveTotalMs += performance.now() - insertedAt;
      activityStats.combinedSeqAvailabilityResolves++;
      combinedSeqToAvailability.delete(seqId);
      combinedSeqDependencies.delete(seqId);
    });
    availability.catch(() => {});
    combinedSeqToAvailability.set(seqId, availability);
  };
  const rememberCombinedDurability = (seqId: string, promise: PromiseLike<unknown>) => {
    const insertedAt = performance.now();
    const durability = traceSpanHot({ description: "bulldozer-js.low-level.lmdb.combinedDurability", attributes: { "bulldozer.low_level.backend": "lmdb" } }, async () => {
      await awaitLmdbPromise(promise);
      activityStats.combinedSeqDurabilityResolveTotalMs += performance.now() - insertedAt;
      activityStats.combinedSeqDurabilityResolves++;
      combinedSeqToDurability.delete(seqId);
    });
    durability.catch(() => {});
    combinedSeqToDurability.set(seqId, durability);
  };
  const trackCommit = (seqId: string, promise: PromiseLike<unknown>) => {
    rememberAvailability(seqId, promise);
    rememberDurability(seqId, promise);
    return toSeq(seqId);
  };
  const commitBatch = async (operations: PendingCommitOperation[]) => {
    if (operations.length === 0) return;
    try {
      const version = nextVersion();
      await traceSpanHot({ description: "bulldozer-js.low-level.lmdb.commit", attributes: { "bulldozer.low_level.backend": "lmdb", "bulldozer.low_level.operation_count": operations.length } }, async () => {
        const requiredSeqWaitStartedAt = performance.now();
        const batchSeqIds = new Set(operations.map(operation => operation.seqId));
        await Promise.all(operations.map(async operation => await waitUntilAvailableOutsideBatch(operation.requiresSeq, batchSeqIds)));
        activityStats.requiredSeqWaits++;
        activityStats.requiredSeqWaitTotalMs += performance.now() - requiredSeqWaitStartedAt;
        const transactionStartedAt = performance.now();
        let transactionCallbackFinishedAt: number | null = null;
        await root.transaction(() => {
          activityStats.transactionQueueWaitTotalMs += performance.now() - transactionStartedAt;
          activityStats.transactions++;
          return (async () => {
            const actionStartedAt = performance.now();
            for (const operation of operations) await operation.action(version);
            activityStats.transactionActionTotalMs += performance.now() - actionStartedAt;
            const metaPutStartedAt = performance.now();
            await meta.put("seq", version);
            activityStats.metaPutTotalMs += performance.now() - metaPutStartedAt;
          })().finally(() => {
            transactionCallbackFinishedAt = performance.now();
          });
        }).finally(() => {
          const transactionFinishedAt = performance.now();
          activityStats.transactionTotalMs += transactionFinishedAt - transactionStartedAt;
          if (transactionCallbackFinishedAt !== null) activityStats.transactionCommitTailTotalMs += transactionFinishedAt - transactionCallbackFinishedAt;
        });
      });
      for (const operation of operations) operation.resolve();
    } catch (error) {
      const unwrapped = await unwrapLmdbCommitError(error);
      for (const operation of operations) operation.reject(unwrapped);
      throw unwrapped;
    }
  };
  const flushPendingCommits = async () => {
    if (pendingCommitFlushTimer !== null) {
      clearTimeout(pendingCommitFlushTimer);
      pendingCommitFlushTimer = null;
    }
    const batch = pendingCommitOperations;
    pendingCommitOperations = [];
    await commitBatch(batch);
  };
  const schedulePendingCommitFlush = () => {
    if (pendingCommitFlushTimer !== null) return;
    pendingCommitFlushTimer = setTimeout(() => {
      pendingCommitFlushTimer = null;
      pendingCommitFlushPromise = flushPendingCommits().finally(() => {
        pendingCommitFlushPromise = null;
      });
      pendingCommitFlushPromise.catch(() => {});
    }, 10);
  };
  const commit = (requiresSeq: DatabaseSeq, action: (version: number) => Promise<void>) => {
    if (isClosing) throw new Error("LMDB database is closing and cannot accept writes");
    const seqId = nextSeqId();
    const deferred = createVoidDeferred();
    pendingCommitOperations.push({ seqId, requiresSeq, action, resolve: deferred.resolve, reject: deferred.reject });
    schedulePendingCommitFlush();
    return trackCommit(seqId, deferred.promise);
  };
  const commitConditionally = async (db: BinaryDatabase, key: Buffer, expectedVersion: number | null, action: (version: number) => Promise<void>) => {
    if (isClosing) throw new Error("LMDB database is closing and cannot accept writes");
    const nextVersionRef: { value: number | null } = { value: null };
    const seqId = nextSeqId();
    const write = () => {
      return (async () => {
        nextVersionRef.value = nextVersion();
        await action(nextVersionRef.value);
        await meta.put("seq", nextVersionRef.value);
      })();
    };
    const wasSet = expectedVersion === null
      ? await db.ifNoExists(key, write)
      : await db.ifVersion(key, expectedVersion, write);
    if (!wasSet) return null;
    if (nextVersionRef.value === null) throw new Error("Assertion error: LMDB compare-and-set succeeded without assigning a version");
    rememberAvailability(seqId, root.committed);
    rememberDurability(seqId, Promise.resolve());
    return toSeq(seqId);
  };
  const putWithVersion = async (db: BinaryDatabase, key: Buffer, value: Buffer, version: number) => {
    activityStats.puts++;
    activityStats.putBytes += value.byteLength;
    const startedAt = performance.now();
    try {
      await db.put(key, value, version);
    } finally {
      activityStats.putAwaitTotalMs += performance.now() - startedAt;
    }
  };
  const waitUntilAvailable = async (seq: DatabaseSeq) => {
    await getAvailabilityPromise(getSeqId(seq));
  };
  const waitUntilDurable = async (seq: DatabaseSeq) => {
    await getDurabilityPromise(getSeqId(seq));
  };
  const waitUntilAvailableOutsideBatch = async (seq: DatabaseSeq, batchSeqIds: Set<string>): Promise<void> => {
    const seqId = getSeqId(seq);
    if (seqId === initialSeqId || batchSeqIds.has(seqId)) return;
    const dependencies = combinedSeqDependencies.get(seqId);
    if (dependencies === undefined) {
      await getAvailabilityPromise(seqId);
      return;
    }
    await Promise.all(dependencies.map(async dependencySeqId => {
      if (dependencySeqId === initialSeqId || batchSeqIds.has(dependencySeqId)) return;
      const dependencySeq = toSeq(dependencySeqId);
      await waitUntilAvailableOutsideBatch(dependencySeq, batchSeqIds);
    }));
  };
  const waitUntilAllAvailable = async () => {
    await Promise.all(seqToAvailability.values());
  };

  const declareLmdbLowLevelKvStoreOrDump = (storeOrDump: "store" | "dump", id: string): LowLevelKvStore & LowLevelKvDump => {
    const debugStoreId = `${storeOrDump}-${id}` as const;
    const attributes = { "bulldozer.low_level.backend": "lmdb", "bulldozer.low_level.kind": storeOrDump, "bulldozer.low_level.id": id };
    const db = root.openDB<Buffer, Uint8Array>({
      name: `${dbId}:${storeOrDump}:${id}`,
      encoding: "binary",
      keyEncoding: "binary",
      useVersions: true,
    }) as VersionedBinaryDatabase;
    const dumpKey = createDumpKeyGenerator();
    const reserveKeys = (count: number) => {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("KV dump reservation count must be a non-negative safe integer");
      return Array.from({ length: count }, dumpKey);
    };

    const result: LowLevelKvStore & LowLevelKvDump = {
      reserveKeys,
      async get(key) {
        assertReadAllowed();
        return await trackRead(traceSpanHot({ description: "bulldozer-js.low-level.lmdb.get", attributes }, async () => {
          validateKey(key);
          if (simulateReadMissDelayMs > 0) await wait(simulateReadMissDelayMs);
          const [buffer] = await db.getMany([bufferFromArrayBuffer(key)]);
          return {
            buffer: buffer ? arrayBufferFromUint8Array(buffer) : null,
            seq: initialSeq,
          };
        }));
      },
      async listEntries(options) {
        assertReadAllowed();
        return await trackRead(traceSpanHot({ description: "bulldozer-js.low-level.lmdb.listEntries", attributes }, async () => {
          const limit = options?.limit ?? 1000;
          if (!Number.isInteger(limit) || limit <= 0) throw new Error("KV store list limit must be a positive integer");
          if (options?.startAfter !== undefined) validateKey(options.startAfter);
          const entries = await (db.getRange({
            start: options?.startAfter === undefined ? undefined : bufferFromArrayBuffer(options.startAfter),
            exclusiveStart: options?.startAfter !== undefined,
            limit: limit + 1,
          }) as lmdb.RangeIterable<{ key: Uint8Array, value: Buffer }>).map(({ key, value }) => ({
            key: arrayBufferFromUint8Array(key),
            value: arrayBufferFromUint8Array(value),
          })).asArray;
          return {
            entries: entries.slice(0, limit),
            hasMore: entries.length > limit,
          };
        }));
      },
      async setAll(entries, setOptions) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.lmdb.setAll", attributes: { ...attributes, "bulldozer.low_level.entry_count": entries.length } }, async () => {
          for (const { key, value } of entries) {
            validateKey(key);
            validateValue("value", value);
          }
          if (entries.length === 0) return { seq: setOptions?.requiresSeq ?? initialSeq };
          return {
            seq: commit(setOptions?.requiresSeq ?? initialSeq, async version => {
              for (const { key, value } of entries) {
                await putWithVersion(db, bufferFromArrayBuffer(key), bufferFromArrayBuffer(value), version);
              }
            }),
          };
        });
      },
      async deleteAll(keys, deleteOptions) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.lmdb.deleteAll", attributes: { ...attributes, "bulldozer.low_level.key_count": keys.length } }, async () => {
          for (const key of keys) validateKey(key);
          if (keys.length === 0) return { seq: deleteOptions?.requiresSeq ?? initialSeq };
          return {
            seq: commit(deleteOptions?.requiresSeq ?? initialSeq, async () => {
              for (const key of keys) await db.remove(bufferFromArrayBuffer(key));
            }),
          };
        });
      },
      async insertAll(values, insertOptions) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.lmdb.insertAll", attributes: { ...attributes, "bulldozer.low_level.value_count": values.length } }, async () => {
          for (const value of values) validateValue("value", value);
          const keys = insertOptions?.keys ?? reserveKeys(values.length);
          if (keys.length !== values.length) throw new Error("KV dump insertion must provide exactly one key per value");
          for (const key of keys) validateKey(key);
          if (new Set(keys.map(key => encodeBase64(new Uint8Array(key)))).size !== keys.length) {
            throw new Error("KV dump insertion keys must be unique");
          }
          if (values.length === 0) return { keys: [], seq: insertOptions?.requiresSeq ?? initialSeq };
          return {
            keys,
            seq: commit(insertOptions?.requiresSeq ?? initialSeq, async version => {
              await Promise.all(values.map(async (value, index) => await putWithVersion(db, bufferFromArrayBuffer(keys[index]), bufferFromArrayBuffer(value), version)));
            }),
          };
        });
      },
      async compareAndSetAll(entries, casOptions) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.lmdb.compareAndSetAll", attributes: { ...attributes, "bulldozer.low_level.entry_count": entries.length } }, async () => {
          const keys = new Set<string>();
          for (const { key, compare, value } of entries) {
            validateKey(key);
            if (compare !== null) validateValue("compare", compare);
            validateValue("value", value);
            const keyBase64 = encodeBase64(new Uint8Array(key));
            const previousSize = keys.size;
            keys.add(keyBase64);
            if (keys.size === previousSize) throw new Error("compareAndSetAll entries must not contain duplicate keys");
          }
          const results = await Promise.all(entries.map(async ({ key, compare, value }) => {
            await waitUntilAvailable(casOptions?.requiresSeq ?? initialSeq);
            await waitUntilAllAvailable();
            const keyBuffer = bufferFromArrayBuffer(key);
            const existing = db.getEntry(keyBuffer);
            if (compare === null) {
              if (existing !== undefined) return { wasSet: false as const, seq: null };
              const seq = await commitConditionally(db, keyBuffer, null, async version => await putWithVersion(db, keyBuffer, bufferFromArrayBuffer(value), version));
              return seq === null ? { wasSet: false as const, seq: null } : { wasSet: true as const, seq };
            }
            if (existing === undefined || existing.version === undefined || !arrayBuffersAreEqual(arrayBufferFromUint8Array(existing.value), compare)) {
              return { wasSet: false as const, seq: null };
            }
            const seq = await commitConditionally(db, keyBuffer, existing.version, async version => await putWithVersion(db, keyBuffer, bufferFromArrayBuffer(value), version));
            return seq === null ? { wasSet: false as const, seq: null } : { wasSet: true as const, seq };
          }));
          const successful = results.filter(result => result.wasSet).map(result => result.seq);
          return {
            results,
            seq: successful.length === 0
              ? casOptions?.requiresSeq ?? initialSeq
              : combineSeqsForStore(...successful),
          };
        });
      },
      async debugEntries() {
        assertReadAllowed();
        return await trackRead(traceSpanHot({ description: "bulldozer-js.low-level.lmdb.debugEntries", attributes }, async () => await (db.getRange() as lmdb.RangeIterable<{ key: Uint8Array, value: Buffer }>).map(({ key, value }) => {
          const keyBuffer = Buffer.from(key);
          const valueBuffer = Buffer.from(value);
          return {
            keyBase64: encodeBase64(new Uint8Array(arrayBufferFromUint8Array(keyBuffer))),
            keyUtf8: decodeUtf8(arrayBufferFromUint8Array(keyBuffer)),
            keyHex: encodeHex(keyBuffer),
            valueBase64: encodeBase64(new Uint8Array(arrayBufferFromUint8Array(valueBuffer))),
            valueUtf8: decodeUtf8(arrayBufferFromUint8Array(valueBuffer)),
            valueByteLength: valueBuffer.byteLength,
          };
        }).asArray));
      },
    };
    debugEntriesByStoreId.set(debugStoreId, () => result.debugEntries!());
    return result;
  };

  return {
    getDebugInfo() {
      return {
        backend: "lmdb",
        constructorArguments: options,
        dbId,
        simulateReadMissDelayMs,
        root,
        meta,
        currentVersion,
        debugEntriesByStoreId,
        seqToAvailability,
        seqToDurability,
        combinedSeqToAvailability,
        combinedSeqToDurability,
        combinedSeqDependencies,
        pendingCommitOperations,
        pendingCommitFlushTimer,
        pendingCommitFlushPromise,
        initialSeq,
      };
    },
    declareKvDump(dumpId) {
      return declareLmdbLowLevelKvStoreOrDump("dump", dumpId);
    },
    declareKvStore(storeId) {
      return declareLmdbLowLevelKvStoreOrDump("store", storeId);
    },
    async waitUntilAvailable(seq) {
      await traceSpanHot({ description: "bulldozer-js.low-level.lmdb.waitUntilAvailable", attributes: { "bulldozer.low_level.backend": "lmdb" } }, async () => await waitUntilAvailable(seq));
    },
    async waitUntilDurable(seq) {
      await traceSpanHot({ description: "bulldozer-js.low-level.lmdb.waitUntilDurable", attributes: { "bulldozer.low_level.backend": "lmdb" } }, async () => await waitUntilDurable(seq));
    },
    async waitUntilReplicated(seq) {
      await traceSpanHot({ description: "bulldozer-js.low-level.lmdb.waitUntilReplicated", attributes: { "bulldozer.low_level.backend": "lmdb" } }, async () => await this.waitUntilAvailable(seq));
    },
    async waitUntilConsistent(seq) {
      await traceSpanHot({ description: "bulldozer-js.low-level.lmdb.waitUntilConsistent", attributes: { "bulldozer.low_level.backend": "lmdb" } }, async () => {
        await Promise.all([this.waitUntilReplicated(seq), this.waitUntilDurable(seq)]);
      });
    },
    combineSeqs(...seqs) {
      return combineSeqsForStore(...seqs);
    },
    close() {
      if (closePromise === null) {
        isClosing = true;
        clearInterval(activityInterval);
        closePromise = traceSpanHot({ description: "bulldozer-js.low-level.lmdb.close", attributes: { "bulldozer.low_level.backend": "lmdb" } }, async () => {
          try {
            if (pendingCommitFlushPromise !== null) await pendingCommitFlushPromise;
            await flushPendingCommits();
            if (pendingCommitFlushPromise !== null) await pendingCommitFlushPromise;
            await Promise.all([
              ...seqToDurability.values(),
              ...combinedSeqToDurability.values(),
            ]);
          } finally {
            try {
              // lmdb-js tracks async reads per child handle, but root.close() only drains the root handle's counter.
              // Drain every read issued by this environment before closing the root so a child prefetch worker
              // cannot observe the native environment after lmdb-js has nulled it.
              await drainInFlightReads();
            } finally {
              await root.close();
            }
          }
        });
      }
      return closePromise;
    },
    async debugSnapshot() {
      return await traceSpanHot({ description: "bulldozer-js.low-level.lmdb.debugSnapshot", attributes: { "bulldozer.low_level.backend": "lmdb" } }, async () => {
        const stores: Record<string, LowLevelDatabaseDebugEntry[]> = {};
        const dumps: Record<string, LowLevelDatabaseDebugEntry[]> = {};
        for (const [storeId, entries] of debugEntriesByStoreId.entries()) {
          if (storeId.startsWith("store-")) {
            stores[storeId.slice("store-".length)] = await entries();
          } else {
            dumps[storeId.slice("dump-".length)] = await entries();
          }
        }
        return { stores, dumps };
      });
    },
    initialSeq,
  };
}

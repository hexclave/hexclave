import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { traceSpanHot } from "../../../otel.js";
import { createDatabaseSeq, DatabaseSeq } from "../../index.js";
import { LowLevelDatabase, LowLevelKvDump, LowLevelKvStore } from "../index.js";

function arrayBuffersAreEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const aUint8Array = new Uint8Array(a);
  const bUint8Array = new Uint8Array(b);
  for (let i = 0; i < aUint8Array.length; i++) {
    if (aUint8Array[i] !== bUint8Array[i]) return false;
  }
  return true;
}

type SeqRecord = {
  underlyingSeq: DatabaseSeq,
  underlyingAvailable: Promise<void>,
  isSettled: boolean,
};
type CachedValue = {
  buffer: ArrayBuffer | null,
  seq: DatabaseSeq,
};
export type InstantAvailabilityLowLevelDatabaseDebugSnapshot = {
  createdSeqRecords: number,
  pendingSeqRecords: number,
  underlyingAvailableSeqRecords: number,
  cachedValues: number,
};
export type InstantAvailabilityLowLevelDatabase = LowLevelDatabase & {
  debugInstantAvailability(): InstantAvailabilityLowLevelDatabaseDebugSnapshot,
  waitUntilUnderlyingAvailable(seq: DatabaseSeq): Promise<void>,
};
export type InstantAvailabilityLowLevelDatabaseOptions = {
  dbId?: string,
  maxPendingSeqRecords?: number,
};

const cloneArrayBuffer = (value: ArrayBuffer) => value.slice(0);

export function declareInstantAvailabilityLowLevelDatabase(wrapped: LowLevelDatabase, options: InstantAvailabilityLowLevelDatabaseOptions = {}): InstantAvailabilityLowLevelDatabase {
  const dbId = options.dbId ?? `instant-availability-${crypto.randomUUID()}`;
  const maxPendingSeqRecords = options.maxPendingSeqRecords ?? 20_000;
  if (!Number.isFinite(maxPendingSeqRecords) || maxPendingSeqRecords <= 0) throw new Error("maxPendingSeqRecords must be a positive finite number");
  const initialSeqId = "initial";
  const initialSeq = createDatabaseSeq(dbId, initialSeqId);
  const seqRecords = new WeakMap<object, SeqRecord>();
  let createdSeqRecords = 1;
  let underlyingAvailableSeqRecords = 1;
  const pendingSeqRecords = new Set<SeqRecord>();
  let currentWriteGateOperation: Promise<void> = Promise.resolve();
  let isClosing = false;
  let closePromise: Promise<void> | null = null;
  let pendingSeqRecordsChangedResolve: () => void;
  let pendingSeqRecordsChanged = new Promise<void>(resolve => {
    pendingSeqRecordsChangedResolve = resolve;
  });
  seqRecords.set(initialSeq, {
    underlyingSeq: wrapped.initialSeq,
    underlyingAvailable: Promise.resolve(),
    isSettled: true,
  });
  const cacheMaps = new Set<Map<string, CachedValue>>();

  const toSeq = (seqId: string) => createDatabaseSeq(dbId, seqId);
  const getSeqId = (seq: DatabaseSeq | undefined) => {
    if (seq === undefined) return initialSeqId;
    if (seq[0] !== dbId || typeof seq[1] !== "string") throw new Error("Instant-availability sequence does not belong to this database");
    return seq[1];
  };
  const getSeqRecord = (seq: DatabaseSeq | undefined) => {
    const seqObject = seq ?? initialSeq;
    getSeqId(seqObject);
    const record = seqRecords.get(seqObject);
    if (record === undefined) throw new Error("Unknown instant-availability sequence");
    return record;
  };
  const getUnderlyingSeq = (seq: DatabaseSeq | undefined) => getSeqRecord(seq).underlyingSeq;
  const notifyPendingSeqRecordsChanged = () => {
    pendingSeqRecordsChangedResolve();
    pendingSeqRecordsChanged = new Promise<void>(resolve => {
      pendingSeqRecordsChangedResolve = resolve;
    });
  };
  const waitForPendingSeqRecordBudget = async () => {
    await traceSpanHot({ description: "bulldozer-js.low-level.instant.waitForPendingSeqRecordBudget", attributes: { "bulldozer.low_level.backend": "instant-availability" } }, async () => {
      while (pendingSeqRecords.size >= maxPendingSeqRecords) {
        await pendingSeqRecordsChanged;
      }
    });
  };
  const withWriteGate = async <T>(operation: () => Promise<T>): Promise<T> => {
    return await traceSpanHot({ description: "bulldozer-js.low-level.instant.withWriteGate", attributes: { "bulldozer.low_level.backend": "instant-availability" } }, async () => {
      if (isClosing) throw new Error("Instant-availability database is closing and cannot accept writes");
      const previousOperation = currentWriteGateOperation;
      let releaseCurrentOperation: () => void;
      currentWriteGateOperation = new Promise<void>(resolve => {
        releaseCurrentOperation = resolve;
      });
      await previousOperation.catch(() => {});
      try {
        await waitForPendingSeqRecordBudget();
        return await operation();
      } finally {
        releaseCurrentOperation!();
      }
    });
  };
  const createSeq = (underlyingSeq: DatabaseSeq) => {
    const seq = toSeq(crypto.randomUUID());
    const underlyingAvailable = traceSpanHot({ description: "bulldozer-js.low-level.instant.underlyingAvailable", attributes: { "bulldozer.low_level.backend": "instant-availability" } }, async () => {
      await wrapped.waitUntilAvailable(underlyingSeq);
    });
    // This is the "instant availability" trade-off: callers (e.g. write routes)
    // return as soon as the value is in this in-memory cache, NOT after it lands
    // in the wrapped (on-disk) store. If that background commit fails, the data
    // never reached disk even though the caller saw success — so we must surface
    // it to Sentry rather than swallowing it, so it can be detected and the row
    // reconciled. We deliberately don't block any caller on this (no fsync on the
    // hot path); other awaiters of `underlyingAvailable` handle the rejection
    // themselves, this handler exists purely to report + avoid an unhandled
    // rejection. (LMDB unwraps opaque commit failures in the low-level layer.)
    underlyingAvailable.catch(error => captureError("bulldozer-js:instant-availability-durable-commit", error));
    const record = { underlyingSeq, underlyingAvailable, isSettled: false };
    createdSeqRecords++;
    pendingSeqRecords.add(record);
    underlyingAvailable.finally(() => {
      record.isSettled = true;
      underlyingAvailableSeqRecords++;
      pendingSeqRecords.delete(record);
      notifyPendingSeqRecordsChanged();
    }).catch(() => {});
    seqRecords.set(seq, record);
    return seq;
  };
  const declareStoreOrDump = (wrappedStore: LowLevelKvStore & LowLevelKvDump): LowLevelKvStore & LowLevelKvDump => {
    const cachedValues = new Map<string, CachedValue>();
    let lastWriteSeq: DatabaseSeq | undefined;
    cacheMaps.add(cachedValues);
    const attributes = { "bulldozer.low_level.backend": "instant-availability" };
    const cacheKey = (key: ArrayBuffer) => encodeBase64(new Uint8Array(key));
    const setCachedValue = (key: ArrayBuffer, value: ArrayBuffer | null, seq: DatabaseSeq) => {
      cachedValues.set(cacheKey(key), { buffer: value === null ? null : cloneArrayBuffer(value), seq });
    };
    const evictAfterWrappedAvailability = (keys: ArrayBuffer[], seq: DatabaseSeq) => {
      getSeqRecord(seq).underlyingAvailable
        .then(() => {
          for (const key of keys) {
            const keyString = cacheKey(key);
            if (cachedValues.get(keyString)?.seq === seq) cachedValues.delete(keyString);
          }
        })
        .catch(() => {});
    };
    const getChainedRequiresSeq = (requiresSeq: DatabaseSeq | undefined): DatabaseSeq => {
      const previousWriteSeq = lastWriteSeq;
      const underlyingRequiresSeq = getUnderlyingSeq(requiresSeq);
      if (previousWriteSeq === undefined) return underlyingRequiresSeq;
      // Same-key underlying writes must be issued in instant-seq order; otherwise an evicted cache entry exposes and persists the older value.
      return wrapped.combineSeqs(underlyingRequiresSeq, getSeqRecord(previousWriteSeq).underlyingSeq);
    };
    const recordWrite = (underlyingSeq: DatabaseSeq, cacheEntries: Array<{ key: ArrayBuffer, value: ArrayBuffer | null }>) => {
      const seq = createSeq(underlyingSeq);
      lastWriteSeq = seq;
      for (const { key, value } of cacheEntries) setCachedValue(key, value, seq);
      evictAfterWrappedAvailability(cacheEntries.map(({ key }) => key), seq);
      return seq;
    };

    const result: LowLevelKvStore & LowLevelKvDump = {
      reserveKeys(count) {
        return wrappedStore.reserveKeys(count).map(cloneArrayBuffer);
      },
      async get(key) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.instant.get", attributes }, async (span) => {
          const cached = cachedValues.get(cacheKey(key));
          span.setAttribute("bulldozer.low_level.instant.cache_hit", cached !== undefined);
          if (cached !== undefined) {
            return {
              buffer: cached.buffer === null ? null : cloneArrayBuffer(cached.buffer),
              seq: cached.seq,
            };
          }

          const { buffer, seq } = await wrappedStore.get(key);
          await wrapped.waitUntilAvailable(seq);
          return { buffer, seq: initialSeq };
        });
      },
      async listEntries(options) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.instant.listEntries", attributes }, async () => {
          return await withWriteGate(async () => {
            // A range cannot be overlaid cheaply with the per-key pending cache. Drain the
            // latest write to this store while writes are gated, then read one coherent wrapped
            // range. Waiting on the store's causal write chain avoids unrelated stores and also
            // propagates a failed cached write instead of exposing stale wrapped data.
            if (lastWriteSeq !== undefined) await getSeqRecord(lastWriteSeq).underlyingAvailable;
            const result = await wrappedStore.listEntries(options);
            return {
              entries: result.entries.map(({ key, value }) => ({ key: cloneArrayBuffer(key), value: cloneArrayBuffer(value) })),
              hasMore: result.hasMore,
            };
          });
        });
      },
      async setAll(entries, setOptions) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.instant.setAll", attributes: { ...attributes, "bulldozer.low_level.entry_count": entries.length } }, async () => {
          if (entries.length === 0) return { seq: setOptions?.requiresSeq ?? initialSeq };
          return await withWriteGate(async () => {
            const entriesForWrapped = entries.map(({ key, value }) => ({ key: cloneArrayBuffer(key), value: cloneArrayBuffer(value) }));
            const requiresSeq = getChainedRequiresSeq(setOptions?.requiresSeq);
            const { seq: underlyingSeq } = await wrappedStore.setAll(entriesForWrapped, { requiresSeq });
            return { seq: recordWrite(underlyingSeq, entriesForWrapped) };
          });
        });
      },
      async deleteAll(keys, deleteOptions) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.instant.deleteAll", attributes: { ...attributes, "bulldozer.low_level.key_count": keys.length } }, async () => {
          if (keys.length === 0) return { seq: deleteOptions?.requiresSeq ?? initialSeq };
          return await withWriteGate(async () => {
            const keysForWrapped = keys.map(cloneArrayBuffer);
            const requiresSeq = getChainedRequiresSeq(deleteOptions?.requiresSeq);
            const { seq: underlyingSeq } = await wrappedStore.deleteAll(keysForWrapped, { requiresSeq });
            return { seq: recordWrite(underlyingSeq, keysForWrapped.map(key => ({ key, value: null }))) };
          });
        });
      },
      async insertAll(values, insertOptions) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.instant.insertAll", attributes: { ...attributes, "bulldozer.low_level.value_count": values.length } }, async () => {
          if (insertOptions?.keys !== undefined && insertOptions.keys.length !== values.length) {
            throw new Error("KV dump insertion must provide exactly one key per value");
          }
          if (values.length === 0) return { keys: [], seq: insertOptions?.requiresSeq ?? initialSeq };
          return await withWriteGate(async () => {
            const valuesForWrapped = values.map(cloneArrayBuffer);
            const keysForWrapped = insertOptions?.keys?.map(cloneArrayBuffer);
            const requiresSeq = getChainedRequiresSeq(insertOptions?.requiresSeq);
            const { keys, seq: underlyingSeq } = await wrappedStore.insertAll(valuesForWrapped, { requiresSeq, keys: keysForWrapped });
            const seq = recordWrite(underlyingSeq, keys.map((key, index) => ({ key, value: valuesForWrapped[index] })));
            return { keys: keys.map(cloneArrayBuffer), seq };
          });
        });
      },
      async compareAndSetAll(entries, compareAndSetOptions) {
        return await traceSpanHot({ description: "bulldozer-js.low-level.instant.compareAndSetAll", attributes: { ...attributes, "bulldozer.low_level.entry_count": entries.length } }, async () => {
          if (entries.length === 0) return { results: [], seq: compareAndSetOptions?.requiresSeq ?? initialSeq };
          const keys = new Set<string>();
          for (const { key } of entries) {
            const keyCacheKey = cacheKey(key);
            const previousSize = keys.size;
            keys.add(keyCacheKey);
            if (keys.size === previousSize) throw new Error("compareAndSetAll entries must not contain duplicate keys");
          }
          return await withWriteGate(async () => {
            const existingValues = await Promise.all(entries.map(async ({ key }) => await result.get(key)));
            const locallyMatching = entries.map(({ compare }, index) => {
              const existing = existingValues[index];
              return compare === null
                ? existing.buffer === null
                : existing.buffer !== null && arrayBuffersAreEqual(existing.buffer, compare);
            });
            const matchingEntries = entries.filter((_, index) => locallyMatching[index]);
            if (matchingEntries.length === 0) {
              const failedResults: Array<{ wasSet: false, seq: null }> = locallyMatching.map(() => ({ wasSet: false, seq: null }));
              return {
                results: failedResults,
                seq: compareAndSetOptions?.requiresSeq ?? initialSeq,
              };
            }
            // Existing-value comparisons are serialized by this wrapper's write gate and keep the
            // cheap setAll path. Absence must be checked by the wrapped store: another instant
            // wrapper can otherwise observe the same miss and overwrite the first initializer.
            const missingEntriesForWrapped = matchingEntries.filter(entry => entry.compare === null).map(({ key, value }) => ({
              key: cloneArrayBuffer(key),
              compare: null,
              value: cloneArrayBuffer(value),
            }));
            const presentEntriesForWrapped = matchingEntries.filter(entry => entry.compare !== null).map(({ key, value }) => ({
              key: cloneArrayBuffer(key),
              value: cloneArrayBuffer(value),
            }));
            const requiresSeq = getChainedRequiresSeq(compareAndSetOptions?.requiresSeq);
            const [missingResult, presentResult] = await Promise.all([
              missingEntriesForWrapped.length === 0
                ? null
                : wrappedStore.compareAndSetAll(missingEntriesForWrapped, { requiresSeq }),
              presentEntriesForWrapped.length === 0
                ? null
                : wrappedStore.setAll(presentEntriesForWrapped, { requiresSeq }),
            ]);
            const successfulMissingEntries = missingResult === null
              ? []
              : missingEntriesForWrapped.filter((_, index) => missingResult.results[index].wasSet);
            const successfulEntries = [...successfulMissingEntries, ...presentEntriesForWrapped];
            const successfulUnderlyingSeqs = [
              ...(successfulMissingEntries.length === 0 || missingResult === null ? [] : [missingResult.seq]),
              ...(presentResult === null ? [] : [presentResult.seq]),
            ];
            const seq = successfulEntries.length === 0
              ? compareAndSetOptions?.requiresSeq ?? initialSeq
              : recordWrite(wrapped.combineSeqs(...successfulUnderlyingSeqs), successfulEntries);
            const results: Array<{ wasSet: true, seq: DatabaseSeq } | { wasSet: false, seq: null }> = [];
            let missingIndex = 0;
            for (const [index, entry] of entries.entries()) {
              if (!locallyMatching[index]) {
                results.push({ wasSet: false, seq: null });
                continue;
              }
              const wasSet = entry.compare !== null || missingResult?.results[missingIndex++].wasSet === true;
              results.push(wasSet ? { wasSet: true, seq } : { wasSet: false, seq: null });
            }
            return { results, seq };
          });
        });
      },
      async debugEntries() {
        return await traceSpanHot({ description: "bulldozer-js.low-level.instant.debugEntries", attributes }, async () => await wrappedStore.debugEntries?.() ?? []);
      },
    };

    return result;
  };

  return {
    getDebugInfo() {
      return {
        backend: "instant-availability",
        constructorArguments: { wrapped, options },
        wrapped,
        dbId,
        maxPendingSeqRecords,
        initialSeq,
        seqRecords,
        createdSeqRecords,
        underlyingAvailableSeqRecords,
        pendingSeqRecords,
        currentWriteGateOperation,
        pendingSeqRecordsChanged,
        cacheMaps,
      };
    },
    declareKvStore(id) {
      return declareStoreOrDump(wrapped.declareKvStore(id) as LowLevelKvStore & LowLevelKvDump);
    },
    declareKvDump(id) {
      return declareStoreOrDump(wrapped.declareKvDump(id) as LowLevelKvStore & LowLevelKvDump);
    },
    async waitUntilAvailable() {
      return await traceSpanHot({ description: "bulldozer-js.low-level.instant.waitUntilAvailable", attributes: { "bulldozer.low_level.backend": "instant-availability" } }, async () => {});
    },
    async waitUntilDurable(seq) {
      await traceSpanHot({ description: "bulldozer-js.low-level.instant.waitUntilDurable", attributes: { "bulldozer.low_level.backend": "instant-availability" } }, async () => await wrapped.waitUntilDurable(getUnderlyingSeq(seq)));
    },
    async waitUntilReplicated(seq) {
      await traceSpanHot({ description: "bulldozer-js.low-level.instant.waitUntilReplicated", attributes: { "bulldozer.low_level.backend": "instant-availability" } }, async () => await wrapped.waitUntilReplicated(getUnderlyingSeq(seq)));
    },
    async waitUntilConsistent(seq) {
      await traceSpanHot({ description: "bulldozer-js.low-level.instant.waitUntilConsistent", attributes: { "bulldozer.low_level.backend": "instant-availability" } }, async () => await wrapped.waitUntilConsistent(getUnderlyingSeq(seq)));
    },
    combineSeqs(...seqs) {
      if (seqs.length === 0) return initialSeq;
      const uniqueSeqs = new Set(seqs);
      if (uniqueSeqs.size === 1) return seqs[0];
      if (seqs.every(seq => getSeqId(seq) === initialSeqId)) return initialSeq;
      return createSeq(wrapped.combineSeqs(...seqs.map(seq => getUnderlyingSeq(seq))));
    },
    close() {
      if (closePromise === null) {
        isClosing = true;
        closePromise = traceSpanHot({ description: "bulldozer-js.low-level.instant.close", attributes: { "bulldozer.low_level.backend": "instant-availability" } }, async () => {
          await currentWriteGateOperation;
          try {
            await Promise.all([...pendingSeqRecords].map(async record => await record.underlyingAvailable));
          } finally {
            await wrapped.close();
          }
        });
      }
      return closePromise;
    },
    async debugSnapshot() {
      return await traceSpanHot({ description: "bulldozer-js.low-level.instant.debugSnapshot", attributes: { "bulldozer.low_level.backend": "instant-availability" } }, async () => await wrapped.debugSnapshot?.() ?? { stores: {}, dumps: {} });
    },
    debugInstantAvailability() {
      return {
        createdSeqRecords,
        pendingSeqRecords: pendingSeqRecords.size,
        underlyingAvailableSeqRecords,
        cachedValues: [...cacheMaps].reduce((sum, cachedValues) => sum + cachedValues.size, 0),
      };
    },
    async waitUntilUnderlyingAvailable(seq) {
      await traceSpanHot({ description: "bulldozer-js.low-level.instant.waitUntilUnderlyingAvailable", attributes: { "bulldozer.low_level.backend": "instant-availability" } }, async () => await getSeqRecord(seq).underlyingAvailable);
    },
    initialSeq,
  };
}

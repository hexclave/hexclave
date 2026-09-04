import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { createDatabaseSeq, DatabaseSeq } from "../../index.js";
import { PiledriverDatabase, PiledriverObject } from "../index.js";

type PendingEntry = {
  id: string,
  key: ArrayBuffer,
  state: { type: "set", value: PiledriverObject } | { type: "delete" },
  latestSeq: DatabaseSeq,
  records: SeqRecord[],
};
type SeqRecord = {
  flush: Promise<DatabaseSeq>,
  resolve: (seq: DatabaseSeq) => void,
  reject: (error: unknown) => void,
};

const getPendingKey = (key: ArrayBuffer) => ({
  id: encodeBase64(new Uint8Array(key)),
  key: key.slice(0),
});

export function declareBufferedPiledriverDatabase(wrapped: PiledriverDatabase): PiledriverDatabase {
  const dbId = `buffered-piledriver-${crypto.randomUUID()}`;
  const initialSeq = createDatabaseSeq(dbId, "initial");
  const seqRecords = new WeakMap<object, SeqRecord>();
  const pending = new Map<string, PendingEntry>();
  const inFlight = new Map<string, PendingEntry>();
  let drainPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let isClosing = false;

  const getRecord = (seq: DatabaseSeq) => {
    if (seq === initialSeq) return null;
    if (!Array.isArray(seq) || seq[0] !== dbId) throw new Error("Buffered Piledriver sequence does not belong to this database");
    const record = seqRecords.get(seq);
    if (record === undefined) throw new Error("Unknown buffered Piledriver sequence");
    return record;
  };

  const drain = async () => {
    while (pending.size > 0) {
      const entry = pending.values().next().value ?? throwErr("Buffered Piledriver drain expected a pending entry");
      pending.delete(entry.id);
      inFlight.set(entry.id, entry);
      try {
        const result = entry.state.type === "delete"
          ? await wrapped.deleteRootObject(entry.key)
          : await wrapped.setRootObject(entry.key, entry.state.value);
        for (const record of entry.records) record.resolve(result.seq);
        if (inFlight.get(entry.id) === entry && !pending.has(entry.id)) inFlight.delete(entry.id);
      } catch (error) {
        // The caller was already told this write succeeded, so rolling back a failed flush could expose stale data
        // without anyone noticing; keep the failed value visible and report the anomaly instead.
        for (const record of entry.records) record.reject(error);
        captureError("bulldozer-js:piledriver-buffered-flush", error);
      }
    }
  };

  const ensureDrain = () => {
    if (drainPromise === null) {
      drainPromise = drain().finally(() => {
        drainPromise = null;
        if (pending.size > 0) ensureDrain();
      });
    }
  };

  const drainBeforeOperation = async () => {
    while (drainPromise !== null || pending.size > 0) {
      if (drainPromise !== null) await drainPromise;
      else ensureDrain();
    }
  };

  const createSeq = () => {
    const seq = createDatabaseSeq(dbId, crypto.randomUUID());
    let resolve!: (value: DatabaseSeq) => void;
    let reject!: (error: unknown) => void;
    const flush = new Promise<DatabaseSeq>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const record = { flush, resolve, reject };
    // Background flush failures are already reported through captureError, and real awaiters still observe the rejection.
    // This handler only prevents an unobserved record rejection from becoming an unhandled process rejection.
    record.flush.catch(() => undefined);
    seqRecords.set(seq, record);
    return { seq, record };
  };

  const createResolvedSeq = (underlyingSeq: DatabaseSeq) => {
    const { seq, record } = createSeq();
    record.resolve(underlyingSeq);
    return seq;
  };

  const write = (key: ArrayBuffer, state: PendingEntry["state"]) => {
    if (isClosing) throw new Error("Buffered Piledriver database is closing and cannot accept writes");
    const pendingKey = getPendingKey(key);
    const { seq, record } = createSeq();
    const entry = pending.get(pendingKey.id) ?? {
      id: pendingKey.id,
      key: pendingKey.key,
      state,
      latestSeq: seq,
      records: [],
    };
    entry.state = state;
    entry.latestSeq = seq;
    entry.records.push(record);
    pending.set(pendingKey.id, entry);
    ensureDrain();
    return seq;
  };

  const createCombinedSeq = (seqs: DatabaseSeq[]) => {
    if (seqs.length === 0) return initialSeq;
    const memberRecords = seqs.map(memberSeq => ({
      memberSeq,
      record: getRecord(memberSeq),
    }));
    if (memberRecords.length === 1) return memberRecords[0].memberSeq;
    const { seq, record } = createSeq();
    runAsynchronously(async () => {
      const underlyingSeqs = await Promise.all(memberRecords.map(({ record: memberRecord }) => {
        return memberRecord === null ? Promise.resolve(wrapped.initialSeq) : memberRecord.flush;
      }));
      record.resolve(wrapped.combineSeqs(...underlyingSeqs));
    }, {
      noErrorLogging: true,
      onError: error => record.reject(error),
    });
    return seq;
  };

  const waitUntil = async (seq: DatabaseSeq, wait: (underlyingSeq: DatabaseSeq) => Promise<void>) => {
    const record = getRecord(seq);
    if (record === null) return await wait(wrapped.initialSeq);
    const underlyingSeq = await record.flush;
    await wait(underlyingSeq);
  };

  return {
    getDebugInfo() {
      return { backend: "piledriver-buffered", wrapped, pendingBufferSize: pending.size, inFlightBufferSize: inFlight.size };
    },
    async getRootObject(key) {
      const pendingKey = getPendingKey(key);
      const entry = pending.get(pendingKey.id) ?? inFlight.get(pendingKey.id);
      if (entry !== undefined) {
        if (entry.state.type === "delete") throw new Error("Root object not found");
        // Pending reads return the original object without serialization, so callers must preserve the same immutability
        // expectations as with the in-memory Piledriver backend.
        return { object: entry.state.value, seq: entry.latestSeq };
      }
      const result = await wrapped.getRootObject(key);
      return { object: result.object, seq: createResolvedSeq(result.seq) };
    },
    async setRootObject(key, value) {
      return { seq: write(key, { type: "set", value }) };
    },
    async deleteRootObject(key) {
      return { seq: write(key, { type: "delete" }) };
    },
    getGarbageCollectionProcessStartedAtMillis() {
      return wrapped.getGarbageCollectionProcessStartedAtMillis();
    },
    async collectGarbage(cutoffTimestampMillis, maxObjects) {
      await drainBeforeOperation();
      return await wrapped.collectGarbage(cutoffTimestampMillis, maxObjects);
    },
    async debugSnapshot() {
      await drainBeforeOperation();
      if (wrapped.debugSnapshot === undefined) return { roots: [], heap: [] };
      return await wrapped.debugSnapshot();
    },
    async debugLowLevelSnapshot() {
      await drainBeforeOperation();
      if (wrapped.debugLowLevelSnapshot === undefined) return { stores: {}, dumps: {} };
      return await wrapped.debugLowLevelSnapshot();
    },
    combineSeqs(...seqs) {
      return createCombinedSeq(seqs);
    },
    waitUntilAvailable: async () => {},
    waitUntilDurable: async seq => await waitUntil(seq, underlyingSeq => wrapped.waitUntilDurable(underlyingSeq)),
    waitUntilReplicated: async seq => await waitUntil(seq, underlyingSeq => wrapped.waitUntilReplicated(underlyingSeq)),
    waitUntilConsistent: async seq => await waitUntil(seq, underlyingSeq => wrapped.waitUntilConsistent(underlyingSeq)),
    async close() {
      if (closePromise === null) {
        isClosing = true;
        closePromise = (async () => {
          try {
            await drainBeforeOperation();
          } finally {
            await wrapped.close();
          }
        })();
      }
      await closePromise;
    },
    initialSeq,
  };
}

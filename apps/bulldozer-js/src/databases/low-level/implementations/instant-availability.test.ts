import { describe, expect, it } from "vitest";
import { DatabaseSeq } from "../../index.js";
import { LowLevelDatabase, LowLevelKvDump, LowLevelKvStore } from "../index.js";
import { declareInMemoryLowLevelDatabase } from "./in-memory.js";
import { declareInstantAvailabilityLowLevelDatabase } from "./instant-availability.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const buffer = (value: string) => textEncoder.encode(value).buffer;
const text = (value: ArrayBuffer | null) => value === null ? null : textDecoder.decode(value);

function createSlowSetDatabase() {
  const releaseSets: Array<() => void> = [];
  const rejectSets: Array<(error: Error) => void> = [];
  let setCallCount = 0;
  let closeCallCount = 0;
  const committed = new Map<string, ArrayBuffer>();
  const initialSeq = ["slow", "initial"] as unknown as DatabaseSeq;
  const seqToPromise = new Map<DatabaseSeq, Promise<void>>([[initialSeq, Promise.resolve()]]);
  const store: LowLevelKvStore = {
    async get(key) {
      return { buffer: committed.get(text(key)!)?.slice(0) ?? null, seq: initialSeq };
    },
    async listEntries(options) {
      const limit = options?.limit ?? 1000;
      const startAfter = options?.startAfter === undefined ? undefined : text(options.startAfter);
      if (startAfter === null) throw new Error("Expected a non-null pagination cursor");
      const matchingEntries = [...committed.entries()]
        .filter(([key]) => startAfter === undefined || key > startAfter)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return {
        entries: matchingEntries.slice(0, limit).map(([key, value]) => ({ key: buffer(key), value: value.slice(0) })),
        hasMore: matchingEntries.length > limit,
      };
    },
    async setAll(entries) {
      setCallCount++;
      const seq = ["slow", crypto.randomUUID()] as unknown as DatabaseSeq;
      const promise = new Promise<void>((resolve, reject) => {
        releaseSets.push(() => {
          for (const { key, value } of entries) committed.set(text(key)!, value.slice(0));
          resolve();
        });
        rejectSets.push(reject);
      });
      seqToPromise.set(seq, promise);
      return { seq };
    },
    async deleteAll() {
      throw new Error("not implemented");
    },
    async compareAndSetAll() {
      throw new Error("not implemented");
    },
  };
  const db: LowLevelDatabase = {
    getDebugInfo() {
      return {
        backend: "slow-set-test",
        releaseSets,
        setCallCount,
        committed,
        seqToPromise,
        initialSeq,
      };
    },
    declareKvStore: () => store,
    declareKvDump: () => {
      throw new Error("not implemented");
    },
    async waitUntilAvailable(seq) {
      await seqToPromise.get(seq);
    },
    async waitUntilDurable(seq) {
      await seqToPromise.get(seq);
    },
    async waitUntilReplicated(seq) {
      await seqToPromise.get(seq);
    },
    async waitUntilConsistent(seq) {
      await seqToPromise.get(seq);
    },
    combineSeqs(...seqs) {
      return seqs[seqs.length - 1] ?? initialSeq;
    },
    async close() {
      closeCallCount++;
      await Promise.all(seqToPromise.values());
    },
    initialSeq,
  };
  return {
    db,
    releaseSet: () => {
      const releaseSet = releaseSets.shift();
      if (releaseSet === undefined) throw new Error("set was not started");
      rejectSets.shift();
      releaseSet();
    },
    rejectSet: (error: Error) => {
      releaseSets.shift();
      const rejectSet = rejectSets.shift();
      if (rejectSet === undefined) throw new Error("set was not started");
      rejectSet(error);
    },
    setCallCount: () => setCallCount,
    closeCallCount: () => closeCallCount,
  };
}

function createReorderingSetDatabase() {
  const committed = new Map<string, ArrayBuffer>();
  const initialSeq = ["reordering", "initial"] as unknown as DatabaseSeq;
  const seqToPromise = new Map<DatabaseSeq, Promise<void>>([[initialSeq, Promise.resolve()]]);
  const callCountWaiters: Array<{ count: number, resolve: () => void }> = [];
  const combineSeqArgs: DatabaseSeq[][] = [];
  const setRequiresSeqs: Array<DatabaseSeq | undefined> = [];
  const underlyingSeqs: DatabaseSeq[] = [];
  let setCallCount = 0;
  let firstSetStartedResolve: (() => void) | undefined;
  let releaseFirstSet: (() => void) | undefined;
  const firstSetStarted = new Promise<void>(resolve => {
    firstSetStartedResolve = resolve;
  });
  const store: LowLevelKvStore = {
    async get(key) {
      return { buffer: committed.get(text(key)!)?.slice(0) ?? null, seq: initialSeq };
    },
    async listEntries() {
      throw new Error("not implemented");
    },
    async setAll(entries, setOptions) {
      setCallCount++;
      setRequiresSeqs.push(setOptions?.requiresSeq);
      for (const waiter of callCountWaiters) {
        if (setCallCount >= waiter.count) waiter.resolve();
      }
      callCountWaiters.splice(0, callCountWaiters.length, ...callCountWaiters.filter(waiter => setCallCount < waiter.count));
      const seq = ["reordering", crypto.randomUUID()] as unknown as DatabaseSeq;
      underlyingSeqs.push(seq);
      let resolveSet!: () => void;
      let rejectSet!: (error: unknown) => void;
      const committedPromise = new Promise<void>((resolve, reject) => {
        resolveSet = resolve;
        rejectSet = reject;
      });
      seqToPromise.set(seq, committedPromise);
      const commit = () => {
        for (const { key, value } of entries) committed.set(text(key)!, value.slice(0));
        resolveSet();
      };
      if (setCallCount === 1) {
        firstSetStartedResolve!();
        releaseFirstSet = commit;
      } else {
        const requiresSeq = setOptions?.requiresSeq ?? initialSeq;
        const prerequisite = seqToPromise.get(requiresSeq);
        if (prerequisite === undefined) throw new Error("Missing prerequisite sequence in reordering test backend");
        prerequisite.then(commit, rejectSet).catch(rejectSet);
      }
      return { seq };
    },
    async deleteAll() {
      throw new Error("not implemented");
    },
    async compareAndSetAll() {
      throw new Error("not implemented");
    },
  };
  const db: LowLevelDatabase = {
    getDebugInfo() {
      return { backend: "reordering-test", committed, initialSeq };
    },
    declareKvStore: () => store,
    declareKvDump: () => {
      throw new Error("not implemented");
    },
    async waitUntilAvailable(seq) {
      await seqToPromise.get(seq);
    },
    async waitUntilDurable(seq) {
      await seqToPromise.get(seq);
    },
    async waitUntilReplicated(seq) {
      await seqToPromise.get(seq);
    },
    async waitUntilConsistent(seq) {
      await seqToPromise.get(seq);
    },
    combineSeqs(...seqs) {
      combineSeqArgs.push(seqs);
      return seqs[seqs.length - 1] ?? initialSeq;
    },
    async close() {},
    initialSeq,
  };
  return {
    db,
    firstSetStarted,
    releaseFirstSet() {
      releaseFirstSet!();
    },
    waitForSetCallCount(count: number) {
      if (setCallCount >= count) return Promise.resolve();
      return new Promise<void>(resolve => callCountWaiters.push({ count, resolve }));
    },
    combineSeqArgs: () => combineSeqArgs.map(seqs => [...seqs]),
    setRequiresSeqs: () => [...setRequiresSeqs],
    underlyingSeqs: () => [...underlyingSeqs],
  };
}

function createDelayedSetImmediateInsertDatabase() {
  const committed = new Map<string, ArrayBuffer>();
  committed.set("earlier", buffer("set"));
  const initialSeq = ["delayed-set", "initial"] as unknown as DatabaseSeq;
  let releaseSet!: () => void;
  let setStarted = false;
  const pendingSet = new Promise<void>(resolve => {
    releaseSet = resolve;
  });
  const seqToPromise = new Map<DatabaseSeq, Promise<void>>([[initialSeq, Promise.resolve()]]);
  let nextDumpKey = 0;
  const store: LowLevelKvStore & LowLevelKvDump = {
    reserveKeys(count) {
      return Array.from({ length: count }, () => buffer(`inserted-${nextDumpKey++}`));
    },
    async get(key) {
      return { buffer: committed.get(text(key)!)?.slice(0) ?? null, seq: initialSeq };
    },
    async listEntries(options) {
      const startAfter = options?.startAfter === undefined ? undefined : text(options.startAfter);
      if (startAfter === null) throw new Error("Expected a non-null pagination cursor");
      const entries = [...committed.entries()]
        .filter(([key]) => startAfter === undefined || key > startAfter)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, value]) => ({ key: buffer(key), value: value.slice(0) }));
      const limit = options?.limit ?? 1000;
      return { entries: entries.slice(0, limit), hasMore: entries.length > limit };
    },
    async setAll(entries) {
      setStarted = true;
      const seq = ["delayed-set", "set"] as unknown as DatabaseSeq;
      const available = pendingSet.then(() => {
        for (const { key, value } of entries) committed.set(text(key)!, value.slice(0));
      });
      seqToPromise.set(seq, available);
      return { seq };
    },
    async deleteAll(keys) {
      setStarted = true;
      const seq = ["delayed-set", "delete"] as unknown as DatabaseSeq;
      const available = pendingSet.then(() => {
        for (const key of keys) committed.delete(text(key)!);
      });
      seqToPromise.set(seq, available);
      return { seq };
    },
    async insertAll(values, options) {
      const keys = options?.keys ?? store.reserveKeys(values.length);
      await seqToPromise.get(options?.requiresSeq ?? initialSeq);
      for (const [index, key] of keys.entries()) committed.set(text(key)!, values[index].slice(0));
      const seq = ["delayed-set", "insert"] as unknown as DatabaseSeq;
      seqToPromise.set(seq, Promise.resolve());
      return { keys, seq };
    },
    async compareAndSetAll() {
      throw new Error("not implemented");
    },
  };
  const db = {
    getDebugInfo: () => ({ backend: "delayed-set-immediate-insert", committed, initialSeq }),
    declareKvStore: () => store,
    declareKvDump: () => store,
    waitUntilAvailable: async seq => await seqToPromise.get(seq),
    waitUntilDurable: async seq => await seqToPromise.get(seq),
    waitUntilReplicated: async seq => await seqToPromise.get(seq),
    waitUntilConsistent: async seq => await seqToPromise.get(seq),
    combineSeqs: (...seqs) => seqs[seqs.length - 1] ?? initialSeq,
    close: async () => {},
    initialSeq,
  } satisfies LowLevelDatabase;
  return {
    db,
    waitForSetStarted: async () => {
      while (!setStarted) await Promise.resolve();
    },
    releaseSet,
  };
}

describe("instant-availability low-level database", () => {
  it("serves pending writes from memory before the wrapped database is available", async () => {
    const slow = createSlowSetDatabase();
    const db = declareInstantAvailabilityLowLevelDatabase(slow.db, { dbId: "instant-test" });
    const store = db.declareKvStore("store");

    const { seq } = await store.setAll([{ key: buffer("key"), value: buffer("pending") }]);
    await db.waitUntilAvailable(seq);
    expect(text((await store.get(buffer("key"))).buffer)).toBe("pending");

    let replicated = false;
    const replicatedPromise = db.waitUntilReplicated(seq).then(() => {
      replicated = true;
    });
    await Promise.resolve();
    expect(replicated).toBe(false);

    slow.releaseSet();
    await replicatedPromise;
    expect(replicated).toBe(true);
  });

  it("waits for this store's pending writes before listing a coherent range", async () => {
    const slow = createSlowSetDatabase();
    const db = declareInstantAvailabilityLowLevelDatabase(slow.db, { dbId: "instant-list-test" });
    const store = db.declareKvStore("store");
    await store.setAll([{ key: buffer("key"), value: buffer("pending") }]);

    let listed = false;
    const listing = store.listEntries().then(result => {
      listed = true;
      return result;
    });
    await Promise.resolve();
    expect(listed).toBe(false);

    slow.releaseSet();
    expect((await listing).entries.map(entry => [text(entry.key), text(entry.value)])).toEqual([["key", "pending"]]);
  });

  it("chains insertAll behind an earlier pending deleteAll before listing", async () => {
    const delayed = createDelayedSetImmediateInsertDatabase();
    const db = declareInstantAvailabilityLowLevelDatabase(delayed.db, { dbId: "instant-insert-chain-test" });
    const store = db.declareKvDump("store");
    await store.deleteAll([buffer("earlier")]);
    await delayed.waitForSetStarted();

    const reservedKeys = store.reserveKeys(1);
    const insert = store.insertAll([buffer("insert")], { keys: reservedKeys });
    const listing = store.listEntries();
    let listed = false;
    const listedResult = listing.then(result => {
      listed = true;
      return result;
    });
    await Promise.resolve();
    expect(listed).toBe(false);

    delayed.releaseSet();
    expect((await insert).keys).toEqual(reservedKeys);
    expect((await listedResult).entries.map(entry => [text(entry.key), text(entry.value)])).toEqual([["inserted-0", "insert"]]);
  });

  it("does not block a range read on another store's pending write", async () => {
    const slow = createSlowSetDatabase();
    const db = declareInstantAvailabilityLowLevelDatabase(slow.db, { dbId: "instant-list-store-scope-test" });
    const writingStore = db.declareKvStore("writing");
    const unrelatedStore = db.declareKvStore("unrelated");
    await writingStore.setAll([{ key: buffer("key"), value: buffer("pending") }]);

    await expect(unrelatedStore.listEntries()).resolves.toEqual({ entries: [], hasMore: false });
    slow.releaseSet();
  });

  it("rejects range reads when this store's optimistic write failed", async () => {
    const slow = createSlowSetDatabase();
    const db = declareInstantAvailabilityLowLevelDatabase(slow.db, { dbId: "instant-list-failure-test" });
    const store = db.declareKvStore("store");
    await store.setAll([{ key: buffer("key"), value: buffer("pending") }]);
    slow.rejectSet(new Error("underlying write failed"));

    await expect(store.listEntries()).rejects.toThrow("underlying write failed");
  });

  it("applies backpressure to writes when too many seq records are pending", async () => {
    const slow = createSlowSetDatabase();
    const db = declareInstantAvailabilityLowLevelDatabase(slow.db, {
      dbId: "instant-test",
      maxPendingSeqRecords: 1,
    });
    const store = db.declareKvStore("store");

    await store.setAll([{ key: buffer("first"), value: buffer("pending") }]);
    await Promise.resolve();
    expect(slow.setCallCount()).toBe(1);

    let secondWriteFinished = false;
    const secondWrite = store.setAll([{ key: buffer("second"), value: buffer("blocked") }]).then(() => {
      secondWriteFinished = true;
    });
    await Promise.resolve();
    expect(slow.setCallCount()).toBe(1);
    expect(secondWriteFinished).toBe(false);

    slow.releaseSet();
    await secondWrite;
    expect(slow.setCallCount()).toBe(2);
    expect(secondWriteFinished).toBe(true);

    slow.releaseSet();
  });

  it("drains pending writes and closes the wrapped database exactly once", async () => {
    const slow = createSlowSetDatabase();
    const db = declareInstantAvailabilityLowLevelDatabase(slow.db, { dbId: "instant-close-test" });
    const store = db.declareKvStore("store");
    await store.setAll([{ key: buffer("key"), value: buffer("pending") }]);

    const closing = db.close();
    expect(await Promise.race([
      closing.then(() => "closed"),
      Promise.resolve("pending"),
    ])).toBe("pending");
    expect(slow.closeCallCount()).toBe(0);

    slow.releaseSet();
    await closing;
    expect(slow.closeCallCount()).toBe(1);
    await db.close();
    expect(slow.closeCallCount()).toBe(1);
    await expect(store.setAll([{ key: buffer("late"), value: buffer("rejected") }])).rejects.toThrow("closing");
  });

  it("only allows a single winner for concurrent compareAndSetAll on the same key", async () => {
    const db = declareInstantAvailabilityLowLevelDatabase(
      declareInMemoryLowLevelDatabase(crypto.randomUUID()),
      { dbId: "instant-test" },
    );
    const store = db.declareKvStore("store");

    // Seed the key so both racers observe the same starting value from the in-memory cache.
    await store.setAll([{ key: buffer("key"), value: buffer("start") }]);

    // Launch both one-entry compare-and-sets concurrently. The read+compare must be gated together with
    // the write, so exactly one of them may observe "start" and win — the other must lose.
    const [first, second] = await Promise.all([
      store.compareAndSetAll([{ key: buffer("key"), compare: buffer("start"), value: buffer("a") }]),
      store.compareAndSetAll([{ key: buffer("key"), compare: buffer("start"), value: buffer("b") }]),
    ]);

    const results = [first.results[0], second.results[0]];
    const winners = results.filter(result => result.wasSet);
    const losers = results.filter(result => !result.wasSet);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].seq).toBeNull();

    // The stored value must reflect the single winner.
    expect(text((await store.get(buffer("key"))).buffer)).toBe(first.results[0].wasSet ? "a" : "b");
  });

  it("atomically compares against absence across instant-availability instances", async () => {
    const underlying = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const first = declareInstantAvailabilityLowLevelDatabase(underlying, { dbId: "instant-first" });
    const second = declareInstantAvailabilityLowLevelDatabase(underlying, { dbId: "instant-second" });
    const firstStore = first.declareKvStore("store");
    const secondStore = second.declareKvStore("store");

    const [firstResult, secondResult] = await Promise.all([
      firstStore.compareAndSetAll([{ key: buffer("key"), compare: null, value: buffer("first") }]),
      secondStore.compareAndSetAll([{ key: buffer("key"), compare: null, value: buffer("second") }]),
    ]);

    expect([firstResult.results[0].wasSet, secondResult.results[0].wasSet].filter(Boolean)).toHaveLength(1);
    expect(["first", "second"]).toContain(text((await underlying.declareKvStore("store").get(buffer("key"))).buffer));
  });

  it("preserves instant-seq order when a prior underlying write is delayed", async () => {
    const reordering = createReorderingSetDatabase();
    const db = declareInstantAvailabilityLowLevelDatabase(reordering.db, { dbId: "instant-reordering-test" });
    const store = db.declareKvStore("store");

    const dependency = await store.setAll([{ key: buffer("dependency"), value: buffer("dependency") }]);
    await reordering.firstSetStarted;
    const requiresSeq = dependency.seq;
    const oldWritePromise = store.setAll([{ key: buffer("key"), value: buffer("old") }], { requiresSeq });
    const newWritePromise = store.setAll([{ key: buffer("key"), value: buffer("new") }]);
    await new Promise(resolve => setTimeout(resolve, 10));
    reordering.releaseFirstSet();
    await reordering.waitForSetCallCount(2);
    const [{ seq: oldSeq }, { seq: newSeq }] = await Promise.all([oldWritePromise, newWritePromise]);
    await Promise.all([db.waitUntilAvailable(oldSeq), db.waitUntilAvailable(newSeq)]);
    expect(text((await store.get(buffer("key"))).buffer)).toBe("new");
  });

  it("chains the prior underlying sequence into the next wrapped write", async () => {
    const reordering = createReorderingSetDatabase();
    const db = declareInstantAvailabilityLowLevelDatabase(reordering.db, { dbId: "instant-reordering-chain-test" });
    const store = db.declareKvStore("store");

    const previous = await store.setAll([{ key: buffer("previous"), value: buffer("value") }]);
    await reordering.firstSetStarted;
    reordering.releaseFirstSet();
    await db.waitUntilAvailable(previous.seq);

    const next = await store.setAll([{ key: buffer("next"), value: buffer("value") }]);
    await reordering.waitForSetCallCount(2);
    await db.waitUntilAvailable(next.seq);

    const combineSeqArgs = reordering.combineSeqArgs();
    expect(combineSeqArgs).toHaveLength(1);
    expect(combineSeqArgs[0]).toHaveLength(2);
    expect(combineSeqArgs[0][1]).toBe(reordering.underlyingSeqs()[0]);
    expect(reordering.setRequiresSeqs()[1]).toBe(combineSeqArgs[0][1]);
  });
});

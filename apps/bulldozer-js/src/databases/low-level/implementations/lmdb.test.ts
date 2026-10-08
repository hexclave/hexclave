import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as lmdb from "lmdb";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { describe, expect, it, vi } from "vitest";
import { declareLmdbLowLevelDatabase } from "./lmdb.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const buffer = (value: string) => textEncoder.encode(value).buffer;
const byteBuffer = (value: Uint8Array) => new Uint8Array(value).slice().buffer;
const text = (value: ArrayBuffer | null) => value === null ? null : textDecoder.decode(value);
const tempLmdbPath = async () => await mkdtemp(join(tmpdir(), "bulldozer-lmdb-"));

describe("LMDB low-level database", () => {
  it("persists store values across database instances and exposes useful debug entries", async () => {
    const path = await tempLmdbPath();
    try {
      const db1 = declareLmdbLowLevelDatabase({ path, dbId: "persist" });
      const store1 = db1.declareKvStore("root");
      const { seq } = await store1.setAll([{ key: buffer("hello"), value: buffer("world") }]);
      await db1.waitUntilAvailable(seq);
      await db1.waitUntilDurable(seq);

      const db2 = declareLmdbLowLevelDatabase({ path, dbId: "persist" });
      const store2 = db2.declareKvStore("root");
      expect(text((await store2.get(buffer("hello"))).buffer)).toBe("world");
      expect(await db2.debugSnapshot!()).toMatchObject({
        stores: {
          root: [{
            keyUtf8: "hello",
            valueUtf8: "world",
            valueByteLength: 5,
          }],
        },
      });
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("records compression in constructorArguments and reopens compressed values", async () => {
    const path = await tempLmdbPath();
    try {
      const db1 = declareLmdbLowLevelDatabase({ path, dbId: "compress", compression: true });
      expect((db1.getDebugInfo() as { constructorArguments: { compression?: boolean } }).constructorArguments.compression).toBe(true);
      const store1 = db1.declareKvStore("root");
      // Value larger than the default 1000-byte compression threshold so LZ4 actually engages.
      const large = "x".repeat(2_000);
      const { seq } = await store1.setAll([{ key: buffer("big"), value: buffer(large) }]);
      await db1.waitUntilDurable(seq);
      await db1.close();

      const db2 = declareLmdbLowLevelDatabase({ path, dbId: "compress", compression: true });
      const store2 = db2.declareKvStore("root");
      expect(text((await store2.get(buffer("big"))).buffer)).toBe(large);
      await db2.close();

      // Raw open without compression: stored payload must be smaller than plaintext
      // (otherwise the `compression: true` option was a no-op).
      const rawRoot = lmdb.open({ path, compression: false });
      try {
        const rawDb = rawRoot.openDB({ name: "compress:store:root", encoding: "binary" });
        const rawValue = rawDb.get(Buffer.from("big"));
        expect(rawValue).toBeTruthy();
        expect(Buffer.byteLength(rawValue as Buffer)).toBeLessThan(large.length);
      } finally {
        // lmdb-js close() is async; await so the outer rm() does not race mapped files.
        await rawRoot.close();
      }
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("does not decode plaintext when reopened without compression (sticky)", async () => {
    const path = await tempLmdbPath();
    try {
      const db1 = declareLmdbLowLevelDatabase({ path, dbId: "sticky", compression: true });
      const store1 = db1.declareKvStore("root");
      const large = "y".repeat(2_000);
      const { seq } = await store1.setAll([{ key: buffer("big"), value: buffer(large) }]);
      await db1.waitUntilDurable(seq);
      await db1.close();

      const db2 = declareLmdbLowLevelDatabase({ path, dbId: "sticky", compression: false });
      try {
        const store2 = db2.declareKvStore("root");
        // With compression off, lmdb-js still returns the on-disk bytes (LZ4 framing) —
        // it does not throw. Assert we get opaque compressed payload, not plaintext.
        const value = (await store2.get(buffer("big"))).buffer;
        if (value == null) {
          throw new Error("expected on-disk compressed bytes, got null");
        }
        expect(value.byteLength).toBeLessThan(large.length);
        expect(text(value)).not.toBe(large);
      } finally {
        await db2.close();
      }
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("flushes delayed commits before close resolves", async () => {
    const path = await tempLmdbPath();
    const db = declareLmdbLowLevelDatabase({ path, dbId: "close-drain" });
    try {
      const store = db.declareKvStore("store");
      await store.setAll([{ key: buffer("key"), value: buffer("durable") }]);
      // setAll intentionally returns before the 10ms commit batch is submitted.
      // close must flush that application-level queue before closing LMDB.
      await db.close();

      const reopened = declareLmdbLowLevelDatabase({ path, dbId: "close-drain" });
      try {
        const reopenedStore = reopened.declareKvStore("store");
        expect(text((await reopenedStore.get(buffer("key"))).buffer)).toBe("durable");
      } finally {
        await reopened.close();
      }
    } finally {
      await db.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("drains in-flight reads before closing and rejects reads after close starts", async () => {
    const path = await tempLmdbPath();
    const db = declareLmdbLowLevelDatabase({
      path,
      dbId: "read-close",
      simulateReadMissDelayMs: 25,
    });
    try {
      const store = db.declareKvStore("store");
      const write = await store.setAll([{ key: buffer("key"), value: buffer("value") }]);
      await db.waitUntilDurable(write.seq);

      const read = store.get(buffer("key"));
      const closing = db.close();

      await expect(store.get(buffer("key"))).rejects.toThrow("LMDB database is closing");
      await expect(read).resolves.toMatchObject({ buffer: buffer("value") });
      await expect(closing).resolves.toBeUndefined();
    } finally {
      await db.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("waits for all reads before surfacing a read failure from close", async () => {
    const path = await tempLmdbPath();
    const db = declareLmdbLowLevelDatabase({
      path,
      dbId: "read-close-rejection",
      simulateReadMissDelayMs: 25,
    });
    try {
      const store = db.declareKvStore("store");
      const write = await store.setAll([{ key: buffer("key"), value: buffer("value") }]);
      await db.waitUntilDurable(write.seq);

      let pendingReadResolved = false;
      const pendingRead = store.get(buffer("key")).then(result => {
        pendingReadResolved = true;
        return result;
      });
      const rejectedRead = store.listEntries({ limit: 0 });
      const rejectedReadError = rejectedRead.then(() => null, error => error);
      const closing = db.close();

      await expect(closing).rejects.toThrow("KV store list limit must be a positive integer");
      expect(pendingReadResolved).toBe(true);
      await expect(pendingRead).resolves.toMatchObject({ buffer: buffer("value") });
      expect(await rejectedReadError).toMatchObject({ message: "KV store list limit must be a positive integer" });
    } finally {
      await expect(db.close()).rejects.toThrow("KV store list limit must be a positive integer");
      await rm(path, { recursive: true, force: true });
    }
  });

  it("supports compareAndSetAll without advancing seq on failed comparisons", async () => {
    const path = await tempLmdbPath();
    try {
      const db = declareLmdbLowLevelDatabase({ path, dbId: "cas" });
      const store = db.declareKvStore("store");
      const first = await store.setAll([{ key: buffer("key"), value: buffer("old") }]);
      const failed = await store.compareAndSetAll([{ key: buffer("key"), compare: buffer("wrong"), value: buffer("new") }]);
      expect(failed.results).toEqual([{ wasSet: false, seq: null }]);
      expect(failed.seq).toBe(db.initialSeq);
      expect(text((await store.get(buffer("key"))).buffer)).toBe("old");

      const succeeded = await store.compareAndSetAll([{ key: buffer("key"), compare: buffer("old"), value: buffer("new") }], { requiresSeq: first.seq });
      expect(succeeded.results).toEqual([{ wasSet: true, seq: succeeded.seq }]);
      await db.waitUntilConsistent(succeeded.seq);
      expect(text((await store.get(buffer("key"))).buffer)).toBe("new");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("atomically compares against a missing key across database instances", async () => {
    const path = await tempLmdbPath();
    const first = declareLmdbLowLevelDatabase({ path, dbId: "cas-missing" });
    const second = declareLmdbLowLevelDatabase({ path, dbId: "cas-missing" });
    try {
      const firstStore = first.declareKvStore("store");
      const secondStore = second.declareKvStore("store");
      const [firstResult, secondResult] = await Promise.all([
        firstStore.compareAndSetAll([{ key: buffer("key"), compare: null, value: buffer("first") }]),
        secondStore.compareAndSetAll([{ key: buffer("key"), compare: null, value: buffer("second") }]),
      ]);

      expect([firstResult.results[0].wasSet, secondResult.results[0].wasSet].filter(Boolean)).toHaveLength(1);
      expect(["first", "second"]).toContain(text((await firstStore.get(buffer("key"))).buffer));
    } finally {
      await Promise.all([first.close(), second.close()]);
      await rm(path, { recursive: true, force: true });
    }
  });

  it("supports immutable dump inserts", async () => {
    const path = await tempLmdbPath();
    try {
      const db = declareLmdbLowLevelDatabase({ path, dbId: "dump" });
      const dump = db.declareKvDump("heap");
      const { keys, seq } = await dump.insertAll([buffer("payload"), buffer("second"), buffer("third")]);
      await db.waitUntilDurable(seq);
      expect(keys.every(key => key.byteLength === 17)).toBe(true);
      expect(keys.every(key => new Uint8Array(key)[0] === 0x01)).toBe(true);
      expect(text((await dump.get(keys[0])).buffer)).toBe("payload");
      const firstPage = await dump.listEntries({ limit: 2 });
      expect(firstPage.entries).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);
      const secondPage = await dump.listEntries({ startAfter: firstPage.entries[1].key, limit: 2 });
      expect(secondPage.entries).toHaveLength(1);
      expect(secondPage.hasMore).toBe(false);
      const listedEntries = [...firstPage.entries, ...secondPage.entries];
      expect(listedEntries.every((entry, index) => index === 0 || Buffer.compare(
        Buffer.from(listedEntries[index - 1].key),
        Buffer.from(entry.key),
      ) < 0)).toBe(true);
      expect(new Set(listedEntries.map(entry => text(entry.value)))).toEqual(new Set(["payload", "second", "third"]));
      const deleted = await dump.deleteAll(keys, { requiresSeq: seq });
      await db.waitUntilAvailable(deleted.seq);
      expect(await Promise.all(keys.map(async key => text((await dump.get(key)).buffer)))).toEqual([null, null, null]);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("generates ordered dump keys and preserves legacy values", async () => {
    const path = await tempLmdbPath();
    try {
      const rawRoot = lmdb.open({ path, maxDbs: 1024, separateFlushed: true });
      const rawDump = rawRoot.openDB<Buffer, Uint8Array>({
        name: "ordered:dump:heap",
        encoding: "binary",
        keyEncoding: "binary",
        useVersions: true,
      });
      rawDump.putSync(Buffer.alloc(48, 0x7f), Buffer.from("legacy-arbitrary"), 1);
      rawDump.putSync(Buffer.alloc(48, 0xff), Buffer.from("legacy-max"), 2);
      await rawRoot.close();

      const db = declareLmdbLowLevelDatabase({ path, dbId: "ordered" });
      try {
        const dump = db.declareKvDump("heap");
        const inserted = await dump.insertAll([
          buffer("first"),
          buffer("second"),
          ...Array.from({ length: 448 }, () => buffer("extra")),
        ]);
        await db.waitUntilDurable(inserted.seq);

        expect(inserted.keys).toHaveLength(450);
        expect(inserted.keys[0].byteLength).toBe(17);
        expect(new Uint8Array(inserted.keys[0])[0]).toBe(0x01);
        expect(new Set(inserted.keys.map(key => Buffer.from(key).toString("hex"))).size).toBe(450);
        expect(inserted.keys.every((key, index) => index === 0 || Buffer.compare(
          Buffer.from(inserted.keys[index - 1]),
          Buffer.from(key),
        ) < 0)).toBe(true);
        expect(text((await dump.get(byteBuffer(Buffer.alloc(48, 0x7f)))).buffer)).toBe("legacy-arbitrary");
        expect(text((await dump.get(byteBuffer(Buffer.alloc(48, 0xff)))).buffer)).toBe("legacy-max");
        expect(text((await dump.get(inserted.keys[0])).buffer)).toBe("first");
        expect(text((await dump.get(inserted.keys[1])).buffer)).toBe("second");
      } finally {
        await db.close();
      }
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("continues generating versioned dump keys after reopening", async () => {
    const path = await tempLmdbPath();
    try {
      const db1 = declareLmdbLowLevelDatabase({ path, dbId: "reopen" });
      const dump1 = db1.declareKvDump("heap");
      const first = await dump1.insertAll([buffer("first")]);
      await db1.waitUntilDurable(first.seq);
      await db1.close();

      const db2 = declareLmdbLowLevelDatabase({ path, dbId: "reopen" });
      try {
        const dump2 = db2.declareKvDump("heap");
        const second = await dump2.insertAll([buffer("second")]);
        await db2.waitUntilDurable(second.seq);

        expect(second.keys[0].byteLength).toBe(17);
        expect(new Uint8Array(second.keys[0])[0]).toBe(0x01);
        expect(Buffer.compare(Buffer.from(first.keys[0]), Buffer.from(second.keys[0]))).toBeLessThan(0);
        expect(text((await dump2.get(first.keys[0])).buffer)).toBe("first");
        expect(text((await dump2.get(second.keys[0])).buffer)).toBe("second");
      } finally {
        await db2.close();
      }
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("batches store and dump writes", async () => {
    const path = await tempLmdbPath();
    try {
      const db = declareLmdbLowLevelDatabase({ path, dbId: "batch" });
      const store = db.declareKvStore("store");
      const dump = db.declareKvDump("heap");

      const set = await store.setAll([
        { key: buffer("a"), value: buffer("one") },
        { key: buffer("b"), value: buffer("two") },
      ]);
      await db.waitUntilAvailable(set.seq);
      expect(text((await store.get(buffer("a"))).buffer)).toBe("one");
      expect(text((await store.get(buffer("b"))).buffer)).toBe("two");

      const deleted = await store.deleteAll([buffer("a"), buffer("b")]);
      await db.waitUntilAvailable(deleted.seq);
      expect(text((await store.get(buffer("a"))).buffer)).toBe(null);
      expect(text((await store.get(buffer("b"))).buffer)).toBe(null);

      const reservedKeys = dump.reserveKeys(2);
      const inserted = await dump.insertAll([buffer("first"), buffer("second")], { keys: reservedKeys });
      await db.waitUntilAvailable(inserted.seq);
      expect(inserted.keys).toEqual(reservedKeys);
      expect(text((await dump.get(inserted.keys[0])).buffer)).toBe("first");
      expect(text((await dump.get(inserted.keys[1])).buffer)).toBe("second");
      await expect(dump.insertAll([buffer("missing-key")], { keys: [] })).rejects.toThrow("exactly one key per value");
      expect(() => dump.reserveKeys(-1)).toThrow("non-negative safe integer");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("coalesces independent writes into one delayed transaction", async () => {
    const path = await tempLmdbPath();
    try {
      const db = declareLmdbLowLevelDatabase({ path, dbId: "coalesce" });
      const store = db.declareKvStore("store");
      const beforeVersion = db.getDebugInfo().currentVersion;

      const first = await store.setAll([{ key: buffer("a"), value: buffer("one") }]);
      const second = await store.setAll([{ key: buffer("b"), value: buffer("two") }]);

      expect(db.getDebugInfo().currentVersion).toBe(beforeVersion);
      await db.waitUntilAvailable(db.combineSeqs(first.seq, second.seq));

      expect(db.getDebugInfo().currentVersion).toBe(beforeVersion + 1);
      expect(text((await store.get(buffer("a"))).buffer)).toBe("one");
      expect(text((await store.get(buffer("b"))).buffer)).toBe("two");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("does not deadlock when one queued write requires another queued write", async () => {
    const path = await tempLmdbPath();
    try {
      const db = declareLmdbLowLevelDatabase({ path, dbId: "same-batch-dependency" });
      const store = db.declareKvStore("store");
      const beforeVersion = db.getDebugInfo().currentVersion;

      const first = await store.setAll([{ key: buffer("parent"), value: buffer("first") }]);
      const second = await store.setAll([{ key: buffer("child"), value: buffer("second") }], { requiresSeq: db.combineSeqs(first.seq) });

      await db.waitUntilAvailable(second.seq);
      expect(db.getDebugInfo().currentVersion).toBe(beforeVersion + 1);
      expect(text((await store.get(buffer("parent"))).buffer)).toBe("first");
      expect(text((await store.get(buffer("child"))).buffer)).toBe("second");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("commits a batch whose writes require a very deep shared combined-seq chain", async () => {
    // Piledriver GC's pattern: every write requires `latest`, then `latest = combineSeqs(latest, write)`.
    // Deep enough to overflow the stack with a recursive walk, and O(writes × depth) with per-write walks.
    const path = await tempLmdbPath();
    const db = declareLmdbLowLevelDatabase({ path, dbId: "deep-chain" });
    try {
      const store = db.declareKvStore("store");
      const beforeVersion = db.getDebugInfo().currentVersion;
      const writeCount = 20_000;

      let latest = db.initialSeq;
      for (let i = 0; i < writeCount; i++) {
        const { seq } = await store.setAll([{ key: buffer(`key-${i}`), value: buffer(`value-${i}`) }], { requiresSeq: latest });
        latest = db.combineSeqs(latest, seq);
      }
      await db.waitUntilAvailable(latest);

      expect(db.getDebugInfo().currentVersion).toBe(beforeVersion + 1);
      expect(text((await store.get(buffer("key-0"))).buffer)).toBe("value-0");
      expect(text((await store.get(buffer(`key-${writeCount - 1}`))).buffer)).toBe(`value-${writeCount - 1}`);
    } finally {
      await db.close();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("holds a batch until a still-pending dependency from an earlier batch, reached through several combined seqs, commits", async () => {
    const path = await tempLmdbPath();
    const db = declareLmdbLowLevelDatabase({ path, dbId: "pending-outside-dependency" });
    // Hold the first LMDB transaction (the batch containing `earlier`) until the test releases it,
    // so `earlier` is still pending, and outside the batch, when the dependent writes are committed.
    const root = db.getDebugInfo().root;
    const originalTransaction = root.transaction.bind(root);
    const firstTransaction = {
      started: (): void => { throw new Error("first transaction started before its promise was created"); },
      release: (): void => { throw new Error("first transaction released before its promise was created"); },
    };
    const firstTransactionStarted = new Promise<void>(resolve => {
      firstTransaction.started = resolve;
    });
    const firstTransactionReleased = new Promise<void>(resolve => {
      firstTransaction.release = resolve;
    });
    let transactionCount = 0;
    root.transaction = async <T>(action: () => T) => {
      if (transactionCount++ === 0) {
        firstTransaction.started();
        await firstTransactionReleased;
      }
      return await originalTransaction(action);
    };
    try {
      const store = db.declareKvStore("store");
      const beforeVersion = db.getDebugInfo().currentVersion;

      const earlier = await store.setAll([{ key: buffer("earlier"), value: buffer("earlier") }]);
      await firstTransactionStarted;

      const sibling = await store.setAll([{ key: buffer("sibling"), value: buffer("sibling") }]);
      const left = db.combineSeqs(earlier.seq, sibling.seq);
      const right = db.combineSeqs(sibling.seq, earlier.seq);
      const first = await store.setAll([{ key: buffer("first"), value: buffer("first") }], { requiresSeq: db.combineSeqs(left, right) });
      const second = await store.setAll([{ key: buffer("second"), value: buffer("second") }], { requiresSeq: left });
      let dependentsAvailable = false;
      const dependentsAvailability = db.waitUntilAvailable(db.combineSeqs(first.seq, second.seq)).then(() => {
        dependentsAvailable = true;
      });

      // Several flush intervals: the dependents' batch must still be waiting on `earlier`.
      await wait(100);
      expect(dependentsAvailable).toBe(false);
      expect(transactionCount).toBe(1);
      expect((await store.get(buffer("first"))).buffer).toBeNull();
      expect((await store.get(buffer("second"))).buffer).toBeNull();

      firstTransaction.release();
      await dependentsAvailability;
      expect(db.getDebugInfo().currentVersion).toBe(beforeVersion + 2);
      expect(text((await store.get(buffer("earlier"))).buffer)).toBe("earlier");
      expect(text((await store.get(buffer("first"))).buffer)).toBe("first");
      expect(text((await store.get(buffer("second"))).buffer)).toBe("second");
    } finally {
      // close() drains pending commits, so a failed assertion above must not leave the first one held.
      firstTransaction.release();
      await db.close();
      await rm(path, { recursive: true, force: true });
    }
  });
});

// lmdb-js's patched LMDB occasionally aborts a commit with this in production; it can't be triggered on
// demand, so these tests make `root.transaction` fail the way lmdb-js does (a rejected commit whose
// unwrapped error carries the native status code).
const mdbBadTxnError = () => Object.assign(new Error("MDB_BAD_TXN: Transaction must abort, has a child, or is invalid: reserved freelist had a data entry with zero-size, last id 1"), { code: -30782 });

function failRootTransactions(db: ReturnType<typeof declareLmdbLowLevelDatabase>, nextFailure: () => Error | null) {
  const root = db.getDebugInfo().root;
  const originalTransaction = root.transaction.bind(root);
  let attempts = 0;
  vi.spyOn(root, "transaction").mockImplementation((...args: unknown[]) => {
    attempts++;
    const failure = nextFailure();
    return failure === null ? originalTransaction(...args) : Promise.reject(failure);
  });
  return { attempts: () => attempts };
}

describe("LMDB low-level database commit failures", () => {
  it("retries a commit that lmdb-js aborted with MDB_BAD_TXN", async () => {
    const path = await tempLmdbPath();
    try {
      const db = declareLmdbLowLevelDatabase({ path, dbId: "retry-bad-txn" });
      const store = db.declareKvStore("store");
      let failuresLeft = 2;
      const transactions = failRootTransactions(db, () => failuresLeft-- > 0 ? mdbBadTxnError() : null);

      const { seq } = await store.setAll([{ key: buffer("key"), value: buffer("value") }]);
      await db.waitUntilDurable(seq);

      expect(transactions.attempts()).toBe(3);
      expect(text((await store.get(buffer("key"))).buffer)).toBe("value");
      await db.close();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("gives up and surfaces the native error when MDB_BAD_TXN keeps happening", async () => {
    const path = await tempLmdbPath();
    try {
      const db = declareLmdbLowLevelDatabase({ path, dbId: "retry-exhausted" });
      const store = db.declareKvStore("store");
      const transactions = failRootTransactions(db, mdbBadTxnError);

      const { seq } = await store.setAll([{ key: buffer("key"), value: buffer("value") }]);
      await expect(db.waitUntilAvailable(seq)).rejects.toMatchObject({ code: -30782 });

      expect(transactions.attempts()).toBe(5);
      expect((await store.get(buffer("key"))).buffer).toBeNull();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("does not retry commit failures other than MDB_BAD_TXN", async () => {
    const path = await tempLmdbPath();
    try {
      const db = declareLmdbLowLevelDatabase({ path, dbId: "no-retry" });
      const store = db.declareKvStore("store");
      const transactions = failRootTransactions(db, () => new Error("some other commit failure"));

      const { seq } = await store.setAll([{ key: buffer("key"), value: buffer("value") }]);
      await expect(db.waitUntilAvailable(seq)).rejects.toThrow("some other commit failure");
      expect(transactions.attempts()).toBe(1);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("keeps rejecting writes that depend on a failed commit without poisoning unrelated work", async () => {
    const path = await tempLmdbPath();
    try {
      const db = declareLmdbLowLevelDatabase({ path, dbId: "failed-commit-isolation" });
      const failedStore = db.declareKvStore("failed");
      const otherStore = db.declareKvStore("other");
      let failNext = true;
      failRootTransactions(db, () => {
        if (!failNext) return null;
        failNext = false;
        return new Error("simulated non-retryable commit failure");
      });

      const failed = await failedStore.setAll([{ key: buffer("a"), value: buffer("lost") }]);
      await expect(db.waitUntilAvailable(failed.seq)).rejects.toThrow("simulated non-retryable commit failure");
      await expect(db.waitUntilDurable(failed.seq)).rejects.toThrow("simulated non-retryable commit failure");

      // A write that requires the failed one must not land as if the failed write had happened...
      const independent = await otherStore.setAll([{ key: buffer("b"), value: buffer("independent") }]);
      const dependent = await failedStore.setAll([{ key: buffer("c"), value: buffer("dependent") }], { requiresSeq: db.combineSeqs(independent.seq, failed.seq) });
      await expect(db.waitUntilAvailable(dependent.seq)).rejects.toThrow("simulated non-retryable commit failure");
      await db.waitUntilAvailable(independent.seq);

      // ...but the old failure must not leak into unrelated compare-and-sets or close().
      const cas = await otherStore.compareAndSetAll([{ key: buffer("d"), compare: null, value: buffer("cas") }]);
      expect(cas.results).toMatchObject([{ wasSet: true }]);
      await db.waitUntilAvailable(cas.seq);

      const debugInfo = db.getDebugInfo();
      expect(debugInfo.seqToAvailability.pending.size).toBe(0);
      expect(debugInfo.combinedSeqToAvailability.pending.size).toBe(0);
      expect(debugInfo.combinedSeqDependencies.size).toBe(0);
      expect(text((await failedStore.get(buffer("a"))).buffer)).toBeNull();
      expect(text((await failedStore.get(buffer("c"))).buffer)).toBeNull();
      expect(text((await otherStore.get(buffer("b"))).buffer)).toBe("independent");
      expect(text((await otherStore.get(buffer("d"))).buffer)).toBe("cas");
      await db.close();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });

  it("waits on very deep chains of pending combined seqs without overflowing the stack", async () => {
    const path = await tempLmdbPath();
    try {
      const db = declareLmdbLowLevelDatabase({ path, dbId: "deep-combined-chain" });
      const store = db.declareKvStore("store");
      // Hold the first commit open so every combined seq below stays pending (and in the dependency graph).
      let releaseFirstCommit: () => void = () => {
        throw new Error("releaseFirstCommit called before the first commit started");
      };
      const firstCommitGate = new Promise<void>(resolve => {
        releaseFirstCommit = resolve;
      });
      const root = db.getDebugInfo().root;
      const originalTransaction = root.transaction.bind(root);
      let isFirstTransaction = true;
      vi.spyOn(root, "transaction").mockImplementation(async (...args: unknown[]) => {
        if (isFirstTransaction) {
          isFirstTransaction = false;
          await firstCommitGate;
        }
        return await originalTransaction(...args);
      });

      const first = await store.setAll([{ key: buffer("first"), value: buffer("1") }]);
      // Every link also points back at `first`, so the graph is both deep and full of shared nodes.
      let chained = db.combineSeqs(first.seq, first.seq);
      for (let i = 0; i < 50_000; i++) chained = db.combineSeqs(chained, first.seq);
      const last = await store.setAll([{ key: buffer("last"), value: buffer("2") }], { requiresSeq: chained });

      releaseFirstCommit();
      await db.waitUntilAvailable(last.seq);
      expect(text((await store.get(buffer("last"))).buffer)).toBe("2");
      await db.close();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });
});

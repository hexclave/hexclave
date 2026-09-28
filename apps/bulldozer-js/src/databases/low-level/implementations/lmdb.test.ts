import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as lmdb from "lmdb";
import { describe, expect, it } from "vitest";
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
});

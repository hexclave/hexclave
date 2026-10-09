import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asHeapObject, isPiledriverHeapObjectSymbol } from "../../index.js";
import { declareBreezyDatabaseWithStorage } from "./core.js";
import { openBreezyLmdbStorage } from "./storage-lmdb.js";
import { openBreezyliteStorage } from "../breezylite/index.js";

for (const [name, open] of [
  ["Breezy", openBreezyLmdbStorage],
  ["Breezylite", openBreezyliteStorage],
] as const) {
  describe(name, () => {
    it("preserves binary ordering, versions and data across reopen", async () => {
      const path = mkdtempSync(join(tmpdir(), "breezy-storage-"));
      let storage = open({ path });
      try {
        const a = storage.openStore("a");
        const key = Buffer.from([0, 255]);
        const writes: Promise<boolean>[] = [];
        const committed = await storage.transaction(version => {
          writes.push(a.put(key, Buffer.from("original"), version), a.put(Buffer.from([255]), Buffer.alloc(0), version));
          return version;
        });
        await Promise.all(writes);
        await storage.flush();
        expect([...a.getRange({ end: Buffer.from([255]), limit: 1 })].map(row => row.key)).toEqual([key]);
        expect([...a.getRange()].map(row => row.key)).toEqual([key, Buffer.from([255])]);
        await storage.close();
        storage = open({ path });
        expect(storage.openStore("a").getEntry(key)).toEqual({ value: Buffer.from("original"), version: committed });
        expect(storage.lastTransactionId()).toBeGreaterThanOrEqual(committed);
      } finally {
        await storage.close();
        rmSync(path, { recursive: true, force: true });
      }
    });

    // lmdb-js transaction() commits callback writes even when the callback throws. Keep
    // this expected failure visible instead of changing the existing Breezy benchmark baseline.
    (name === "Breezy" ? it.fails : it)("rolls back partial writes across stores when the callback throws", async () => {
      const path = mkdtempSync(join(tmpdir(), "breezy-rollback-"));
      const storage = open({ path });
      try {
        const a = storage.openStore("a");
        const b = storage.openStore("b");
        const key = Buffer.from([0, 255]);
        const pending: Promise<boolean>[] = [];
        const version = await storage.transaction(version => {
          pending.push(a.put(key, Buffer.from("original"), version));
          return version;
        });
        await Promise.all(pending);
        await storage.flush();
        await expect(storage.transaction(version => {
          pending.push(a.put(key, Buffer.from("replaced"), version));
          pending.push(b.put(key, Buffer.from("new"), version));
          throw new Error("rollback");
        })).rejects.toThrow("rollback");
        await Promise.all(pending);
        storage.refreshReads();
        expect(a.getEntry(key)).toEqual({ value: Buffer.from("original"), version });
        expect(b.doesExist(key)).toBe(false);
      } finally {
        await storage.close();
        rmSync(path, { recursive: true, force: true });
      }
    });

    it("persists shared heap graphs, serializes concurrent roots and collects unreachable objects", async () => {
      const path = mkdtempSync(join(tmpdir(), "breezy-graph-"));
      let db = declareBreezyDatabaseWithStorage(open({ path }), "test");
      const root = Uint8Array.from([1]).buffer;
      const other = Uint8Array.from([2]).buffer;
      try {
        const child = asHeapObject({ message: "persisted" });
        const writes = await Promise.all([
          db.setRootObject(root, asHeapObject({ first: child, second: child })),
          db.setRootObject(other, child),
        ]);
        await db.waitUntilConsistent(db.combineSeqs(...writes.map(write => write.seq)));
        await db.close();
        db = declareBreezyDatabaseWithStorage(open({ path }), "test");
        const { object } = await db.getRootObject(other);
        if (typeof object !== "object" || object === null || !(isPiledriverHeapObjectSymbol in object)) throw new Error("Expected heap reference");
        expect(await object.get()).toEqual({ message: "persisted" });
        await db.deleteRootObject(root);
        await db.deleteRootObject(other);
        await db.close();
        const cutoff = Date.now() + 1;
        db = declareBreezyDatabaseWithStorage(open({ path }), "test", { garbageCollectionProcessStartedAtMillis: cutoff + 1 });
        const result = await db.collectGarbage(cutoff);
        expect(result.objects.deleted).toBe(2);
        await expect(db.getRootObject(root)).rejects.toThrow("Root object not found");
        expect((await db.debugSnapshot?.())?.heap).toHaveLength(0);
      } finally {
        await db.close();
        rmSync(path, { recursive: true, force: true });
      }
    });
  });
}

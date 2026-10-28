import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { declareBreezyDatabaseWithStorage, FreePageReleaseConflictError } from "../breezy/core.js";
import type { BreezyStorage } from "../breezy/storage.js";
import { openBreezyliteStorage } from "./index.js";

const { DatabaseSync }: typeof import("node:sqlite") = createRequire(import.meta.url)("node:sqlite");

const withStorage = async (prefix: string, test: (storage: BreezyStorage, path: string) => Promise<void>) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const storage = openBreezyliteStorage({ path });
  try {
    await test(storage, path);
  } finally {
    await storage.close();
    rmSync(path, { recursive: true, force: true });
  }
};

const freePagesOf = (storage: BreezyStorage) => storage.freePages ?? throwErr("Breezylite storage must support releasing free pages");

/** Writes `rows` incompressible 4 KB values, then deletes them all, so their pages become free. */
const fillThenDelete = async (storage: BreezyStorage, rows: number) => {
  const store = storage.openStore("filler");
  const keys = Array.from({ length: rows }, (_, i) => Buffer.from(`row-${String(i).padStart(8, "0")}`));
  await Promise.all(await storage.transaction(version => keys.map(key => store.put(key, randomBytes(4000), version))));
  await Promise.all(await storage.transaction(() => keys.map(key => store.remove(key))));
};

it("a new database can release free pages, and releasing them shrinks the file by that many pages", async () => {
  await withStorage("breezylite-free-pages-", async storage => {
    const freePages = freePagesOf(storage);
    expect(freePages.stats().canRelease).toBe(true);
    await fillThenDelete(storage, 5000);

    const before = freePages.stats();
    // 5,000 rows of 4 KB with 4 KB pages: the deleted rows must leave thousands of free pages.
    expect(before.freePages).toBeGreaterThan(4000);

    const released = freePages.release(before.freePages);
    freePages.checkpoint();

    const after = freePages.stats();
    expect(released).toBe(before.freePages);
    expect(after.freePages).toBe(0);
    // At least the free pages go; SQLite also drops the pointer-map pages that only tracked them.
    expect(after.totalPages).toBeLessThanOrEqual(before.totalPages - before.freePages);
    expect(storage.fileSizesInBytes()["breezy.sqlite"]).toBe(after.totalPages * after.pageSizeBytes);
  });
});

it("releases no more pages than asked, and a later call continues from there", async () => {
  await withStorage("breezylite-free-pages-limit-", async storage => {
    const freePages = freePagesOf(storage);
    await fillThenDelete(storage, 2000);
    const before = freePages.stats().freePages;

    expect(freePages.release(100)).toBe(100);
    expect(freePages.stats().freePages).toBe(before - 100);
    expect(freePages.release(100)).toBe(100);
    expect(freePages.stats().freePages).toBe(before - 200);
  });
});

it("releasing with no free pages releases nothing", async () => {
  await withStorage("breezylite-free-pages-none-", async storage => {
    const freePages = freePagesOf(storage);
    expect(freePages.stats().freePages).toBe(0);
    expect(freePages.release(1000)).toBe(0);
  });
});

it("a database created before auto_vacuum still opens and works, but reports that it can't release pages", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-free-pages-old-"));
  // The exact schema Breezylite created before this change, with SQLite's default auto_vacuum=NONE.
  const raw = new DatabaseSync(join(path, "breezy.sqlite"));
  raw.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE store_names (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE entries (
      store INTEGER NOT NULL, key BLOB NOT NULL, value BLOB NOT NULL, version INTEGER NOT NULL,
      codec INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (store, key)
    ) WITHOUT ROWID;
    CREATE TABLE sequence (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO sequence VALUES (1, 0);
    PRAGMA user_version=1;`);
  raw.close();
  const storage = openBreezyliteStorage({ path });
  try {
    const freePages = freePagesOf(storage);
    await fillThenDelete(storage, 500);
    const store = storage.openStore("kept");
    await storage.transaction(version => store.put(Buffer.from("key"), Buffer.from("value"), version));
    expect(store.get(Buffer.from("key"))).toEqual(Buffer.from("value"));

    const stats = freePages.stats();
    expect(stats.canRelease).toBe(false);
    expect(stats.freePages).toBeGreaterThan(0);
    expect(() => freePages.release(10)).toThrow("auto_vacuum");
    expect(freePages.stats().freePages).toBe(stats.freePages);
  } finally {
    await storage.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("keeps the WAL file at or under 64 MiB once a large write has been checkpointed", async () => {
  await withStorage("breezylite-free-pages-wal-", async storage => {
    const store = storage.openStore("big");
    // ~80 MB in one transaction: the WAL must grow past the limit, because it can't be checkpointed mid-transaction.
    await Promise.all(await storage.transaction(version => Array.from({ length: 20_000 }, (_, i) => store.put(Buffer.from(`big-${i}`), randomBytes(4000), version))));
    expect(storage.fileSizesInBytes()["breezy.sqlite-wal"]).toBeGreaterThan(64 * 1024 * 1024);

    freePagesOf(storage).checkpoint();
    // SQLite trims the WAL file when the next write starts over at the beginning of it.
    await storage.transaction(version => store.put(Buffer.from("small"), Buffer.from("x"), version));
    expect(storage.fileSizesInBytes()["breezy.sqlite-wal"]).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});

const mib = 1024 * 1024;
const rootKey = (i: number) => new TextEncoder().encode(`root-${i}`).buffer;

/** A Breezy database over Breezylite with `rowsToFree` 4 KB rows written and then deleted, so their pages are free. */
const withFreedDatabase = async (prefix: string, rowsToFree: number, test: (db: ReturnType<typeof declareBreezyDatabaseWithStorage>, storage: BreezyStorage) => Promise<void>) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const storage = openBreezyliteStorage({ path });
  // The database owns the storage from here: its close() closes the storage too.
  const db = declareBreezyDatabaseWithStorage(storage, "test");
  try {
    await fillThenDelete(storage, rowsToFree);
    await test(db, storage);
  } finally {
    await db.close();
    rmSync(path, { recursive: true, force: true });
  }
};

it("releaseFreePages gives every free page back and reports what it did", async () => {
  await withFreedDatabase("breezylite-release-all-", 3000, async (db, storage) => {
    const before = freePagesOf(storage).stats();
    const result = await db.releaseFreePages({ maxBytes: 1024 * mib, dryRun: false });

    expect(result.stoppedBecause).toBe("no-free-pages");
    expect(result.before.freePages).toBe(before.freePages);
    expect(result.released.pages).toBe(before.freePages);
    expect(result.released.bytes).toBe(before.freePages * before.pageSizeBytes);
    expect(result.after.freePages).toBe(0);
    // The checkpoint at the end is what shortens the main file, so the reported size is already the shrunk one.
    expect(result.after.fileSizesInBytes["breezy.sqlite"]).toBe(result.after.totalPages * before.pageSizeBytes);
    expect(result.after.fileSizesInBytes["breezy.sqlite"]).toBeLessThan(result.before.fileSizesInBytes["breezy.sqlite"] - result.released.bytes / 2);
    expect(result.checkpoint?.busy).toBe(false);
    expect(result.chunks.count).toBeGreaterThan(1);
  });
});

it("releaseFreePages stops at maxBytes, says so, and the next call continues", async () => {
  await withFreedDatabase("breezylite-release-limit-", 3000, async (db, storage) => {
    const { pageSizeBytes, freePages } = freePagesOf(storage).stats();
    const first = await db.releaseFreePages({ maxBytes: 500 * pageSizeBytes, dryRun: false });
    expect(first.stoppedBecause).toBe("limit");
    expect(first.released.pages).toBe(500);
    expect(first.after.freePages).toBe(freePages - 500);

    const second = await db.releaseFreePages({ maxBytes: 1024 * mib, dryRun: false });
    expect(second.stoppedBecause).toBe("no-free-pages");
    expect(second.released.pages).toBe(freePages - 500);
  });
});

it("a dry run reports the free pages and changes nothing", async () => {
  await withFreedDatabase("breezylite-release-dry-", 1000, async (db, storage) => {
    const before = freePagesOf(storage).stats();
    const sizeBefore = storage.fileSizesInBytes()["breezy.sqlite"];
    const result = await db.releaseFreePages({ maxBytes: 1024 * mib, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.before.freePages).toBe(before.freePages);
    expect(result.released.pages).toBe(0);
    expect(freePagesOf(storage).stats().freePages).toBe(before.freePages);
    expect(storage.fileSizesInBytes()["breezy.sqlite"]).toBe(sizeBefore);
  });
});

it("rejects a second release while one is running, and allows one after it finishes", async () => {
  await withFreedDatabase("breezylite-release-concurrent-", 3000, async db => {
    const first = db.releaseFreePages({ maxBytes: 1024 * mib, dryRun: false });
    await expect(db.releaseFreePages({ maxBytes: 1024 * mib, dryRun: false })).rejects.toBeInstanceOf(FreePageReleaseConflictError);
    expect((await first).released.pages).toBeGreaterThan(0);
    expect((await db.releaseFreePages({ maxBytes: 1024 * mib, dryRun: false })).stoppedBecause).toBe("no-free-pages");
  });
});

it("rejects releasing on a file created without auto_vacuum, but a dry run still reports it", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-release-old-"));
  const raw = new DatabaseSync(join(path, "breezy.sqlite"));
  raw.exec("PRAGMA journal_mode=WAL; CREATE TABLE placeholder (x)");
  raw.close();
  // Breezylite creates its tables next to the placeholder; the file stays in auto_vacuum=NONE.
  const storage = openBreezyliteStorage({ path });
  const db = declareBreezyDatabaseWithStorage(storage, "test");
  try {
    await expect(db.releaseFreePages({ maxBytes: mib, dryRun: false })).rejects.toBeInstanceOf(FreePageReleaseConflictError);
    expect((await db.releaseFreePages({ maxBytes: mib, dryRun: true })).before.canRelease).toBe(false);
  } finally {
    await db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("keeps serving writes while it releases: none fail, all read back, and other work runs in between chunks", async () => {
  await withFreedDatabase("breezylite-release-writes-", 6000, async db => {
    let releaseFinished = false;
    let otherWorkRanDuringRelease = false;
    const release = db.releaseFreePages({ maxBytes: 1024 * mib, dryRun: false }).finally(() => {
      releaseFinished = true;
    });
    setImmediate(() => {
      otherWorkRanDuringRelease = !releaseFinished;
    });
    const writes = Array.from({ length: 200 }, async (_, i) => await db.setRootObject(rootKey(i), { index: i, padding: "x".repeat(2000) }));

    const [released, ...written] = await Promise.all([release, ...writes]);
    expect(released.after.freePages).toBe(0);
    expect(written).toHaveLength(200);
    expect(otherWorkRanDuringRelease).toBe(true);
    for (let i = 0; i < 200; i++) {
      expect((await db.getRootObject(rootKey(i))).object).toEqual({ index: i, padding: "x".repeat(2000) });
    }
  });
});

it("close() waits for a release in progress instead of closing the file under it", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-release-close-"));
  const storage = openBreezyliteStorage({ path });
  try {
    await fillThenDelete(storage, 3000);
    const db = declareBreezyDatabaseWithStorage(storage, "test");
    const release = db.releaseFreePages({ maxBytes: 1024 * mib, dryRun: false });
    await db.close();
    expect((await release).stoppedBecause).toBe("no-free-pages");
    await expect(db.releaseFreePages({ maxBytes: mib, dryRun: false })).rejects.toThrow("closed");
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

it("sizes each chunk to a short time budget, even when releasing a page is slow", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-release-slow-"));
  const storage = openBreezyliteStorage({ path });
  const realFreePages = freePagesOf(storage);
  // Stands in for a huge file, where SQLite spends most of each release searching the free list.
  const millisecondsPerPage = 0.5;
  const busyWait = (ms: number) => {
    const until = performance.now() + ms;
    while (performance.now() < until) { /* spin */ }
  };
  const slowStorage: BreezyStorage = {
    ...storage,
    freePages: {
      ...realFreePages,
      release(maxPages) {
        busyWait(maxPages * millisecondsPerPage);
        return realFreePages.release(maxPages);
      },
    },
  };
  const db = declareBreezyDatabaseWithStorage(slowStorage, "test");
  try {
    await fillThenDelete(storage, 1000);
    const result = await db.releaseFreePages({ maxBytes: 300 * 4096, dryRun: false });
    expect(result.released.pages).toBe(300);
    // Asserted on chunk size, not chunk time: wall-clock time also counts whatever else the machine
    // did meanwhile, so it flakes on a busy CI worker. Every page here costs at least 0.5 ms, so after
    // the 16-page probe each chunk fits the 5 ms budget at <= 10 pages. One 300-page chunk (what a
    // fixed page count would do) would block for 150 ms.
    expect(result.chunks.largestPages).toBeLessThanOrEqual(16);
  } finally {
    await db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("releases pages freed while it was yielding, instead of claiming the limit was reached", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-release-concurrent-free-"));
  const storage = openBreezyliteStorage({ path });
  const realFreePages = freePagesOf(storage);
  const churn = storage.openStore("churn");
  const churnWrites: Promise<unknown>[] = [];
  let freedDuringLastYield = false;
  // A write that frees pages, scheduled by the chunk that empties the free list, so it runs during
  // the yield right after the release's last chunk: the moment a stale count would end the loop.
  const churningStorage: BreezyStorage = {
    ...storage,
    freePages: {
      ...realFreePages,
      release(maxPages) {
        const released = realFreePages.release(maxPages);
        if (!freedDuringLastYield && realFreePages.stats().freePages === 0) {
          freedDuringLastYield = true;
          setImmediate(() => {
            const keys = Array.from({ length: 200 }, (_, i) => Buffer.from(`churn-${i}`));
            churnWrites.push(storage.transaction(version => keys.map(key => churn.put(key, randomBytes(4000), version))));
            churnWrites.push(storage.transaction(() => keys.map(key => churn.remove(key))));
          });
        }
        return released;
      },
    },
  };
  const db = declareBreezyDatabaseWithStorage(churningStorage, "test");
  try {
    await fillThenDelete(storage, 2000);
    const result = await db.releaseFreePages({ maxBytes: 1024 * mib, dryRun: false });
    await Promise.all(churnWrites);

    expect(freedDuringLastYield).toBe(true);
    // 1 GiB was never reached, so "limit" would wrongly tell the operator to run it again.
    expect(result.stoppedBecause).toBe("no-free-pages");
    expect(result.after.freePages).toBe(0);
  } finally {
    await db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("says it made no progress, rather than that the limit was reached, when a chunk releases nothing", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-release-no-progress-"));
  const storage = openBreezyliteStorage({ path });
  const realFreePages = freePagesOf(storage);
  const stuckStorage: BreezyStorage = { ...storage, freePages: { ...realFreePages, release: () => 0 } };
  const db = declareBreezyDatabaseWithStorage(stuckStorage, "test");
  try {
    await fillThenDelete(storage, 500);
    const result = await db.releaseFreePages({ maxBytes: 1024 * mib, dryRun: false });
    expect(result.stoppedBecause).toBe("no-progress");
    expect(result.released.pages).toBe(0);
    expect(result.after.freePages).toBeGreaterThan(0);
  } finally {
    await db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("reports free pages in diagnostics", async () => {
  await withFreedDatabase("breezylite-release-diagnostics-", 500, async (db, storage) => {
    expect(db.getDiagnostics().freePages).toEqual(freePagesOf(storage).stats());
  });
});

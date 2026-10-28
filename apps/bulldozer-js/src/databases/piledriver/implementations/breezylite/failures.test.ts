import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { openBreezyliteStorage } from "./index.js";

const { DatabaseSync }: typeof import("node:sqlite") = createRequire(import.meta.url)("node:sqlite");
const SQLITE_FULL = 13;

/**
 * Makes every write transaction that starts from now on run out of space, like a full disk.
 *
 * SQLite's `max_page_count` caps how large one connection may grow the database file, and hitting it
 * raises the same SQLITE_FULL error as a real full disk. The cap is per connection and the engine
 * doesn't expose its connection, so this sets it on whichever connection begins a transaction.
 */
const fillDiskBeforeNextTransaction = () => {
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
    if (sql.startsWith("BEGIN")) {
      const pageCount = this.prepare("PRAGMA page_count").get()?.page_count;
      exec.call(this, `PRAGMA max_page_count=${String(pageCount)}`);
    }
    exec.call(this, sql);
  });
};

it("reports a full disk as SQLITE_FULL and keeps earlier data readable", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-disk-full-"));
  const storage = openBreezyliteStorage({ path });
  try {
    const store = storage.openStore("test");
    await storage.transaction(version => store.put(Buffer.from("before"), Buffer.from("kept"), version));

    fillDiskBeforeNextTransaction();
    // Random bytes, so compression can't shrink the value below the space that is left.
    const incompressibleValue = randomBytes(1024 * 1024);
    await expect(storage.transaction(version => store.put(Buffer.from("too-big"), incompressibleValue, version))).rejects.toMatchObject({ errcode: SQLITE_FULL });

    expect(store.get(Buffer.from("before"))).toEqual(Buffer.from("kept"));
    expect(store.doesExist(Buffer.from("too-big"))).toBe(false);
  } finally {
    vi.restoreAllMocks();
    await storage.close();
    rmSync(path, { recursive: true, force: true });
  }
});

import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { deflateRawSync } from "node:zlib";
import { openBreezyliteStorage } from "./index.js";

const { DatabaseSync }: typeof import("node:sqlite") = createRequire(import.meta.url)("node:sqlite");

it("isolates stores and preserves their IDs across connections and reopen", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-stores-"));
  let db = openBreezyliteStorage({ path });
  const inspect = new DatabaseSync(join(path, "breezy.sqlite"));
  const key = Buffer.from([0, 255]);
  try {
    const first = db.openStore("first");
    const second = db.openStore("second");
    const writes: Promise<boolean>[] = [];
    await db.transaction(version => {
      writes.push(first.put(key, Buffer.alloc(0), version));
      writes.push(second.put(key, Buffer.alloc(4096, 97), version));
    });
    await Promise.all(writes);
    const mappings = inspect.prepare("SELECT * FROM store_names ORDER BY id").all();
    expect(mappings.map(row => row.id)).toEqual([1, 2]);
    expect(first.doesExist(key)).toBe(true);
    expect(second.doesExist(key)).toBe(true);
    const other = openBreezyliteStorage({ path });
    try {
      expect(other.openStore("second").get(key)).toEqual(Buffer.alloc(4096, 97));
      const third = other.openStore("third");
      await other.transaction(version => third.put(key, Buffer.from("third"), version));
      expect(db.openStore("third").get(key)).toEqual(Buffer.from("third"));
    } finally { await other.close(); }
    await db.close();
    db = openBreezyliteStorage({ path });
    expect(db.openStore("first").get(key)).toEqual(Buffer.alloc(0));
    expect(db.openStore("second").get(key)).toEqual(Buffer.alloc(4096, 97));
    expect(inspect.prepare("SELECT * FROM store_names WHERE id <= 2 ORDER BY id").all()).toEqual(mappings);
    await db.transaction(() => db.openStore("first").remove(key));
    expect(db.openStore("first").doesExist(key)).toBe(false);
    expect(db.openStore("second").doesExist(key)).toBe(true);
  } finally {
    inspect.close();
    await db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it.each([false, true])("rejects older text-store PoC files (codec column: %s) without changing them", codec => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-old-format-"));
  const raw = new DatabaseSync(join(path, "breezy.sqlite"));
  try {
    raw.exec(`CREATE TABLE entries (store TEXT NOT NULL, key BLOB NOT NULL, value BLOB NOT NULL, version INTEGER NOT NULL${codec ? ", codec INTEGER NOT NULL DEFAULT 0" : ""}, PRIMARY KEY(store,key)) WITHOUT ROWID`);
    raw.prepare("INSERT INTO entries (store,key,value,version) VALUES (?,?,?,?)").run("test", Buffer.from("key"), Buffer.from("preserved"), 1);
    expect(() => openBreezyliteStorage({ path })).toThrow("use a fresh SQLite directory");
    expect(Buffer.from(raw.prepare("SELECT value FROM entries").get()!.value as Uint8Array)).toEqual(Buffer.from("preserved"));
    expect(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='store_names'").get()).toBeUndefined();
  } finally {
    raw.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("rejects the older DEFLATE format without modifying its data or format version", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-deflate-format-"));
  const db = openBreezyliteStorage({ path });
  await db.close();
  const raw = new DatabaseSync(join(path, "breezy.sqlite"));
  try {
    const compressed = deflateRawSync(Buffer.alloc(4096, 97));
    raw.exec("PRAGMA user_version=0; INSERT INTO store_names VALUES (1, 'test')");
    raw.prepare("INSERT INTO entries VALUES (1, ?, ?, 1, 1)").run(Buffer.from("key"), compressed);
    expect(() => openBreezyliteStorage({ path })).toThrow("use a fresh SQLite directory");
    expect(Buffer.from(raw.prepare("SELECT value FROM entries").get()!.value as Uint8Array)).toEqual(compressed);
    expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
  } finally {
    raw.close();
    rmSync(path, { recursive: true, force: true });
  }
});

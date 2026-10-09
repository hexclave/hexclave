import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { openBreezyliteStorage } from "./index.js";

const { DatabaseSync }: typeof import("node:sqlite") = createRequire(import.meta.url)("node:sqlite");

it("migrates raw databases and reads mixed codecs regardless of the write compression setting", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-compression-"));
  const key = Buffer.from("a");
  const repeated = Buffer.alloc(4096, 97);
  const random = randomBytes(4096);
  const legacy = new DatabaseSync(join(path, "breezy.sqlite"));
  legacy.exec("CREATE TABLE entries (store TEXT NOT NULL, key BLOB NOT NULL, value BLOB NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(store,key)) WITHOUT ROWID");
  legacy.prepare("INSERT INTO entries VALUES (?, ?, ?, ?)").run("test", key, repeated, 1);
  legacy.close();
  let db = openBreezyliteStorage({ path, compression: true });
  try {
    let store = db.openStore("test");
    expect(store.get(key)).toEqual(repeated);
    const writes: Promise<boolean>[] = [];
    await db.transaction(version => {
      writes.push(store.put(Buffer.from("b"), repeated, version));
      writes.push(store.put(Buffer.from("c"), random, version));
      writes.push(store.put(Buffer.from("d"), Buffer.from("tiny"), version));
    });
    await Promise.all(writes);
    const inspect = new DatabaseSync(join(path, "breezy.sqlite"));
    try {
      expect(inspect.prepare("SELECT codec FROM entries ORDER BY key").all().map(row => row.codec)).toEqual([0, 1, 0, 0]);
      expect(Number(inspect.prepare("SELECT length(value) AS size FROM entries WHERE codec=1").get()?.size)).toBeLessThan(repeated.length);
    } finally { inspect.close(); }
    await db.close();
    db = openBreezyliteStorage({ path, compression: false });
    store = db.openStore("test");
    expect([...store.getRange()].map(row => row.value)).toEqual([repeated, repeated, random, Buffer.from("tiny")]);
    expect(store.getEntry(Buffer.from("b"))?.value).toEqual(repeated);
    await db.transaction(version => store.put(Buffer.from("b"), random, version));
    expect(store.get(Buffer.from("b"))).toEqual(random);
    await expect(db.transaction(version => {
      writes.push(store.put(key, random, version));
      throw new Error("abort");
    })).rejects.toThrow("abort");
    await Promise.all(writes);
    expect(store.get(key)).toEqual(repeated);
  } finally {
    await db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("rejects unknown codecs and corrupt compressed bytes", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-corrupt-"));
  const db = openBreezyliteStorage({ path });
  const raw = new DatabaseSync(join(path, "breezy.sqlite"));
  try {
    const store = db.openStore("test");
    const key = Buffer.from("a");
    raw.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?)").run("test", key, Buffer.from([255]), 1, 99);
    expect(() => store.get(key)).toThrow("Unsupported Breezylite value codec");
    raw.exec("UPDATE entries SET codec=1");
    expect(() => store.get(key)).toThrow();
    expect(() => [...store.getRange()]).toThrow();
  } finally {
    raw.close();
    await db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

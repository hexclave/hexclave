import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { zstdDecompressSync } from "node:zlib";
import { openBreezyliteStorage } from "./index.js";

const { DatabaseSync }: typeof import("node:sqlite") = createRequire(import.meta.url)("node:sqlite");

it("reads mixed codecs regardless of the write compression setting", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-compression-"));
  const key = Buffer.from("a");
  const repeated = Buffer.alloc(4096, 97);
  const random = randomBytes(4096);
  let db = openBreezyliteStorage({ path, compression: false });
  try {
    let store = db.openStore("test");
    await db.transaction(version => store.put(key, repeated, version));
    await db.close();
    db = openBreezyliteStorage({ path });
    store = db.openStore("test");
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
      expect(inspect.prepare("SELECT codec FROM entries ORDER BY key").all().map(row => row.codec)).toEqual([0, 2, 0, 0]);
      const compressed = inspect.prepare("SELECT value FROM entries WHERE codec=2").get()?.value as Uint8Array;
      expect(compressed.length).toBeLessThan(repeated.length);
      expect(zstdDecompressSync(compressed)).toEqual(repeated);
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

it("never returns wrong data when one bit of a stored compressed value flips", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-bitflip-"));
  const db = openBreezyliteStorage({ path });
  const raw = new DatabaseSync(join(path, "breezy.sqlite"));
  try {
    const store = db.openStore("test");
    const key = Buffer.from("a");
    // Prod values average ~380 bytes of JSON-like text, which compresses.
    const value = Buffer.from(JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ customerId: `customer-${i}`, quantity: i * 7, product: "pro-plan" }))).slice(0, 380));
    await db.transaction(version => store.put(key, value, version));
    const stored = raw.prepare("SELECT value, codec FROM entries WHERE key = ?").get(key);
    expect(stored?.codec).toBe(2);
    const compressed = Buffer.from(stored?.value as Uint8Array);

    const silentlyWrongBitPositions: number[] = [];
    for (let bit = 0; bit < compressed.length * 8; bit++) {
      const corrupted = Buffer.from(compressed);
      corrupted[bit >> 3] ^= 1 << (bit & 7);
      raw.prepare("UPDATE entries SET value = ? WHERE key = ?").run(corrupted, key);
      let readBack: Buffer | undefined;
      try {
        readBack = store.get(key);
      } catch {
        continue; // Detected: the read failed instead of returning damaged data.
      }
      if (readBack === undefined || !readBack.equals(value)) silentlyWrongBitPositions.push(bit);
    }
    expect(silentlyWrongBitPositions).toEqual([]);
  } finally {
    raw.close();
    await db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("never returns wrong data when a stored compressed value is cut short", async () => {
  const path = mkdtempSync(join(tmpdir(), "breezylite-truncated-"));
  const db = openBreezyliteStorage({ path });
  const raw = new DatabaseSync(join(path, "breezy.sqlite"));
  try {
    const store = db.openStore("test");
    const key = Buffer.from("a");
    // Large enough that Zstd splits it into several blocks, so a cut can land between blocks.
    const value = Buffer.from(Array.from({ length: 20_000 }, (_, i) => `row-${i * 7919 % 10_007};`).join(""));
    await db.transaction(version => store.put(key, value, version));
    const compressed = Buffer.from(raw.prepare("SELECT value FROM entries WHERE key = ?").get(key)?.value as Uint8Array);

    const silentlyWrongLengths: number[] = [];
    for (let length = 0; length < compressed.length; length += Math.ceil(compressed.length / 64)) {
      raw.prepare("UPDATE entries SET value = ? WHERE key = ?").run(compressed.subarray(0, length), key);
      let readBack: Buffer | undefined;
      try {
        readBack = store.get(key);
      } catch {
        continue; // Detected: the read failed instead of returning damaged data.
      }
      if (readBack === undefined || !readBack.equals(value)) silentlyWrongLengths.push(length);
    }
    expect(silentlyWrongLengths).toEqual([]);
  } finally {
    raw.close();
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
    const storeId = raw.prepare("SELECT id FROM store_names WHERE name=?").get("test")?.id;
    raw.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?)").run(storeId!, key, Buffer.from([255]), 1, 99);
    expect(store.doesExist(key)).toBe(true);
    expect(store.doesExist(Buffer.from("missing"))).toBe(false);
    expect(() => store.get(key)).toThrow("Unsupported Breezylite value codec");
    raw.exec("UPDATE entries SET codec=1");
    expect(() => store.get(key)).toThrow("Unsupported Breezylite value codec");
    raw.exec("UPDATE entries SET codec=2");
    expect(() => store.get(key)).toThrow();
    expect(() => [...store.getRange()]).toThrow();
  } finally {
    raw.close();
    await db.close();
    rmSync(path, { recursive: true, force: true });
  }
});

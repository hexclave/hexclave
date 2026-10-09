import { deflateRawSync, inflateRawSync } from "node:zlib";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { declareBreezyDatabaseWithStorage, type BreezyPiledriverDatabaseOptions } from "../breezy/core.js";
import type { BreezyStorage } from "../breezy/storage.js";

// node:sqlite requires its prefix; older Vite versions strip it from static imports.
const { DatabaseSync }: typeof import("node:sqlite") = createRequire(import.meta.url)("node:sqlite");

export function openBreezyliteStorage(options: { path: string, compression?: boolean }): BreezyStorage {
  if (existsSync(join(options.path, "data.mdb")) || existsSync(join(options.path, "lock.mdb"))) {
    throw new Error("SQLite PoC requires a separate directory; the selected path contains an LMDB store");
  }
  mkdirSync(options.path, { recursive: true });
  const db = new DatabaseSync(join(options.path, "breezy.sqlite"));
  // FULL syncs the WAL at each commit, including heap publication before root publication.
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS entries (
      store TEXT NOT NULL, key BLOB NOT NULL, value BLOB NOT NULL, version INTEGER NOT NULL,
      PRIMARY KEY (store, key)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS sequence (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT OR IGNORE INTO sequence VALUES (1, 0);`);
  // A column distinguishes legacy raw values without reserving bytes in their payload.
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("PRAGMA table_info(entries)").all().some(column => column.name === "codec")) {
      db.exec("ALTER TABLE entries ADD COLUMN codec INTEGER NOT NULL DEFAULT 0");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const decode = (value: Uint8Array, codec: unknown) => {
    if (codec === 0) return Buffer.from(value);
    if (codec === 1) return inflateRawSync(value);
    throw new Error(`Unsupported Breezylite value codec: ${String(codec)}`);
  };
  const select = db.prepare("SELECT value, version, codec FROM entries WHERE store = ? AND key = ?");
  const put = db.prepare("INSERT INTO entries (store, key, value, version, codec) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store, key) DO UPDATE SET value=excluded.value, version=excluded.version, codec=excluded.codec");
  const remove = db.prepare("DELETE FROM entries WHERE store = ? AND key = ?");
  const range = db.prepare("SELECT key, value, codec FROM entries WHERE store = ? ORDER BY key LIMIT ?");
  const rangeEnd = db.prepare("SELECT key, value, codec FROM entries WHERE store = ? AND key < ? ORDER BY key LIMIT ?");
  const readSequence = db.prepare("SELECT version FROM sequence WHERE id = 1");
  const incrementSequence = db.prepare("UPDATE sequence SET version = version + 1 WHERE id = 1");
  let writing = false;
  const lastTransactionId = () => {
    const version = readSequence.get()?.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) throw new Error("Invalid SQLite transaction sequence");
    return version;
  };
  const requireWrite = () => {
    if (!writing) throw new Error("SQLite writes require an active transaction");
  };
  return {
    backend: "piledriver-breezylite",
    openStore: store => ({
      get(key) { return this.getEntry(key)?.value; },
      getEntry(key) {
        const row = select.get(store, key);
        if (row === undefined) return undefined;
        if (!(row.value instanceof Uint8Array) || typeof row.version !== "number") throw new Error("Invalid SQLite entry");
        return { value: decode(row.value, row.codec), version: row.version };
      },
      doesExist(key) { return select.get(store, key) !== undefined; },
      put(key, value, version) {
        requireWrite();
        // Skip tiny values and retain raw bytes whenever compression would increase size.
        const compressed = options.compression !== false && value.length >= 256 ? deflateRawSync(value, { level: 1 }) : undefined;
        const useCompressed = compressed !== undefined && compressed.length < value.length;
        put.run(store, key, useCompressed ? compressed : value, version, useCompressed ? 1 : 0);
        return Promise.resolve(true);
      },
      remove(key) {
        requireWrite();
        return Promise.resolve(Number(remove.run(store, key).changes) > 0);
      },
      *getRange(options = {}) {
        const rows = options.end === undefined
          ? range.iterate(store, options.limit ?? -1)
          : rangeEnd.iterate(store, options.end, options.limit ?? -1);
        for (const row of rows) {
          if (!(row.key instanceof Uint8Array) || !(row.value instanceof Uint8Array)) throw new Error("Invalid SQLite range entry");
          yield { key: Buffer.from(row.key), value: decode(row.value, row.codec) };
        }
      },
    }),
    async transaction(action) {
      if (writing) throw new Error("Nested SQLite transactions are unsupported");
      db.exec("BEGIN IMMEDIATE");
      writing = true;
      try {
        incrementSequence.run();
        const result = action(lastTransactionId());
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        writing = false;
      }
    },
    lastTransactionId,
    refreshReads() {}, // Each statement sees the latest committed snapshot.
    async flush() {}, // COMMIT already synchronized the WAL (synchronous=FULL).
    async close() { db.close(); },
  };
}

export function declareBreezylitePiledriverDatabase(
  storageOptions: { path: string, dbId?: string, compression?: boolean },
  options: BreezyPiledriverDatabaseOptions = {},
) {
  return declareBreezyDatabaseWithStorage(openBreezyliteStorage(storageOptions), storageOptions.dbId, options);
}

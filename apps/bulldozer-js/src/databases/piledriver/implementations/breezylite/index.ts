import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { declareBreezyDatabaseWithStorage, type BreezyPiledriverDatabaseOptions } from "../breezy/core.js";
import { existingFileSizesInBytes, type BreezyStorage } from "../breezy/storage.js";

// node:sqlite requires its prefix; older Vite versions strip it from static imports.
const { DatabaseSync }: typeof import("node:sqlite") = createRequire(import.meta.url)("node:sqlite");

/**
 * Returns the decompressed size that a Zstd frame's header declares (RFC 8878, section 3.1.1.1).
 *
 * Node's zstdDecompressSync doesn't fail on a frame that is cut short: it returns whatever it had
 * decoded, often nothing, and skips the checksum if the cut removed it. Comparing the output's length
 * with this size is what catches that. Node always writes the size, so a frame without one is damaged.
 */
function zstdFrameContentSize(frame: Uint8Array) {
  const header = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (header.length < 5) throw new Error("Breezylite Zstd value is truncated or corrupt");
  const descriptor = header[4];
  const isSingleSegment = (descriptor & 0b0010_0000) !== 0;
  const dictionaryIdBytes = [0, 1, 2, 4][descriptor & 0b11];
  const sizeFieldBytes = [isSingleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6];
  // A window descriptor byte follows the frame header descriptor unless the frame is a single segment.
  const sizeFieldOffset = 5 + (isSingleSegment ? 0 : 1) + dictionaryIdBytes;
  if (sizeFieldBytes === 0 || header.length < sizeFieldOffset + sizeFieldBytes) throw new Error("Breezylite Zstd value is truncated or corrupt");
  // The 2-byte form stores the size minus 256; sizes below 256 use the 1-byte form instead.
  if (sizeFieldBytes === 1) return header.readUInt8(sizeFieldOffset);
  if (sizeFieldBytes === 2) return header.readUInt16LE(sizeFieldOffset) + 256;
  if (sizeFieldBytes === 4) return header.readUInt32LE(sizeFieldOffset);
  return Number(header.readBigUInt64LE(sizeFieldOffset));
}

const walSizeLimitBytes = 64 * 1024 * 1024;
const incrementalAutoVacuum = 2;

export function openBreezyliteStorage(options: { path: string, compression?: boolean }): BreezyStorage {
  if (existsSync(join(options.path, "data.mdb")) || existsSync(join(options.path, "lock.mdb"))) {
    throw new Error("SQLite PoC requires a separate directory; the selected path contains an LMDB store");
  }
  mkdirSync(options.path, { recursive: true });
  const db = new DatabaseSync(join(options.path, "breezy.sqlite"));
  try {
    const columns = db.prepare("PRAGMA table_info(entries)").all();
    if (columns.length > 0 && (
      db.prepare("PRAGMA user_version").get()?.user_version !== 1
      || columns.find(column => column.name === "store")?.type !== "INTEGER"
      || !columns.some(column => column.name === "codec")
      || db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_names'").get() === undefined
    )) {
      throw new Error("Unsupported older Breezylite PoC format; use a fresh SQLite directory (no migration is provided)");
    }
    // auto_vacuum=INCREMENTAL lets freePages.release() shrink the file in small steps. SQLite only
    // accepts it before the first table exists, so it must come first; on a file created without it,
    // this does nothing and the file can only be shrunk by a full VACUUM (see freePages below).
    // journal_size_limit: after a large write, SQLite trims the WAL file back to 64 MiB instead of
    // keeping it at its largest size forever.
    // busy_timeout=0: SQLite waits for a lock on the main thread, freezing every request. This engine
    // is the database's only writer, so a held lock belongs to another process; fail instead of waiting.
    db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;
      PRAGMA journal_size_limit=${String(walSizeLimitBytes)};
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS store_names (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS entries (
        store INTEGER NOT NULL, key BLOB NOT NULL, value BLOB NOT NULL, version INTEGER NOT NULL,
        codec INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (store, key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS sequence (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO sequence VALUES (1, 0);
      PRAGMA user_version=1;
      COMMIT;`);
  } catch (error) {
    db.close();
    throw error;
  }
  const decode = (value: Uint8Array, codec: unknown) => {
    if (codec === 0) return Buffer.from(value);
    if (codec === 2) {
      const decompressed = zstdDecompressSync(value);
      if (decompressed.length !== zstdFrameContentSize(value)) throw new Error("Breezylite Zstd value is truncated or corrupt");
      return decompressed;
    }
    throw new Error(`Unsupported Breezylite value codec: ${String(codec)}`);
  };
  const select = db.prepare("SELECT value, version, codec FROM entries WHERE store = ? AND key = ?");
  const exists = db.prepare("SELECT 1 FROM entries WHERE store = ? AND key = ?");
  const findStore = db.prepare("SELECT id FROM store_names WHERE name = ?");
  const createStore = db.prepare("INSERT INTO store_names(name) VALUES (?) ON CONFLICT(name) DO NOTHING");
  const put = db.prepare("INSERT INTO entries (store, key, value, version, codec) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store, key) DO UPDATE SET value=excluded.value, version=excluded.version, codec=excluded.codec");
  const remove = db.prepare("DELETE FROM entries WHERE store = ? AND key = ?");
  const rangeSql = "SELECT key, value, codec FROM entries WHERE store = ? ORDER BY key LIMIT ?";
  const rangeEndSql = "SELECT key, value, codec FROM entries WHERE store = ? AND key < ? ORDER BY key LIMIT ?";
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
  // Each of these reads a field of SQLite's file header, so they cost the same on any file size.
  const pragmaNumberReader = (name: string) => {
    const statement = db.prepare(`PRAGMA ${name}`);
    return () => {
      const value = statement.get()?.[name];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid SQLite PRAGMA ${name}`);
      return value;
    };
  };
  const readPageSize = pragmaNumberReader("page_size");
  const readPageCount = pragmaNumberReader("page_count");
  const readFreePageCount = pragmaNumberReader("freelist_count");
  const readAutoVacuumMode = pragmaNumberReader("auto_vacuum");
  const freePageStats = () => ({
    pageSizeBytes: readPageSize(),
    totalPages: readPageCount(),
    freePages: readFreePageCount(),
    canRelease: readAutoVacuumMode() === incrementalAutoVacuum,
  });
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  return {
    backend: "piledriver-breezylite",
    openStore(name) {
      let row = findStore.get(name);
      if (row === undefined) {
        createStore.run(name);
        row = findStore.get(name);
      }
      const store = row?.id;
      if (typeof store !== "number" || !Number.isSafeInteger(store) || store <= 0) throw new Error("Invalid SQLite store ID");
      return {
        get(key) { return this.getEntry(key)?.value; },
        getEntry(key) {
          const row = select.get(store, key);
          if (row === undefined) return undefined;
          if (!(row.value instanceof Uint8Array) || typeof row.version !== "number") throw new Error("Invalid SQLite entry");
          return { value: decode(row.value, row.codec), version: row.version };
        },
        doesExist(key) { return exists.get(store, key) !== undefined; },
        put(key, value, version) {
          requireWrite();
          // Skip tiny values and retain raw bytes whenever compression would increase size.
          // The checksum (4 bytes) makes decompression fail on a flipped bit; without it, most flips
          // decode to silently wrong data. Each frame records whether it has one, so old values still read.
          const compressed = options.compression !== false && value.length >= 256 ? zstdCompressSync(value, { params: { [constants.ZSTD_c_compressionLevel]: 1, [constants.ZSTD_c_checksumFlag]: 1 } }) : undefined;
          const useCompressed = compressed !== undefined && compressed.length < value.length;
          put.run(store, key, useCompressed ? compressed : value, version, useCompressed ? 2 : 0);
          return Promise.resolve(true);
        },
        remove(key) {
          requireWrite();
          return Promise.resolve(Number(remove.run(store, key).changes) > 0);
        },
        *getRange(options = {}) {
          // A fresh statement per scan: a statement has a single cursor, so scans sharing one would
          // read each other's rows whenever two are open at once.
          const rows = options.end === undefined
            ? db.prepare(rangeSql).iterate(store, options.limit ?? -1)
            : db.prepare(rangeEndSql).iterate(store, options.end, options.limit ?? -1);
          for (const row of rows) {
            if (!(row.key instanceof Uint8Array) || !(row.value instanceof Uint8Array)) throw new Error("Invalid SQLite range entry");
            yield { key: Buffer.from(row.key), value: decode(row.value, row.codec) };
          }
        },
      };
    },
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
        // After some errors (disk full, I/O error, out of memory) SQLite has already rolled back.
        // Rolling back again would fail and replace the real error with "no transaction is active".
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      } finally {
        writing = false;
      }
    },
    lastTransactionId,
    refreshReads() {}, // Each statement sees the latest committed snapshot.
    fileSizesInBytes: () => existingFileSizesInBytes(options.path, ["breezy.sqlite", "breezy.sqlite-wal", "breezy.sqlite-shm"]),
    freePages: {
      stats: freePageStats,
      release(maxPages) {
        // incremental_vacuum(0) means "release every free page" in SQLite, which on a large file
        // would hold the write lock for minutes, so 0 must never reach it.
        if (!Number.isSafeInteger(maxPages) || maxPages <= 0) throw new Error("maxPages must be a positive safe integer");
        if (writing) throw new Error("Free pages can't be released inside a write transaction");
        const before = freePageStats();
        if (!before.canRelease) {
          throw new Error("This SQLite file was created without auto_vacuum=INCREMENTAL, so its free pages can't be released incrementally");
        }
        db.exec(`PRAGMA incremental_vacuum(${String(maxPages)})`);
        return before.freePages - readFreePageCount();
      },
      checkpoint() {
        const row = checkpoint.get();
        const busy = row?.busy;
        const logFrames = row?.log;
        const checkpointedFrames = row?.checkpointed;
        if (typeof busy !== "number" || typeof logFrames !== "number" || typeof checkpointedFrames !== "number") throw new Error("Invalid SQLite checkpoint result");
        return { busy: busy !== 0, logFrames, checkpointedFrames };
      },
    },
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

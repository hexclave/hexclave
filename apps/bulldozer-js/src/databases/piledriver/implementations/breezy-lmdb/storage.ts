import * as lmdb from "lmdb";
import type { BreezyStorage } from "../breezy/storage.js";

export function openBreezyLMDBStorage(options: { path: string, compression?: boolean }): BreezyStorage {
  const root = lmdb.open({ path: options.path, maxDbs: 1024, compression: options.compression === true, separateFlushed: true });
  return {
    backend: "piledriver-breezy-lmdb",
    openStore(name) {
      const db = root.openDB<Buffer, Uint8Array>({ name, encoding: "binary", keyEncoding: "binary", useVersions: true });
      return {
        get: key => db.get(key),
        getEntry(key) {
          const entry = db.getEntry(key);
          if (entry === undefined) return undefined;
          if (entry.version === undefined) throw new Error("Versioned LMDB entry has no transaction ID");
          return { value: entry.value, version: entry.version };
        },
        doesExist: key => db.doesExist(key),
        put: (key, value, version) => db.put(key, value, version),
        remove: key => db.remove(key),
        getRange: options => db.getRange(options),
      };
    },
    transaction: async action => await root.transaction(() => action(root.getWriteTxnId())),
    lastTransactionId() {
      const value: unknown = Reflect.get(root.getStats(), "lastTxnId");
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("LMDB returned an invalid transaction ID");
      return value;
    },
    refreshReads: () => root.resetReadTxn(),
    flush: async () => { await root.flushed; },
    close: async () => { await root.close(); },
  };
}

import type { PiledriverDatabase } from "./databases/piledriver/index.js";

/** SQLite is an opt-in PoC with its own path, never a reinterpretation of an LMDB store. */
export async function createServicePiledriver(
  options: { implementation?: string, sqlitePath?: string, disableHeapReadCache?: boolean },
  createDefault: () => PiledriverDatabase,
): Promise<PiledriverDatabase> {
  if (options.implementation === undefined || options.implementation === "base") return createDefault();
  if (options.implementation !== "breezylite") throw new Error("HEXCLAVE_BULLDOZER_JS_PILEDRIVER_IMPLEMENTATION must be base or breezylite");
  if (options.sqlitePath === undefined || options.sqlitePath.trim().length === 0) {
    throw new Error("SQLite PoC requires HEXCLAVE_BULLDOZER_JS_SQLITE_PATH pointing to a separate database directory");
  }
  // Keep the Node >=22.13 SQLite requirement out of the default backend's startup path.
  const { declareBreezylitePiledriverDatabase } = await import("./databases/piledriver/implementations/breezylite/index.js");
  return declareBreezylitePiledriverDatabase({ path: options.sqlitePath }, { disableHeapReadCache: options.disableHeapReadCache });
}

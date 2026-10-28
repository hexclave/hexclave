import { getLmdbDiagnostics, type LmdbDiagnostics } from "./databases/low-level/implementations/lmdb.js";
import type { BreezyDiagnostics, FreePageReleaseResult } from "./databases/piledriver/implementations/breezy/core.js";
import type { PiledriverDatabase } from "./databases/piledriver/index.js";

/**
 * Settings that only the default backend (base Piledriver over LMDB) reads, each with a test for
 * whether its value changes anything. The repo's .env files set all of them, some to defaults
 * (USE_TMP_LMDB=0, LOW_LEVEL_BACKEND=), so Breezylite reports the effective ones instead of refusing
 * to start: refusing would make it unusable wherever those files load.
 */
const isEffectiveLmdbOnlySettingByName = new Map<string, (value: string) => boolean>([
  ["HEXCLAVE_BULLDOZER_JS_LOW_LEVEL_BACKEND", value => value !== ""],
  ["HEXCLAVE_BULLDOZER_JS_LMDB_PATH", value => value !== ""],
  ["HEXCLAVE_BULLDOZER_JS_USE_TMP_LMDB", value => value === "1"],
  ["HEXCLAVE_BULLDOZER_JS_LMDB_COMPRESSION", value => value === "1"],
]);

/** The storage backend the service runs on, and how to describe it in logs and /diagnostics. */
export type ServicePiledriver = {
  piledriver: PiledriverDatabase,
  /** The settings that apply to this backend, for the startup log. */
  startupSettings: Record<string, string | boolean>,
  /** What GET /diagnostics returns. LMDB has nothing to report until its first 5-second activity window ends. */
  getDiagnostics: () => LmdbDiagnostics | BreezyDiagnostics | { available: false },
  /** Gives free pages back to the OS so the file shrinks. Null when the backend can't do that. */
  releaseFreePages: ((options: { maxBytes: number, dryRun: boolean }) => Promise<FreePageReleaseResult>) | null,
};

/** Picks and opens the service's Piledriver from its environment. SQLite is an opt-in PoC with its own path, never a reinterpretation of an LMDB store. */
export async function createServicePiledriver(
  env: Record<string, string | undefined>,
  createDefault: () => PiledriverDatabase,
): Promise<ServicePiledriver> {
  const implementation = env.HEXCLAVE_BULLDOZER_JS_PILEDRIVER_IMPLEMENTATION ?? "base";
  if (implementation === "base") {
    return {
      piledriver: createDefault(),
      startupSettings: {
        piledriverImplementation: "base",
        // Mirrors createLowLevelDatabase in index.ts: only this exact value selects in-memory.
        lowLevelBackend: env.HEXCLAVE_BULLDOZER_JS_LOW_LEVEL_BACKEND === "in-memory" ? "in-memory" : "lmdb",
        usingTmpLmdb: env.HEXCLAVE_BULLDOZER_JS_USE_TMP_LMDB === "1",
        lmdbCompression: env.HEXCLAVE_BULLDOZER_JS_LMDB_COMPRESSION === "1",
      },
      getDiagnostics: () => getLmdbDiagnostics() ?? { available: false },
      releaseFreePages: null,
    };
  }
  if (implementation !== "breezylite") throw new Error("HEXCLAVE_BULLDOZER_JS_PILEDRIVER_IMPLEMENTATION must be base or breezylite");
  const sqlitePath = env.HEXCLAVE_BULLDOZER_JS_SQLITE_PATH;
  if (sqlitePath === undefined || sqlitePath.trim().length === 0) {
    throw new Error("SQLite PoC requires HEXCLAVE_BULLDOZER_JS_SQLITE_PATH pointing to a separate database directory");
  }
  // Keep the Node >=22.15 SQLite/Zstd requirement out of the default backend's startup path.
  const { declareBreezylitePiledriverDatabase } = await import("./databases/piledriver/implementations/breezylite/index.js");
  const piledriver = declareBreezylitePiledriverDatabase(
    { path: sqlitePath },
    { disableHeapReadCache: env.HEXCLAVE_BULLDOZER_JS_DISABLE_PILEDRIVER_HEAP_READ_CACHE === "1" },
  );
  return {
    piledriver,
    // The service has no setting to turn compression off, so it is always on.
    startupSettings: {
      piledriverImplementation: "breezylite",
      sqlitePath,
      sqliteCompression: true,
      ignoredLmdbSettings: [...isEffectiveLmdbOnlySettingByName]
        .filter(([name, isEffective]) => isEffective(env[name] ?? ""))
        .map(([name]) => name)
        .join(", "),
    },
    getDiagnostics: () => piledriver.getDiagnostics(),
    releaseFreePages: async options => await piledriver.releaseFreePages(options),
  };
}

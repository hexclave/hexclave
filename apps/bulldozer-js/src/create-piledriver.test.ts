import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { expect, it, vi } from "vitest";
import { createServicePiledriver } from "./create-piledriver.js";
import { declareInMemoryPiledriverDatabase } from "./databases/piledriver/implementations/in-memory.js";
import { declareBufferedPiledriverDatabase } from "./databases/piledriver/implementations/buffered.js";

const breezyliteEnv = (path: string) => ({ HEXCLAVE_BULLDOZER_JS_PILEDRIVER_IMPLEMENTATION: "breezylite", HEXCLAVE_BULLDOZER_JS_SQLITE_PATH: path });
const failIfDefaultOpens = () => {
  throw new Error("Default backend should not open");
};

it("preserves the default backend and rejects unknown implementations or missing SQLite paths", async () => {
  const db = declareInMemoryPiledriverDatabase("test");
  const createDefault = vi.fn(() => db);
  expect((await createServicePiledriver({}, createDefault)).piledriver).toBe(db);
  expect((await createServicePiledriver({ HEXCLAVE_BULLDOZER_JS_PILEDRIVER_IMPLEMENTATION: "base" }, createDefault)).piledriver).toBe(db);
  await expect(createServicePiledriver({ HEXCLAVE_BULLDOZER_JS_PILEDRIVER_IMPLEMENTATION: "typo" }, createDefault)).rejects.toThrow("must be base or breezylite");
  await expect(createServicePiledriver({ HEXCLAVE_BULLDOZER_JS_PILEDRIVER_IMPLEMENTATION: "breezylite" }, createDefault)).rejects.toThrow("SQLITE_PATH");
  expect(createDefault).toHaveBeenCalledTimes(2);
  await db.close();
});

it("opens SQLite without the default backend and persists through the service's buffering wrapper", async () => {
  const path = mkdtempSync(join(tmpdir(), "sqlite-service-"));
  const createDefault = vi.fn(failIfDefaultOpens);
  const key = Uint8Array.from([1]).buffer;
  const writer = declareBufferedPiledriverDatabase((await createServicePiledriver(breezyliteEnv(path), createDefault)).piledriver);
  try {
    const written = await writer.setRootObject(key, { value: "persisted".repeat(512) });
    await writer.waitUntilConsistent(written.seq);
  } finally {
    await writer.close();
  }
  const reader = (await createServicePiledriver(breezyliteEnv(path), createDefault)).piledriver;
  try {
    expect((await reader.getRootObject(key)).object).toEqual({ value: "persisted".repeat(512) });
    expect(createDefault).not.toHaveBeenCalled();
  } finally {
    await reader.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("refuses an LMDB directory instead of starting with an empty SQLite database beside it", async () => {
  const path = mkdtempSync(join(tmpdir(), "sqlite-wrong-path-"));
  try {
    writeFileSync(join(path, "data.mdb"), "existing-store");
    await expect(createServicePiledriver(breezyliteEnv(path), failIfDefaultOpens)).rejects.toThrow("contains an LMDB store");
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

it("lists the LMDB-only settings that Breezylite ignores, skipping ones left at their defaults", async () => {
  const path = mkdtempSync(join(tmpdir(), "sqlite-lmdb-settings-"));
  // What the repo's .env.development sets, plus an explicit in-memory request.
  const service = await createServicePiledriver({
    ...breezyliteEnv(path),
    HEXCLAVE_BULLDOZER_JS_LMDB_COMPRESSION: "1",
    HEXCLAVE_BULLDOZER_JS_LMDB_PATH: ".data/bulldozer-js-lmdb",
    HEXCLAVE_BULLDOZER_JS_USE_TMP_LMDB: "0",
    HEXCLAVE_BULLDOZER_JS_LOW_LEVEL_BACKEND: "in-memory",
  }, failIfDefaultOpens);
  try {
    expect(service.startupSettings.ignoredLmdbSettings).toBe("HEXCLAVE_BULLDOZER_JS_LOW_LEVEL_BACKEND, HEXCLAVE_BULLDOZER_JS_LMDB_PATH, HEXCLAVE_BULLDOZER_JS_LMDB_COMPRESSION");
  } finally {
    await service.piledriver.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("describes only the settings that apply to the chosen backend, for the startup log", async () => {
  const db = declareInMemoryPiledriverDatabase("test");
  // An empty LOW_LEVEL_BACKEND (as in the repo's .env) still means LMDB.
  const base = await createServicePiledriver({ HEXCLAVE_BULLDOZER_JS_LMDB_COMPRESSION: "1", HEXCLAVE_BULLDOZER_JS_LOW_LEVEL_BACKEND: "" }, () => db);
  expect(base.startupSettings).toEqual({ piledriverImplementation: "base", lowLevelBackend: "lmdb", usingTmpLmdb: false, lmdbCompression: true });
  await db.close();

  const path = mkdtempSync(join(tmpdir(), "sqlite-startup-settings-"));
  const breezylite = await createServicePiledriver(breezyliteEnv(path), failIfDefaultOpens);
  try {
    expect(breezylite.startupSettings).toEqual({ piledriverImplementation: "breezylite", sqlitePath: path, sqliteCompression: true, ignoredLmdbSettings: "" });
  } finally {
    await breezylite.piledriver.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("offers releasing free pages only on Breezylite", async () => {
  const db = declareInMemoryPiledriverDatabase("test");
  const base = await createServicePiledriver({}, () => db);
  expect(base.releaseFreePages).toBeNull();
  await db.close();

  const path = mkdtempSync(join(tmpdir(), "sqlite-release-free-pages-"));
  const breezylite = await createServicePiledriver(breezyliteEnv(path), failIfDefaultOpens);
  try {
    const release = breezylite.releaseFreePages ?? throwErr("Breezylite must offer releasing free pages");
    const result = await release({ maxBytes: 1024 * 1024, dryRun: true });
    expect(result.before.canRelease).toBe(true);
    const diagnostics = breezylite.getDiagnostics();
    if (!("freePages" in diagnostics)) throw new Error(`Expected Breezy diagnostics, got ${JSON.stringify(diagnostics)}`);
    expect(diagnostics.freePages?.canRelease).toBe(true);
  } finally {
    await breezylite.piledriver.close();
    rmSync(path, { recursive: true, force: true });
  }
});

it("reports Breezylite's write activity and file sizes in diagnostics", async () => {
  const path = mkdtempSync(join(tmpdir(), "sqlite-diagnostics-"));
  const service = await createServicePiledriver(breezyliteEnv(path), failIfDefaultOpens);
  try {
    const written = await service.piledriver.setRootObject(Uint8Array.from([1]).buffer, { value: "x".repeat(1000) });
    await service.piledriver.waitUntilDurable(written.seq);
    const diagnostics = service.getDiagnostics();
    if (!("writeTransactions" in diagnostics)) throw new Error(`Expected Breezy diagnostics, got ${JSON.stringify(diagnostics)}`);
    expect(diagnostics.backend).toBe("piledriver-breezylite");
    // The write above is at least one transaction, and it landed in the write-ahead log.
    expect(diagnostics.writeTransactions.count).toBeGreaterThanOrEqual(1);
    expect(diagnostics.writeTransactions.maxMs).toBeGreaterThanOrEqual(diagnostics.writeTransactions.averageMs);
    expect(diagnostics.fileSizesInBytes["breezy.sqlite-wal"]).toBeGreaterThan(0);
    expect(Object.keys(diagnostics.fileSizesInBytes).sort()).toEqual(["breezy.sqlite", "breezy.sqlite-shm", "breezy.sqlite-wal"]);
  } finally {
    await service.piledriver.close();
    rmSync(path, { recursive: true, force: true });
  }
});

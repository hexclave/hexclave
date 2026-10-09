import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createServicePiledriver } from "./create-piledriver.js";
import { declareInMemoryPiledriverDatabase } from "./databases/piledriver/implementations/in-memory.js";
import { declareBufferedPiledriverDatabase } from "./databases/piledriver/implementations/buffered.js";

it("preserves the default backend and rejects unknown implementations or missing SQLite paths", async () => {
  const db = declareInMemoryPiledriverDatabase("test");
  const createDefault = vi.fn(() => db);
  expect(await createServicePiledriver({}, createDefault)).toBe(db);
  expect(await createServicePiledriver({ implementation: "base" }, createDefault)).toBe(db);
  await expect(createServicePiledriver({ implementation: "typo" }, createDefault)).rejects.toThrow("must be base or breezylite");
  await expect(createServicePiledriver({ implementation: "breezylite" }, createDefault)).rejects.toThrow("SQLITE_PATH");
  expect(createDefault).toHaveBeenCalledTimes(2);
  await db.close();
});

it("opens SQLite without the default backend and persists through the service's buffering wrapper", async () => {
  const path = mkdtempSync(join(tmpdir(), "sqlite-service-"));
  const createDefault = vi.fn(() => {
    throw new Error("Default backend should not open");
  });
  const options = { implementation: "breezylite", sqlitePath: path };
  const key = Uint8Array.from([1]).buffer;
  const writer = declareBufferedPiledriverDatabase(await createServicePiledriver(options, createDefault));
  try {
    const written = await writer.setRootObject(key, { value: "persisted".repeat(512) });
    await writer.waitUntilConsistent(written.seq);
  } finally {
    await writer.close();
  }
  const reader = await createServicePiledriver(options, createDefault);
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
    await expect(createServicePiledriver({ implementation: "breezylite", sqlitePath: path }, () => {
      throw new Error("Default backend should not open");
    })).rejects.toThrow("contains an LMDB store");
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

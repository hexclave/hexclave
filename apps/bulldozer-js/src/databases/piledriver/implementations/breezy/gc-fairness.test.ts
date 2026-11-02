import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asHeapObject } from "../../index.js";
import { declareBreezyLMDBPiledriverDatabase } from "../breezy-lmdb/index.js";
import { declareBreezylitePiledriverDatabase } from "../breezylite/index.js";

for (const [name, declare] of [
  ["BreezyLMDB", declareBreezyLMDBPiledriverDatabase],
  ["Breezylite", declareBreezylitePiledriverDatabase],
] as const) {
  describe(name, () => {
    it("lets other requests run while garbage collection works through many batches", async () => {
      const path = mkdtempSync(join(tmpdir(), "breezy-gc-fairness-"));
      let db = declare({ path, dbId: "test" });
      try {
        // 40 roots with 10 heap objects each: 400+ garbage objects once deleted, several GC batches.
        const keys = Array.from({ length: 40 }, (_, i) => new TextEncoder().encode(`root-${i}`).buffer);
        for (const key of keys) {
          await db.setRootObject(key, asHeapObject(Array.from({ length: 10 }, (_, j) => asHeapObject({ j, payload: "x".repeat(50) }))));
        }
        for (const key of keys) await db.deleteRootObject(key);
        await db.close();
        const cutoff = Date.now() + 1;
        db = declare({ path, dbId: "test" }, { garbageCollectionProcessStartedAtMillis: cutoff + 1 });

        // Stands in for an HTTP request that arrives while GC runs: it can only be served if GC yields.
        let requestServedBeforeGcFinished = false;
        let gcFinished = false;
        setImmediate(() => {
          requestServedBeforeGcFinished = !gcFinished;
        });
        const result = await db.collectGarbage(cutoff);
        gcFinished = true;

        expect(result.objects.deleted).toBeGreaterThan(64 * 3);
        expect(requestServedBeforeGcFinished).toBe(true);
      } finally {
        await db.close();
        rmSync(path, { recursive: true, force: true });
      }
    });
  });
}

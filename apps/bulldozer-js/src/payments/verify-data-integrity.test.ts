import { describe, expect, it } from "vitest";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { declareBulldozerDatabase } from "../databases/bulldozer/index.js";
import { declareInMemoryLowLevelDatabase } from "../databases/low-level/implementations/in-memory.js";
import { declarePiledriverDatabase } from "../databases/piledriver/index.js";
import { handleVerifyDataIntegrityRequest, verifyDataIntegrity } from "./verify-data-integrity.js";

const rootKey = new TextEncoder().encode("bulldozer-database-root").buffer;

async function createDatabase() {
  const db = declareBulldozerDatabase(
    declarePiledriverDatabase(declareInMemoryLowLevelDatabase(crypto.randomUUID())),
    { migrations: [] },
  );
  await db.applyRemainingMigrations();
  return db;
}

async function runToCompletion(db: Awaited<ReturnType<typeof createDatabase>>, stepCount: number) {
  let continuation: string | undefined;
  const errors: string[] = [];
  let calls = 0;
  while (true) {
    if (++calls > 10_000) throw new Error("verification did not terminate");
    const response = await verifyDataIntegrity(db, {
      ...(continuation === undefined ? {} : { continue: continuation }),
      step_count: stepCount,
    });
    errors.push(...response.errors.map(error => error.code));
    if (response.done) return errors;
    if (response.next_cursor === null) throw new Error("verification stopped without a cursor");
    continuation = response.next_cursor;
  }
}

describe("Piledriver data-integrity verification", () => {
  it("maps malformed requests and cursors to bad requests", async () => {
    const expectBadRequest = async (body: unknown) => {
      try {
        await handleVerifyDataIntegrityRequest(body, async () => {
          throw new Error("verification should not run");
        });
        throw new Error("expected a bad request");
      } catch (error) {
        expect(StatusError.isStatusError(error)).toBe(true);
        if (!StatusError.isStatusError(error)) throw error;
        expect(error.statusCode).toBe(400);
      }
    };
    await expectBadRequest({ continue: "not-a-cursor" });
    await expectBadRequest({ step_count: 0 });
    await expectBadRequest({ continue: Buffer.from(JSON.stringify({ version: 999 }), "utf8").toString("base64url") });
  });

  it("returns the same findings when heap scanning is resumed with small budgets", async () => {
    const db = await createDatabase();
    const unpaged = await runToCompletion(db, 1_000);
    const paged = await runToCompletion(db, 1);
    expect(paged).toEqual(unpaged);
  });

  it("rejects a continuation created by another process", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const piledriver = declarePiledriverDatabase(lowLevel);
    const db = declareBulldozerDatabase(piledriver, { migrations: [] });
    await db.applyRemainingMigrations();
    const [heapKey] = (await lowLevel.declareKvDump("heap").insertAll([
      new TextEncoder().encode(JSON.stringify(["array", [[]]])).buffer,
    ])).keys;
    const heapKeyBase64 = Buffer.from(heapKey).toString("base64");
    await lowLevel.declareKvStore("root").setAll([{
      key: rootKey,
      value: new TextEncoder().encode(JSON.stringify(["array", [["heap-reference", heapKeyBase64]]])).buffer,
    }]);
    const first = await verifyDataIntegrity(db, { step_count: 1 });
    if (first.next_cursor === null) throw new Error("expected a continuation");
    const cursor = first.next_cursor;
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { processStartedAtMillis: number };
    parsed.processStartedAtMillis++;
    const foreignCursor = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
    try {
      await verifyDataIntegrity(db, { continue: foreignCursor, step_count: 1 });
      throw new Error("expected a bad request");
    } catch (error) {
      expect(StatusError.isStatusError(error)).toBe(true);
      if (!StatusError.isStatusError(error)) throw error;
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe("This verification was started by another Bulldozer process. Restart verification.");
    }
  });

  it("reports a dangling reference from the pinned root", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const piledriver = declarePiledriverDatabase(lowLevel);
    const db = declareBulldozerDatabase(piledriver, { migrations: [] });
    await db.applyRemainingMigrations();
    await lowLevel.declareKvStore("root").setAll([{
      key: rootKey,
      value: new TextEncoder().encode(JSON.stringify(["array", [["heap-reference", "bWlzc2luZw=="]]])).buffer,
    }]);
    const result = await verifyDataIntegrity(db, { step_count: 1_000 });
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "dangling_heap_reference", phase: "root" }));
  });

  it("reports malformed heap entries as findings", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const piledriver = declarePiledriverDatabase(lowLevel);
    const db = declareBulldozerDatabase(piledriver, { migrations: [] });
    await db.applyRemainingMigrations();
    await lowLevel.declareKvDump("heap").insertAll([new Uint8Array([0xff]).buffer]);
    const result = await verifyDataIntegrity(db, { step_count: 1_000 });
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "invalid_heap_entry", phase: "heap-scan" }));
  });

  it("reports malformed pinned root bytes as a finding", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const piledriver = declarePiledriverDatabase(lowLevel);
    const db = declareBulldozerDatabase(piledriver, { migrations: [] });
    await db.applyRemainingMigrations();
    await lowLevel.declareKvStore("root").setAll([{
      key: rootKey,
      value: new Uint8Array([0xff]).buffer,
    }]);
    const result = await verifyDataIntegrity(db, { step_count: 1_000 });
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "invalid_root", phase: "root" }));
  });
});

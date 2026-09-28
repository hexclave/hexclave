import { describe, expect, it } from "vitest";
import { asHeapObject } from "../index.js";
import { declareInMemoryPiledriverDatabase } from "./in-memory.js";

const key = (value: string) => new TextEncoder().encode(value).buffer;

describe("in-memory Piledriver", () => {
  it("sets, gets, and deletes roots", async () => {
    const db = declareInMemoryPiledriverDatabase(crypto.randomUUID());
    const rootKey = key("root");
    await db.setRootObject(rootKey, { value: 1 });
    await expect(db.getRootObject(rootKey)).resolves.toMatchObject({ object: { value: 1 } });
    await db.deleteRootObject(rootKey);
    await expect(db.getRootObject(rootKey)).rejects.toThrow("Root object not found");
  });

  it("round trips the same heap object and resolves its payload", async () => {
    const db = declareInMemoryPiledriverDatabase(crypto.randomUUID());
    const heapObject = asHeapObject({ value: 1 });
    const rootKey = key("heap");
    await db.setRootObject(rootKey, heapObject);
    const result = await db.getRootObject(rootKey);
    expect(result.object).toBe(heapObject);
    await expect(heapObject.get()).resolves.toEqual({ value: 1 });
  });

  it("shares roots by db id and isolates different ids", async () => {
    const rootKey = key("shared");
    const sharedDbId = crypto.randomUUID();
    const isolatedDbId = crypto.randomUUID();
    const first = declareInMemoryPiledriverDatabase(sharedDbId);
    const second = declareInMemoryPiledriverDatabase(sharedDbId);
    const isolated = declareInMemoryPiledriverDatabase(isolatedDbId);
    await first.setRootObject(rootKey, "value");
    await expect(second.getRootObject(rootKey)).resolves.toMatchObject({ object: "value" });
    await expect(isolated.getRootObject(rootKey)).rejects.toThrow("Root object not found");
  });

  it("reports no garbage collection work", async () => {
    const db = declareInMemoryPiledriverDatabase(crypto.randomUUID());
    const result = await db.collectGarbage(0, 10);
    expect(result.objects.deleted).toBe(0);
    expect(result.limits.limitReached).toBe(false);
    expect(result.reclaimed.knownLogicalBytes).toBe(0);
  });
});

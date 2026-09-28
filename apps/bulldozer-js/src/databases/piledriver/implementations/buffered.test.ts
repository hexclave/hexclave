import { describe, expect, it } from "vitest";
import { declareInMemoryPiledriverDatabase } from "./in-memory.js";
import { declareBufferedPiledriverDatabase } from "./buffered.js";
import type { PiledriverDatabase } from "../index.js";

const key = (value: string) => new TextEncoder().encode(value).buffer;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

function countingDatabase() {
  const wrapped = declareInMemoryPiledriverDatabase(crypto.randomUUID());
  let writes = 0;
  const counted: PiledriverDatabase = {
    ...wrapped,
    async setRootObject(rootKey, value) {
      writes++;
      return await wrapped.setRootObject(rootKey, value);
    },
    async deleteRootObject(rootKey) {
      writes++;
      return await wrapped.deleteRootObject(rootKey);
    },
  };
  return { wrapped, counted, getWrites: () => writes };
}

describe("BufferedPiledriverDatabase", () => {
  it("reads pending writes immediately", async () => {
    const { counted } = countingDatabase();
    const db = declareBufferedPiledriverDatabase(counted);
    const rootKey = key("read-your-writes");

    await db.setRootObject(rootKey, "value");

    await expect(db.getRootObject(rootKey)).resolves.toMatchObject({ object: "value" });
  });

  it("coalesces writes to one key while an underlying write is in flight", async () => {
    const gate = deferred<void>();
    const wrapped = declareInMemoryPiledriverDatabase(crypto.randomUUID());
    let writes = 0;
    const delayed: PiledriverDatabase = {
      ...wrapped,
      async setRootObject(rootKey, value) {
        writes++;
        if (writes === 1) await gate.promise;
        return await wrapped.setRootObject(rootKey, value);
      },
    };
    const db = declareBufferedPiledriverDatabase(delayed);
    const rootKey = key("coalesce");

    await db.setRootObject(rootKey, "first");
    await Promise.resolve();
    await db.setRootObject(rootKey, "second");
    const third = await db.setRootObject(rootKey, "third");
    gate.resolve();
    await db.waitUntilDurable(third.seq);

    expect(writes).toBe(2);
    await expect(wrapped.getRootObject(rootKey)).resolves.toMatchObject({ object: "third" });
  });

  it("reads pending deletions as missing roots", async () => {
    const { counted } = countingDatabase();
    const rootKey = key("delete");
    await counted.setRootObject(rootKey, "value");
    const db = declareBufferedPiledriverDatabase(counted);

    const { seq } = await db.deleteRootObject(rootKey);

    await expect(db.getRootObject(rootKey)).rejects.toThrow("Root object not found");
    await db.waitUntilDurable(seq);
    await expect(counted.getRootObject(rootKey)).rejects.toThrow("Root object not found");
  });

  it("keeps all in-flight writes visible while the flush is blocked", async () => {
    const gate = deferred<void>();
    const wrapped = declareInMemoryPiledriverDatabase(crypto.randomUUID());
    const delayed: PiledriverDatabase = {
      ...wrapped,
      async setRootObject(rootKey, value) {
        if (value === "first") await gate.promise;
        return await wrapped.setRootObject(rootKey, value);
      },
    };
    const db = declareBufferedPiledriverDatabase(delayed);
    const firstKey = key("in-flight-first");
    const secondKey = key("in-flight-second");

    const first = db.setRootObject(firstKey, "first");
    const second = db.setRootObject(secondKey, "second");
    await Promise.resolve();

    await expect(db.getRootObject(firstKey)).resolves.toMatchObject({ object: "first" });
    await expect(db.getRootObject(secondKey)).resolves.toMatchObject({ object: "second" });
    gate.resolve();
    await db.waitUntilDurable((await first).seq);
    await db.waitUntilDurable((await second).seq);
  });

  it("never has more than one underlying write in flight", async () => {
    const wrapped = declareInMemoryPiledriverDatabase(crypto.randomUUID());
    let inFlight = 0;
    let maxInFlight = 0;
    const observed: PiledriverDatabase = {
      ...wrapped,
      async setRootObject(rootKey, value) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await Promise.resolve();
          return await wrapped.setRootObject(rootKey, value);
        } finally {
          inFlight--;
        }
      },
    };
    const db = declareBufferedPiledriverDatabase(observed);
    const values = ["one", "two", "three"];
    const writes = await Promise.all(values.map(async value => await db.setRootObject(key(value), value)));
    await Promise.all(writes.map(async ({ seq }) => await db.waitUntilDurable(seq)));

    expect(maxInFlight).toBe(1);
    for (const value of values) await expect(wrapped.getRootObject(key(value))).resolves.toMatchObject({ object: value });
  });

  it("waits for every member of a combined sequence", async () => {
    const gate = deferred<void>();
    const wrapped = declareInMemoryPiledriverDatabase(crypto.randomUUID());
    let writes = 0;
    const delayed: PiledriverDatabase = {
      ...wrapped,
      async setRootObject(rootKey, value) {
        writes++;
        if (writes === 1) await gate.promise;
        return await wrapped.setRootObject(rootKey, value);
      },
    };
    const db = declareBufferedPiledriverDatabase(delayed);
    const firstKey = key("combined-first");
    const secondKey = key("combined-second");
    const first = await db.setRootObject(firstKey, "first");
    await Promise.resolve();
    const second = await db.setRootObject(secondKey, "second");
    const combined = db.combineSeqs(second.seq, first.seq);
    gate.resolve();

    await db.waitUntilDurable(combined);

    await expect(wrapped.getRootObject(firstKey)).resolves.toMatchObject({ object: "first" });
    await expect(wrapped.getRootObject(secondKey)).resolves.toMatchObject({ object: "second" });
  });

  it("rejects combined sequences from another buffered database synchronously", async () => {
    const wrapped = declareInMemoryPiledriverDatabase(crypto.randomUUID());
    const first = declareBufferedPiledriverDatabase(wrapped);
    const second = declareBufferedPiledriverDatabase(wrapped);
    const { seq } = await first.setRootObject(key("foreign"), "value");

    expect(() => second.combineSeqs(seq)).toThrow("does not belong to this database");
  });

  it("waits for a single-member combined sequence", async () => {
    const { wrapped, counted } = countingDatabase();
    const db = declareBufferedPiledriverDatabase(counted);
    const { seq } = await db.setRootObject(key("single-combined"), "value");

    await db.waitUntilDurable(db.combineSeqs(seq));

    await expect(wrapped.getRootObject(key("single-combined"))).resolves.toMatchObject({ object: "value" });
  });

  it("rejects a failed entry without blocking later entries", async () => {
    const wrapped = declareInMemoryPiledriverDatabase(crypto.randomUUID());
    let attempts = 0;
    const failing: PiledriverDatabase = {
      ...wrapped,
      async setRootObject(rootKey, value) {
        attempts++;
        if (value === "failure") throw new Error("write failed");
        return await wrapped.setRootObject(rootKey, value);
      },
    };
    const db = declareBufferedPiledriverDatabase(failing);
    const failed = await db.setRootObject(key("failure"), "failure");
    const succeeded = await db.setRootObject(key("success"), "success");

    await expect(db.waitUntilDurable(failed.seq)).rejects.toThrow("write failed");
    await expect(db.waitUntilDurable(succeeded.seq)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    await expect(db.getRootObject(key("failure"))).resolves.toMatchObject({ object: "failure" });
  });

  it("wraps sequences returned by fallthrough reads", async () => {
    const wrapped = declareInMemoryPiledriverDatabase(crypto.randomUUID());
    const rootKey = key("fallthrough");
    const { seq: wrappedSeq } = await wrapped.setRootObject(rootKey, "value");
    const durableSeqs: PiledriverDatabase["initialSeq"][] = [];
    const observed: PiledriverDatabase = {
      ...wrapped,
      async waitUntilDurable(seq) {
        durableSeqs.push(seq);
        await wrapped.waitUntilDurable(seq);
      },
    };
    const db = declareBufferedPiledriverDatabase(observed);

    const { seq } = await db.getRootObject(rootKey);
    await db.waitUntilDurable(seq);
    await db.waitUntilDurable(db.combineSeqs(seq));
    expect(durableSeqs).toEqual([wrappedSeq, wrappedSeq]);
  });

  it("waits for the drain before durable completion", async () => {
    const { wrapped, counted } = countingDatabase();
    const db = declareBufferedPiledriverDatabase(counted);
    const rootKey = key("durable");

    const { seq } = await db.setRootObject(rootKey, "value");
    await db.waitUntilDurable(seq);

    await expect(wrapped.getRootObject(rootKey)).resolves.toMatchObject({ object: "value" });
  });

  it("flushes on close", async () => {
    const { wrapped, counted } = countingDatabase();
    const db = declareBufferedPiledriverDatabase(counted);
    const rootKey = key("close");

    await db.setRootObject(rootKey, "value");
    await db.close();

    await expect(wrapped.getRootObject(rootKey)).resolves.toMatchObject({ object: "value" });
    await db.close();
  });
});

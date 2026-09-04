import { describe, expect, it } from "vitest";
import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { LowLevelDatabase } from "../low-level/index.js";
import { declareInMemoryLowLevelDatabase } from "../low-level/implementations/in-memory.js";
import { asHeapObject, isPiledriverHeapObjectSymbol, PiledriverHeapObject, PiledriverObject, piledriverObjectEquals } from "./index.js";
import { declareBasePiledriverDatabase } from "./implementations/base.js";
import { declarePiledriverGarbageCollector } from "./gc.js";

function wrapWithHeapGetCounter(lowLevel: LowLevelDatabase, onHeapGet: () => void): LowLevelDatabase {
  return {
    ...lowLevel,
    declareKvDump(id) {
      const dump = lowLevel.declareKvDump(id);
      if (id !== "heap") return dump;
      return {
        ...dump,
        async get(key) {
          onHeapGet();
          return await dump.get(key);
        },
      };
    },
  };
}

function wrapWithHeapListCounter(lowLevel: LowLevelDatabase, onHeapList: () => void): LowLevelDatabase {
  return {
    ...lowLevel,
    declareKvDump(id) {
      const dump = lowLevel.declareKvDump(id);
      if (id !== "heap") return dump;
      return {
        ...dump,
        async listEntries(options) {
          onHeapList();
          return await dump.listEntries(options);
        },
      };
    },
  };
}

function wrapWithGcReferenceCounter(
  lowLevel: LowLevelDatabase,
  onMetadataGet: () => void,
  onMetadataCompareAndSet: (entryCount: number) => void,
  onMetadataSetAll: (entryCount: number) => void = () => {},
  onCandidateSetAll: (entryCount: number) => void = () => {},
): LowLevelDatabase {
  return {
    ...lowLevel,
    declareKvStore(id) {
      const store = lowLevel.declareKvStore(id);
      if (id !== "piledriver-gc-reference-metadata-v3" && id !== "piledriver-gc-zero-reference-candidates-v3") return store;
      return {
        ...store,
        async get(key) {
          if (id === "piledriver-gc-reference-metadata-v3") onMetadataGet();
          return await store.get(key);
        },
        async compareAndSetAll(entries, options) {
          if (id === "piledriver-gc-reference-metadata-v3") onMetadataCompareAndSet(entries.length);
          return await store.compareAndSetAll(entries, options);
        },
        async setAll(entries, options) {
          if (id === "piledriver-gc-reference-metadata-v3") onMetadataSetAll(entries.length);
          else onCandidateSetAll(entries.length);
          return await store.setAll(entries, options);
        },
      };
    },
  };
}

function failNextMetadataWrite(lowLevel: LowLevelDatabase): LowLevelDatabase {
  let shouldFail = true;
  const failIfRequested = () => {
    if (!shouldFail) return;
    shouldFail = false;
    throw new Error("injected metadata write failure");
  };
  return {
    ...lowLevel,
    declareKvStore(id) {
      const store = lowLevel.declareKvStore(id);
      if (id !== "piledriver-gc-reference-metadata-v3") return store;
      return {
        ...store,
        async setAll(entries, options) {
          failIfRequested();
          return await store.setAll(entries, options);
        },
        async compareAndSetAll(entries, options) {
          failIfRequested();
          return await store.compareAndSetAll(entries, options);
        },
      };
    },
  };
}

function failAvailabilityAfterRootWrite(lowLevel: LowLevelDatabase): LowLevelDatabase {
  let shouldFail = false;
  let hasFailed = false;
  return {
    ...lowLevel,
    async waitUntilAvailable(seq) {
      if (shouldFail) {
        shouldFail = false;
        hasFailed = true;
        throw new Error("injected root availability failure");
      }
      await lowLevel.waitUntilAvailable(seq);
    },
    declareKvStore(id) {
      const store = lowLevel.declareKvStore(id);
      if (id !== "root") return store;
      return {
        ...store,
        async setAll(entries, options) {
          const result = await store.setAll(entries, options);
          shouldFail = !hasFailed;
          return result;
        },
      };
    },
  };
}

async function timestampAfter(value: number) {
  while (Date.now() <= value) await new Promise(resolve => setTimeout(resolve, 1));
  return Date.now();
}

const databaseImplementations: { name: string, declareDatabase: typeof declareBasePiledriverDatabase }[] = [
  { name: "base", declareDatabase: declareBasePiledriverDatabase },
];

describe.each(databaseImplementations)("PiledriverDatabase ($name)", ({ name, declareDatabase: declareBasePiledriverDatabase }) => {
  const declareAfterRestart = (lowLevel: LowLevelDatabase, cutoffTimestampMillis: number) => declareBasePiledriverDatabase(lowLevel, {
    garbageCollectionProcessStartedAtMillis: cutoffTimestampMillis + 1,
  });

  it("round-trips an own __proto__ property", async () => {
    const key = new TextEncoder().encode("proto").buffer;
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const writer = declareBasePiledriverDatabase(lowLevel);
    const value: PiledriverObject = JSON.parse('{"__proto__":{"marker":"value"}}');

    await writer.setRootObject(key, value);

    const reader = declareBasePiledriverDatabase(lowLevel);
    const { object } = await reader.getRootObject(key);
    if (object === null || typeof object !== "object") throw new Error("Expected object root");
    expect(Object.hasOwn(object, "__proto__")).toBe(true);
    expect(object).toEqual(value);
  });

  it("deserializes heap references lazily", async () => {
    const key = new TextEncoder().encode("root").buffer;
    let heapGets = 0;
    const lowLevel = wrapWithHeapGetCounter(declareInMemoryLowLevelDatabase(crypto.randomUUID()), () => heapGets++);

    await declareBasePiledriverDatabase(lowLevel).setRootObject(key, {
      child: asHeapObject({ nested: "value" }),
    });

    const reader = declareBasePiledriverDatabase(lowLevel);
    const { object } = await reader.getRootObject(key);
    expect(heapGets).toBe(0);

    await reader.setRootObject(new TextEncoder().encode("copy").buffer, object);
    expect(heapGets).toBe(0);

    if (typeof object !== "object" || object === null || Array.isArray(object) || !("child" in object)) {
      throw new Error("Expected root object with child heap reference");
    }
    const { child } = object;
    if (typeof child !== "object" || child === null || Array.isArray(child) || !(isPiledriverHeapObjectSymbol in child)) {
      throw new Error("Expected child to be a heap object");
    }
    expect(await child.get()).toEqual({ nested: "value" });
    expect(heapGets).toBe(1);
  });

  it("collects a recursively dereferenced DAG after a restart barrier", async () => {
    let durabilityWaits = 0;
    const underlyingLowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const lowLevel: LowLevelDatabase = {
      ...underlyingLowLevel,
      async waitUntilDurable(seq) {
        durabilityWaits++;
        await underlyingLowLevel.waitUntilDurable(seq);
      },
    };
    const writer = declareBasePiledriverDatabase(lowLevel);
    const rootKey = new TextEncoder().encode("root").buffer;
    const child = asHeapObject({ value: "child" });
    const parent = asHeapObject({ child });
    await writer.setRootObject(rootKey, { parent });
    await writer.setRootObject(rootKey, { replacement: true });

    const cutoff = await timestampAfter(Date.now());
    await timestampAfter(cutoff);
    const restarted = declareAfterRestart(lowLevel, cutoff);
    durabilityWaits = 0;
    const result = await restarted.collectGarbage(cutoff);
    expect(result).toMatchObject({
      limits: {
        maxObjects: 1000,
        limitReached: false,
      },
      objects: {
        deleted: 2,
        candidatesExamined: 2,
        candidatesSkipped: 0,
        metadataEntriesExaminedForRepair: 0,
        childObjectsBecameUnreferenced: 1,
        maxCascadeDepth: 1,
      },
      references: {
        outgoingEdgesProcessed: 1,
        legacyImmortalEdgesIgnored: 0,
        referenceCountCompareAndSetAttempts: 1,
        referenceCountCompareAndSetConflicts: 0,
      },
      recovery: {
        deletionClaimConflicts: 0,
        deletionProgressCompareAndSetConflicts: 0,
      },
      reclaimed: {
        physicalFileBytesReduced: null,
      },
    });
    expect(result.reclaimed.heapPayloadBytes).toBeGreaterThan(0);
    expect(result.reclaimed.knownLogicalBytes).toBeGreaterThanOrEqual(result.reclaimed.heapPayloadBytes);
    expect(result.reclaimed.physicalStorageNote).toContain("do not normally shrink");
    // One wait validates the persisted generation during initialization; the other is the
    // collection-wide mutation barrier.
    expect(durabilityWaits).toBe(2);
    expect((await (restarted.debugSnapshot ?? throwErr("Expected restarted Piledriver database to expose debugSnapshot"))()).heap).toHaveLength(0);
  });

  it("keeps descendants that still have another incoming reference", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const writer = declareBasePiledriverDatabase(lowLevel);
    const rootKey = new TextEncoder().encode("root").buffer;
    const child = asHeapObject({ value: "shared" });
    const discardedParent = asHeapObject({ child, parent: "discarded" });
    const retainedParent = asHeapObject({ child, parent: "retained" });
    await writer.setRootObject(rootKey, { discardedParent, retainedParent });
    await writer.setRootObject(rootKey, { retainedParent });

    const cutoff = await timestampAfter(Date.now());
    await timestampAfter(cutoff);
    const restarted = declareAfterRestart(lowLevel, cutoff);
    const result = await restarted.collectGarbage(cutoff);
    expect(result.objects.deleted).toBe(1);
    expect((await (restarted.debugSnapshot ?? throwErr("Expected restarted Piledriver database to expose debugSnapshot"))()).heap).toHaveLength(2);
  });

  it("serializes concurrent mutations of the same root", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const writer = declareBasePiledriverDatabase(lowLevel);
    const rootKey = new TextEncoder().encode("root").buffer;
    await Promise.all([
      writer.setRootObject(rootKey, { child: asHeapObject({ value: "first" }) }),
      writer.setRootObject(rootKey, { child: asHeapObject({ value: "second" }) }),
    ]);
    await writer.setRootObject(rootKey, { replacement: true });

    const cutoff = await timestampAfter(Date.now());
    await timestampAfter(cutoff);
    const restarted = declareAfterRestart(lowLevel, cutoff);
    expect((await restarted.collectGarbage(cutoff)).objects.deleted).toBe(2);
  });

  it("allows a root mutation to retry after the previous write fails its availability barrier", async () => {
    const lowLevel = failAvailabilityAfterRootWrite(declareInMemoryLowLevelDatabase(crypto.randomUUID()));
    const writer = declareBasePiledriverDatabase(lowLevel);
    const rootKey = new TextEncoder().encode("root").buffer;
    await writer.setRootObject(rootKey, { value: "first" });

    await expect(writer.setRootObject(rootKey, { value: "blocked" })).rejects.toThrow("injected root availability failure");
    await expect(writer.setRootObject(rootKey, { value: "retry" })).resolves.toEqual({ seq: expect.anything() });
    await expect(writer.getRootObject(rootKey)).resolves.toMatchObject({ object: { value: "retry" } });
    await expect(writer.deleteRootObject(rootKey)).resolves.toEqual({ seq: expect.anything() });
  });

  it("batches metadata initialization for created heap objects", async () => {
    const metadataCompareAndSetEntryCounts: number[] = [];
    const metadataSetAllEntryCounts: number[] = [];
    const candidateSetAllEntryCounts: number[] = [];
    const lowLevel = wrapWithGcReferenceCounter(
      declareInMemoryLowLevelDatabase(crypto.randomUUID()),
      () => {},
      count => metadataCompareAndSetEntryCounts.push(count),
      count => metadataSetAllEntryCounts.push(count),
      count => candidateSetAllEntryCounts.push(count),
    );
    const writer = declareBasePiledriverDatabase(lowLevel);
    const rootKey = new TextEncoder().encode("root").buffer;
    const created = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`object${index}`, asHeapObject({ index })]),
    );

    await writer.setRootObject(rootKey, created);

    expect(metadataCompareAndSetEntryCounts).toEqual([20]);
    expect(metadataSetAllEntryCounts).toEqual(name === "base" ? [20] : []);
    expect(candidateSetAllEntryCounts).toEqual(name === "base" ? [20] : []);
  });

  it("removes the candidate using the original eligibility timestamp", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const writer = declareBasePiledriverDatabase(lowLevel);
    const rootKey = new TextEncoder().encode("root").buffer;
    const heapObject = asHeapObject({ value: "candidate-transition" });
    const candidateStore = lowLevel.declareKvStore("piledriver-gc-zero-reference-candidates-v3");

    await writer.setRootObject(rootKey, { heapObject });
    await writer.setRootObject(rootKey, {});
    await writer.setRootObject(rootKey, { heapObject });

    expect(await candidateStore.debugEntries?.()).toHaveLength(0);
  });

  it("retries after first-reference metadata publication fails", async () => {
    const lowLevel = failNextMetadataWrite(declareInMemoryLowLevelDatabase(crypto.randomUUID()));
    const writer = declareBasePiledriverDatabase(lowLevel);
    const rootKey = new TextEncoder().encode("root").buffer;
    const heapObject = asHeapObject({ value: "retry-me" });

    await expect(writer.setRootObject(rootKey, { heapObject })).rejects.toThrow("injected metadata write failure");
    await expect(writer.setRootObject(rootKey, { heapObject })).resolves.toEqual({ seq: expect.anything() });

    const metadata = await lowLevel.declareKvStore("piledriver-gc-reference-metadata-v3").listEntries();
    expect(metadata.entries).toHaveLength(1);
  });

  it("publishes shared heap creation before another root records its reference", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const writer = declareBasePiledriverDatabase(lowLevel);
    const sharedHeapObject = asHeapObject({ value: "shared" });
    const firstRoot = new TextEncoder().encode("first").buffer;
    const secondRoot = new TextEncoder().encode("second").buffer;

    await Promise.all([
      writer.setRootObject(firstRoot, { sharedHeapObject }),
      writer.setRootObject(secondRoot, { sharedHeapObject }),
    ]);

    const cutoff = await timestampAfter(Date.now());
    await timestampAfter(cutoff);
    const restarted = declareAfterRestart(lowLevel, cutoff);
    const result = await restarted.collectGarbage(cutoff);
    expect(result.objects.deleted).toBe(0);
  });

  it("aborts an unfinished batch when heap serialization fails", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const writer = declareBasePiledriverDatabase(lowLevel);
    const goodHeapObject = asHeapObject({ value: "retry-sibling" });
    const badHeapObject: PiledriverHeapObject = {
      async get() {
        throw new Error("injected heap serialization failure");
      },
      getValueIfLocallyCreated() {
        throw new Error("injected heap serialization failure");
      },
      [isPiledriverHeapObjectSymbol]: true,
    };
    const rootKey = new TextEncoder().encode("root").buffer;

    await expect(writer.setRootObject(rootKey, { goodHeapObject, badHeapObject })).rejects.toThrow("injected heap serialization failure");
    await expect(writer.setRootObject(rootKey, { goodHeapObject })).resolves.toEqual({ seq: expect.anything() });
  });

  it("publishes crossing shared heap objects without a batch wait cycle", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const writer = declareBasePiledriverDatabase(lowLevel);
    const firstChildHeapObject = asHeapObject({ value: "first-child" });
    const secondChildHeapObject = asHeapObject({ value: "second-child" });
    const firstHeapObject: PiledriverHeapObject = {
      async get() {
        return { firstChildHeapObject };
      },
      getValueIfLocallyCreated() {
        return { status: "locally-created", value: { firstChildHeapObject } };
      },
      [isPiledriverHeapObjectSymbol]: true,
    };
    const secondHeapObject: PiledriverHeapObject = {
      async get() {
        return { secondChildHeapObject };
      },
      getValueIfLocallyCreated() {
        return { status: "locally-created", value: { secondChildHeapObject } };
      },
      [isPiledriverHeapObjectSymbol]: true,
    };

    await Promise.all([
      writer.setRootObject(new TextEncoder().encode("first").buffer, { firstHeapObject, secondHeapObject }),
      writer.setRootObject(new TextEncoder().encode("second").buffer, { secondHeapObject, firstHeapObject }),
    ]);

    const metadata = await lowLevel.declareKvStore("piledriver-gc-reference-metadata-v3").listEntries();
    expect(metadata.entries).toHaveLength(4);
    const candidates = await lowLevel.declareKvStore("piledriver-gc-zero-reference-candidates-v3").listEntries();
    expect(candidates.entries).toHaveLength(0);
    const cutoff = await timestampAfter(Date.now());
    await timestampAfter(cutoff);
    const restarted = declareAfterRestart(lowLevel, cutoff);
    expect((await restarted.collectGarbage(cutoff)).objects.deleted).toBe(0);
  });

  it("never collects objects created after the restart barrier", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const initial = declareBasePiledriverDatabase(lowLevel);
    await initial.setRootObject(new TextEncoder().encode("initial").buffer, { initialized: true });
    const cutoff = await timestampAfter(Date.now());
    await timestampAfter(cutoff);

    const restarted = declareAfterRestart(lowLevel, cutoff);
    await restarted.setRootObject(new TextEncoder().encode("new-root").buffer, {
      child: asHeapObject({ created: "after-restart" }),
    });
    await restarted.setRootObject(new TextEncoder().encode("new-root").buffer, { replacement: true });
    expect(await restarted.collectGarbage(cutoff)).toMatchObject({
      objects: {
        deleted: 0,
        candidatesExamined: 0,
        metadataEntriesExaminedForRepair: 1,
        candidatesSkipped: 0,
      },
      reclaimed: {
        heapPayloadBytes: 0,
        knownLogicalBytes: 0,
      },
    });
    expect((await (restarted.debugSnapshot ?? throwErr("Expected restarted Piledriver database to expose debugSnapshot"))()).heap).toHaveLength(1);
  });

  it("durably initializes GC state before publishing its generation", async () => {
    const underlying = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    let durabilityWaits = 0;
    const lowLevel: LowLevelDatabase = {
      ...underlying,
      async waitUntilDurable(seq) {
        durabilityWaits++;
        await underlying.waitUntilDurable(seq);
      },
    };

    await declareBasePiledriverDatabase(lowLevel).setRootObject(
      new TextEncoder().encode("root").buffer,
      { initialized: true },
    );
    expect(durabilityWaits).toBe(1);
  });

  it("uses one metadata generation when first-time initialization races", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const first = declareBasePiledriverDatabase(lowLevel);
    const second = declareBasePiledriverDatabase(lowLevel);
    await Promise.all([
      first.setRootObject(new TextEncoder().encode("first").buffer, { child: asHeapObject({ source: "first" }) }),
      second.setRootObject(new TextEncoder().encode("second").buffer, { child: asHeapObject({ source: "second" }) }),
    ]);

    const state = await lowLevel.declareKvStore("piledriver-gc-state-v3").get(new TextEncoder().encode("state").buffer);
    if (state.buffer === null) throw new Error("Expected initialized Piledriver GC state");
    const stateGeneration = JSON.parse(new TextDecoder().decode(state.buffer))["generation"];
    if (typeof stateGeneration !== "string" || stateGeneration.length === 0) {
      throw new Error("Expected initialized Piledriver GC state to contain a generation");
    }
    const metadata = await lowLevel.declareKvStore("piledriver-gc-reference-metadata-v3").listEntries();
    expect(metadata.entries).toHaveLength(2);
    expect(new Set(metadata.entries.map(entry => JSON.parse(new TextDecoder().decode(entry.value))["generation"]))).toEqual(new Set([stateGeneration]));
  });

  it("walks deeply nested serialized structures without an artificial GC depth limit", async () => {
    let nested: PiledriverObject = "leaf";
    for (let depth = 0; depth <= 1001; depth++) nested = [nested];

    await expect(declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(crypto.randomUUID())).setRootObject(
      new TextEncoder().encode("root").buffer,
      nested,
    )).resolves.toEqual({ seq: expect.anything() });
  });

  if (name === "base") {
    it("keeps legacy objects immortal while collecting newly created objects", async () => {
      const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
      const legacyRootKey = new TextEncoder().encode("legacy-root").buffer;
      const legacyWriter = declareBasePiledriverDatabase(lowLevel);
      await legacyWriter.setRootObject(legacyRootKey, {
        parent: asHeapObject({ child: asHeapObject({ legacy: true }) }),
      });
      for (const storeId of [
        "piledriver-gc-reference-metadata-v3",
        "piledriver-gc-zero-reference-candidates-v3",
        "piledriver-gc-state-v3",
      ]) {
        const store = lowLevel.declareKvStore(storeId);
        const entries = await store.listEntries();
        await store.deleteAll(entries.entries.map(entry => entry.key));
      }

      let heapListCalls = 0;
      const trackingWriter = declareBasePiledriverDatabase(wrapWithHeapListCounter(lowLevel, () => heapListCalls++));
      const legacyRoot = (await trackingWriter.getRootObject(legacyRootKey)).object;
      if (typeof legacyRoot !== "object" || legacyRoot === null || Array.isArray(legacyRoot) || !("parent" in legacyRoot)) {
        throw new Error("Expected legacy root to contain its parent reference");
      }
      const legacyParent = legacyRoot.parent;
      if (typeof legacyParent !== "object" || legacyParent === null || Array.isArray(legacyParent) || !(isPiledriverHeapObjectSymbol in legacyParent)) {
        throw new Error("Expected legacy parent to be a heap reference");
      }
      await trackingWriter.setRootObject(legacyRootKey, { replacement: true });
      expect(heapListCalls).toBe(0);
      const trackedRootKey = new TextEncoder().encode("tracked-root").buffer;
      await trackingWriter.setRootObject(trackedRootKey, {
        parent: asHeapObject({
          child: asHeapObject({ tracked: true }),
          legacyParent,
        }),
      });
      await trackingWriter.setRootObject(trackedRootKey, { replacement: true });
      const cutoff = await timestampAfter(Date.now());
      await timestampAfter(cutoff);
      const restarted = declareAfterRestart(lowLevel, cutoff);
      const result = await restarted.collectGarbage(cutoff);
      expect(result.objects.deleted).toBe(2);
      expect(result.references.legacyImmortalEdgesIgnored).toBe(1);
      expect((await (restarted.debugSnapshot ?? throwErr("Expected restarted Piledriver database to expose debugSnapshot"))()).heap).toHaveLength(2);
    });
  } else {
    it("rejects decrements for heap objects whose metadata is unexpectedly missing", async () => {
      const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
      const rootKey = new TextEncoder().encode("root").buffer;
      const writer = declareBasePiledriverDatabase(lowLevel);
      await writer.setRootObject(rootKey, { child: asHeapObject({ tracked: true }) });
      const metadataStore = lowLevel.declareKvStore("piledriver-gc-reference-metadata-v3");
      const metadata = await metadataStore.listEntries();
      await metadataStore.deleteAll(metadata.entries.map(entry => entry.key));

      await expect(writer.setRootObject(rootKey, { replacement: true })).rejects.toThrow(
        "cannot decrement heap object",
      );
    });
  }

  it("repairs a missing zero-reference candidate", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const rootKey = new TextEncoder().encode("root").buffer;
    const writer = declareBasePiledriverDatabase(lowLevel);
    await writer.setRootObject(rootKey, { child: asHeapObject({ tracked: true }) });
    await writer.setRootObject(rootKey, { replacement: true });
    const candidateStore = lowLevel.declareKvStore("piledriver-gc-zero-reference-candidates-v3");
    const candidates = await candidateStore.listEntries();
    await candidateStore.deleteAll(candidates.entries.map(entry => entry.key));

    const cutoff = await timestampAfter(Date.now());
    await timestampAfter(cutoff);
    const restarted = declareAfterRestart(lowLevel, cutoff);
    expect(await restarted.collectGarbage(cutoff)).toMatchObject({
      objects: {
        deleted: 1,
        candidatesExamined: 1,
        metadataEntriesExaminedForRepair: 1,
        candidatesSkipped: 0,
      },
      recovery: {
        missingCandidateEntriesRepaired: 1,
      },
    });
  });

  it("does not allow re-instantiation to bypass the process restart barrier", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const cutoff = await timestampAfter(Date.now());
    const sameProcessDatabase = declareBasePiledriverDatabase(lowLevel);
    await expect(sameProcessDatabase.collectGarbage(cutoff)).rejects.toThrow("restart the Bulldozer service");
  });

  it("rejects cycles between heap objects", async () => {
    let second: PiledriverHeapObject | undefined;
    const first: PiledriverHeapObject = {
      async get() {
        if (second === undefined) throw new Error("Second heap object was not initialized");
        return { second };
      },
      getValueIfLocallyCreated() {
        if (second === undefined) throw new Error("Second heap object was not initialized");
        return { status: "locally-created", value: { second } };
      },
      [isPiledriverHeapObjectSymbol]: true,
    };
    second = {
      async get() {
        return { first };
      },
      getValueIfLocallyCreated() {
        return { status: "locally-created", value: { first } };
      },
      [isPiledriverHeapObjectSymbol]: true,
    };
    const database = declareBasePiledriverDatabase(declareInMemoryLowLevelDatabase(crypto.randomUUID()));
    await expect(database.setRootObject(new TextEncoder().encode("root").buffer, { first, second })).rejects.toThrow("must not contain cycles");
  });
});

describe("Piledriver garbage-collection metadata", () => {
  it("does not lose concurrent first-reference increments", async () => {
    const lowLevel = declareInMemoryLowLevelDatabase(crypto.randomUUID());
    const heapDump = lowLevel.declareKvDump("heap");
    const options: Parameters<typeof declarePiledriverGarbageCollector>[0] = {
      lowLevelDb: lowLevel,
      heapDump,
      processStartedAtMillis: Date.now(),
      missingMetadataBehavior: "initialize-on-positive-reference",
    };
    const first = declarePiledriverGarbageCollector(options);
    const second = declarePiledriverGarbageCollector(options);
    await Promise.all([first.initialize(), second.initialize()]);

    const childKey = crypto.getRandomValues(new Uint8Array(16)).buffer;
    const reference = new TextEncoder().encode(JSON.stringify([
      "heap-reference",
      encodeBase64(new Uint8Array(childKey)),
    ])).buffer;
    await Promise.all([
      first.beforeSerializedHeapObjectsBecomeVisible([reference], lowLevel.initialSeq),
      second.beforeSerializedHeapObjectsBecomeVisible([reference], lowLevel.initialSeq),
    ]);

    const stored = await lowLevel.declareKvStore("piledriver-gc-reference-metadata-v3").get(childKey);
    if (stored.buffer === null) throw new Error("Expected concurrent references to initialize metadata");
    expect(JSON.parse(new TextDecoder().decode(stored.buffer))["referenceCount"]).toBe(2);
  });
});

describe("piledriverObjectEquals", () => {
  it("compares primitives", () => {
    expect(piledriverObjectEquals(1, 1)).toBe(true);
    expect(piledriverObjectEquals(1, 2)).toBe(false);
    expect(piledriverObjectEquals("a", "a")).toBe(true);
    expect(piledriverObjectEquals(null, null)).toBe(true);
    expect(piledriverObjectEquals(null, {})).toBe(false);
    expect(piledriverObjectEquals(1, "1")).toBe(false);
  });

  it("compares objects structurally without ignoring extra keys", () => {
    expect(piledriverObjectEquals({ a: 1, b: [1, { c: null }] }, { a: 1, b: [1, { c: null }] })).toBe(true);
    expect(piledriverObjectEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(piledriverObjectEquals({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(piledriverObjectEquals({ a: 1 }, { b: 1 })).toBe(false);
  });

  it("distinguishes arrays from objects", () => {
    expect(piledriverObjectEquals([1, 2], [1, 2])).toBe(true);
    expect(piledriverObjectEquals([1, 2], [1, 2, 3])).toBe(false);
    expect(piledriverObjectEquals({ "0": 1 }, [1])).toBe(false);
    expect(piledriverObjectEquals([], {})).toBe(false);
  });
});

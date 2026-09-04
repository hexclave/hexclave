import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { createDatabaseSeq, DatabaseSeq } from "../../index.js";
import { PiledriverDatabase, PiledriverObject } from "../index.js";
import { zeroPiledriverGarbageCollectionResult } from "../gc.js";

const piledriverProcessStartedAtMillis = Date.now();
const inMemoryPiledriverRoots = new Map<string, Map<string, PiledriverObject>>();

/**
 * An in-memory Piledriver backend for tests and embedders that need no durability. It exercises
 * none of the serialization or garbage-collection logic, so it is not a substitute for the base
 * implementation in tests that care about stored-form behavior. Because nothing is serialized,
 * mutating an object after passing it to `setRootObject` is visible to later reads; the existing
 * rule that Piledriver objects are immutable matters even more here.
 */
export function declareInMemoryPiledriverDatabase(dbId: string): PiledriverDatabase {
  const roots = inMemoryPiledriverRoots.get(dbId) ?? new Map<string, PiledriverObject>();
  inMemoryPiledriverRoots.set(dbId, roots);
  const initialSeq = createDatabaseSeq();
  return {
    getDebugInfo() {
      return { backend: "piledriver-in-memory", constructorArguments: { dbId }, roots };
    },
    async getRootObject(key) {
      const keyBase64 = encodeBase64(new Uint8Array(key));
      const object = roots.get(keyBase64);
      if (object === undefined) throw new Error("Root object not found");
      return { object, seq: initialSeq };
    },
    async setRootObject(key, value) {
      roots.set(encodeBase64(new Uint8Array(key)), value);
      return { seq: initialSeq };
    },
    async deleteRootObject(key) {
      roots.delete(encodeBase64(new Uint8Array(key)));
      return { seq: initialSeq };
    },
    getGarbageCollectionProcessStartedAtMillis() {
      return piledriverProcessStartedAtMillis;
    },
    async collectGarbage(cutoffTimestampMillis, maxObjects = 1000) {
      // This backend intentionally has no garbage-collection contract; V8 owns liveness.
      return zeroPiledriverGarbageCollectionResult(cutoffTimestampMillis, piledriverProcessStartedAtMillis, maxObjects, Date.now());
    },
    combineSeqs() {
      return initialSeq;
    },
    async waitUntilAvailable() {},
    async waitUntilDurable() {},
    async waitUntilReplicated() {},
    async waitUntilConsistent() {},
    async close() {},
    initialSeq,
  };
}

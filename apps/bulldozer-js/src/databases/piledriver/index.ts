import { isBase64 } from "@hexclave/shared/dist/utils/bytes";
import { Database, DatabaseSeq } from "../index.js";
import type { LowLevelDatabaseDebugSnapshot } from "../low-level/index.js";
import type { PiledriverGarbageCollectionResult } from "./gc.js";

export const isPiledriverHeapObjectSymbol = Symbol.for("hexclave-piledriver-heap-object-symbol");
export type PiledriverHeapObjectLocalValue =
  | { status: "locally-created", value: PiledriverObject }
  | { status: "database-reference" };
export type PiledriverHeapObject = {
  get(): Promise<PiledriverObject>,
  getValueIfLocallyCreated(): PiledriverHeapObjectLocalValue,
  [isPiledriverHeapObjectSymbol]: true,
};

export class InvalidPiledriverSerializedObjectError extends Error {
  constructor() {
    super("Invalid serialized Piledriver object");
  }
}

const heapObjectsMapNullSentinel = { __heapObjectsMapNullSentinel: true };
export const heapObjectsByObject = new WeakMap<PiledriverObject & object, PiledriverHeapObject>();

// TODO: Make heap-object creation database-scoped and brand both locally created and loaded
// references with their owning Piledriver database. Passing a heap object between databases should
// fail at the API boundary instead of implicitly loading and copying a foreign database reference.
/**
 * Creates a new heap object, which will be stored as a reference by Piledriver.
 *
 * Accessing it will take an extra database lookup, but becomes an optional operation.
 *
 * Note that since Piledriver objects are inherently immutable, `obj` must be immutable as well. Behavior is undefined
 * if it is modified after being passed to this function.
 */
export function asHeapObject(obj: PiledriverObject): PiledriverHeapObject {
  if (typeof obj !== "object") throw new Error("Can only create heap objects from actual objects!");
  const existing = heapObjectsByObject.get(obj ?? heapObjectsMapNullSentinel);
  if (existing) return existing;

  const localValue: PiledriverHeapObjectLocalValue = { status: "locally-created", value: obj };
  const res: PiledriverHeapObject = {
    async get() {
      return obj;
    },
    getValueIfLocallyCreated() {
      return localValue;
    },
    [isPiledriverHeapObjectSymbol]: true,
  };
  heapObjectsByObject.set(obj ?? heapObjectsMapNullSentinel, res);
  return res;
}

export type PiledriverObject = string | number | boolean | null | PiledriverObject[] | { [key: string]: PiledriverObject } | PiledriverHeapObject;
export function piledriverObjectEquals(a: PiledriverObject, b: PiledriverObject): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    if (a === null || b === null) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => piledriverObjectEquals(v, b[i]));
    }
    const aEntries = Object.entries(a);
    const bRecord = b as { [key: string]: PiledriverObject };
    return aEntries.length === Object.keys(bRecord).length && aEntries.every(([k, v]) => piledriverObjectEquals(v, bRecord[k]));
  }
  return false;
}

export type PiledriverSerializedFormAccess = {
  getSerializedRootObject(key: ArrayBuffer): Promise<{ buffer: ArrayBuffer, seq: DatabaseSeq }>,
  deserializeSerializedObject(buffer: ArrayBuffer, seq?: DatabaseSeq): Promise<{ object: PiledriverObject, seq: DatabaseSeq }>,
  getSerializedHeapObject(key: ArrayBuffer): Promise<{ buffer: ArrayBuffer | null, seq: DatabaseSeq }>,
  listHeapEntries(options: { startAfter?: ArrayBuffer, limit?: number }): Promise<{
    entries: Array<{ key: ArrayBuffer, value: ArrayBuffer }>,
    hasMore: boolean,
  }>,
};

export type PiledriverDatabase = Database & {
  getRootObject(key: ArrayBuffer): Promise<{ object: PiledriverObject, seq: DatabaseSeq }>,
  /**
   * Optional because the integrity verifier inspects objects in their stored form. A backend that
   * never serializes (in-memory) or uses a different codec (breezy's binary codec) cannot answer
   * these calls; callers report the check as skipped, and breezy must implement this before it can
   * become a production backend.
   */
  getSerializedFormAccess?(): PiledriverSerializedFormAccess,
  setRootObject(key: ArrayBuffer, value: PiledriverObject): Promise<{ seq: DatabaseSeq }>,
  deleteRootObject(key: ArrayBuffer): Promise<{ seq: DatabaseSeq }>,
  getGarbageCollectionProcessStartedAtMillis(): number,
  collectGarbage(cutoffTimestampMillis: number, maxObjects?: number): Promise<PiledriverGarbageCollectionResult>,
  debugSnapshot?(): Promise<PiledriverDatabaseDebugSnapshot>,
  debugLowLevelSnapshot?(): Promise<LowLevelDatabaseDebugSnapshot>,
};

export type PiledriverDatabaseDebugSnapshot = {
  roots: Array<{ keyBase64: string, keyUtf8: string | null, keyHex: string, serializedJson: unknown, valueByteLength: number }>,
  heap: Array<{ keyBase64: string, keyUtf8: string | null, keyHex: string, serializedJson: unknown, valueByteLength: number }>,
};

export function collectSerializedHeapReferences(jsonableObject: unknown, references: string[] = []): string[] {
  if (Array.isArray(jsonableObject)) {
    const tag = jsonableObject[0];
    if (tag === "heap-reference") {
      if (jsonableObject.length !== 2 || typeof jsonableObject[1] !== "string" || !isBase64(jsonableObject[1])) throw new InvalidPiledriverSerializedObjectError();
      references.push(jsonableObject[1]);
    } else if (tag === "array") {
      if (jsonableObject.length !== 2 || !Array.isArray(jsonableObject[1])) throw new InvalidPiledriverSerializedObjectError();
      for (const item of jsonableObject[1]) collectSerializedHeapReferences(item, references);
    } else if (tag !== "NaN" && tag !== "Infinity" && tag !== "-Infinity" && tag !== "-0") {
      throw new InvalidPiledriverSerializedObjectError();
    }
  } else if (jsonableObject !== null && typeof jsonableObject === "object") {
    for (const item of Object.values(jsonableObject)) collectSerializedHeapReferences(item, references);
  }
  return references;
}

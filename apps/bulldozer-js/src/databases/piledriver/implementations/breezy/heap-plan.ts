import { isPiledriverHeapObjectSymbol, PiledriverHeapObject, PiledriverObject } from "../../index.js";
import { plannedHeapReference, PlannedPiledriverObject } from "./codec.js";

export type PlannedHeapObject = {
  object: PiledriverHeapObject,
  key: ArrayBuffer,
  value: PlannedPiledriverObject,
};

export type HeapObjectPlan<Dependency> = {
  root: PlannedPiledriverObject,
  heapObjects: PlannedHeapObject[],
  dependencies: Dependency[],
};

const defineOwn = (object: { [key: string]: PlannedPiledriverObject }, key: string, value: PlannedPiledriverObject) => {
  if (key === "__proto__") {
    Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
  } else {
    object[key] = value;
  }
};

/**
 * Replaces every heap object with its stored or reserved key and collects new heap payloads.
 *
 * Existing objects contribute their publication dependency without being loaded. New objects expose
 * the value originally passed to `asHeapObject`, keeping the complete traversal synchronous and
 * returning their serialized payloads child-first.
 */
export function planHeapObjects<Dependency>(
  root: PiledriverObject,
  locateKnown: (object: PiledriverHeapObject) => { key: ArrayBuffer, dependency: Dependency } | undefined,
  reserveKey: () => ArrayBuffer,
): HeapObjectPlan<Dependency> {
  const references = new Map<PiledriverHeapObject, ReturnType<typeof plannedHeapReference>>();
  const dependencies = new Set<Dependency>();
  const heapObjects: PlannedHeapObject[] = [];

  const visit = (
    value: PiledriverObject,
    heapPath: Set<PiledriverHeapObject>,
    objectPath: Set<object>,
  ): PlannedPiledriverObject => {
    if (value === null || typeof value !== "object") return value;

    if (isPiledriverHeapObjectSymbol in value) {
      if (heapPath.has(value)) throw new Error("Piledriver objects must not contain cycles (found a cycle of heap objects)");

      const known = locateKnown(value);
      if (known !== undefined) {
        dependencies.add(known.dependency);
        return plannedHeapReference(known.key);
      }

      const existingReference = references.get(value);
      if (existingReference !== undefined) return existingReference;

      const localValue = value.getValueIfLocallyCreated();
      if (localValue.status === "database-reference") {
        throw new Error("Cannot write a heap object read from another Piledriver database");
      }
      const reference = plannedHeapReference(reserveKey());
      references.set(value, reference);
      heapPath.add(value);
      const plannedValue = visit(localValue.value, heapPath, new Set());
      heapPath.delete(value);
      heapObjects.push({ object: value, key: reference.key, value: plannedValue });
      return reference;
    }

    if (objectPath.has(value)) throw new Error("Piledriver objects must not contain cycles");
    objectPath.add(value);
    let result: PlannedPiledriverObject;
    if (Array.isArray(value)) {
      result = [];
      for (const child of value) result.push(visit(child, heapPath, objectPath));
    } else {
      const object: { [key: string]: PlannedPiledriverObject } = {};
      for (const key of Object.keys(value)) {
        defineOwn(object, key, visit(value[key], heapPath, objectPath));
      }
      result = object;
    }
    objectPath.delete(value);
    return result;
  };

  const plannedRoot = visit(root, new Set(), new Set());
  return { root: plannedRoot, heapObjects, dependencies: [...dependencies] };
}

import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { isPiledriverHeapObjectSymbol } from "./index.js";

/**
 * Piledriver saves JSON-like values: strings, numbers, booleans, null, arrays, plain objects, and heap
 * objects. Anything else would be silently dropped or rewritten when saved (a function disappears, a
 * Date or Map becomes `{}`), so it must be rejected instead. The types already forbid such values, but
 * callers can still pass them through casts or untyped JSON handling.
 */

/**
 * Checks one value without looking inside it. Returns null if Piledriver can save it, or the name of
 * its type (for the error message) if it can't.
 */
export function unsavableTypeName(value: unknown): string | null {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean": {
      return null;
    }
    case "object": {
      if (value === null || Array.isArray(value) || isPiledriverHeapObjectSymbol in value) return null;
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) return null;
      const constructor: unknown = Reflect.get(Object(prototype), "constructor");
      return typeof constructor === "function" ? constructor.name : "object with a custom prototype";
    }
    default: {
      return typeof value;
    }
  }
}

/** A caller passed a value the types forbid; that's a bug in the caller, so it's an assertion error. */
export function cannotSaveError(typeName: string) {
  return new HexclaveAssertionError(`Cannot save a value of type ${typeName} in Piledriver: only strings, numbers, booleans, null, arrays, plain objects and heap objects can be saved`, { typeName });
}

/**
 * Throws if `value`, or anything nested inside it, can't be saved. Heap objects are skipped: rows from
 * callers don't contain them, and the ones Bulldozer builds itself hold only already-checked values.
 */
export function assertSavable(value: unknown) {
  const pending: unknown[] = [value];
  // Values can share or (through a cast) even cycle back to the same object; visit each only once.
  const visited = new Set<object>();
  while (pending.length > 0) {
    // `pop()` can't tell "empty" from a real `undefined` value, hence the length check above.
    const next = pending.pop();
    const typeName = unsavableTypeName(next);
    if (typeName !== null) throw cannotSaveError(typeName);
    if (typeof next !== "object" || next === null || isPiledriverHeapObjectSymbol in next || visited.has(next)) continue;
    visited.add(next);
    for (const child of Array.isArray(next) ? next : Object.values(next)) pending.push(child);
  }
}

import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
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
 * The deepest nesting a saved row may have, counting the row object itself as level 1. Real rows are
 * a few levels deep; only customer-defined JSON (product metadata) could go deeper, and thousands of
 * levels means abuse or a buggy script. Breezy can store values far deeper, but the base backend
 * saves with JSON.stringify, which fails at a few thousand levels (fewer on Linux than on a Mac), and
 * that failure would happen deep in the write path, where prod's buffered writer then fails every
 * later save too. Arrays are stored as two JSON levels, so this keeps every accepted row well below that.
 */
export const maximumSavedNestingDepth = 1000;

/**
 * Throws if `value`, or anything nested inside it, can't be saved: an unsupported type, or nesting
 * deeper than `maximumSavedNestingDepth`. Heap objects are skipped: rows from callers don't contain
 * them, and the ones Bulldozer builds itself hold only already-checked values.
 */
export function assertSavable(value: unknown) {
  const pending: { value: unknown, depth: number }[] = [{ value, depth: 1 }];
  // Values can share or (through a cast) even cycle back to the same object. Each object is checked
  // again only if it's reached at a deeper level than before, since its children then are too. A
  // cycle keeps getting deeper, so it ends at the depth limit.
  const deepestDepthByVisitedObject = new Map<object, number>();
  while (pending.length > 0) {
    // `pop()` can't tell "empty" from a real `undefined` value, hence the length check above.
    const next = pending.pop() ?? throwErr("pending is non-empty");
    const typeName = unsavableTypeName(next.value);
    if (typeName !== null) throw cannotSaveError(typeName);
    if (typeof next.value !== "object" || next.value === null || isPiledriverHeapObjectSymbol in next.value) continue;
    if (next.depth > maximumSavedNestingDepth) {
      throw new HexclaveAssertionError(`Cannot save a value nested more than ${maximumSavedNestingDepth} levels deep (or one that contains itself) in Piledriver`, { maximumSavedNestingDepth });
    }
    if ((deepestDepthByVisitedObject.get(next.value) ?? 0) >= next.depth) continue;
    deepestDepthByVisitedObject.set(next.value, next.depth);
    for (const child of Array.isArray(next.value) ? next.value : Object.values(next.value)) pending.push({ value: child, depth: next.depth + 1 });
  }
}

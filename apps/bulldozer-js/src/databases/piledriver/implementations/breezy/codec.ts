/**
 * Piledriver's persisted wire codec.
 *
 * The tagged JSON representation is part of the database format, not merely an implementation
 * detail. Existing databases contain these values, so changing a tag or its shape requires an
 * explicit compatibility plan. Heap storage is deliberately injected through callbacks: this
 * module defines the format while the database implementation owns IO and sequence ordering.
 */
import { decodeBase64, encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { PiledriverHeapObject, PiledriverObject } from "../../index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const isPlannedHeapReferenceSymbol = Symbol("piledriver-planned-heap-reference");

type PlannedHeapReference = {
  key: ArrayBuffer,
  [isPlannedHeapReferenceSymbol]: true,
};

export type PlannedPiledriverObject =
  | string
  | number
  | boolean
  | null
  | PlannedPiledriverObject[]
  | { [key: string]: PlannedPiledriverObject }
  | PlannedHeapReference;

export function plannedHeapReference(key: ArrayBuffer): PlannedHeapReference {
  return { key, [isPlannedHeapReferenceSymbol]: true };
}

export function plannedHeapReferenceKeys(value: PlannedPiledriverObject): ArrayBuffer[] {
  const references: ArrayBuffer[] = [];
  const pending: PlannedPiledriverObject[] = [value];
  while (pending.length !== 0) {
    const node = pending.pop();
    if (node === undefined || node === null || typeof node !== "object") continue;
    if (isPlannedHeapReferenceSymbol in node) {
      references.push(node.key);
    } else if (Array.isArray(node)) {
      pending.push(...node);
    } else {
      pending.push(...Object.values(node));
    }
  }
  return references;
}

const defineOwn = <T extends object>(object: T, key: string, value: Json) => {
  // Assignment would invoke Object.prototype.__proto__ instead of restoring an own property.
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
};

/**
 * Decodes one stored value without loading referenced heap payloads.
 *
 * `resolveHeapObject` must return a lazy wrapper for a key. Keeping resolution synchronous here
 * ensures that reading a root only parses the root buffer; heap IO happens later through
 * `PiledriverHeapObject.get()`.
 */
export function decodePiledriverObject(
  buffer: ArrayBuffer,
  resolveHeapObject: (key: ArrayBuffer) => PiledriverHeapObject,
): PiledriverObject {
  const decode = (value: Json): PiledriverObject => {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      // Every real array is tagged, leaving singleton arrays available for special numeric values.
      const tag = value[0];
      const payload = value[1];
      if (tag === "array" && value.length === 2 && Array.isArray(payload)) return payload.map(decode);
      if (tag === "heap-reference" && value.length === 2 && typeof payload === "string") {
        return resolveHeapObject(decodeBase64(payload).buffer);
      }
      if (value.length === 1 && tag === "NaN") return NaN;
      if (value.length === 1 && tag === "Infinity") return Infinity;
      if (value.length === 1 && tag === "-Infinity") return -Infinity;
      if (value.length === 1 && tag === "-0") return -0;
      throw new Error("Assertion error: Invalid serialized Piledriver tagged value");
    }
    if (typeof value !== "object") throw new Error(`Assertion error: Invalid serialized Piledriver value: ${typeof value}`);
    const result: { [key: string]: PiledriverObject } = {};
    for (const [key, child] of Object.entries(value)) defineOwn(result, key, decode(child));
    return result;
  };

  return decode(JSON.parse(decoder.decode(buffer)));
}

/**
 * Encodes one planned value whose heap objects have already been replaced by key references.
 *
 * Planning owns traversal, cycle detection, key assignment, and causal dependencies. Keeping those
 * concerns out of the codec makes this operation a synchronous conversion to the persisted format.
 */
export function encodePiledriverObject(value: PlannedPiledriverObject): ArrayBuffer {
  const encode = (node: PlannedPiledriverObject): Json => {
    if (typeof node === "number") {
      if (Number.isFinite(node) && !Object.is(node, -0)) return node;
      // JSON would otherwise collapse NaN/infinities to null and -0 to 0.
      return [Object.is(node, -0) ? "-0" : node.toString()];
    }
    if (node === null || typeof node === "string" || typeof node === "boolean") return node;
    if (isPlannedHeapReferenceSymbol in node) {
      return ["heap-reference", encodeBase64(new Uint8Array(node.key))];
    }
    if (Array.isArray(node)) {
      return ["array", node.map(encode)];
    }
    const object: { [key: string]: Json } = {};
    for (const [key, child] of Object.entries(node)) defineOwn(object, key, encode(child));
    return object;
  };

  return encoder.encode(JSON.stringify(encode(value))).buffer;
}

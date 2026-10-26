/**
 * Piledriver's persisted wire codec.
 *
 * The tagged JSON representation is part of the database format, not merely an implementation
 * detail. Existing databases contain these values, so changing a tag or its shape requires an
 * explicit compatibility plan. Heap storage is deliberately injected through callbacks: this
 * module defines the format while the database implementation owns IO and sequence ordering.
 */
import { decodeBase64, encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { PiledriverHeapObject, PiledriverObject } from "../../index.js";
import { defineOwnProperty, fillSlot, type PendingSlot } from "./pending-slots.js";

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
      for (const child of node) pending.push(child);
    } else {
      for (const child of Object.values(node)) pending.push(child);
    }
  }
  return references;
}

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
  // JSON.parse itself doesn't recurse in V8, so only the conversion below needs to avoid it.
  const root: PiledriverObject[] = [null];
  const pending: PendingSlot<unknown, PiledriverObject>[] = [{ input: JSON.parse(decoder.decode(buffer)), containerType: "array", container: root, key: 0 }];
  while (pending.length > 0) {
    const slot = pending.pop() ?? throwErr("pending is non-empty");
    const value = slot.input;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fillSlot(slot, value);
    } else if (Array.isArray(value)) {
      // Every real array is tagged, leaving singleton arrays available for special numeric values.
      const tag: unknown = value[0];
      const payload: unknown = value[1];
      if (tag === "array" && value.length === 2 && Array.isArray(payload)) {
        const result: PiledriverObject[] = payload.map(() => null);
        fillSlot(slot, result);
        for (let i = 0; i < payload.length; i++) pending.push({ input: payload[i], containerType: "array", container: result, key: i });
      } else if (tag === "heap-reference" && value.length === 2 && typeof payload === "string") {
        fillSlot(slot, resolveHeapObject(decodeBase64(payload).buffer));
      } else if (value.length === 1 && tag === "NaN") {
        fillSlot(slot, NaN);
      } else if (value.length === 1 && tag === "Infinity") {
        fillSlot(slot, Infinity);
      } else if (value.length === 1 && tag === "-Infinity") {
        fillSlot(slot, -Infinity);
      } else if (value.length === 1 && tag === "-0") {
        fillSlot(slot, -0);
      } else {
        throw new Error("Assertion error: Invalid serialized Piledriver tagged value");
      }
    } else if (typeof value === "object") {
      const result: { [key: string]: PiledriverObject } = {};
      fillSlot(slot, result);
      for (const [key, child] of Object.entries(value)) {
        defineOwnProperty(result, key, null);
        pending.push({ input: child, containerType: "object", container: result, key });
      }
    } else {
      throw new Error(`Assertion error: Invalid serialized Piledriver value: ${typeof value}`);
    }
  }
  return root[0];
}

/**
 * Encodes one planned value whose heap objects have already been replaced by key references.
 *
 * Planning owns traversal, cycle detection, key assignment, and causal dependencies. Keeping those
 * concerns out of the codec makes this operation a synchronous conversion to the persisted format.
 */
export function encodePiledriverObject(value: PlannedPiledriverObject): ArrayBuffer {
  const root: unknown[] = [null];
  const pending: PendingSlot<PlannedPiledriverObject, unknown>[] = [{ input: value, containerType: "array", container: root, key: 0 }];
  while (pending.length > 0) {
    const slot = pending.pop() ?? throwErr("pending is non-empty");
    const node = slot.input;
    if (typeof node === "number") {
      // JSON would otherwise collapse NaN/infinities to null and -0 to 0.
      if (Number.isFinite(node) && !Object.is(node, -0)) fillSlot(slot, node);
      else fillSlot(slot, [Object.is(node, -0) ? "-0" : node.toString()]);
    } else if (node === null || typeof node === "string" || typeof node === "boolean") {
      fillSlot(slot, node);
    } else if (isPlannedHeapReferenceSymbol in node) {
      fillSlot(slot, ["heap-reference", encodeBase64(new Uint8Array(node.key))]);
    } else if (Array.isArray(node)) {
      const items: unknown[] = node.map(() => null);
      fillSlot(slot, ["array", items]);
      for (let i = 0; i < node.length; i++) pending.push({ input: node[i], containerType: "array", container: items, key: i });
    } else {
      const object: { [key: string]: unknown } = {};
      fillSlot(slot, object);
      for (const [key, child] of Object.entries(node)) {
        defineOwnProperty(object, key, null);
        pending.push({ input: child, containerType: "object", container: object, key });
      }
    }
  }
  // JSON.stringify does recurse, but fails at write time (~6,000 levels), so nothing unreadable is saved.
  return encoder.encode(JSON.stringify(root[0])).buffer;
}

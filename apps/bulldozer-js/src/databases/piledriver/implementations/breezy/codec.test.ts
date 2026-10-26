import { describe, expect, it } from "vitest";
import { isPiledriverHeapObjectSymbol, type PiledriverHeapObject, type PiledriverObject } from "../../index.js";
import { decodePiledriverObject, encodePiledriverObject, plannedHeapReference, type PlannedPiledriverObject } from "./codec.js";

// Deep values are built and checked with loops: vitest's own deep equality is recursive and would
// overflow on these shapes before the codec does.
type Wrap = "object" | "array";
const nest = (depth: number, wrap: Wrap, leaf: PlannedPiledriverObject) => {
  let value = leaf;
  for (let i = 0; i < depth; i++) value = wrap === "object" ? { m: value } : [value];
  return value;
};
const unwrapLevels = (value: PiledriverObject, wrap: Wrap) => {
  let levels = 0;
  let node = value;
  while (true) {
    if (wrap === "object" && typeof node === "object" && node !== null && !Array.isArray(node) && !(isPiledriverHeapObjectSymbol in node) && "m" in node) node = node.m;
    else if (wrap === "array" && Array.isArray(node) && node.length === 1) node = node[0];
    else return { levels, leaf: node };
    levels++;
  }
};
const fakeHeapObject = (key: ArrayBuffer): PiledriverHeapObject => ({
  get: async () => new Uint8Array(key)[0],
  getValueIfLocallyCreated: () => ({ status: "database-reference" }),
  [isPiledriverHeapObjectSymbol]: true,
});
const noHeapObjects = () => {
  throw new Error("Expected no heap references");
};

describe("Breezy codec", () => {
  // Recursive encode/decode used one stack frame per nesting level, so a value a warmed-up server
  // could save (~3,000 levels) overflowed the smaller stack budget of a freshly started reader.
  // JSON.stringify recurses too, and its limit differs by machine (~6,000 levels on an M-series Mac,
  // under 5,000 on Linux CI), so these depths are well past it everywhere.
  it.each([["object", 20_000], ["array", 10_000]] as const)("round-trips %ss nested %i levels deep", async (wrap, depth) => {
    const leaf = { special: [NaN, -0, Infinity, -Infinity], reference: plannedHeapReference(new Uint8Array([7]).buffer), text: "leaf" };
    const decoded = decodePiledriverObject(encodePiledriverObject(nest(depth, wrap, leaf)), fakeHeapObject, "test value");
    const { levels, leaf: decodedLeaf } = unwrapLevels(decoded, wrap);
    expect(levels).toBe(depth);
    if (typeof decodedLeaf !== "object" || decodedLeaf === null || Array.isArray(decodedLeaf) || isPiledriverHeapObjectSymbol in decodedLeaf) throw new Error("Expected the leaf object");
    const { reference, ...rest } = decodedLeaf;
    expect(rest).toEqual({ special: [NaN, -0, Infinity, -Infinity], text: "leaf" });
    // toEqual treats -0 and 0 as equal, so check the sign separately.
    expect(Array.isArray(rest.special) && Object.is(rest.special[1], -0)).toBe(true);
    if (typeof reference !== "object" || reference === null || !(isPiledriverHeapObjectSymbol in reference)) throw new Error("Expected a heap object");
    expect(await reference.get()).toBe(7);
  });

  it("reads stored values nested far deeper than any process can write", () => {
    const depth = 100_000;
    const stored = new TextEncoder().encode('["array",['.repeat(depth) + "1" + "]]".repeat(depth)).buffer;
    expect(unwrapLevels(decodePiledriverObject(stored, noHeapObjects, "test value"), "array")).toEqual({ levels: depth, leaf: 1 });
  });

  it("keeps the stored format unchanged", () => {
    const value: PlannedPiledriverObject = { list: [1, -0, NaN, "x", null, true], ref: plannedHeapReference(new Uint8Array([1, 2]).buffer), nested: { empty: [], obj: {} } };
    expect(new TextDecoder().decode(encodePiledriverObject(value))).toBe('{"list":["array",[1,["-0"],["NaN"],"x",null,true]],"ref":["heap-reference","AQI="],"nested":{"empty":["array",[]],"obj":{}}}');
  });

  it("restores own properties named __proto__ instead of changing the prototype", () => {
    const decoded = decodePiledriverObject(new TextEncoder().encode('{"__proto__":{"polluted":true}}').buffer, noHeapObjects, "test value");
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.keys(decoded as object)).toEqual(["__proto__"]);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

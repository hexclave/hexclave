/**
 * Shared helpers for the augmented-tree-map serialization compatibility checks:
 *  - the golden fixtures + `serialization-compat.test.ts` (checked-in, per-version regression), and
 *  - `serialization-cross-version.ts` (CI harness that has one code version write a dump and another
 *    read it back).
 *
 * Everything here depends only on the long-stable `AugmentedTreeMap` / piledriver public API, so this
 * module also imports cleanly under older checkouts of the repo (which the cross-version CI job relies
 * on when it runs the harness against the base branch's code).
 */
import { AugmentedTreeMap } from "../augmented-tree-map.js";
import { PiledriverHeapObject, PiledriverObject, isPiledriverHeapObjectSymbol } from "../../index.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type SerializationQueries = {
  size: number,
  entriesInRange: [number, number][],
  reversedLimited: [number, number][],
  augmentationAll: number,
  augmentationRange: number,
};

// A self-describing serialized tree: the persisted object graph plus the query results the writer
// observed. A reader passes the check iff, after deserialising `tree`, it reproduces `queries`.
export type SerializationDump = {
  arity: number,
  tree: Json,
  queries: SerializationQueries,
};

export const FIXTURE_ARITY = 8;
export const FIXTURE_ROW_COUNT = 40;

export function optionsFor(arity: number) {
  return {
    arity,
    comparator: (a: number, b: number) => a - b,
    initialAugmentation: 0,
    extractAugmentation: (value: number) => value,
    mergeAugmentations: (...values: number[]) => values.reduce((sum, value) => sum + value, 0),
  };
}

// The deterministic dataset every writer produces, so dumps from different code versions are directly
// comparable: keys 1..FIXTURE_ROW_COUNT mapped to key*2.
export async function buildSampleTree(arity: number, rowCount: number): Promise<AugmentedTreeMap<number, number, number>> {
  let tree = new AugmentedTreeMap<number, number, number>(optionsFor(arity));
  for (let key = 1; key <= rowCount; key++) tree = await tree.set(key, key * 2);
  return tree;
}

async function arrayFrom<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

// The fixed set of queries used to attest that a deserialised tree behaves identically regardless of
// which code version wrote it. Covers forward/reverse iteration, limits, and full/partial aggregation.
export async function computeQueries(tree: AugmentedTreeMap<number, number, number>): Promise<SerializationQueries> {
  return {
    size: await tree.size(),
    entriesInRange: await arrayFrom(tree.entries({ gte: 10, lte: 15 })),
    reversedLimited: await arrayFrom(tree.entries({ lte: 30, reverse: true, limit: 5 })),
    augmentationAll: await tree.getAugmentation({}),
    augmentationRange: await tree.getAugmentation({ gte: 10, lte: 20 }),
  };
}

// Recursively resolves every heap object into its inline content, producing a plain-JSON snapshot of
// the persisted object graph (heap references inlined where they point). Mirrors the real on-disk node
// shape without needing the internal Node/Child types.
export async function resolveHeap(value: PiledriverObject): Promise<Json> {
  if (value === null || typeof value !== "object") return value;
  if (isPiledriverHeapObjectSymbol in value) return await resolveHeap(await value.get());
  if (Array.isArray(value)) return await Promise.all(value.map(resolveHeap));
  const out: { [key: string]: Json } = {};
  for (const [key, child] of Object.entries(value)) out[key] = await resolveHeap(child);
  return out;
}

// Wraps a plain object as a heap object whose `get()` resolves to it, mirroring how piledriver hands
// deserialised heap objects back to the tree.
function asFrozenHeapObject(object: PiledriverObject): PiledriverHeapObject {
  return {
    async get() {
      return object;
    },
    getValueIfLocallyCreated() {
      return { status: "database-reference" };
    },
    [isPiledriverHeapObjectSymbol]: true,
  };
}

// Reconstructs the persisted object graph, wrapping every `ref` field back into a heap object (the
// only place the tree stores heap references). Keying on the real field name is intentional: if a
// future format renames/relocates it, the fixture's `ref` becomes unreadable and the check fails —
// which is exactly the regression we want to surface.
export function inflate(value: Json): PiledriverObject {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(inflate);
  const out: { [key: string]: PiledriverObject } = {};
  for (const [key, child] of Object.entries(value)) {
    const inflated = inflate(child);
    out[key] = key === "ref" ? asFrozenHeapObject(inflated) : inflated;
  }
  return out;
}

export function treeFromDump(dump: SerializationDump): AugmentedTreeMap<number, number, number> {
  return AugmentedTreeMap.fromPiledriverObject<number, number, number>(inflate(dump.tree), optionsFor(dump.arity));
}

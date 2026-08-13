import { describe, expect, it } from "vitest";
import { isPiledriverHeapObjectSymbol, PiledriverHeapObject, PiledriverObject } from "../index.js";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { AugmentedTreeMap, AugmentedTreeMultiMap, treeVerificationNodeLoadBudget } from "./augmented-tree-map.js";

type Range = { lte?: number, gte?: number, lt?: number, gt?: number };
type Entry = [number, number];

const options = (arity: number) => ({
  arity,
  comparator: (a: number, b: number) => a - b,
  initialAugmentation: 0,
  extractAugmentation: (value: number) => value,
  mergeAugmentations: (...values: number[]) => values.reduce((sum, value) => sum + value, 0),
});

class AugmentedSlowMap {
  constructor(private readonly entries: Entry[] = []) {}

  async size() {
    return this.entries.length;
  }

  async has(key: number) {
    return await this.get(key) !== undefined;
  }

  async get(key: number) {
    return this.entries.find(([k]) => k === key)?.[1];
  }

  async set(key: number, value: number) {
    const entries = this.entries.filter(([k]) => k !== key);
    entries.push([key, value]);
    return new AugmentedSlowMap(entries.sort(([a], [b]) => a - b));
  }

  async insert(key: number, value: number) {
    if (await this.has(key)) throw new Error("Key already exists");
    return await this.set(key, value);
  }

  async delete(key: number) {
    return new AugmentedSlowMap(this.entries.filter(([k]) => k !== key));
  }

  async *entriesInRange(range: Range & { limit?: number, reverse?: boolean } = {}) {
    let yielded = 0;
    const entries = range.reverse ? [...this.entries].reverse() : this.entries;
    for (const entry of entries) {
      if (range.limit !== undefined && yielded >= range.limit) return;
      if (!isInRange(entry[0], range)) continue;
      yielded++;
      yield entry;
    }
  }

  async getAugmentation(range: Range) {
    let sum = 0;
    for (const [key, value] of this.entries) if (isInRange(key, range)) sum += value;
    return sum;
  }
}

function isInRange(key: number, range: Range) {
  return (range.gte === undefined || key >= range.gte)
    && (range.gt === undefined || key > range.gt)
    && (range.lte === undefined || key <= range.lte)
    && (range.lt === undefined || key < range.lt);
}

async function arrayFrom<T>(iterable: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

async function expectSame(tree: AugmentedTreeMap<number, number, number>, slow: AugmentedSlowMap) {
  const ranges: Array<Range & { limit?: number, reverse?: boolean }> = [
    {},
    { gte: 5, lte: 20 },
    { gt: 10, lt: 35 },
    { gte: 12, limit: 7 },
    { lte: 24, reverse: true, limit: 9 },
  ];

  expect(await tree.size()).toBe(await slow.size());
  for (const key of [1, 7, 19, 41, 99]) {
    expect(await tree.has(key)).toBe(await slow.has(key));
    expect(await tree.get(key)).toBe(await slow.get(key));
  }
  for (const range of ranges) {
    const slowEntries = await arrayFrom(slow.entriesInRange(range));
    expect(await arrayFrom(tree.entries(range))).toEqual(slowEntries);
    expect(await arrayFrom(tree.keys(range))).toEqual(slowEntries.map(([key]: Entry) => key));
    expect(await arrayFrom(tree.values(range))).toEqual(slowEntries.map(([, value]: Entry) => value));
  }
  for (const range of [{}, { gte: 5, lte: 20 }, { gt: 10, lt: 35 }, { gte: 50 }]) {
    expect(await tree.getAugmentation(range)).toBe(await slow.getAugmentation(range));
  }
}

async function runOperations(arity: number, operations: Array<[string, number, number?]>) {
  let tree = new AugmentedTreeMap(options(arity));
  let slow = new AugmentedSlowMap();

  for (const [operation, key, value = key] of operations) {
    if (operation === "set") {
      tree = await tree.set(key, value);
      slow = await slow.set(key, value);
    } else if (operation === "insert") {
      tree = await tree.insert(key, value);
      slow = await slow.insert(key, value);
    } else if (operation === "delete") {
      tree = await tree.delete(key);
      slow = await slow.delete(key);
    } else {
      throw new Error(`Unknown operation ${operation}`);
    }
    await expectSame(tree, slow);
  }
}

function shuffled(size: number, step: number) {
  return Array.from({ length: size }, (_, index) => ((index * step) % size) + 1);
}

type Serialized = ReturnType<AugmentedTreeMap<number, number, number>["toPiledriverObject"]>;

function isNode(value: unknown): value is { entries: Entry[], children: Array<{ ref: PiledriverHeapObject }> } {
  return !!value
    && typeof value === "object"
    && Array.isArray((value as { entries?: unknown }).entries)
    && Array.isArray((value as { children?: unknown }).children);
}

function withHeapCounters(tree: AugmentedTreeMap<number, number, number>, arity = 32) {
  let gets = 0;
  const seen = new WeakMap<PiledriverHeapObject, PiledriverHeapObject>();

  const wrapRef = (ref: PiledriverHeapObject): PiledriverHeapObject => {
    const cached = seen.get(ref);
    if (cached) return cached;
    const wrapped = {
      async get() {
        gets++;
        const node: any = await ref.get();
        return isNode(node) ? { ...node, children: node.children.map(wrapChild) } : node;
      },
      [isPiledriverHeapObjectSymbol]: true as const,
    } as PiledriverHeapObject;
    seen.set(ref, wrapped);
    return wrapped;
  };
  const wrapChild = (child: any) => child ? { ...child, ref: wrapRef(child.ref) } : child;
  const serialized = tree.toPiledriverObject();

  return {
    tree: AugmentedTreeMap.fromPiledriverObject({ ...serialized, root: wrapChild(serialized.root) }, options(arity)),
    reset: () => { gets = 0; },
    gets: () => gets,
  };
}

function withMultiMapHeapCounters(tree: AugmentedTreeMultiMap<number, number, number, string>, multiMapOptions: ConstructorParameters<typeof AugmentedTreeMultiMap<number, number, number, string>>[0]) {
  let gets = 0;
  const seen = new WeakMap<PiledriverHeapObject, PiledriverHeapObject>();

  const wrapRef = (ref: PiledriverHeapObject): PiledriverHeapObject => {
    const cached = seen.get(ref);
    if (cached) return cached;
    const wrapped = {
      async get() {
        gets++;
        const node: any = await ref.get();
        return isNode(node) ? { ...node, children: node.children.map(wrapChild) } : node;
      },
      [isPiledriverHeapObjectSymbol]: true as const,
    } as PiledriverHeapObject;
    seen.set(ref, wrapped);
    return wrapped;
  };
  const wrapChild = (child: any) => child ? { ...child, ref: wrapRef(child.ref) } : child;
  const serialized = tree.toPiledriverObject() as { type: string, tree: { type: string, root: any } };

  return {
    tree: AugmentedTreeMultiMap.fromPiledriverObject<number, number, number, string>({ ...serialized, tree: { ...serialized.tree, root: wrapChild(serialized.tree.root) } }, multiMapOptions),
    reset: () => { gets = 0; },
    gets: () => gets,
  };
}

async function collectRefs(tree: AugmentedTreeMap<number, number, number>) {
  const refs = new Set<PiledriverHeapObject>();
  const visit = async (child: Serialized["root"]) => {
    if (!child || refs.has(child.ref)) return;
    refs.add(child.ref);
    const node = await child.ref.get() as { children: Serialized["root"][] };
    for (const grandchild of node.children) await visit(grandchild);
  };
  await visit(tree.toPiledriverObject().root);
  return refs;
}

async function newHeapObjects(
  before: AugmentedTreeMap<number, number, number>,
  after: AugmentedTreeMap<number, number, number>,
) {
  const beforeRefs = await collectRefs(before);
  return [...await collectRefs(after)].filter(ref => !beforeRefs.has(ref)).length;
}

async function build(size: number, arity = 32) {
  let tree = new AugmentedTreeMap(options(arity));
  for (const key of shuffled(size, 37)) tree = await tree.set(key, key);
  return tree;
}

async function checkStructuralInvariants(tree: AugmentedTreeMap<number, number, number>, arity: number) {
  expect(await tree.verifyDataIntegrity(), `tree arity ${arity} should satisfy persisted invariants`).toEqual([]);
}

async function corruptedTree(
  tree: AugmentedTreeMap<number, number, number>,
  mutate: (node: Record<string, unknown>) => Record<string, unknown>,
) {
  const serialized = tree.toPiledriverObject();
  const root = serialized.root;
  if (root === null) throw new Error("Expected a non-empty tree");
  const originalGet = root.ref.get;
  const corruptedRoot = {
    ...root,
    ref: {
      ...root.ref,
      async get(): Promise<PiledriverObject> {
        const node = await originalGet();
        if (typeof node !== "object" || node === null || Array.isArray(node)) throw new Error("Expected a tree node");
        return mutate(node as Record<string, unknown>) as PiledriverObject;
      },
    },
  };
  return AugmentedTreeMap.fromPiledriverObject({ ...serialized, root: corruptedRoot }, options(3));
}

describe("AugmentedTreeMap", () => {
  it("matches a slow immutable map across mixed operations", async () => {
    const operations: Array<[string, number, number?]> = [
      ...shuffled(60, 17).map(key => ["set", key, key * 2] as [string, number, number]),
      ...shuffled(30, 11).map(key => ["delete", key] as [string, number]),
      ...shuffled(20, 7).map(key => ["set", key, key * 3] as [string, number, number]),
    ];

    for (const arity of [3, 4, 8, 32]) await runOperations(arity, operations);
  });

  it("preserves ordering and summaries while deleting every key", async () => {
    for (const arity of [3, 4, 5, 8, 32]) {
      for (const order of [shuffled(100, 1), shuffled(100, 99), shuffled(100, 37)]) {
        await runOperations(arity, [
          ...shuffled(100, 17).map(key => ["set", key] as [string, number]),
          ...order.map(key => ["delete", key] as [string, number]),
        ]);
      }
    }
  });

  it("maintains B-tree node size bounds across operations", async () => {
    // Regression test: deleting a separator whose adjacent children were both minimally
    // filled used to pre-merge them into a node with maxEntries + 1 entries (for odd arity).
    for (const arity of [3, 4, 5, 8]) {
      let tree = new AugmentedTreeMap<number, number, number>(options(arity));
      for (const key of shuffled(50, 13)) {
        tree = await tree.set(key, key);
        await checkStructuralInvariants(tree, arity);
      }
      for (const key of shuffled(50, 23)) {
        tree = await tree.delete(key);
        await checkStructuralInvariants(tree, arity);
      }
    }

    // Minimal repro of the original overflow at arity 3.
    let tree = new AugmentedTreeMap<number, number, number>(options(3));
    for (const key of [4, 5, 6, 7, 8, 1, 2, 3]) tree = await tree.set(key, key);
    tree = await tree.delete(5);
    await checkStructuralInvariants(tree, 3);
  });

  it("reports a wrong aggregate through the production checker", async () => {
    const tree = await build(20, 3);
    const wrongAggregate = await corruptedTree(tree, node => ({ ...node, augmentation: 999 }));
    expect(await wrongAggregate.verifyDataIntegrity()).toContainEqual(expect.objectContaining({ code: "augmentation" }));
  });

  it("reports a wrong entry count through the production checker", async () => {
    const tree = await build(20, 3);
    const wrongEntryCount = await corruptedTree(tree, node => ({ ...node, entries: [...(node.entries as unknown[]), [999, 999]] }));
    expect(await wrongEntryCount.verifyDataIntegrity()).toContainEqual(expect.objectContaining({ code: "entry_count" }));
  });

  it("reports unbalanced child heights through the production checker", async () => {
    const tree = await build(20, 3);
    const unbalanced = await corruptedTree(tree, node => ({ ...node, children: [] }));
    expect(await unbalanced.verifyDataIntegrity()).toContainEqual(expect.objectContaining({ code: "size" }));
  });

  it("reports a persisted child cycle without exhausting memory", async () => {
    const tree = await build(20, 3);
    const serialized = tree.toPiledriverObject();
    const root = serialized.root;
    if (root === null) throw new Error("Expected a non-empty tree");
    let rootLoads = 0;
    const makeCorruptedRootRef = (): PiledriverHeapObject => ({
      ...root.ref,
      async get(): Promise<PiledriverObject> {
        rootLoads++;
        const node = await root.ref.get();
        if (typeof node !== "object" || node === null || Array.isArray(node)) throw new Error("Expected a tree node");
        const children = (node as { children: Array<Record<string, unknown>> }).children.map(child => ({ ...child, ref: makeCorruptedRootRef() }));
        return { ...node, children } as PiledriverObject;
      },
    });
    const corruptedRootRef = makeCorruptedRootRef();
    const cyclic = AugmentedTreeMap.fromPiledriverObject({ ...serialized, root: { ...root, ref: corruptedRootRef } }, options(3));
    expect(await cyclic.verifyDataIntegrity()).toContainEqual(expect.objectContaining({ code: "cycle" }));
    expect(rootLoads).toBeLessThan(200);
  });

  it("scales the cycle guard with the persisted size", () => {
    expect(treeVerificationNodeLoadBudget(30_000)).toBeGreaterThan(100_000);
    expect(treeVerificationNodeLoadBudget(Number.MAX_SAFE_INTEGER)).toBe(10_000_000);
  });

  it("round-trips through piledriver objects", async () => {
    let tree = await build(100, 8);
    tree = AugmentedTreeMap.fromPiledriverObject(tree.toPiledriverObject(), options(8));

    expect(await arrayFrom(tree.entries({ gte: 20, lt: 25 }))).toEqual([[20, 20], [21, 21], [22, 22], [23, 23], [24, 24]]);
    expect(await tree.getAugmentation({ gte: 20, lte: 25 })).toBe(135);
  });

  it("reads legacy nodes persisted before format versioning", async () => {
    // Nodes written by an older build have no `version` and no `entryAugmentations`. Simulate such
    // an on-disk tree by stripping those fields on read, then confirm reads still work (the tree
    // must fall back to recomputing augmentations rather than trusting absent cached ones).
    const legacyRef = (ref: PiledriverHeapObject): PiledriverHeapObject => ({
      async get() {
        const node: any = await ref.get();
        if (!isNode(node)) return node;
        const { version: _version, entryAugmentations: _entryAugmentations, ...legacy } = node as any;
        return { ...legacy, children: node.children.map((child: any) => child ? { ...child, ref: legacyRef(child.ref) } : child) };
      },
      [isPiledriverHeapObjectSymbol]: true as const,
    } as PiledriverHeapObject);

    const built = await build(100, 8);
    const serialized = built.toPiledriverObject();
    const legacy = AugmentedTreeMap.fromPiledriverObject(
      { ...serialized, root: serialized.root ? { ...serialized.root, ref: legacyRef(serialized.root.ref) } : null },
      options(8),
    );

    expect(await arrayFrom(legacy.entries({ gte: 20, lt: 25 }))).toEqual([[20, 20], [21, 21], [22, 22], [23, 23], [24, 24]]);
    expect(await legacy.getAugmentation({ gte: 20, lte: 25 })).toBe(135);
    expect(await legacy.getAugmentation({})).toBe(5050);

    // A mutation over a legacy tree must produce a valid current-format tree.
    const updated = await legacy.set(50, -1);
    expect(await updated.get(50)).toBe(-1);
    expect(await updated.getAugmentation({})).toBe(5050 - 50 + -1);
  });

  it("defaults arity when omitted", async () => {
    let tree = new AugmentedTreeMap({
      comparator: (a: number, b: number) => a - b,
      initialAugmentation: 0,
      extractAugmentation: (value: number) => value,
      mergeAugmentations: (...values: number[]) => values.reduce((sum, value) => sum + value, 0),
    });

    tree = await tree.set(2, 20);
    tree = await tree.set(1, 10);
    expect(await arrayFrom(tree.entries())).toEqual([[1, 10], [2, 20]]);
  });

  it("stores multiple values for comparator-equal keys", async () => {
    let tree = new AugmentedTreeMultiMap({
      ...options(8),
      entryIdComparator: stringCompare,
    });

    tree = await tree.add(10, "b", 2);
    tree = await tree.add(10, "a", 1);
    tree = await tree.add(11, "a", 4);
    tree = AugmentedTreeMultiMap.fromPiledriverObject(tree.toPiledriverObject(), {
      ...options(8),
      entryIdComparator: stringCompare,
    });

    expect(await tree.getAll(10)).toEqual([["a", 1], ["b", 2]]);
    expect(await arrayFrom(tree.entries({ gte: 10, lte: 10 }))).toEqual([[10, "a", 1], [10, "b", 2]]);
    expect(await tree.getAugmentation({ gte: 10, lte: 10 })).toBe(3);

    tree = await tree.delete(10, "a");
    expect(await arrayFrom(tree.entries())).toEqual([[10, "b", 2], [11, "a", 4]]);
  });

  it("answers hasAny without materializing all entries for a key", async () => {
    const multiMapOptions = {
      ...options(8),
      entryIdComparator: stringCompare,
    };
    let tree = new AugmentedTreeMultiMap(multiMapOptions);

    expect(await tree.hasAny(10)).toBe(false);
    for (let i = 0; i < 1000; i++) tree = await tree.add(10, `id-${i}`, i);
    tree = await tree.add(11, "a", 1);

    expect(await tree.hasAny(10)).toBe(true);
    expect(await tree.hasAny(11)).toBe(true);
    expect(await tree.hasAny(12)).toBe(false);

    // hasAny must stay O(depth) even when many entries share the key; getAll here would load
    // all 1000 entries (hundreds of node reads).
    const counted = withMultiMapHeapCounters(tree, multiMapOptions);
    counted.reset();
    await counted.tree.hasAny(10);
    expect(counted.gets()).toBeLessThanOrEqual(8);
  });

  it("uses binary search for bounded range scans inside large nodes", async () => {
    let comparisons = 0;
    const countedOptions = {
      arity: 2048,
      comparator: (a: number, b: number) => {
        comparisons++;
        return a - b;
      },
      initialAugmentation: 0,
      extractAugmentation: (value: number) => value,
      mergeAugmentations: (...values: number[]) => values.reduce((sum, value) => sum + value, 0),
      entryIdComparator: stringCompare,
    };
    let tree = new AugmentedTreeMultiMap<number, number, number, string>(countedOptions);
    for (let i = 0; i < 1000; i++) tree = await tree.add(i, "", i);

    comparisons = 0;
    expect(await arrayFrom(tree.entries({ gte: 990, limit: 1 }))).toEqual([[990, "", 990]]);
    expect(comparisons).toBeLessThan(80);

    comparisons = 0;
    expect(await arrayFrom(tree.entries({ lte: 10, reverse: true, limit: 1 }))).toEqual([[10, "", 10]]);
    expect(comparisons).toBeLessThan(80);
  });

  it("keeps heap reads logarithmic for point operations", async () => {
    for (const size of [100, 1_000, 10_000]) {
      const counted = withHeapCounters(await build(size));
      const budget = Math.ceil(Math.log(size) / Math.log(32)) + 8;

      for (const [name, operation] of [
        ["get", () => counted.tree.get(Math.ceil(size / 2))],
        ["set", () => counted.tree.set(Math.ceil(size / 2), -1)],
        ["insert", () => counted.tree.set(size + 1, size + 1)],
        ["delete", () => counted.tree.delete(Math.ceil(size / 2))],
        ["point augmentation", () => counted.tree.getAugmentation({ gte: Math.ceil(size / 2), lte: Math.ceil(size / 2) })],
      ] as const) {
        counted.reset();
        await operation();
        expect(counted.gets(), `${name} heap reads at n=${size}`).toBeLessThanOrEqual(budget);
      }

      counted.reset();
      await counted.tree.size();
      expect(counted.gets()).toBe(0);

      counted.reset();
      await counted.tree.getAugmentation({});
      expect(counted.gets()).toBe(0);
    }
  });

  it("keeps heap writes logarithmic for updates", async () => {
    for (const size of [100, 1_000, 10_000]) {
      const tree = await build(size);
      const budget = Math.ceil(Math.log(size) / Math.log(32)) + 8;

      expect(await newHeapObjects(tree, await tree.set(Math.ceil(size / 2), -1))).toBeLessThanOrEqual(budget);
      expect(await newHeapObjects(tree, await tree.set(size + 1, size + 1))).toBeLessThanOrEqual(budget);
      expect(await newHeapObjects(tree, await tree.delete(Math.ceil(size / 2)))).toBeLessThanOrEqual(budget);
    }
  });

  it("uses subtree summaries for range operations", async () => {
    const tree = await build(10_000);
    const counted = withHeapCounters(tree);

    counted.reset();
    expect(await counted.tree.getAugmentation({})).toBe(50_005_000);
    expect(counted.gets()).toBe(0);

    counted.reset();
    expect(await counted.tree.getAugmentation({ gte: 2_500, lte: 7_500 })).toBe(25_005_000);
    expect(counted.gets()).toBeLessThanOrEqual(12);

    counted.reset();
    expect(await arrayFrom(counted.tree.entries({ gte: 5_000, limit: 100 }))).toHaveLength(100);
    expect(counted.gets()).toBeLessThanOrEqual(16);
  });
});

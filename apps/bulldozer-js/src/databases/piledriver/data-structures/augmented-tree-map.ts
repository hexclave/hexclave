import { asHeapObject, isPiledriverHeapObjectSymbol, PiledriverHeapObject, piledriverObjectEquals, PiledriverObject } from "../index.js";

type AsyncImmutableMap<K, V> = {
  get(key: K): Promise<V | undefined>,
  set(key: K, value: V): Promise<AsyncImmutableMap<K, V>>,
  delete(key: K): Promise<AsyncImmutableMap<K, V>>,
  has(key: K): Promise<boolean>,
  size(): Promise<number>,
  keys(): AsyncIterable<K>,
  values(): AsyncIterable<V>,
  entries(): AsyncIterable<[K, V]>,
};

type MaybePromise<T> = T | Promise<T>;
type Opt<K, V, A, I extends PiledriverObject = string> = {
  arity?: number,
  comparator: (a: K, b: K) => number,
  initialAugmentation?: A,
  extractAugmentation: (value: V, key: K, entryId: I) => MaybePromise<A>,
  mergeAugmentations: (...augmentations: A[]) => MaybePromise<A>,
};

// Internal marker for "no augmentation accumulated yet". A distinct sentinel (rather than
// null/undefined) is needed because null is a valid augmentation value.
const noAugmentation = Symbol("no-augmentation");
type NoAugmentation = typeof noAugmentation;
type Entry<K, V> = [K, V];
type Child<K, A> = { ref: PiledriverHeapObject, augmentation: A, size: number, entryCount: number, minKey: K, maxKey: K };
type StoredValue<V extends PiledriverObject> = V | PiledriverHeapObject;
type Split<K, V extends PiledriverObject, A> = { entry: Entry<K, StoredValue<V>>, right: Child<K, A> };
// Persisted B-tree node. Children are heap objects, so unchanged subtrees are shared across versions.
type Node<K, V extends PiledriverObject, A> = {
  // On-disk format version for this node. Absent (undefined) on nodes persisted before versioning
  // was introduced — those are treated as version 0. Bump `nodeFormatVersion` whenever a persisted
  // field is added/changed in a way that makes previously-written data unsafe to trust, and gate
  // the reads of that field on the version so old nodes keep deserialising correctly.
  version?: number,
  entries: Entry<K, StoredValue<V>>[],
  // Cached per-entry augmentations, parallel to `entries`. When a node is path-copied during a
  // mutation, unchanged entries (same tuple identity) can reuse their cached augmentation instead
  // of re-calling extractAugmentation. This avoids creating duplicate heap objects for the same
  // data, letting the downstream serializer recognise them as already-written (heap cache hits).
  // Only trusted when `version >= 1` (see `nodeFormatVersion`).
  entryAugmentations?: A[],
  children: Child<K, A>[],
  augmentation: A,
  size: number,
  minKey: K,
  maxKey: K,
};
type EntryOptions<K> = {
  lte?: K,
  gte?: K,
  lt?: K,
  gt?: K,
  limit?: number,
  reverse?: boolean,
};
type AugmentedTreeMapObject = {
  type: "AugmentedTreeMap",
  root: Child<PiledriverObject, PiledriverObject> | null,
};
type MultiMapOptions<K, V, A, I extends PiledriverObject> = Opt<K, V, A, I> & {
  entryIdComparator?: (a: I, b: I) => number,
};
type MultiKey<K extends PiledriverObject, I extends PiledriverObject> = {
  [key: string]: PiledriverObject,
  key: K,
  id: I,
};
type AugmentedTreeMultiMapObject = {
  type: "AugmentedTreeMultiMap",
  tree: PiledriverObject,
};

export type PersistedTreeIntegrityIssue = {
  code: string,
  message: string,
};

export function treeVerificationNodeLoadBudget(persistedSize: number): number {
  const size = Number.isSafeInteger(persistedSize) && persistedSize >= 0 ? persistedSize : 0;
  // Keep the work budget proportional to the persisted size; the high absolute ceiling only
  // protects against nonsense sizes, which are also caught by the recomputed-size invariant.
  return Math.min(10_000_000, size * 4 + 32);
}

const lowerEntryId = Symbol("lower-entry-id");
const upperEntryId = Symbol("upper-entry-id");
const mapEntryId = "";
const defaultArity = 32;
// Current on-disk B-tree node format version. Version 1 introduced cached per-entry augmentations
// (`entryAugmentations`). Nodes without a `version` field were written before versioning (version 0)
// and have their augmentations recomputed on read. See the `version` field on `Node`.
const nodeFormatVersion = 1;

// Code-unit comparisons; localeCompare would persist a tree whose order depends on the runtime locale.
function compareStrings(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function defaultEntryIdComparator<I extends PiledriverObject>(a: I, b: I) {
  return compareStrings(JSON.stringify(a), JSON.stringify(b));
}

function mapOptions<K extends PiledriverObject, V extends PiledriverObject, A extends PiledriverObject>(options: Opt<K, V, A, string>): MultiMapOptions<K, V, A, string> {
  return {
    ...options,
    entryIdComparator: compareStrings,
  };
}

export class AugmentedTreeMultiMap<Key extends PiledriverObject, Value extends PiledriverObject, Augmentation extends PiledriverObject, EntryId extends PiledriverObject = string> {
  constructor(
    private readonly options: MultiMapOptions<Key, Value, Augmentation, EntryId>,
    private readonly root: Child<MultiKey<Key, EntryId>, Augmentation> | null = null,
  ) {}

  async size() {
    return this.root?.size ?? 0;
  }

  async getEntry(key: Key, entryId: EntryId): Promise<Value | undefined> {
    return await this.getRaw({ key, id: entryId });
  }

  async getAll(key: Key): Promise<Array<[EntryId, Value]>> {
    const result: Array<[EntryId, Value]> = [];
    for await (const [, entryId, value] of this.entries({ gte: key, lte: key })) {
      result.push([entryId, value]);
    }
    return result;
  }

  // O(depth) existence check. Callers that only need to know whether *any* entry exists for a
  // key must use this instead of `getAll(key).length`: getAll materializes every entry, which
  // is O(n) when many entries share one key (e.g. null-ish join keys) and turns bulk ingestion
  // into O(n^2).
  async hasAny(key: Key): Promise<boolean> {
    for await (const _entry of this.entries({ gte: key, lte: key, limit: 1 })) return true;
    return false;
  }

  async add(key: Key, entryId: EntryId, value: Value) {
    return await this.insertRaw({ key, id: entryId }, value);
  }

  async set(key: Key, entryId: EntryId, value: Value) {
    return await this.setRaw({ key, id: entryId }, value);
  }

  async delete(key: Key, entryId: EntryId) {
    return await this.deleteRaw({ key, id: entryId });
  }

  async deleteAll(key: Key) {
    let result: AugmentedTreeMultiMap<Key, Value, Augmentation, EntryId> = this;
    for (const [entryId] of await this.getAll(key)) {
      result = await result.delete(key, entryId);
    }
    return result;
  }

  async *keys(options?: EntryOptions<Key>) {
    for await (const [key] of this.entries(options)) yield key;
  }

  async *values(options?: EntryOptions<Key>) {
    for await (const [, , value] of this.entries(options)) yield value;
  }

  async *entries(options: EntryOptions<Key> = {}): AsyncIterable<[Key, EntryId, Value]> {
    for await (const [multiKey, value] of this.rawEntries(this.indexRange(options))) {
      yield [multiKey.key, multiKey.id, value];
    }
  }

  async getAugmentation(range: { lte?: Key, gte?: Key, lt?: Key, gt?: Key }): Promise<Augmentation> {
    const result = await this.augmentation(this.root, this.indexRange(range));
    return result === noAugmentation ? await this.empty() : result;
  }

  toPiledriverObject(): AugmentedTreeMultiMapObject {
    return { type: "AugmentedTreeMultiMap", tree: this.toTreePiledriverObject() };
  }

  toTreePiledriverObject(): PiledriverObject {
    return { type: "AugmentedTreeMap", root: this.root };
  }

  async verifyDataIntegrity(): Promise<PersistedTreeIntegrityIssue[]> {
    const issues: PersistedTreeIntegrityIssue[] = [];
    if (this.root === null) return issues;
    type Summary = { height: number, size: number, entryCount: number, minKey: MultiKey<Key, EntryId>, maxKey: MultiKey<Key, EntryId>, augmentation: Augmentation };
    type Frame = { child: Child<MultiKey<Key, EntryId>, Augmentation>, node: Node<MultiKey<Key, EntryId>, Value, Augmentation>, path: number[], nextChild: number, children: Array<Summary | undefined> };
    const stack: Frame[] = [];
    const maxNodeLoads = treeVerificationNodeLoadBudget(this.root.size);
    let nodeLoads = 1;
    const loadFrame = async (child: Child<MultiKey<Key, EntryId>, Augmentation>, path: number[]): Promise<Frame> => {
      const node = await this.node(child.ref);
      if (node === null) throw new Error("Missing persisted tree node");
      return { child, node, path, nextChild: 0, children: [] };
    };
    let frame = await loadFrame(this.root, []);
    stack.push(frame);
    while (stack.length > 0) {
      frame = stack[stack.length - 1];
      if (frame.nextChild < frame.node.children.length) {
        const childIndex = frame.nextChild;
        frame.nextChild++;
        const child = frame.node.children[childIndex];
        if (nodeLoads >= maxNodeLoads) {
          issues.push({ code: "cycle", message: "A tree loaded more nodes than its persisted size can justify, indicating a cycle or corrupt structure" });
          break;
        }
        nodeLoads++;
        stack.push(await loadFrame(child, [...frame.path, childIndex]));
        continue;
      }
      const node = frame.node;
      const maxEntries = this.arity() - 1;
      if (frame.child.entryCount !== node.entries.length) issues.push({ code: "entry_count", message: "A tree child entry count does not match its node" });
      if (node.entries.length > maxEntries) issues.push({ code: "node_arity", message: "A tree node exceeds the maximum entry count" });
      if (frame.path.length > 0 && node.entries.length < this.minEntries()) issues.push({ code: "node_occupancy", message: "A non-root tree node has too few entries" });
      if (node.children.length > 0 && node.children.length !== node.entries.length + 1) issues.push({ code: "children_count", message: "A tree node must have one more child than entries" });
      for (let index = 1; index < node.entries.length; index++) {
        if (this.compareKeys(node.entries[index - 1][0], node.entries[index][0]) >= 0) issues.push({ code: "key_order", message: "Tree entries are not strictly ordered" });
      }
      const heights = frame.children.flatMap(child => child === undefined ? [] : [child.height]);
      if (heights.some(height => height !== heights[0])) issues.push({ code: "child_height", message: "Tree children do not have equal heights" });
      const augmentations: Augmentation[] = [];
      let size = node.entries.length;
      let entryCount = node.entries.length;
      for (let index = 0; index < node.entries.length; index++) {
        const child = frame.children[index];
        if (child !== undefined) {
          augmentations.push(child.augmentation);
          size += child.size;
          entryCount += child.entryCount;
          if (index > 0 && this.compareKeys(child.minKey, node.entries[index - 1][0]) <= 0) issues.push({ code: "key_boundary", message: "A child key range crosses its previous parent entry" });
          if (this.compareKeys(child.maxKey, node.entries[index][0]) >= 0) issues.push({ code: "key_boundary", message: "A child key range crosses its parent entry" });
        }
        const value = await this.loadValue(node.entries[index][1]);
        const entryAugmentation = await this.options.extractAugmentation(value, node.entries[index][0].key, node.entries[index][0].id);
        const persistedEntryAugmentation = (node.version ?? 0) >= 1 ? node.entryAugmentations?.[index] : undefined;
        if (persistedEntryAugmentation !== undefined && !piledriverObjectEquals(persistedEntryAugmentation, entryAugmentation)) {
          issues.push({ code: "entry_augmentation", message: "A persisted entry augmentation does not match its recomputation" });
        }
        augmentations.push(entryAugmentation);
      }
      const lastChild = frame.children[node.entries.length];
      if (frame.children.length > node.entries.length && lastChild !== undefined) {
        augmentations.push(lastChild.augmentation);
        size += lastChild.size;
        entryCount += lastChild.entryCount;
        if (node.entries.length > 0 && this.compareKeys(node.entries[node.entries.length - 1][0], lastChild.minKey) >= 0) issues.push({ code: "key_boundary", message: "A child key range crosses its parent entry" });
      }
      const augmentation = await this.options.mergeAugmentations(...augmentations);
      if (!piledriverObjectEquals(node.augmentation, augmentation)) issues.push({ code: "augmentation", message: "Persisted tree augmentation does not match its recomputation" });
      if (node.size !== size) issues.push({ code: "size", message: "A tree node size does not match its contents" });
      const firstChild = frame.children.find(child => child !== undefined);
      const summary: Summary = {
        height: (heights[0] ?? 0) + 1,
        size,
        entryCount,
        minKey: firstChild === undefined ? node.entries[0]?.[0] ?? node.minKey : firstChild.minKey,
        maxKey: lastChild === undefined ? node.entries[node.entries.length - 1]?.[0] ?? node.maxKey : lastChild.maxKey,
        augmentation,
      };
      stack.pop();
      const compareChild = (persistedChild: Child<MultiKey<Key, EntryId>, Augmentation>) => {
        if (persistedChild.size !== summary.size) issues.push({ code: "child_size", message: "A persisted child size does not match its contents" });
        if (!piledriverObjectEquals(persistedChild.minKey, summary.minKey)) issues.push({ code: "child_min_key", message: "A persisted child minimum key does not match its contents" });
        if (!piledriverObjectEquals(persistedChild.maxKey, summary.maxKey)) issues.push({ code: "child_max_key", message: "A persisted child maximum key does not match its contents" });
        if (!piledriverObjectEquals(persistedChild.augmentation, summary.augmentation)) issues.push({ code: "child_augmentation", message: "A persisted child augmentation does not match its contents" });
      };
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        const childIndex = frame.path[frame.path.length - 1];
        const persistedChild = parent.node.children[childIndex];
        compareChild(persistedChild);
        parent.children.push(summary);
      } else {
        compareChild(frame.child);
      }
    }
    return issues;
  }

  static fromPiledriverObject<K extends PiledriverObject, V extends PiledriverObject, A extends PiledriverObject, I extends PiledriverObject = string>(object: PiledriverObject, options: MultiMapOptions<K, V, A, I>) {
    const serialized = object as Partial<AugmentedTreeMultiMapObject>;
    if (!object || typeof object !== "object" || Array.isArray(object) || serialized.type !== "AugmentedTreeMultiMap") {
      throw new Error("Invalid AugmentedTreeMultiMap object");
    }
    return AugmentedTreeMultiMap.fromTreePiledriverObject(serialized.tree!, options);
  }

  static fromTreePiledriverObject<K extends PiledriverObject, V extends PiledriverObject, A extends PiledriverObject, I extends PiledriverObject = string>(object: PiledriverObject, options: MultiMapOptions<K, V, A, I>) {
    const serialized = object as Partial<AugmentedTreeMapObject>;
    if (!object || typeof object !== "object" || Array.isArray(object) || serialized.type !== "AugmentedTreeMap") {
      throw new Error("Invalid AugmentedTreeMap object");
    }

    const root = serialized.root;
    if (root !== null && !AugmentedTreeMultiMap.isChild(root)) {
      throw new Error("Invalid AugmentedTreeMap root");
    }

    return new AugmentedTreeMultiMap(options, root as Child<MultiKey<K, I>, A> | null);
  }

  private async getRaw(key: MultiKey<Key, EntryId>): Promise<Value | undefined> {
    for (let node = await this.node(this.root?.ref ?? null); node;) {
      const { index, found } = this.search(node.entries, key);
      if (found) return await this.loadValue(node.entries[index][1]);
      node = await this.node(node.children[index]?.ref ?? null);
    }
  }

  private async setRaw(key: MultiKey<Key, EntryId>, value: Value) {
    return new AugmentedTreeMultiMap(this.options, await this.finishUpsert(await this.upsert(this.root?.ref ?? null, key, value, true)));
  }

  private async insertRaw(key: MultiKey<Key, EntryId>, value: Value) {
    return new AugmentedTreeMultiMap(this.options, await this.finishUpsert(await this.upsert(this.root?.ref ?? null, key, value, false)));
  }

  private async deleteRaw(key: MultiKey<Key, EntryId>) {
    const { root, deleted } = await this.deleteFrom(this.root, key, true);
    return deleted ? new AugmentedTreeMultiMap(this.options, root) : this;
  }

  private async *rawEntries(options: EntryOptions<MultiKey<Key, EntryId>> = {}): AsyncIterable<[MultiKey<Key, EntryId>, Value]> {
    let yielded = 0;
    const lowerBound = this.tighterLowerBound(options.gte, options.gt);
    const upperBound = this.tighterUpperBound(options.lte, options.lt);
    const isInRange = (key: MultiKey<Key, EntryId>) =>
      (options.gte === undefined || this.compareKeys(key, options.gte) >= 0)
      && (options.gt === undefined || this.compareKeys(key, options.gt) > 0)
      && (options.lte === undefined || this.compareKeys(key, options.lte) <= 0)
      && (options.lt === undefined || this.compareKeys(key, options.lt) < 0);

    const walk = async function* (tree: AugmentedTreeMultiMap<Key, Value, Augmentation, EntryId>, child: Child<MultiKey<Key, EntryId>, Augmentation> | null): AsyncIterable<Entry<MultiKey<Key, EntryId>, Value>> {
      if (!child || (options.limit !== undefined && yielded >= options.limit) || !tree.overlaps(child, options)) return;
      const node = (await tree.node(child.ref))!;

      const visitEntry = async function* (entry: Entry<MultiKey<Key, EntryId>, StoredValue<Value>>): AsyncIterable<Entry<MultiKey<Key, EntryId>, Value>> {
        if (isInRange(entry[0]) && (options.limit === undefined || yielded++ < options.limit)) yield [entry[0], await tree.loadValue(entry[1])];
      };

      const startIndex = lowerBound === undefined ? 0 : tree.lowerBoundIndex(node.entries, lowerBound);
      const endIndex = upperBound === undefined ? node.entries.length : tree.lowerBoundIndex(node.entries, upperBound);

      if (options.reverse) {
        yield* walk(tree, node.children[endIndex] ?? null);
        for (let i = endIndex - 1; i >= startIndex; i--) {
          yield* visitEntry(node.entries[i]);
          yield* walk(tree, node.children[i] ?? null);
        }
      } else {
        for (let i = startIndex; i < endIndex; i++) {
          yield* walk(tree, node.children[i] ?? null);
          yield* visitEntry(node.entries[i]);
        }
        yield* walk(tree, node.children[endIndex] ?? null);
      }
    };

    yield* walk(this, this.root);
  }

  private static isChild(value: PiledriverObject | undefined): value is Child<PiledriverObject, PiledriverObject> {
    if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const child = value as Partial<Child<PiledriverObject, PiledriverObject>>;
    return typeof child.size === "number"
      && typeof child.entryCount === "number"
      && "augmentation" in value
      && "minKey" in value
      && "maxKey" in value
      && child.ref !== undefined
      && typeof child.ref === "object"
      && !Array.isArray(child.ref)
      && isPiledriverHeapObjectSymbol in child.ref;
  }

  private async node(heapObject: PiledriverHeapObject | null) {
    return heapObject ? await heapObject.get() as Node<MultiKey<Key, EntryId>, Value, Augmentation> : null;
  }

  private storeValue(value: Value): StoredValue<Value> {
    return value !== null && typeof value === "object" ? asHeapObject(value) : value;
  }

  private async loadValue(value: StoredValue<Value>): Promise<Value> {
    return value !== null && typeof value === "object" && isPiledriverHeapObjectSymbol in value ? await value.get() as Value : value;
  }

  private async empty() {
    return this.options.initialAugmentation !== undefined ? this.options.initialAugmentation : await this.options.mergeAugmentations();
  }

  private async merge(a: Augmentation | NoAugmentation, b: Augmentation | NoAugmentation) {
    if (a === noAugmentation) return b;
    if (b === noAugmentation) return a;
    return await this.options.mergeAugmentations(a, b);
  }

  private child(ref: PiledriverHeapObject, node: Node<MultiKey<Key, EntryId>, Value, Augmentation>): Child<MultiKey<Key, EntryId>, Augmentation> {
    return {
      ref,
      augmentation: node.augmentation,
      size: node.size,
      entryCount: node.entries.length,
      minKey: node.minKey,
      maxKey: node.maxKey,
    };
  }

  // Recomputes all cached metadata for a freshly path-copied node.
  // cachedEntryAugs: when provided, maps entry tuple references to their previously computed
  // augmentations. Unchanged entries (same tuple identity) get a cache hit, avoiding a redundant
  // extractAugmentation call and — critically — reusing the same PiledriverHeapObjects so that
  // downstream serialization sees them as already-written (heap object cache hits).
  private async make(entries: Entry<MultiKey<Key, EntryId>, StoredValue<Value>>[], children: Child<MultiKey<Key, EntryId>, Augmentation>[] = [], cachedEntryAugs?: ReadonlyMap<object, Augmentation>) {
    if (!entries.length && children.length !== 1) throw new Error("Invalid empty B-tree node");
    if (!entries.length) {
      const [onlyChild] = children;
      const node = {
        version: nodeFormatVersion,
        entries,
        children,
        augmentation: onlyChild.augmentation,
        size: onlyChild.size,
        minKey: onlyChild.minKey,
        maxKey: onlyChild.maxKey,
      };
      return this.child(asHeapObject(node as PiledriverObject), node);
    }

    const augmentations: Augmentation[] = [];
    const entryAugmentations: Augmentation[] = [];
    let size = entries.length;

    for (let i = 0; i < entries.length; i++) {
      const child = children.at(i);
      if (child) {
        augmentations.push(child.augmentation);
        size += child.size;
      }
      const cached = cachedEntryAugs?.get(entries[i]);
      const entryAug = cached !== undefined
        ? cached
        : await this.options.extractAugmentation(await this.loadValue(entries[i][1]), entries[i][0].key, entries[i][0].id);
      entryAugmentations.push(entryAug);
      augmentations.push(entryAug);
    }
    const lastChild = children.at(entries.length);
    if (lastChild) {
      augmentations.push(lastChild.augmentation);
      size += lastChild.size;
    }

    const node = {
      version: nodeFormatVersion,
      entries,
      entryAugmentations,
      children,
      augmentation: await this.options.mergeAugmentations(...augmentations),
      size,
      minKey: children[0]?.minKey ?? entries[0][0],
      maxKey: children[children.length - 1]?.maxKey ?? entries[entries.length - 1][0],
    };
    return this.child(asHeapObject(node as PiledriverObject), node);
  }

  // Builds a Map from entry tuple references to their cached augmentations, enabling O(1) lookups
  // during make(). Returns undefined if the node has no cached augmentations (e.g. old format).
  private buildEntryAugCache(node: Node<MultiKey<Key, EntryId>, Value, Augmentation>): ReadonlyMap<object, Augmentation> | undefined {
    if ((node.version ?? 0) < 1) return undefined;
    if (!node.entryAugmentations || node.entryAugmentations.length !== node.entries.length) return undefined;
    const cache = new Map<object, Augmentation>();
    for (let i = 0; i < node.entries.length; i++) {
      cache.set(node.entries[i], node.entryAugmentations[i]);
    }
    return cache;
  }

  // Combines a parent entry-aug cache (for the separator entry) with a child node's cache into a
  // single map for make(). Used by borrow paths where the receiving node is built from a parent
  // separator plus a child's entries.
  private combineCaches(
    parentCache: ReadonlyMap<object, Augmentation> | undefined,
    separator: Entry<MultiKey<Key, EntryId>, StoredValue<Value>>,
    childCache: ReadonlyMap<object, Augmentation> | undefined,
  ): ReadonlyMap<object, Augmentation> | undefined {
    const sepAug = parentCache?.get(separator);
    if (sepAug === undefined && !childCache) return undefined;
    const combined = new Map<object, Augmentation>();
    if (childCache) for (const [e, a] of childCache) combined.set(e, a);
    if (sepAug !== undefined) combined.set(separator, sepAug);
    return combined;
  }

  private arity() {
    return Math.max(3, this.options.arity ?? defaultArity);
  }

  private maxEntries() {
    return this.arity() - 1;
  }

  private minEntries() {
    return Math.floor(this.maxEntries() / 2);
  }

  private search(entries: Entry<MultiKey<Key, EntryId>, StoredValue<Value>>[], key: MultiKey<Key, EntryId>) {
    const low = this.lowerBoundIndex(entries, key);
    return { index: low, found: low < entries.length && this.compareKeys(entries[low][0], key) === 0 };
  }

  private lowerBoundIndex(entries: Entry<MultiKey<Key, EntryId>, StoredValue<Value>>[], key: MultiKey<Key, EntryId>) {
    let low = 0, high = entries.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.compareKeys(entries[mid][0], key) < 0) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private tighterLowerBound(a: MultiKey<Key, EntryId> | undefined, b: MultiKey<Key, EntryId> | undefined) {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return this.compareKeys(a, b) >= 0 ? a : b;
  }

  private tighterUpperBound(a: MultiKey<Key, EntryId> | undefined, b: MultiKey<Key, EntryId> | undefined) {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return this.compareKeys(a, b) <= 0 ? a : b;
  }

  private async finishUpsert(result: { root: Child<MultiKey<Key, EntryId>, Augmentation>, split?: Split<MultiKey<Key, EntryId>, Value, Augmentation> }) {
    return result.split ? await this.make([result.split.entry], [result.root, result.split.right]) : result.root;
  }

  private async split(entries: Entry<MultiKey<Key, EntryId>, StoredValue<Value>>[], children: Child<MultiKey<Key, EntryId>, Augmentation>[], cachedEntryAugs?: ReadonlyMap<object, Augmentation>) {
    const middle = entries.length >> 1;
    const left = await this.make(entries.slice(0, middle), children.length ? children.slice(0, middle + 1) : [], cachedEntryAugs);
    const right = await this.make(entries.slice(middle + 1), children.length ? children.slice(middle + 1) : [], cachedEntryAugs);
    return { root: left, split: { entry: entries[middle], right } };
  }

  private async done(entries: Entry<MultiKey<Key, EntryId>, StoredValue<Value>>[], children: Child<MultiKey<Key, EntryId>, Augmentation>[], added: boolean, cachedEntryAugs?: ReadonlyMap<object, Augmentation>) {
    const result = entries.length > this.maxEntries() ? await this.split(entries, children, cachedEntryAugs) : { root: await this.make(entries, children, cachedEntryAugs) };
    return { ...result, added };
  }

  private async upsert(heapObject: PiledriverHeapObject | null, key: MultiKey<Key, EntryId>, value: Value, replace: boolean): Promise<{ root: Child<MultiKey<Key, EntryId>, Augmentation>, split?: Split<MultiKey<Key, EntryId>, Value, Augmentation>, added: boolean }> {
    const node = await this.node(heapObject);
    if (!node) return { root: await this.make([[key, this.storeValue(value)]]), added: true };

    const { index, found } = this.search(node.entries, key);
    const entries = [...node.entries];
    const children = [...node.children];
    const cachedEntryAugs = this.buildEntryAugCache(node);

    if (found) {
      if (!replace) throw new Error("Key already exists");
      entries[index] = [key, this.storeValue(value)];
      return await this.done(entries, children, false, cachedEntryAugs);
    }

    if (!children.length) {
      entries.splice(index, 0, [key, this.storeValue(value)]);
      return await this.done(entries, children, true, cachedEntryAugs);
    }

    const child = await this.upsert(children[index].ref, key, value, replace);
    children[index] = child.root;
    if (child.split) {
      entries.splice(index, 0, child.split.entry);
      children.splice(index + 1, 0, child.split.right);
    }
    return await this.done(entries, children, child.added, cachedEntryAugs);
  }

  private async deleteFrom(child: Child<MultiKey<Key, EntryId>, Augmentation> | null, key: MultiKey<Key, EntryId>, isRoot = false): Promise<{ root: Child<MultiKey<Key, EntryId>, Augmentation> | null, deleted: boolean }> {
    if (!child) return { root: null, deleted: false };

    const node = (await this.node(child.ref))!;
    const { index, found } = this.search(node.entries, key);
    const entries = [...node.entries];
    const children = [...node.children] as (Child<MultiKey<Key, EntryId>, Augmentation> | null)[];
    const cachedEntryAugs = this.buildEntryAugCache(node);

    if (found) {
      if (!children.length) {
        entries.splice(index, 1);
        return await this.afterDelete(entries, children, isRoot, true, cachedEntryAugs);
      }

      // Replace the separator with its predecessor or successor (from whichever side has more
      // slack), then rebalance that child if it underflowed. Never pre-merge two minimally
      // filled children: the result would have 2 * minEntries + 1 entries, which overflows
      // maxEntries when maxEntries is even.
      const left = children[index]!;
      const right = children[index + 1]!;
      if (right.entryCount > left.entryCount) {
        const { root, entry } = await this.deleteMin(right);
        entries[index] = entry;
        children[index + 1] = root;
        return await this.fixChild(entries, children, index + 1, isRoot, cachedEntryAugs);
      }
      const { root, entry } = await this.deleteMax(left);
      entries[index] = entry;
      children[index] = root;
      return await this.fixChild(entries, children, index, isRoot, cachedEntryAugs);
    }

    if (!children.length) return { root: child, deleted: false };

    const deletedChild = await this.deleteFrom(children[index], key);
    if (!deletedChild.deleted) return { root: child, deleted: false };
    children[index] = deletedChild.root;
    return await this.fixChild(entries, children, index, isRoot, cachedEntryAugs);
  }

  private async deleteMin(child: Child<MultiKey<Key, EntryId>, Augmentation>): Promise<{ root: Child<MultiKey<Key, EntryId>, Augmentation> | null, entry: Entry<MultiKey<Key, EntryId>, StoredValue<Value>> }> {
    const node = (await this.node(child.ref))!;
    const entries = [...node.entries];
    const children = [...node.children] as (Child<MultiKey<Key, EntryId>, Augmentation> | null)[];
    const cachedEntryAugs = this.buildEntryAugCache(node);

    if (!children.length) {
      const [entry] = entries.splice(0, 1);
      return { root: entries.length ? await this.make(entries, [], cachedEntryAugs) : null, entry };
    }

    const result = await this.deleteMin(children[0]!);
    children[0] = result.root;
    return { root: (await this.fixChild(entries, children, 0, false, cachedEntryAugs)).root, entry: result.entry };
  }

  private async deleteMax(child: Child<MultiKey<Key, EntryId>, Augmentation>): Promise<{ root: Child<MultiKey<Key, EntryId>, Augmentation> | null, entry: Entry<MultiKey<Key, EntryId>, StoredValue<Value>> }> {
    const node = (await this.node(child.ref))!;
    const entries = [...node.entries];
    const children = [...node.children] as (Child<MultiKey<Key, EntryId>, Augmentation> | null)[];
    const cachedEntryAugs = this.buildEntryAugCache(node);

    if (!children.length) {
      const entry = entries.pop()!;
      return { root: entries.length ? await this.make(entries, [], cachedEntryAugs) : null, entry };
    }

    const index = children.length - 1;
    const result = await this.deleteMax(children[index]!);
    children[index] = result.root;
    return { root: (await this.fixChild(entries, children, index, false, cachedEntryAugs)).root, entry: result.entry };
  }

  private async afterDelete(entries: Entry<MultiKey<Key, EntryId>, StoredValue<Value>>[], children: (Child<MultiKey<Key, EntryId>, Augmentation> | null)[], isRoot: boolean, deleted: boolean, cachedEntryAugs?: ReadonlyMap<object, Augmentation>) {
    const liveChildren = children.filter(child => child !== null);
    if (!entries.length) return { root: isRoot ? liveChildren[0] ?? null : liveChildren[0] ? await this.make([], [liveChildren[0]]) : null, deleted };
    return { root: await this.make(entries, liveChildren, cachedEntryAugs), deleted };
  }

  private async fixChild(entries: Entry<MultiKey<Key, EntryId>, StoredValue<Value>>[], children: (Child<MultiKey<Key, EntryId>, Augmentation> | null)[], index: number, isRoot: boolean, cachedEntryAugs?: ReadonlyMap<object, Augmentation>): Promise<{ root: Child<MultiKey<Key, EntryId>, Augmentation> | null, deleted: boolean }> {
    const child = children[index];
    if (child && child.entryCount >= this.minEntries()) return await this.afterDelete(entries, children, isRoot, true, cachedEntryAugs);

    const left = children[index - 1];
    if (left && left.entryCount > this.minEntries()) {
      const leftNode = (await this.node(left.ref))!;
      const loadedChild = child ? (await this.node(child.ref))! : undefined;
      const childNode = loadedChild ?? { entries: [] as Entry<MultiKey<Key, EntryId>, StoredValue<Value>>[], children: [] as Child<MultiKey<Key, EntryId>, Augmentation>[] };
      const separator = entries[index - 1];
      const borrowedEntry = leftNode.entries[leftNode.entries.length - 1];
      const borrowedChild = leftNode.children.at(-1);
      entries[index - 1] = borrowedEntry;
      children[index - 1] = await this.make(leftNode.entries.slice(0, -1), leftNode.children.slice(0, -1), this.buildEntryAugCache(leftNode));
      const borrowRecvCache = this.combineCaches(cachedEntryAugs, separator, loadedChild ? this.buildEntryAugCache(loadedChild) : undefined);
      children[index] = await this.make([separator, ...childNode.entries], borrowedChild === undefined ? childNode.children : [borrowedChild, ...childNode.children], borrowRecvCache);
      return await this.afterDelete(entries, children, isRoot, true, cachedEntryAugs);
    }

    const right = children[index + 1];
    if (right && right.entryCount > this.minEntries()) {
      const loadedChild = child ? (await this.node(child.ref))! : undefined;
      const childNode = loadedChild ?? { entries: [] as Entry<MultiKey<Key, EntryId>, StoredValue<Value>>[], children: [] as Child<MultiKey<Key, EntryId>, Augmentation>[] };
      const rightNode = (await this.node(right.ref))!;
      const separator = entries[index];
      const borrowedEntry = rightNode.entries[0];
      const borrowedChild = rightNode.children.at(0);
      entries[index] = borrowedEntry;
      const borrowRecvCache = this.combineCaches(cachedEntryAugs, separator, loadedChild ? this.buildEntryAugCache(loadedChild) : undefined);
      children[index] = await this.make([...childNode.entries, separator], borrowedChild === undefined ? childNode.children : [...childNode.children, borrowedChild], borrowRecvCache);
      children[index + 1] = await this.make(rightNode.entries.slice(1), rightNode.children.slice(1), this.buildEntryAugCache(rightNode));
      return await this.afterDelete(entries, children, isRoot, true, cachedEntryAugs);
    }

    const mergeIndex = left ? index - 1 : index;
    const merged = await this.mergeChildren(children[mergeIndex], entries[mergeIndex], children[mergeIndex + 1], cachedEntryAugs);
    entries.splice(mergeIndex, 1);
    children.splice(mergeIndex, 2, merged);
    return await this.afterDelete(entries, children, isRoot, true, cachedEntryAugs);
  }

  private async mergeChildren(left: Child<MultiKey<Key, EntryId>, Augmentation> | null, entry: Entry<MultiKey<Key, EntryId>, StoredValue<Value>>, right: Child<MultiKey<Key, EntryId>, Augmentation> | null, parentEntryAugs?: ReadonlyMap<object, Augmentation>) {
    const leftNode = left ? (await this.node(left.ref))! : null;
    const rightNode = right ? (await this.node(right.ref))! : null;

    // Build a combined entry augmentation cache from both child nodes and the parent separator
    const cache = new Map<object, Augmentation>();
    if (leftNode) {
      const lc = this.buildEntryAugCache(leftNode);
      if (lc) for (const [e, a] of lc) cache.set(e, a);
    }
    if (rightNode) {
      const rc = this.buildEntryAugCache(rightNode);
      if (rc) for (const [e, a] of rc) cache.set(e, a);
    }
    const sepAug = parentEntryAugs?.get(entry);
    if (sepAug !== undefined) cache.set(entry, sepAug);

    return await this.make(
      [...(leftNode?.entries ?? []), entry, ...(rightNode?.entries ?? [])],
      [...(leftNode?.children ?? []), ...(rightNode?.children ?? [])],
      cache.size ? cache : undefined,
    );
  }

  private async augmentation(child: Child<MultiKey<Key, EntryId>, Augmentation> | null, range: { lte?: MultiKey<Key, EntryId>, gte?: MultiKey<Key, EntryId>, lt?: MultiKey<Key, EntryId>, gt?: MultiKey<Key, EntryId> }): Promise<Augmentation | NoAugmentation> {
    if (!child || !this.overlaps(child, range)) return noAugmentation;

    const aboveLowerBound = (key: MultiKey<Key, EntryId>) =>
      (range.gte === undefined || this.compareKeys(key, range.gte) >= 0)
      && (range.gt === undefined || this.compareKeys(key, range.gt) > 0);
    const belowUpperBound = (key: MultiKey<Key, EntryId>) =>
      (range.lte === undefined || this.compareKeys(key, range.lte) <= 0)
      && (range.lt === undefined || this.compareKeys(key, range.lt) < 0);

    // min/max let us use a whole subtree's cached augmentation without reading descendants.
    if (aboveLowerBound(child.minKey) && belowUpperBound(child.maxKey)) return child.augmentation;

    const node = (await this.node(child.ref))!;
    let result: Augmentation | NoAugmentation = noAugmentation;
    for (let i = 0; i < node.entries.length; i++) {
      result = await this.merge(result, await this.augmentation(node.children[i] ?? null, range));
      if (aboveLowerBound(node.entries[i][0]) && belowUpperBound(node.entries[i][0])) {
        // Trust the cached augmentation only for versioned nodes, and check `!== undefined` (not
        // `??`) so a legitimately-cached `null` augmentation is still a hit rather than re-extracted.
        const cachedEntryAug = (node.version ?? 0) >= 1 ? node.entryAugmentations?.[i] : undefined;
        const entryAug = cachedEntryAug !== undefined
          ? cachedEntryAug
          : await this.options.extractAugmentation(await this.loadValue(node.entries[i][1]), node.entries[i][0].key, node.entries[i][0].id);
        result = await this.merge(result, entryAug);
      }
    }
    return await this.merge(result, await this.augmentation(node.children[node.entries.length] ?? null, range));
  }

  private overlaps(summary: { minKey: MultiKey<Key, EntryId>, maxKey: MultiKey<Key, EntryId> }, range: { lte?: MultiKey<Key, EntryId>, gte?: MultiKey<Key, EntryId>, lt?: MultiKey<Key, EntryId>, gt?: MultiKey<Key, EntryId> }) {
    return (range.gte === undefined || this.compareKeys(summary.maxKey, range.gte) >= 0)
      && (range.gt === undefined || this.compareKeys(summary.maxKey, range.gt) > 0)
      && (range.lte === undefined || this.compareKeys(summary.minKey, range.lte) <= 0)
      && (range.lt === undefined || this.compareKeys(summary.minKey, range.lt) < 0);
  }

  private compareEntryIds(a: EntryId | typeof lowerEntryId | typeof upperEntryId, b: EntryId | typeof lowerEntryId | typeof upperEntryId) {
    if (a === b) return 0;
    if (a === lowerEntryId || b === upperEntryId) return -1;
    if (a === upperEntryId || b === lowerEntryId) return 1;
    return (this.options.entryIdComparator ?? defaultEntryIdComparator)(a, b);
  }

  private compareKeys(a: MultiKey<Key, EntryId>, b: MultiKey<Key, EntryId>) {
    const keyComparison = this.options.comparator(a.key, b.key);
    return keyComparison || this.compareEntryIds(a.id, b.id);
  }

  private indexRange(range: { lte?: Key, gte?: Key, lt?: Key, gt?: Key, limit?: number, reverse?: boolean }) {
    return {
      ...range,
      gte: range.gte === undefined ? undefined : { key: range.gte, id: lowerEntryId } as unknown as MultiKey<Key, EntryId>,
      gt: range.gt === undefined ? undefined : { key: range.gt, id: upperEntryId } as unknown as MultiKey<Key, EntryId>,
      lte: range.lte === undefined ? undefined : { key: range.lte, id: upperEntryId } as unknown as MultiKey<Key, EntryId>,
      lt: range.lt === undefined ? undefined : { key: range.lt, id: lowerEntryId } as unknown as MultiKey<Key, EntryId>,
      limit: range.limit,
      reverse: range.reverse,
    };
  }
}

export class AugmentedTreeMap<K extends PiledriverObject, V extends PiledriverObject, A extends PiledriverObject> implements AsyncImmutableMap<K, V> {
  constructor(
    private readonly options: Opt<K, V, A, string>,
    root: Child<PiledriverObject, PiledriverObject> | null = null,
    private readonly multiMap = root
      ? AugmentedTreeMultiMap.fromTreePiledriverObject({ type: "AugmentedTreeMap", root }, mapOptions(options))
      : new AugmentedTreeMultiMap(mapOptions(options)),
  ) {}

  async size() {
    return await this.multiMap.size();
  }

  async has(key: K) {
    return await this.get(key) !== undefined;
  }

  async get(key: K): Promise<V | undefined> {
    return await this.multiMap.getEntry(key, mapEntryId);
  }

  async set(key: K, value: V) {
    return new AugmentedTreeMap(this.options, null, await this.multiMap.set(key, mapEntryId, value));
  }

  async insert(key: K, value: V) {
    return new AugmentedTreeMap(this.options, null, await this.multiMap.add(key, mapEntryId, value));
  }

  async delete(key: K) {
    return new AugmentedTreeMap(this.options, null, await this.multiMap.delete(key, mapEntryId));
  }

  async *keys(options?: EntryOptions<K>) {
    for await (const [key] of this.entries(options)) yield key;
  }

  async *values(options?: EntryOptions<K>) {
    for await (const [, value] of this.entries(options)) yield value;
  }

  async *entries(options?: EntryOptions<K>): AsyncIterable<[K, V]> {
    for await (const [key, , value] of this.multiMap.entries(options)) {
      yield [key, value];
    }
  }

  async getAugmentation(range: { lte?: K, gte?: K, lt?: K, gt?: K }): Promise<A> {
    return await this.multiMap.getAugmentation(range);
  }

  async verifyDataIntegrity(): Promise<PersistedTreeIntegrityIssue[]> {
    return await this.multiMap.verifyDataIntegrity();
  }

  toPiledriverObject(): AugmentedTreeMapObject {
    return this.multiMap.toTreePiledriverObject() as AugmentedTreeMapObject;
  }

  static fromPiledriverObject<K extends PiledriverObject, V extends PiledriverObject, A extends PiledriverObject>(object: PiledriverObject, options: Opt<K, V, A, string>) {
    const multiMap = AugmentedTreeMultiMap.fromTreePiledriverObject(object, mapOptions(options));
    return new AugmentedTreeMap(options, null, multiMap);
  }
}

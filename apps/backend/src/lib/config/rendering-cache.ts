/**
 * Per-instance memoization of the CPU-heavy steps of config rendering.
 *
 * This is purely a CPU optimization; it does not change what any config query returns. The stored config overrides
 * are still read from the database on every request (so there is no staleness and no cross-instance invalidation to
 * worry about), but turning them into a rendered config — migrating each override, sanity-checking it against the yup
 * schema, merging the levels, applying defaults, normalizing and sanitizing — used to be the single largest CPU cost
 * of the backend, re-done on every request even though overrides rarely change and most traffic hits few projects.
 *
 * How it works:
 *
 * 1. Each stored override is interned per tenancy and level, together with a hash of its JSON content. As long as the
 *    content is unchanged, the same canonical (migrated) object is returned. Entries live in a bounded LRU.
 * 2. Every later step is a pure function of canonical objects, so it is memoized by object identity in WeakMaps.
 *    Those entries live exactly as long as the canonical objects they were derived from, so the LRU in step 1 bounds
 *    the memory of the whole cache, and a changed override automatically produces fresh results downstream.
 *
 * Nothing is shared between tenancies (see {@link ConfigOverrideScope}), but cached values are shared between
 * concurrent requests of the same tenancy, so they are deeply frozen. A caller that tries to mutate one gets a
 * TypeError (all our modules are strict mode) instead of silently leaking its change into other requests.
 */
import { migrateConfigOverride } from "@hexclave/shared/dist/config/schema";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { deepPlainFreeze } from "@hexclave/shared/dist/utils/objects";
import { createHash } from "node:crypto";

/**
 * Upper bound on interned overrides per instance. Each tenancy contributes one entry per level (four), so this covers
 * about a thousand tenancies, comfortably more than the working set of an instance, while bounding worst-case memory.
 */
const MAX_INTERNED_CONFIG_OVERRIDES = 4_000;

/**
 * Map that evicts the least-recently-used entry once it holds more than `maxSize` entries.
 *
 * Values may not be `undefined`, so that `get` returning `undefined` unambiguously means "not present".
 */
export class LruMap<K, V extends {} | null> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new HexclaveAssertionError("LruMap maxSize must be a positive integer", { maxSize });
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Maps iterate in insertion order, so re-inserting moves the key to the most-recently-used end.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxSize) {
      const oldestKey = this.entries.keys().next();
      if (oldestKey.done === true) {
        throw new HexclaveAssertionError("LruMap is over capacity but has no entries; this should never happen");
      }
      this.entries.delete(oldestKey.value);
    }
  }
}

type IdentityMemoNode<V> = {
  readonly children: WeakMap<object, IdentityMemoNode<V>>,
  value: Promise<V> | undefined,
};

/**
 * Memoizes async computations keyed by a tuple of object identities, deep-freezing every result.
 *
 * Entries are held weakly through their keys: once any key object is garbage-collected, the entry goes with it.
 * Concurrent callers with the same keys share one in-flight computation; a rejected computation is evicted so it is
 * retried on the next call rather than cached.
 */
export class FrozenIdentityMemo<V> {
  private readonly root: IdentityMemoNode<V> = { children: new WeakMap(), value: undefined };

  get(keys: readonly object[], compute: () => Promise<V>): Promise<V> {
    if (keys.length === 0) {
      throw new HexclaveAssertionError("FrozenIdentityMemo requires at least one key; otherwise its entry could never be garbage-collected");
    }
    let node = this.root;
    for (const key of keys) {
      let child = node.children.get(key);
      if (child === undefined) {
        child = { children: new WeakMap(), value: undefined };
        node.children.set(key, child);
      }
      node = child;
    }
    if (node.value !== undefined) return node.value;

    const leaf = node;
    const promise = Promise.resolve()
      .then(compute)
      .then((result) => deepPlainFreeze(result))
      .catch((error: unknown) => {
        if (leaf.value === promise) {
          leaf.value = undefined;
        }
        throw error;
      });
    leaf.value = promise;
    return promise;
  }
}

/**
 * The tenancy (and level) a config override was read for. It is part of every cache key, so cached values are never
 * shared between tenancies, even if their stored overrides happen to be identical. That rules out cross-tenant timing
 * side channels (a cache hit revealing that another tenant has the same config), and keeps the cache correct if
 * rendering ever starts to depend on the tenancy and not just on the override content.
 */
export type ConfigOverrideScope =
  | { level: "project", projectId: string }
  | { level: "branch" | "environment", projectId: string, branchId: string }
  | { level: "organization", projectId: string, branchId: string, organizationId: string | null };

type InternedConfigOverride = {
  contentHash: string,
  // `any` mirrors the return type of `migrateConfigOverride`, whose result shape depends on the level; the callers in
  // ./index.tsx assign it to the level-specific override type, exactly as they did before this cache existed.
  migrated: any,
};

// One entry per scope: when a tenancy's stored override changes, its entry is replaced right away, which also releases
// everything derived from the old version (see FrozenIdentityMemo).
const internedConfigOverrides = new LruMap<string, InternedConfigOverride>(MAX_INTERNED_CONFIG_OVERRIDES);

function getScopeKey(scope: ConfigOverrideScope): string {
  // JSON array, so no ID can contain a separator that makes two different scopes produce the same key.
  switch (scope.level) {
    case "project": {
      return JSON.stringify([scope.level, scope.projectId]);
    }
    case "branch":
    case "environment": {
      return JSON.stringify([scope.level, scope.projectId, scope.branchId]);
    }
    case "organization": {
      return JSON.stringify([scope.level, scope.projectId, scope.branchId, scope.organizationId]);
    }
  }
}

/**
 * Migrates a config override as stored in the database and returns the canonical deep-frozen result.
 *
 * Repeated calls for the same scope with equal JSON content return the identical object, which is what lets the
 * downstream rendering steps be memoized by identity (see {@link FrozenIdentityMemo}).
 */
export function getCanonicalMigratedConfigOverride(scope: ConfigOverrideScope, storedConfigOverride: unknown): any {
  const serialized = JSON.stringify(storedConfigOverride) as string | undefined;
  if (serialized === undefined) {
    throw new HexclaveAssertionError("Stored config override is not JSON-serializable", { scope });
  }
  // A hash instead of the full JSON keeps entries small even for large overrides. SHA-256 makes it practically
  // impossible for a changed override to hash the same as the cached version and be served stale.
  const contentHash = createHash("sha256").update(serialized).digest("base64url");
  const scopeKey = getScopeKey(scope);
  const cached = internedConfigOverrides.get(scopeKey);
  if (cached !== undefined && cached.contentHash === contentHash) return cached.migrated;

  // Migrate a private copy so the canonical object can never alias (and freeze) the caller's input.
  const migrated = deepPlainFreeze(migrateConfigOverride(scope.level, JSON.parse(serialized)));
  internedConfigOverrides.set(scopeKey, { contentHash, migrated });
  return migrated;
}

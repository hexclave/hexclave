import { isBrowserLike } from "./env";
import { DependenciesMap } from "./maps";
import { filterUndefined } from "./objects";
import { RateLimitOptions, ReactPromise, pending, rateLimited, resolved, runAsynchronously, wait } from "./promises";
import { AsyncStore } from "./stores";

/**
 * Can be used to cache the result of a function call, for example for the `use` hook in React.
 */
export function cacheFunction<F extends Function>(f: F): F {
  const dependenciesMap = new DependenciesMap<any, any>();

  // SAFETY: DependenciesMap keys each invocation by the forwarded argument
  // tuple, and the wrapper returns exactly the original function's result.
  return ((...args: any) => {
    if (dependenciesMap.has(args)) {
      return dependenciesMap.get(args);
    }

    const value = f(...args);
    dependenciesMap.set(args, value);
    return value;
  }) as any as F;
}
import.meta.vitest?.test("cacheFunction", ({ expect }) => {
  // Test with a simple function
  let callCount = 0;
  const add = (a: number, b: number) => {
    callCount++;
    return a + b;
  };

  const cachedAdd = cacheFunction(add);

  // First call should execute the function
  expect(cachedAdd(1, 2)).toBe(3);
  expect(callCount).toBe(1);

  // Second call with same args should use cached result
  expect(cachedAdd(1, 2)).toBe(3);
  expect(callCount).toBe(1);

  // Call with different args should execute the function again
  expect(cachedAdd(2, 3)).toBe(5);
  expect(callCount).toBe(2);

  // Test with a function that returns objects
  let objectCallCount = 0;
  const createObject = (id: number) => {
    objectCallCount++;
    return { id };
  };

  const cachedCreateObject = cacheFunction(createObject);

  // First call should execute the function
  const obj1 = cachedCreateObject(1);
  expect(obj1).toEqual({ id: 1 });
  expect(objectCallCount).toBe(1);

  // Second call with same args should use cached result
  const obj2 = cachedCreateObject(1);
  expect(obj2).toBe(obj1); // Same reference
  expect(objectCallCount).toBe(1);
});


type CacheStrategy = "write-only" | "read-write" | "never";

export class AsyncCache<D extends any[], T> {
  private readonly _map = new DependenciesMap<D, AsyncValueCache<T>>();

  constructor(
    private readonly _fetcher: (dependencies: D) => Promise<T>,
    private readonly _options: {
      onSubscribe?: (key: D, refresh: () => void) => (() => void),
      rateLimiter?: Omit<RateLimitOptions, "batchCalls">,
    } = {},
  ) {
    // nothing here yet
  }

  private _createKeyed<FunctionName extends keyof AsyncValueCache<T>>(
    functionName: FunctionName,
  ): (key: D, ...args: Parameters<AsyncValueCache<T>[FunctionName]>) => ReturnType<AsyncValueCache<T>[FunctionName]> {
    return (key: D, ...args) => {
      const valueCache = this.getValueCache(key);
      return (valueCache[functionName] as any).apply(valueCache, args);
    };
  }

  getValueCache(dependencies: D): AsyncValueCache<T> {
    let cache = this._map.get(dependencies);
    if (!cache) {
      cache = new AsyncValueCache(
        async () => await this._fetcher(dependencies),
        {
          ...this._options,
          onSubscribe: this._options.onSubscribe ? (cb) => this._options.onSubscribe!(dependencies, cb) : undefined,
        },
      );
      this._map.set(dependencies, cache);
    }
    return cache;
  }

  async refreshWhere(predicate: (dependencies: D) => boolean) {
    const promises: Promise<void>[] = [];
    for (const [dependencies, cache] of this._map) {
      if (predicate(dependencies)) {
        promises.push(cache.refresh());
      }
    }
    await Promise.all(promises);
  }

  async invalidateWhere(predicate: (dependencies: D) => boolean) {
    const promises: Promise<void>[] = [];
    for (const [dependencies, cache] of this._map) {
      if (predicate(dependencies)) {
        promises.push(cache.invalidate().catch(() => undefined));
      }
    }
    await Promise.all(promises);
  }

  readonly isCacheAvailable = this._createKeyed("isCacheAvailable");
  readonly getIfCached = this._createKeyed("getIfCached");
  readonly getOrWait = this._createKeyed("getOrWait");
  readonly forceSetCachedValue = this._createKeyed("forceSetCachedValue");
  readonly forceSetCachedValueAsync = this._createKeyed("forceSetCachedValueAsync");
  readonly refresh = this._createKeyed("refresh");
  readonly invalidate = this._createKeyed("invalidate");
  readonly onStateChange = this._createKeyed("onStateChange");
  readonly isDirty = this._createKeyed("isDirty");
}

class AsyncValueCache<T> {
  private _store: AsyncStore<T>;
  private _pendingPromise: ReactPromise<T> | undefined;
  private _fetcher: () => Promise<T>;
  private readonly _rateLimitOptions: Omit<RateLimitOptions, "batchCalls">;
  private _subscriptionsCount = 0;
  private _unsubscribers: (() => void)[] = [];
  private _mostRecentRefreshPromiseIndex = 0;

  constructor(
    fetcher: () => Promise<T>,
    private readonly _options: {
      onSubscribe?: (refresh: () => void) => (() => void),
      rateLimiter?: Omit<RateLimitOptions, "batchCalls">,
    } = {},
  ) {
    this._store = new AsyncStore();
    this._rateLimitOptions = {
      concurrency: 1,
      throttleMs: 300,
      ...filterUndefined(_options.rateLimiter ?? {}),
    };


    this._fetcher = rateLimited(fetcher, {
      ...this._rateLimitOptions,
      batchCalls: true,
    });
  }

  isCacheAvailable(): boolean {
    return this._store.isAvailable();
  }

  getIfCached() {
    return this._store.get();
  }

  getOrWait(cacheStrategy: CacheStrategy): ReactPromise<T> {
    const cached = this.getIfCached();
    if (cacheStrategy === "read-write" && cached.status === "ok") {
      return resolved(cached.data);
    }

    return this._refetch(cacheStrategy);
  }

  private _set(value: T): void {
    this._store.set(value);
  }

  private _setAsync(value: Promise<T>): ReactPromise<void> {
    if (this._subscriptionsCount === 0 && !isBrowserLike()) {
      // if we're in a server-like environment, we'd rather cache less aggressively to avoid memory leaks.
      // hence, if no one is listening to this cache, let's invalidate it
      this._invalidateCacheSoon();
    }
    const promise = pending(value);
    this._pendingPromise = promise;
    return pending(this._store.setAsync(promise).then(() => undefined));
  }

  private _refetch(cacheStrategy: CacheStrategy): ReactPromise<T> {
    if (cacheStrategy === "read-write" && this._pendingPromise) {
      return this._pendingPromise;
    }
    const promise = pending(this._fetcher());
    if (cacheStrategy === "never") {
      return promise;
    }
    return pending(this._setAsync(promise).then(() => promise));
  }

  forceSetCachedValue(value: T): void {
    this._set(value);
  }

  forceSetCachedValueAsync(value: Promise<T>): ReactPromise<void> {
    return this._setAsync(value);
  }

  /**
   * If anyone is listening to the cache, refreshes the value, and sets it without invalidating the cache.
   */
  async refresh(): Promise<void> {
    // note that we do the extra check here to save a request if no one is listening to the cache anyway
    if (this._subscriptionsCount > 0) {
      await this.getOrWait("write-only");
    }
  }

  /**
   * Invalidates the cache, marking it dirty (ie. it will be refreshed on the next read). If anyone is listening to the cache, it will refresh immediately.
   */
  async invalidate(): Promise<void> {
    this._store.setUnavailable();
    this._pendingPromise = undefined;
    await this.refresh();
  }

  isDirty(): boolean {
    return this._pendingPromise === undefined;
  }

  _invalidateCacheSoon(): void {
    // wait a few seconds; we want to keep the cache up during this time
    // else we do unnecessary requests if we unsubscribe and then subscribe again immediately
    const currentRefreshPromiseIndex = ++this._mostRecentRefreshPromiseIndex;
    runAsynchronously(async () => {
      await wait(5000);
      if (this._subscriptionsCount === 0 && currentRefreshPromiseIndex === this._mostRecentRefreshPromiseIndex) {
        await this.invalidate();
      }
    });
  }

  onStateChange(callback: (value: T, oldValue: T | undefined) => void): { unsubscribe: () => void } {
    const storeObj = this._store.onChange(callback);

    runAsynchronously(this.getOrWait("read-write"));

    if (this._subscriptionsCount++ === 0 && this._options.onSubscribe) {
      const unsubscribe = this._options.onSubscribe(() => {
        runAsynchronously(this.refresh());
      });
      this._unsubscribers.push(unsubscribe);
    }

    let hasUnsubscribed = false;
    return {
      unsubscribe: () => {
        if (hasUnsubscribed) return;
        hasUnsubscribed = true;
        storeObj.unsubscribe();
        if (--this._subscriptionsCount === 0) {
          this._invalidateCacheSoon();

          for (const unsubscribe of this._unsubscribers) {
            unsubscribe();
          }
        }
      },
    };
  }
}

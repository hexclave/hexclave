
import { createGlobal } from "./globals";

/** The slice of `AsyncLocalStorage<T>` the SDK actually uses. */
export type AsyncLocalStorageLike<T> = {
  run: <R>(store: T, fn: () => R) => R,
  getStore: () => T | undefined,
};

type AsyncHooksModuleLike<T> = {
  AsyncLocalStorage?: new () => AsyncLocalStorageLike<T>,
};

// Same opacity trick as otel-sdk-loader: `.join` in a helper so tsdown cannot
// constant-fold the Node builtin into a string-literal dynamic import. Next's
// Edge checker flags that literal even with webpackIgnore — a `const specifier
// = "node:…"` was inlined in dist and warned on every demo page load.
function asyncHooksSpecifier(): string {
  return ["node", "async_hooks"].join(":");
}

const loadPromise = createGlobal("async-local-storage-load-promises", () => new Map<string, Promise<unknown>>());

/**
 * Resolves a fresh `AsyncLocalStorage` for `key`, or `null` on any runtime
 * without one (browsers, and edge runtimes without `nodejs_compat`). Never
 * throws: callers all degrade to a documented fallback rather than failing.
 *
 * Memoized per `key` so repeated calls hand back the SAME storage instance —
 * `run`/`getStore` must agree on one object to be an ambient context at all.
 */
export function loadAsyncLocalStorage<T>(key: string): Promise<AsyncLocalStorageLike<T> | null> {
  let existing = loadPromise.get(key);
  if (existing === undefined) {
    existing = (async (): Promise<AsyncLocalStorageLike<T> | null> => {
      try {
        const specifier = asyncHooksSpecifier();
        // SAFETY: the specifier is deliberately opaque (see asyncHooksSpecifier), so TS cannot type this
        // import. The only member we rely on, `AsyncLocalStorage`, is typeof-guarded on the next line, so
        // an unexpected module still degrades to the documented `null` fallback instead of misbehaving.
        const mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier) as AsyncHooksModuleLike<T>;
        return typeof mod.AsyncLocalStorage === "function" ? new mod.AsyncLocalStorage() : null;
      } catch {
        return null;
      }
    })();
    loadPromise.set(key, existing);
  }
  // SAFETY: the shared cache erases `T`. Each key belongs to a single call site with a fixed `T` (that is
  // the point of the per-key memoization: `run`/`getStore` must observe the same store type), so the
  // promise stored under `key` was created as `Promise<AsyncLocalStorageLike<T> | null>` for this same `T`.
  return existing as Promise<AsyncLocalStorageLike<T> | null>;
}

/** Test-only: forget the cached storages so each test starts from a clean slate. */
export function resetAsyncLocalStorageCacheForTesting(): void {
  loadPromise.clear();
}

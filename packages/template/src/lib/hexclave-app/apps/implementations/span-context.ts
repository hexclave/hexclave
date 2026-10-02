import type { SpanContext } from "./event-tracker";
import { ensureAsyncContext, getAsyncLocalStorage, isAsyncContextSettled, syncStack, type SyncFrame } from "./span-context-state";

/**
 * Ambient span context for withSpan(): tracks the stack of enclosing withSpan
 * frames so telemetry created inside the callback automatically parents under
 * them (merged with compatible global spans and explicit parentIds).
 *
 * Two implementations behind one interface:
 *
 * - **AsyncLocalStorage** (Node, Bun, Deno, Cloudflare Workers / Vercel Edge
 *   with nodejs_compat): correct across await boundaries and under concurrent
 *   requests — two parallel withSpan() flows can never cross-parent. Loaded via
 *   a runtime-guarded dynamic import of the BUILT-IN `node:async_hooks` module
 *   (not an npm dependency); the import specifier is deliberately opaque to
 *   bundlers so browser builds neither resolve nor error on it.
 *
 * - **Sync stack fallback** (browsers, where no async-context primitive
 *   exists): a module-level enter/exit stack. Exact only for a frame's
 *   synchronous prologue (`prologueOpen`); after the callback suspends,
 *   ambient parenting stops and callers must rebind via `span.run()` /
 *   `span.trackEvent` / etc. Frames stay on the stack until settle so nested
 *   cleanup can pop the correct frame under interleaving — they are just not
 *   returned as ambient parents while suspended.
 */

/**
 * The W3C contexts of all enclosing withSpan() frames, OUTERMOST FIRST. The
 * parent resolver takes the LAST entry as the parent, so ordering is load-bearing:
 * the innermost enclosing scope must come last.
 *
 * With an exact primitive (ALS/AsyncContext) the store is per-flow and always
 * returned in full. On the sync-stack fallback, only prologue-open frames are
 * returned — never another flow's suspended frame.
 */
export function getAmbientSpanContexts(): SpanContext[] {
  const als = getAsyncLocalStorage();
  const store = als?.getStore();
  if (store) return [...store];
  return syncStack.filter((frame) => frame.prologueOpen).map((frame) => frame.context);
}

/**
 * Runs `fn` with `frame` appended to the ambient span context. Awaits the ALS
 * probe on the very first call (so server code gets isolation from the first
 * withSpan() rather than racing the module load); once the probe has settled it
 * enters the context SYNCHRONOUSLY — `fn`'s synchronous prologue runs inside the
 * caller's own sync block, which is what makes prologue-open frames compose
 * across nested withSpan calls on the sync-stack fallback.
 */
export async function runWithSpanContext<T>(frame: SpanContext, fn: () => Promise<T>): Promise<T> {
  return await runWithSpanFrame(frame, fn);
}

/**
 * Re-enters `context` as an ambient frame for `fn` — both the driver behind
 * `withSpan()` and the manual-rebind primitive behind `span.run()`, for
 * post-await code, timers, and third-party callbacks. Always awaits the
 * async-context probe before invoking `fn`, so the first call in a Node process
 * gets the same full-async-extent guarantee as later calls. On the sync-stack
 * browser fallback it is exact for `fn`'s synchronous window only.
 */
export async function runWithSpanFrame<T>(context: SpanContext, fn: () => T): Promise<Awaited<T>> {
  if (!isAsyncContextSettled()) await ensureAsyncContext();
  const als = getAsyncLocalStorage();
  if (als) {
    const enclosing = als.getStore() ?? [];
    return await als.run([...enclosing, context], fn);
  }
  const syncFrame: SyncFrame = { context, prologueOpen: true };
  syncStack.push(syncFrame);
  try {
    const result = fn();
    syncFrame.prologueOpen = false;
    return await result;
  } finally {
    syncFrame.prologueOpen = false;
    const index = syncStack.lastIndexOf(syncFrame);
    if (index !== -1) syncStack.splice(index, 1);
  }
}

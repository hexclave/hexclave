import { loadAsyncLocalStorage, type AsyncLocalStorageLike } from "@hexclave/shared/dist/utils/async-local-storage";
import type { SpanContext } from "./event-tracker";

export type { AsyncLocalStorageLike };

let als: AsyncLocalStorageLike<SpanContext[]> | null = null;
let alsInitPromise: Promise<void> | null = null;
let alsSettled = false;

export type SyncFrame = { context: SpanContext, prologueOpen: boolean };
export const syncStack: SyncFrame[] = [];

export function getAsyncLocalStorage(): AsyncLocalStorageLike<SpanContext[]> | null {
  return als;
}

export function isAsyncContextSettled(): boolean {
  return alsSettled;
}

export async function ensureAsyncContext(): Promise<void> {
  if (alsInitPromise) return await alsInitPromise;
  alsInitPromise = (async () => {
    als = await loadAsyncLocalStorage<SpanContext[]>("span-context");
    alsSettled = true;
  })();
  return await alsInitPromise;
}

export function setAsyncContextModeForTesting(mode: "sync-stack" | "auto"): void {
  if (mode === "sync-stack") {
    als = null;
    alsInitPromise = Promise.resolve();
    alsSettled = true;
  } else {
    als = null;
    alsInitPromise = null;
    alsSettled = false;
  }
  syncStack.length = 0;
}

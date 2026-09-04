const globalVar: any =
  typeof globalThis !== 'undefined' ? globalThis :
    typeof global !== 'undefined' ? global :
      typeof window !== 'undefined' ? window :
        typeof self !== 'undefined' ? self :
          {};
export {
  globalVar
};

if (typeof globalThis === 'undefined') {
  // SAFETY: globalVar is the selected host global object, so defining the
  // missing globalThis alias on it is the required environment bootstrap.
  (globalVar as any).globalThis = globalVar;
}

// Hexclave rebrand: file-private symbol key, renamed outright (no cross-version compat needed).
const hexclaveGlobalsSymbol = Symbol.for('__hexclave-globals');
globalVar[hexclaveGlobalsSymbol] ??= {};

// SAFETY: A key is initialized once and every later lookup returns that same
// value, so the caller's T remains stable for the lifetime of the global.
export function createGlobal<T>(key: string, init: () => T) {
  if (!globalVar[hexclaveGlobalsSymbol][key]) {
    globalVar[hexclaveGlobalsSymbol][key] = init();
  }
  // SAFETY: This key is initialized once, so every lookup has the T produced
  // by its initializer.
  return globalVar[hexclaveGlobalsSymbol][key] as T;
}

/**
 * Like createGlobal, but if the asynchronous initialization fails, the global will be reset and recomputed on the next
 * invocation.
 */
// SAFETY: The stored value is either the in-flight Promise<T> created by init
// or the cached Promise<T> from that same key; rejection removes the key before
// another caller can observe a failed value.
export function createGlobalAsync<T>(key: string, init: () => Promise<T>): Promise<T> {
  let promise: Promise<T> | null = null;
  if (!globalVar[hexclaveGlobalsSymbol][key]) {
    promise = init().catch((e) => {
      delete globalVar[hexclaveGlobalsSymbol][key];
      throw e;
    });
    globalVar[hexclaveGlobalsSymbol][key] = promise;
  }
  // SAFETY: The fallback is the Promise<T> stored by this function's init
  // call; failed promises are deleted before they can be returned again.
  return promise ?? globalVar[hexclaveGlobalsSymbol][key] as Promise<T>;
}

export function getGlobal(key: string): any {
  return globalVar[hexclaveGlobalsSymbol][key];
}

export function setGlobal(key: string, value: any) {
  globalVar[hexclaveGlobalsSymbol][key] = value;
}

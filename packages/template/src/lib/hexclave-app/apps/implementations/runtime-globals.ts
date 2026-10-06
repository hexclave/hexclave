/**
 * Typed read/write view of direct `globalThis` properties for keys the ambient
 * type does not declare: host objects that may be absent (`process` outside
 * Node), well-known cross-package slots (bundler-injected debug ids, Vercel's
 * request-context symbol), and the SDK's own registry keys. Unlike
 * `@hexclave/shared`'s `createGlobal`/`getGlobal` (which namespace under one
 * SDK-private symbol), these keys are external contracts that must live
 * directly on the global object.
 */
// SAFETY: every JS runtime's globalThis is an object; viewing it as an open
// record only widens unknown-key reads to `unknown` (and accepts writes of any
// value), which claims nothing about what the properties hold.
export const runtimeGlobals: Record<string | symbol, unknown> = globalThis as typeof globalThis & Record<string | symbol, unknown>;

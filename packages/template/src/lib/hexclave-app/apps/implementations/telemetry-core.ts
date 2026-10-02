import { ignoreUnhandledRejection, runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { CUSTOM_TELEMETRY_MAX_ITEM_DATA_BYTES, CUSTOM_TELEMETRY_NAME_RE, isW3cSpanId, isW3cTraceId } from "@hexclave/shared/dist/utils/analytics-wire";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { generateOtelTraceId } from "./otel-context";
import { runtimeGlobals } from "./runtime-globals";

/**
 * A span's W3C identity: the trace it belongs to plus its own span id. This is
 * the ONE currency of span identity across every tier and boundary — it survives
 * JSON (page props, headers), and unlike a bare span id it is globally
 * meaningful, because a span id only identifies a span WITHIN its trace.
 */
export type SpanContext = {
  traceId: string,
  spanId: string,
  /** Standard OTel trace flags. Omitted serialized parents remain sampled for
   * backwards compatibility with the pre-OTel facade contract. */
  traceFlags?: number,
  /** Opaque W3C vendor state, when the context crossed a propagation boundary. */
  traceState?: string,
};

/** Anything accepted as a parent: a serialized SpanContext or a live Span handle. */
export type ParentRef = SpanContext | Span;

export type TrackOptions = {
  /**
   * The span this item belongs under. Overrides ambient context entirely — a
   * span has exactly one parent, so an explicit one is never merged with the
   * enclosing scope.
   */
  parent?: ParentRef,
  /**
   * Start a NEW trace: ignore ambient context (global spans + the enclosing
   * withSpan scope) so this item becomes a trace root. Combined with an explicit
   * `parent`, the parent still wins — `root` only drops the AMBIENT parent.
   */
  root?: boolean,
};

export type StartSpanOptions = TrackOptions & {
  /**
   * Non-hierarchical references to other spans: causally related work that is
   * not this span's parent (e.g. a second ambient span from an unrelated flow,
   * or the producer of a queued message). OpenTelemetry links belong to spans,
   * not events, so this is deliberately absent from `TrackOptions`.
   */
  links?: ParentRef[],
  data?: Record<string, unknown>,
  startedAtMs?: number,
};

export type Span = {
  /** The trace this span belongs to; shared with every ancestor and descendant. */
  readonly traceId: string,
  readonly spanId: string,
  readonly spanType: string,
  readonly isEnded: boolean,
  /** Shallow-merges into the span's data and re-writes the span. */
  setData(data: Record<string, unknown>): Promise<void>,
  /** Idempotent; repeated calls return the first call's promise. */
  end(options?: { endedAtMs?: number }): Promise<void>,
  trackEvent(eventType: string, data?: Record<string, unknown>, options?: TrackOptions): Promise<void>,
  startSpan(spanType: string, options?: StartSpanOptions): Span,
  /**
   * Runs `fn` inside a child span of this span (auto-ends, records errors —
   * same contract as the app-level withSpan). The HANDLE-based nesting path:
   * parentage comes from this span, not ambient context, so it is exact in
   * every environment and under any concurrency.
   */
  withSpan<T>(spanType: string, fn: (span: Span) => Promise<T> | T): Promise<T>,
  withSpan<T>(spanType: string, options: StartSpanOptions, fn: (span: Span) => Promise<T> | T): Promise<T>,
  /**
   * Re-enters this span as an ambient parent for `fn` — the manual-rebind
   * primitive for post-await code, timers, and third-party callbacks. Under an
   * exact async-context primitive (server today, browsers once AsyncContext
   * ships) the context covers `fn`'s full async extent; on the browser fallback
   * it is exact for `fn`'s synchronous window. Always returns a promise because
   * the first server call may need to initialize the async-context primitive.
   */
  run<T>(fn: () => T): Promise<Awaited<T>>,
  /**
   * The cross-tier propagation headers pinned to exactly this span — the
   * standard `traceparent`/`tracestate` carrying this span's W3C context plus
   * filtered Hexclave correlation baggage. For transports the SDK cannot instrument (XHR,
   * sendBeacon, WebSocket handshakes). Setting these headers on a fetch also
   * overrides the automatic ambient ones.
   */
  getSpanPropagationHeaders(): Record<string, string>,
  /**
   * `fetch` with the propagation header pinned to exactly this span, so the
   * backend span opened by `withSpan({ request })` nests under it — immune to
   * ambient-context ambiguity. Follows the same same-origin/allowlist policy as
   * the automatic wrapper and never overwrites an explicitly-set header.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>,
  /** This span's W3C identity — the serializable form accepted as a `parent`. */
  spanContext(): SpanContext,
};

/** Internal stored form. Target scope is only supplied by trusted platform code. */
export type StoredSpanLink = SpanContext & {
  linkedProjectId?: string,
  linkedBranchId?: string,
};

export const MAX_SPAN_LINKS = 32;

export function preCaught<T>(promise: Promise<T>): Promise<T> {
  ignoreUnhandledRejection(promise);
  return promise;
}

export function rejectedPreCaught(message: string): Promise<never> {
  return preCaught(Promise.reject(new Error(`Hexclave analytics: ${message}`)));
}

export function registerTelemetryBackgroundTask(
  registerBackgroundTask: ((promise: Promise<unknown>) => void) | undefined,
  promise: Promise<unknown>,
  source: string,
): void {
  if (registerBackgroundTask === undefined) return;
  try {
    registerBackgroundTask(promise);
  } catch (error) {
    console.warn(`Hexclave analytics: ${source} waitUntil hook failed:`, error);
  }
}

/**
 * Default serverless keep-alive hook, used when `TelemetryOptions.waitUntil`
 * is not set: on Vercel, un-awaited telemetry sends are killed at response
 * teardown, silently dropping batches — the worst kind of misconfiguration
 * (no error, just missing data). Vercel exposes the active request context
 * under a well-known global symbol (the same contract `@vercel/functions`'
 * `waitUntil` reads), so we can wire it without a dependency. The lookup runs
 * PER SEND — the context is request-scoped, so resolving it once at
 * construction would pin the first request's context (or none). Off Vercel
 * the symbol is absent and this is a no-op, which is why an explicit
 * `waitUntil` stays the way to wire platforms whose context is handed to the
 * handler instead of being globally discoverable (e.g. Cloudflare's
 * `ctx.waitUntil`).
 */
export function autoDetectedBackgroundTaskHook(promise: Promise<unknown>): void {
  // Untyped platform contract: Vercel publishes no types for this seam, so
  // every step is narrowed before use — a contract change degrades to a no-op,
  // never a throw into the telemetry path.
  const holder = runtimeGlobals[Symbol.for("@vercel/request-context")];
  if (!isRecord(holder)) return;
  const get = holder["get"];
  if (typeof get !== "function") return;
  let context: unknown;
  try {
    context = get.call(holder);
  } catch {
    return;
  }
  if (!isRecord(context)) return;
  const waitUntil = context["waitUntil"];
  if (typeof waitUntil !== "function") return;
  waitUntil.call(context, promise);
}

/** Guarded `process.env` access — no Node types in this package, and browser
 * runtimes may not define `process` at all (bundlers that shim it are covered
 * by the same path). */
export function getCustomTelemetryNameError(kind: "event" | "span", name: unknown): string | null {
  if (typeof name !== "string" || !CUSTOM_TELEMETRY_NAME_RE.test(name)) {
    return `Invalid custom ${kind} type ${JSON.stringify(name)}: must start with a letter, contain only letters, digits, "_", ".", ":" or "-", and be at most 64 characters ("$"-prefixed names are reserved for system telemetry)`;
  }
  return null;
}

export function getCustomTelemetryDataError(data: unknown): string | null {
  if (data === undefined) return null;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return "Telemetry data must be a plain JSON-serializable object";
  }
  let serialized: string | undefined;
  try {
    const stringified = JSON.stringify(data);
    serialized = typeof stringified === "string" ? stringified : undefined;
  } catch {
    return "Telemetry data must be JSON-serializable (no circular references or BigInt values)";
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).length > CUSTOM_TELEMETRY_MAX_ITEM_DATA_BYTES) {
    return `Telemetry data must serialize to at most ${CUSTOM_TELEMETRY_MAX_ITEM_DATA_BYTES} bytes`;
  }
  return null;
}

export { truncateUtf8Bytes } from "@hexclave/shared/dist/utils/analytics-wire";

export function resolveEndedAtMs(startedAtMs: number, endedAtMs: number | undefined): number {
  const resolvedEndedAtMs = endedAtMs ?? Date.now();
  if (!Number.isInteger(resolvedEndedAtMs) || resolvedEndedAtMs < 0) {
    throw new Error("Hexclave analytics: endedAtMs must be a non-negative integer epoch-milliseconds value");
  }
  if (resolvedEndedAtMs < startedAtMs) {
    throw new Error("Hexclave analytics: endedAtMs must be greater than or equal to startedAtMs");
  }
  return resolvedEndedAtMs;
}

/**
 * Validates the name/data/startedAtMs inputs of startSpan(), throwing the exact
 * errors every implementation must produce. Shared by the browser tracker, the
 * server-key path, and the non-browser inert path, so invalid input fails with
 * identical messages no matter where the span would have been recorded.
 */
export function assertValidSpanStartInput(spanType: string, options: StartSpanOptions | undefined): void {
  const nameError = getCustomTelemetryNameError("span", spanType);
  if (nameError) {
    throw new Error(`Hexclave analytics: ${nameError}`);
  }
  const dataError = getCustomTelemetryDataError(options?.data);
  if (dataError) {
    throw new Error(`Hexclave analytics: ${dataError}`);
  }
  if (options?.startedAtMs !== undefined && (!Number.isInteger(options.startedAtMs) || options.startedAtMs < 0)) {
    throw new Error("Hexclave analytics: startedAtMs must be a non-negative integer epoch-milliseconds value");
  }
}

function parentRefToSpanContext(ref: ParentRef): SpanContext {
  return "spanContext" in ref && typeof ref.spanContext === "function" ? ref.spanContext() : ref;
}

function getSpanContextError(context: SpanContext, role: string): string | null {
  if (!isW3cTraceId(context.traceId)) {
    return `Invalid ${role} traceId ${JSON.stringify(context.traceId)}: must be 32 lowercase hex characters and not all-zero`;
  }
  if (!isW3cSpanId(context.spanId)) {
    return `Invalid ${role} spanId ${JSON.stringify(context.spanId)}: must be 16 lowercase hex characters and not all-zero`;
  }
  if (context.traceFlags !== undefined && (!Number.isInteger(context.traceFlags) || context.traceFlags < 0 || context.traceFlags > 255)) {
    return `Invalid ${role} traceFlags ${JSON.stringify(context.traceFlags)}: must be an integer between 0 and 255`;
  }
  return null;
}

export type ResolvedSpanParent = {
  traceId: string,
  /** null means the item starts a NEW trace (it is the root activity). */
  parentSpanId: string | null,
  /** Standard flags inherited from the selected parent. */
  traceFlags?: number,
  /** Opaque W3C state inherited from the selected parent. */
  traceState?: string,
  /** Non-hierarchical references; empty when there are none. */
  links: StoredSpanLink[],
};

/**
 * Resolves the ONE parent of a new span/event, W3C-style.
 *
 * A span has exactly one parent, so this picks rather than merges:
 *  - an explicit `parent` always wins (the caller stated their intent);
 *  - otherwise the NEAREST ambient context — `ambient` is ordered
 *    outermost-first (global spans, then enclosing withSpan frames), so the last
 *    entry is the innermost scope;
 *  - `root` drops ambient entirely, so with no explicit parent the item becomes a
 *    trace root with a fresh trace id.
 */
export function resolveSpanParent(opts: {
  explicit?: ParentRef,
  ambient?: readonly SpanContext[],
  links?: readonly ParentRef[],
  /**
   * An ancestor of LAST RESORT: used only when neither an explicit parent nor an
   * ambient context supplies one, and — unlike an ambient context — never turned
   * into a link when something else wins. In the browser this is the current
   * `$page-view`, which encloses everything on the page but is not a peer
   * operation competing for parenthood; the relationship is already recorded on
   * every row as `page_view_span_id`, so linking it too would be noise.
   * Dropped by `root: true` like ambient context.
   */
  fallbackParent?: SpanContext | null,
  /** Ignore ambient and fallback context entirely; only an explicit parent applies. */
  root?: boolean,
}): ResolvedSpanParent | { error: string } {
  const ambient = opts.root ? [] : opts.ambient ?? [];
  for (const context of ambient) {
    const error = getSpanContextError(context, "ambient parent");
    if (error !== null) return { error };
  }

  let parent: SpanContext | null = null;
  if (opts.explicit !== undefined) {
    const explicit = parentRefToSpanContext(opts.explicit);
    const error = getSpanContextError(explicit, "parent");
    if (error !== null) return { error };
    parent = explicit;
  } else {
    parent = ambient.at(-1) ?? null;
  }
  if (parent === null && !opts.root && opts.fallbackParent != null) {
    const error = getSpanContextError(opts.fallbackParent, "fallback parent");
    if (error !== null) return { error };
    parent = opts.fallbackParent;
  }

  const links: StoredSpanLink[] = [];
  for (const ref of opts.links ?? []) {
    const context = parentRefToSpanContext(ref);
    const error = getSpanContextError(context, "link");
    if (error !== null) return { error };
    if (!links.some((link) => link.spanId === context.spanId && link.traceId === context.traceId)) {
      links.push({ traceId: context.traceId, spanId: context.spanId });
    }
  }
  if (links.length > MAX_SPAN_LINKS) {
    return { error: `A span may link to at most ${MAX_SPAN_LINKS} other spans` };
  }
  if (parent !== null) {
    const demoted: StoredSpanLink[] = [];
    for (const context of ambient) {
      if (context.traceId === parent.traceId) continue;
      if (links.some((link) => link.spanId === context.spanId && link.traceId === context.traceId)) continue;
      if (demoted.some((link) => link.spanId === context.spanId && link.traceId === context.traceId)) continue;
      demoted.push({ traceId: context.traceId, spanId: context.spanId });
    }
    const capacity = MAX_SPAN_LINKS - links.length;
    links.push(...demoted.slice(Math.max(0, demoted.length - capacity)));
  }

  return {
    traceId: parent?.traceId ?? generateOtelTraceId(),
    parentSpanId: parent?.spanId ?? null,
    ...parent?.traceFlags === undefined ? {} : { traceFlags: parent.traceFlags },
    ...parent?.traceState === undefined ? {} : { traceState: parent.traceState },
    links,
  };
}

/**
 * Shared implementation of withSpan(): starts the span (parents come from the
 * ENCLOSING context, not itself), runs `fn` with the span as an ambient parent
 * for everything created inside, auto-ends on settle, and on throw records
 * `data.error` and rethrows. Telemetry delivery remains off the callback's
 * critical path, so the caller's result is never blocked on an analytics ack.
 */
export async function withSpanImpl<T>(
  startSpan: (spanType: string, options?: StartSpanOptions) => Span,
  spanType: string,
  optionsOrFn: StartSpanOptions | ((span: Span) => Promise<T> | T),
  maybeFn?: (span: Span) => Promise<T> | T,
): Promise<T> {
  const options = typeof optionsOrFn === "function" ? undefined : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  if (typeof fn !== "function") {
    return await rejectedPreCaught("withSpan() requires a callback function");
  }
  const span = startSpan(spanType, options);
  return await span.run(async () => {
    try {
      const result = await fn(span);
      runAsynchronously(span.end());
      return result;
    } catch (error) {
      runAsynchronously(span.setData({ error: error instanceof Error ? error.message : String(error) }));
      runAsynchronously(span.end());
      throw error;
    }
  });
}

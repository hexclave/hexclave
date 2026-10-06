import type { RequestLike } from "../lib/hexclave-app/common";
import type { Span } from "../lib/hexclave-app/apps/implementations/event-tracker";
import { createErrorScope, getActiveErrorScope, runWithErrorScopeAsync } from "../lib/hexclave-app/apps/implementations/error-scope";
import type { StackServerApp } from "../lib/hexclave-app/apps/interfaces/server-app";
import type { ServerUser } from "../lib/hexclave-app/users";

/**
 * Shared core for the framework adapters (tRPC / oRPC / Elysia / Convex).
 *
 * Each adapter does exactly two things with the incoming request: resolve the
 * caller (`ctx.user`, lazily, cached per request) and wrap the framework's
 * handler in a `withSpan(type, { request }, …)` span — which joins the backend
 * span to the caller's active browser operation via `traceparent` and stamps
 * refresh-token/replay correlation from the session plus the
 * `baggage` header the browser SDK attaches automatically.
 * Consumers of an adapter never pass `{ request }` themselves.
 */

/** The (non-generic) server-app surface the adapters program against. */
export type AdapterServerApp = StackServerApp<boolean, string>;

/** What adapters put on the framework context as the authenticated caller. */
export type AdapterUser = ServerUser;

/**
 * Accepts anything with request-like headers (a fetch `Request`, a Node
 * `IncomingMessage`, `{ headers: Record<string, string | null> }`) and returns
 * it as a RequestLike. A missing request is adapter misconfiguration, not an
 * unauthenticated caller: valid unauthenticated requests still have headers.
 */
export function normalizeRequestLike(input: unknown): RequestLike | null {
  if (typeof input !== "object" || input === null) return null;
  // SAFETY: reading a possibly-absent `headers` as unknown claims nothing.
  const headers = (input as { headers?: unknown }).headers;
  if (typeof headers !== "object" || headers === null) return null;
  // SAFETY: an object-typed `headers` is, in every supported runtime, either a
  // Fetch/Node Headers instance (the `{ get }` variant) or a plain name→value
  // dict — exactly RequestLike's two variants; per-entry value types cannot be
  // verified without eagerly walking headers the SDK may never read.
  return input as RequestLike;
}

/**
 * Per-request context every adapter builds once and threads through: the
 * normalized request plus a lazy, memoized user resolution (no auth work is
 * done until something actually asks for the user).
 */
export type HexclaveRequestContext = {
  request: RequestLike,
  getUser: () => Promise<AdapterUser | null>,
};

export function createRequestContext(app: AdapterServerApp, requestInput: unknown): HexclaveRequestContext {
  const request = normalizeRequestLike(requestInput);
  if (request === null) {
    throw new Error("Hexclave adapter could not find a request-like object with headers. Configure the adapter's request extractor.");
  }
  let userPromise: Promise<AdapterUser | null> | null = null;
  return {
    request,
    getUser: () => {
      // SAFETY: getUser's overloads do not resolve for the non-generic
      // AdapterServerApp (HasTokenStore = boolean), but every concrete
      // instantiation accepts the ({ tokenStore, or: "return-null" }) form
      // selected here and resolves to a nullable user for it.
      userPromise ??= (app.getUser as (options: { tokenStore: RequestLike, or: "return-null" }) => Promise<AdapterUser | null>)({ tokenStore: request, or: "return-null" });
      return userPromise;
    },
  };
}

/**
 * Per-adapter telemetry knob: `false` disables the span, `true`/undefined keeps
 * it. The span TYPE is deliberately not overridable — it must stay
 * low-cardinality (`trpc.procedure`, `orpc.procedure`, `elysia.route`,
 * `convex.function`), and the variable bits (path, method, name) belong in
 * `data`, which is what `data` here extends.
 */
export type AdapterTelemetryOptions = boolean | {
  data?: Record<string, unknown>,
};

/** The span-attribution options an adapter may thread into `withSpan` alongside `data`. */
type AdapterSpanLink = { request?: RequestLike, userId?: string };

/**
 * Wraps `fn` in an adapter span (or calls it straight through when telemetry is
 * off). HTTP adapters pass `{ request }` so the span parents under the caller's
 * client session; non-HTTP adapters can pass another stable link such as
 * `{ userId }`.
 */
export async function runAdapterSpan<T>(
  app: AdapterServerApp,
  info: {
    defaultSpanType: string,
    data: Record<string, unknown>,
    link?: AdapterSpanLink,
    telemetry: AdapterTelemetryOptions | undefined,
    /** Backdated span start — for hook-based adapters (Elysia's plugin) that
     * materialize the span at response time but measured from request receipt. */
    startedAtMs?: number,
  },
  fn: (span: Span | null) => Promise<T>,
): Promise<T> {
  if (info.telemetry === false) {
    return await runWithRequestErrorScope(async () => await fn(null));
  }
  const custom = typeof info.telemetry === "object" ? info.telemetry : undefined;
  const data = { ...info.data, ...custom?.data ?? {} };
  return await runWithRequestErrorScope(async () => await app.withSpan(
    info.defaultSpanType,
    { ...info.link, data, ...info.startedAtMs !== undefined ? { startedAtMs: info.startedAtMs } : {} },
    (span) => fn(span),
  ));
}

async function runWithRequestErrorScope<T>(fn: () => Promise<T>): Promise<T> {
  const scope = createErrorScope(getActiveErrorScope()?.snapshot());
  return await runWithErrorScopeAsync(scope, fn);
}

/**
 * Wraps `fn` in the adapter's request-linked span. The span — and everything
 * created inside `fn` — parents under the caller's client session via
 * `withSpan({ request })`.
 */
export async function runRequestSpan<T>(
  app: AdapterServerApp,
  context: HexclaveRequestContext,
  info: {
    defaultSpanType: string,
    data: Record<string, unknown>,
    telemetry: AdapterTelemetryOptions | undefined,
    /** Backdated span start — for hook-based adapters that materialize the span at response time. */
    startedAtMs?: number,
  },
  fn: (span: Span | null) => Promise<T>,
): Promise<T> {
  return await runAdapterSpan(app, {
    ...info,
    link: { request: context.request },
  }, fn);
}

/**
 * Produces the value an unauthenticated caller is rejected with. Adapters accept
 * one at the factory level and one per handler; the factory-level default is
 * deliberately SHARED between surfaces that can return a `Response` (route
 * handlers) and surfaces that can only throw (server actions/functions), which
 * is why the union covers both.
 */
export type UnauthorizedFactory = () => Response | Error | Promise<Response | Error>;

/** The `required: true` message, in one place — it used to be written out per surface. */
export function unauthorizedMessage(surface: string): string {
  return `You must be signed in to call this ${surface}. (Hexclave: no valid session on the request.)`;
}

async function resolveUnauthorized(
  perHandler: UnauthorizedFactory | undefined,
  factory: UnauthorizedFactory | undefined,
  fallback: () => Response | Error,
): Promise<Response | Error> {
  if (perHandler !== undefined) return await perHandler();
  if (factory !== undefined) return await factory();
  return fallback();
}

export type GuardedHandlerInfo = {
  /** Whatever the framework hands the adapter as the request (see normalizeRequestLike). */
  requestInput: unknown,
  defaultSpanType: string,
  data: Record<string, unknown>,
  telemetry: AdapterTelemetryOptions | undefined,
  /** Reject unauthenticated callers before the handler runs. */
  required: boolean | undefined,
  unauthorized: UnauthorizedFactory | undefined,
  factoryUnauthorized: UnauthorizedFactory | undefined,
  /** Names the surface in the default rejection message, e.g. "route" / "server action". */
  surface: string,
  /** Backdated span start — for hook-based adapters that materialize the span at response time. */
  startedAtMs?: number,
};

/**
 * The shared spine of every request-linked adapter wrapper: build the
 * per-request context, open the request-linked span, resolve the caller, apply
 * `required`, then run the handler inside the span's async extent.
 *
 * `runGuardedRoute` is the flavor for surfaces whose handler returns a
 * `Response`, so an unauthenticated caller can be answered with one (a
 * factory that produced an `Error` instead is thrown). `runGuardedCall` is the
 * flavor for surfaces that can only reject by throwing.
 */
export async function runGuardedRoute(
  app: AdapterServerApp,
  info: GuardedHandlerInfo,
  fn: (ctx: { user: AdapterUser | null, hexclave: HexclaveRequestContext }) => Response | Promise<Response>,
): Promise<Response> {
  const hexclave = createRequestContext(app, info.requestInput);
  return await runRequestSpan(app, hexclave, info, async () => {
    const user = await hexclave.getUser();
    if (user !== null) getActiveErrorScope()?.setUser({ id: user.id });
    if (info.required === true && user === null) {
      const rejection = await resolveUnauthorized(
        info.unauthorized,
        info.factoryUnauthorized,
        () => Response.json({ error: unauthorizedMessage(info.surface) }, { status: 401 }),
      );
      if (rejection instanceof Response) return rejection;
      throw rejection;
    }
    return await fn({ user, hexclave });
  });
}

export async function runGuardedCall<T>(
  app: AdapterServerApp,
  info: GuardedHandlerInfo,
  fn: (ctx: { user: AdapterUser | null, hexclave: HexclaveRequestContext }) => T | Promise<T>,
): Promise<T> {
  const hexclave = createRequestContext(app, info.requestInput);
  return await runRequestSpan(app, hexclave, info, async () => {
    const user = await hexclave.getUser();
    if (user !== null) getActiveErrorScope()?.setUser({ id: user.id });
    if (info.required === true && user === null) {
      throw await resolveUnauthorized(
        info.unauthorized,
        info.factoryUnauthorized,
        () => new Error(unauthorizedMessage(info.surface)),
      );
    }
    return await fn({ user, hexclave });
  });
}

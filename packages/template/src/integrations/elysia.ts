import { AdapterServerApp, AdapterTelemetryOptions, AdapterUser, createRequestContext, HexclaveRequestContext, runRequestSpan } from "./adapter-core";

/**
 * Hexclave adapter for ElysiaJS. Zero runtime dependency on `elysia` —
 * exported as composable pieces: a `.use()`-able plugin that spans EVERY route
 * via lifecycle hooks, a `.resolve()` callback for the user, a `beforeHandle`
 * guard, and a handler wrapper for full-fidelity per-route spans.
 *
 * ```ts
 * const hexclave = createHexclaveElysia(stackServerApp);
 *
 * new Elysia()
 *   .use(hexclave.plugin)                                     // spans ALL routes
 *   .resolve(hexclave.resolveUser)                            // ctx.user (+ ctx.hexclave)
 *   .get("/me", ({ user }) => user, { beforeHandle: hexclave.requireUser })
 *   .post("/checkout", hexclave.handler(async ({ user, hexclave }) => {
 *     // runs inside an `elysia.route` span linked to the caller's client session
 *   }), { beforeHandle: hexclave.requireUser });
 * ```
 *
 * Plugin vs. handler wrapper — what each covers: Elysia has no
 * around-middleware, so the hook-based plugin cannot wrap the handler's async
 * extent. The plugin's span still runs from request receipt (onRequest) to
 * response completion (onAfterResponse/onError), which contains the handler —
 * but the span is only materialized retroactively when the terminal hook fires,
 * so telemetry created inside the handler cannot ambiently nest under it. The
 * `handler()` wrapper remains the full-fidelity path: it puts the handler inside
 * the span's async extent, so child spans/events nest automatically (the plugin
 * detects wrapped handlers and skips its own span — no double recording).
 */

/** What `resolveUser` adds to the Elysia context. */
export type HexclaveElysiaContext = {
  hexclave: HexclaveRequestContext,
  user: AdapterUser | null,
};

/**
 * The slice of Elysia's per-request context the adapter reads. The runtime
 * object carries the consumer's full context; `handler()` is generic over it,
 * so nothing beyond this slice is constrained.
 */
type ElysiaRequestContext = {
  request: Request,
  path?: string,
  set: { status?: number | string },
} & Partial<HexclaveElysiaContext>;

export type HexclaveElysiaHandlerOptions = {
  /** Disable or customize the per-route span. @default true */
  telemetry?: AdapterTelemetryOptions,
};

export type HexclaveElysiaFactoryOptions = {
  /**
   * Default `unauthorized` for `requireUser` (a guard built with
   * `requireUserWith` wins per route). A returned `Response` (or any other
   * value) short-circuits the route as Elysia's beforeHandle result; a
   * returned `Error` is thrown.
   */
  unauthorized?: () => Response | Error | unknown,
  /** Disable or customize the plugin's per-route span. @default true */
  telemetry?: AdapterTelemetryOptions,
};

/**
 * The structural slice of an Elysia instance the plugin needs. Lifecycle hooks
 * are registered with `{ as: "global" }` (Elysia >= 1.0) so they cover every
 * route of the app the plugin is `.use()`d on, not just routes declared on the
 * plugin's own instance.
 */
type ElysiaHookScope = { as: "global" };
export type ElysiaLikeForPlugin = {
  onRequest: (scope: ElysiaHookScope, fn: (ctx: { request: Request }) => void) => unknown,
  onAfterResponse: (scope: ElysiaHookScope, fn: (ctx: { request: Request, path?: string, set: { status?: number | string } }) => Promise<void>) => unknown,
  onError: (scope: ElysiaHookScope, fn: (ctx: { request: Request, error?: unknown, set: { status?: number | string } }) => Promise<void>) => unknown,
};

export function createHexclaveElysia(app: AdapterServerApp, factoryOptions?: HexclaveElysiaFactoryOptions) {
  const ensureContext = (ctx: ElysiaRequestContext): HexclaveRequestContext =>
    ctx.hexclave ?? createRequestContext(app, ctx.request);

  const handlerSpannedRequests = new WeakSet<Request>();
  const pendingPluginRequests = new WeakMap<Request, { startedAtMs: number }>();

  /**
   * Materializes the plugin's span for one finished request. The span is
   * created retroactively (startedAtMs = onRequest time, ended immediately, so
   * its interval is request receipt → terminal hook) — see the module comment
   * for why hooks cannot wrap the handler. `withSpan({ request })` resolution
   * reuses the request-memoized session, so this adds no extra auth
   * round-trip beyond what `resolveUser` already did.
   */
  const recordPluginSpan = async (ctx: { request: Request, path?: string, set: { status?: number | string } }, errorData: { error?: string }) => {
    const pending = pendingPluginRequests.get(ctx.request);
    if (pending === undefined) return;
    pendingPluginRequests.delete(ctx.request);
    if (handlerSpannedRequests.has(ctx.request)) return;
    try {
      await runRequestSpan(app, createRequestContext(app, ctx.request), {
        defaultSpanType: "elysia.route",
        data: {
          path: typeof ctx.path === "string" ? ctx.path : new URL(ctx.request.url).pathname,
          method: ctx.request.method,
          status: typeof ctx.set.status === "number" ? ctx.set.status : 200,
          ...errorData,
        },
        startedAtMs: pending.startedAtMs,
        telemetry: factoryOptions?.telemetry,
      }, async (span) => {
        return span;
      });
    } catch (recordError) {
      console.warn("Hexclave analytics: failed to record an elysia.route span:", recordError);
    }
  };

  const buildRequireUser = (unauthorized: HexclaveElysiaFactoryOptions["unauthorized"]) => {
    return (ctx: ElysiaRequestContext) => {
      if (!ctx.user) {
        if (unauthorized !== undefined) {
          const result = unauthorized();
          if (result instanceof Error) throw result;
          return result;
        }
        ctx.set.status = 401;
        return { error: "You must be signed in to call this route. (Hexclave: no valid session on the request.)" };
      }
    };
  };

  return {
    /**
     * `.use()`-able plugin that spans ALL routes of the consuming app via
     * lifecycle hooks (onRequest / onAfterResponse / onError). See the module
     * comment for the precise interval covered and the ambient-nesting limit;
     * routes wrapped with `handler()` are detected and not double-spanned.
     * Requests that never matched a route (404s) are spanned too — they are
     * real traffic. Requires Elysia >= 1.0 (`{ as: "global" }` hook scoping).
     */
    plugin: <TElysia extends ElysiaLikeForPlugin>(elysia: TElysia): TElysia => {
      elysia.onRequest({ as: "global" }, (ctx) => {
        pendingPluginRequests.set(ctx.request, { startedAtMs: Date.now() });
      });
      elysia.onError({ as: "global" }, async (ctx) => {
        await recordPluginSpan(ctx, {
          error: ctx.error instanceof Error ? ctx.error.message : String(ctx.error),
        });
      });
      elysia.onAfterResponse({ as: "global" }, async (ctx) => {
        await recordPluginSpan(ctx, {});
      });
      return elysia;
    },

    /**
     * `.resolve()` callback: adds the lazy per-request context and the resolved
     * `user` (null when unauthenticated) to every route's context.
     */
    resolveUser: async (ctx: { request: Request }): Promise<HexclaveElysiaContext> => {
      const hexclave = createRequestContext(app, ctx.request);
      return { hexclave, user: await hexclave.getUser() };
    },

    /**
     * `beforeHandle` guard: short-circuits unauthenticated calls with the
     * factory-level `unauthorized` (or a JSON 401 by default).
     */
    requireUser: buildRequireUser(factoryOptions?.unauthorized),

    /**
     * Builds a `beforeHandle` guard with a per-route `unauthorized` override —
     * Elysia guards are attached per route, so this is the adapter's
     * equivalent of the other adapters' per-handler `unauthorized` option.
     */
    requireUserWith: (options: { unauthorized: NonNullable<HexclaveElysiaFactoryOptions["unauthorized"]> }) =>
      buildRequireUser(options.unauthorized),

    /**
     * Wraps a route handler in an `elysia.route` span linked to the caller's
     * client session ({ path, method } in the span data). Everything created
     * inside the handler — trackEvent, child spans — nests under it.
     */
    handler: <TContext extends ElysiaRequestContext, TResult>(
      fn: (ctx: TContext) => TResult | Promise<TResult>,
      handlerOptions?: HexclaveElysiaHandlerOptions,
    ) => {
      return async (ctx: TContext): Promise<TResult> => {
        handlerSpannedRequests.add(ctx.request);
        return await runRequestSpan(app, ensureContext(ctx), {
          defaultSpanType: "elysia.route",
          data: { path: ctx.path ?? new URL(ctx.request.url).pathname, method: ctx.request.method },
          telemetry: handlerOptions?.telemetry,
        }, async () => await fn(ctx));
      };
    },
  };
}

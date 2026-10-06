import { AdapterServerApp, AdapterTelemetryOptions, AdapterUser, createRequestContext, HexclaveRequestContext, runRequestSpan } from "./adapter-core";

/**
 * Hexclave adapter for oRPC. Zero runtime dependency on `orpc`: `middleware()`
 * returns a plain middleware function for `.use(...)`, and `wrapFetchHandler`
 * wraps an `RPCHandler`-like object so the raw `Request` reaches the middleware
 * through the initial context (oRPC middlewares cannot see the Request
 * otherwise).
 *
 * ```ts
 * const hexclave = createHexclaveORPC(stackServerApp, {
 *   unauthorized: () => new ORPCError("UNAUTHORIZED"), // required for `required: true`
 * });
 *
 * export const publicBase = os.$context<HexclaveORPCContext>().use(hexclave.middleware());
 * export const protectedBase = publicBase.use(hexclave.middleware({ required: true }));
 *
 * const handler = new RPCHandler(router);
 * export const handle = hexclave.wrapFetchHandler(handler, { prefix: "/rpc" });
 * ```
 *
 * Every procedure then runs inside an `orpc.procedure` span linked to the
 * caller's client session, with `context.user` resolved — no `{ request }`
 * plumbing.
 *
 * NOTE: oRPC's `ORPCError` is constructor-branded, so the adapter deliberately
 * does NOT fake one structurally — pass your own `unauthorized` factory (built
 * from your `orpc` import) to use `required: true`.
 */

/** Shape of the initial context `wrapFetchHandler` injects / the middleware consumes+extends. */
const hexclaveORPCSpanStarted = Symbol("hexclaveORPCSpanStarted");

export type HexclaveORPCContext = {
  hexclave?: HexclaveRequestContext,
  user?: AdapterUser | null,
  [hexclaveORPCSpanStarted]?: true,
};

/**
 * The slice of oRPC's middleware options the adapter reads. The runtime
 * objects carry the consumer's full context; everything beyond this slice
 * passes through the `...context` spread untouched.
 */
type ORPCMiddlewareOpts = {
  context: HexclaveORPCContext,
  path?: readonly string[],
  next: (opts?: { context?: HexclaveORPCContext }) => Promise<unknown>,
};

export type HexclaveORPCMiddlewareOptions = {
  /** Reject unauthenticated calls; `context.user` is then non-null. Requires an `unauthorized` factory. */
  required?: boolean,
  /** Disable or customize the per-procedure span. @default true */
  telemetry?: AdapterTelemetryOptions,
  /** Error factory for `required` rejections, e.g. `() => new ORPCError("UNAUTHORIZED")`. */
  unauthorized?: () => Error,
};

export function createHexclaveORPC(app: AdapterServerApp, options?: {
  unauthorized?: () => Error,
}) {
  return {
    /** A plain middleware for `.use(...)`: request-linked span + `context.user`. */
    middleware: (middlewareOptions?: HexclaveORPCMiddlewareOptions) => {
      const unauthorized = middlewareOptions?.unauthorized ?? options?.unauthorized;
      if (middlewareOptions?.required && !unauthorized) {
        throw new Error("Hexclave oRPC adapter: `required: true` needs an `unauthorized` error factory (e.g. () => new ORPCError(\"UNAUTHORIZED\")) — oRPC errors cannot be constructed without your orpc import.");
      }
      return async ({ context, path, next }: ORPCMiddlewareOpts) => {
        if (context.hexclave === undefined) {
          throw new Error("Hexclave oRPC adapter middleware needs `wrapFetchHandler()` or a Hexclave request context.");
        }
        const hexclave = context.hexclave;
        const run = async (spanActive: boolean) => {
          const user = await hexclave.getUser();
          if (middlewareOptions?.required && user === null) {
            throw unauthorized!();
          }
          return await next({
            context: {
              ...context,
              hexclave,
              user,
              ...spanActive ? { [hexclaveORPCSpanStarted]: true } : {},
            },
          });
        };
        if (context[hexclaveORPCSpanStarted] === true) {
          return await run(false);
        }
        return await runRequestSpan(app, hexclave, {
          defaultSpanType: "orpc.procedure",
          data: { path: path?.join(".") ?? null },
          telemetry: middlewareOptions?.telemetry,
        }, async (span) => await run(span !== null));
      };
    },

    /**
     * Wraps an oRPC fetch handler (`RPCHandler` / `OpenAPIHandler`) so every
     * `handle(request, …)` call carries the per-request Hexclave context into
     * the middlewares above. Extra per-call options pass through untouched.
     */
    wrapFetchHandler: <THandler extends { handle: (request: Request, handleOptions?: { context?: HexclaveORPCContext }) => unknown }>(
      handler: THandler,
      defaultOptions?: Parameters<THandler["handle"]>[1],
    ) => {
      return (request: Request, handleOptions?: Parameters<THandler["handle"]>[1]): ReturnType<THandler["handle"]> => {
        // The annotation names the one key the wrapper touches; the consumer's
        // remaining handle options still pass through the `...merged` spread.
        const merged: { context?: HexclaveORPCContext } = { ...defaultOptions, ...handleOptions };
        // SAFETY: TS resolves `handler.handle(...)` through the generic
        // constraint (returning unknown); the concrete handler returns exactly
        // ReturnType<THandler["handle"]>, which the cast restores.
        return handler.handle(request, {
          ...merged,
          context: {
            ...merged.context,
            hexclave: createRequestContext(app, request),
          },
        }) as ReturnType<THandler["handle"]>;
      };
    },
  };
}

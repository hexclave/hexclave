import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { AdapterServerApp, AdapterTelemetryOptions, AdapterUser, createRequestContext, HexclaveRequestContext, runRequestSpan } from "./adapter-core";

/**
 * Hexclave adapter for tRPC (v11). Zero runtime dependency on `@trpc/server`:
 * the factory is handed the consumer's `t` instance (from `initTRPC`) and only
 * calls `t.middleware`. Because `TRPCError` is constructor-branded, protected
 * procedures require an error factory created from the consumer's tRPC import.
 *
 * ```ts
 * const t = initTRPC.context<HexclaveTRPCContext>().create();
 * const hexclave = createHexclaveTRPC(t, stackServerApp, {
 *   unauthorized: () => new TRPCError({ code: "UNAUTHORIZED" }),
 * });
 *
 * export const createContext = hexclave.createContext; // pass to your adapter
 * export const publicProcedure = t.procedure.use(hexclave.middleware());
 * export const protectedProcedure = t.procedure.use(hexclave.middleware({ required: true }));
 * ```
 *
 * Every procedure then runs inside a `trpc.procedure` span linked to the
 * caller's client session ({ path, type } in the span data), with `ctx.user`
 * resolved (non-null under `required: true`) — no `{ request }` plumbing.
 */

/** Shape of the context `createContext` produces / the middleware consumes+extends. */
export type HexclaveTRPCContext = {
  hexclave?: HexclaveRequestContext,
  user?: AdapterUser | null,
};

/**
 * The slice of tRPC's middleware options the adapter reads. The runtime
 * objects carry the consumer's full context; everything beyond this slice
 * passes through the `...ctx` spread untouched.
 */
type TRPCMiddlewareOpts = {
  ctx: HexclaveTRPCContext,
  path: string,
  type: string,
  next: (opts?: { ctx?: HexclaveTRPCContext }) => Promise<unknown>,
};

/** The slice of a `initTRPC...create()` instance the adapter needs. */
export type TRPCInstanceLike = {
  middleware: (fn: (opts: TRPCMiddlewareOpts) => Promise<unknown>) => unknown,
};

export type HexclaveTRPCMiddlewareOptions = {
  /** Reject unauthenticated calls (UNAUTHORIZED); `ctx.user` is then non-null. */
  required?: boolean,
  /** Disable or customize the per-procedure span. @default true */
  telemetry?: AdapterTelemetryOptions,
  /** Error factory for `required` rejections (e.g. `() => new TRPCError({ code: "UNAUTHORIZED" })`). */
  unauthorized?: () => Error,
};

/**
 * The slice of the tRPC adapter's `createContext` options the adapter reads:
 * the fetch adapter provides `req` (a `Request`), Node adapters provide `req`
 * (an `IncomingMessage`), and some custom setups provide `request`. The values
 * stay unknown until `normalizeRequestLike` parses them.
 */
export type TRPCContextOptionsLike = { req?: unknown, request?: unknown };

export function createHexclaveTRPC<T extends TRPCInstanceLike>(t: T, app: AdapterServerApp, options?: {
  /** Override how the request is pulled out of the adapter's context options. */
  getRequest?: (contextOptions: TRPCContextOptionsLike) => unknown,
  unauthorized?: () => Error,
}) {
  return {
    /**
     * Context builder to pass to the tRPC adapter (fetch adapter, Next.js, …).
     * Normalizes `opts.req` / `opts.request` (both the fetch adapter's Request
     * and Node's IncomingMessage are request-like) and stashes the lazy
     * per-request Hexclave context.
     */
    createContext: (contextOptions: TRPCContextOptionsLike): HexclaveTRPCContext => {
      const requestInput = options?.getRequest
        ? options.getRequest(contextOptions)
        : contextOptions.req ?? contextOptions.request ?? null;
      return { hexclave: createRequestContext(app, requestInput) };
    },

    /** A `t.middleware(...)` wrapping the procedure in a request-linked span + resolving `ctx.user`. */
    middleware: (middlewareOptions?: HexclaveTRPCMiddlewareOptions): ReturnType<T["middleware"]> => {
      const unauthorized = middlewareOptions?.unauthorized ?? options?.unauthorized;
      if (middlewareOptions?.required && unauthorized === undefined) {
        throw new Error("Hexclave tRPC adapter: `required: true` needs an `unauthorized` error factory (e.g. () => new TRPCError({ code: \"UNAUTHORIZED\" })).");
      }
      // SAFETY (for the trailing cast): TS resolves `t.middleware(...)` through
      // the TRPCInstanceLike constraint (returning unknown); the concrete `t`
      // returns exactly ReturnType<T["middleware"]>, which the cast restores.
      return t.middleware(async ({ ctx, path, type, next }: TRPCMiddlewareOpts) => {
        const hexclave = ctx.hexclave
          ?? throwErr("Hexclave tRPC adapter: pass `hexclave.createContext` to your tRPC adapter so the middleware can see the request.");
        return await runRequestSpan(app, hexclave, {
          defaultSpanType: "trpc.procedure",
          data: { path, type },
          telemetry: middlewareOptions?.telemetry,
        }, async () => {
          const user = await hexclave.getUser();
          if (middlewareOptions?.required && user === null) {
            throw unauthorized!();
          }
          return await next({ ctx: { ...ctx, hexclave, user } });
        });
      }) as ReturnType<T["middleware"]>;
    },
  };
}

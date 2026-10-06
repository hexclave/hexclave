import * as tanstackStartServerContext from "@hexclave/tanstack-start/tanstack-start-server-context";
import type { RequestLike } from "../lib/hexclave-app/common";
import { AdapterServerApp, AdapterTelemetryOptions, AdapterUser, HexclaveRequestContext, runGuardedCall, runGuardedRoute, UnauthorizedFactory } from "./adapter-core";

/**
 * Hexclave adapter for TanStack Start. Wraps the two server surfaces: server
 * function handlers (`createServerFn().handler(...)`) and server route methods.
 * Server functions receive no `Request`, so the adapter reads the ambient
 * request headers through the SDK's TanStack Start server context (the same
 * mechanism the cookie token store uses) — which is why this adapter only ships
 * in `@hexclave/tanstack-start` (it is generated out of the other SDK packages).
 *
 * We deliberately wrap handlers instead of shipping a `createMiddleware(...)`
 * instance: TanStack's middleware generics are version-sensitive across our
 * supported peer range, while a handler wrapper never touches their API — and,
 * like the Elysia adapter, wrapping the handler is the only way to put it
 * inside the span's async extent.
 *
 * ```ts
 * const hexclave = createHexclaveTanStackStart(stackServerApp);
 *
 * export const getOrders = createServerFn({ method: "GET" }).handler(
 *   hexclave.serverFn(async ({ ctx, user }) => {
 *     // runs inside a `tanstack-start.server-function` span linked to the caller's client session
 *   }, { name: "getOrders", required: true }),
 * );
 *
 * export const ServerRoute = createServerFileRoute().methods({
 *   GET: hexclave.routeHandler(async ({ request, user }) => {
 *     return Response.json({ orders: await listOrdersFor(user) });
 *   }, { required: true }),
 * });
 * ```
 */

/**
 * The TanStack Start server context re-exports are `undefined` outside
 * server-side request handling (browser builds resolve to a stub module), so a
 * missing export here means the adapter ran in the wrong environment — fail
 * loudly instead of reporting every caller as unauthenticated.
 */
function getAmbientRequestLike(): RequestLike {
  const { getRequestHeader } = tanstackStartServerContext;
  if (getRequestHeader == null) {
    throw new Error("Hexclave TanStack Start adapter can only run during server-side request handling (the TanStack Start server context is unavailable here).");
  }
  return { headers: { get: (name: string) => getRequestHeader(name) ?? null } };
}

export type HexclaveTanStackStartServerFnOptions = {
  /** Reject unauthenticated calls; the handler's `user` is then non-null. */
  required?: boolean,
  /** The server function's name, recorded in the span data (low-cardinality span type stays `tanstack-start.server-function`). */
  name?: string,
  /** Disable or customize the per-call span. @default true */
  telemetry?: AdapterTelemetryOptions,
  /** Error factory for `required` rejections (wins over the factory-level default). */
  unauthorized?: () => Error,
};

export type HexclaveTanStackStartRouteHandlerOptions = {
  /** Reject unauthenticated calls with a 401 before the handler runs; `user` is then non-null. */
  required?: boolean,
  /** Disable or customize the per-route span. @default true */
  telemetry?: AdapterTelemetryOptions,
  /** Response factory for `required` rejections (wins over the factory-level default). @default a JSON 401 response */
  unauthorized?: () => Response | Promise<Response>,
};

export type HexclaveTanStackStartFactoryOptions = {
  /**
   * Default `unauthorized` for every wrapped surface (a per-handler
   * `unauthorized` always wins). One factory serves both surfaces, so it may
   * produce either: a returned `Response` is sent by route handlers, an `Error`
   * is thrown (server functions can only throw, so return an `Error` there).
   */
  unauthorized?: UnauthorizedFactory,
};

export function createHexclaveTanStackStart(app: AdapterServerApp, factoryOptions?: HexclaveTanStackStartFactoryOptions) {
  return {
    /**
     * Wraps a `createServerFn` handler in a `tanstack-start.server-function`
     * span linked to the caller's client session, with the caller resolved as
     * `user`. The wrapped handler receives `{ ctx, user, hexclave }` — `ctx` is
     * whatever TanStack passes the handler (`{ data, context, … }`).
     */
    serverFn: <TCtx, TResult>(
      fn: (options: { ctx: TCtx, user: AdapterUser | null, hexclave: HexclaveRequestContext }) => TResult | Promise<TResult>,
      options?: HexclaveTanStackStartServerFnOptions,
    ) => {
      return async (ctx: TCtx): Promise<TResult> => {
        return await runGuardedCall(app, {
          requestInput: getAmbientRequestLike(),
          defaultSpanType: "tanstack-start.server-function",
          data: { ...options?.name !== undefined ? { name: options.name } : {} },
          telemetry: options?.telemetry,
          required: options?.required,
          unauthorized: options?.unauthorized,
          factoryUnauthorized: factoryOptions?.unauthorized,
          surface: "server function",
        }, ({ user, hexclave }) => fn({ ctx, user, hexclave }));
      };
    },

    /**
     * Wraps a server route method handler in a `tanstack-start.route` span
     * linked to the caller's client session ({ path, method } in the span
     * data). The wrapped handler receives `{ ctx, request, user, hexclave }` —
     * `request` is `ctx.request`, hoisted for convenience.
     */
    routeHandler: <TCtx extends { request: Request }>(
      fn: (options: { ctx: TCtx, request: Request, user: AdapterUser | null, hexclave: HexclaveRequestContext }) => Response | Promise<Response>,
      options?: HexclaveTanStackStartRouteHandlerOptions,
    ) => {
      return async (ctx: TCtx): Promise<Response> => {
        return await runGuardedRoute(app, {
          requestInput: ctx.request,
          defaultSpanType: "tanstack-start.route",
          data: { path: new URL(ctx.request.url).pathname, method: ctx.request.method },
          telemetry: options?.telemetry,
          required: options?.required,
          unauthorized: options?.unauthorized,
          factoryUnauthorized: factoryOptions?.unauthorized,
          surface: "route",
        }, ({ user, hexclave }) => fn({ ctx, request: ctx.request, user, hexclave }));
      };
    },
  };
}

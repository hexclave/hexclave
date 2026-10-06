import { urlString } from "@hexclave/shared/dist/utils/urls";
import type { ConvexCtx } from "../lib/hexclave-app/common";
import { defaultBaseUrl } from "../lib/hexclave-app/apps/implementations/common";
import { AdapterServerApp, AdapterTelemetryOptions, AdapterUser, runAdapterSpan } from "./adapter-core";

export function getConvexProvidersConfig(options: {
  baseUrl?: string,
  projectId: string,
}) {
  const baseUrl = options.baseUrl || defaultBaseUrl;
  const projectId = options.projectId;
  return [
    {
      type: "customJwt",
      issuer: new URL(urlString`/api/v1/projects/${projectId}`, baseUrl),
      jwks: new URL(urlString`/api/v1/projects/${projectId}/.well-known/jwks.json`, baseUrl),
      algorithm: "ES256",
    },
    {
      type: "customJwt",
      issuer: new URL(urlString`/api/v1/projects-anonymous-users/${projectId}`, baseUrl),
      jwks: new URL(urlString`/api/v1/projects/${projectId}/.well-known/jwks.json?include_anonymous=true`, baseUrl),
      algorithm: "ES256",
    },
  ];
}

export type HexclaveConvexFunctionOptions = {
  /** Reject unauthenticated calls; the handler's `user` is then non-null. */
  required?: boolean,
  /** Recorded in the span data (low-cardinality span type stays `convex.function`). */
  kind?: "query" | "mutation" | "action",
  /** The function's name, recorded in the span data. */
  name?: string,
  /** Disable or customize the span. @default true */
  telemetry?: AdapterTelemetryOptions,
  /** Error factory for `required` rejections (wins over the factory-level default). */
  unauthorized?: () => Error,
};

/**
 * The Hexclave request-scoped helpers passed to Convex handlers. Convex
 * functions receive no Request (clients talk over WebSockets), so unlike the
 * HTTP adapters' HexclaveRequestContext there is no `request` here — only the
 * caller resolution, memoized per call.
 */
export type HexclaveConvexContext = {
  getUser: () => Promise<AdapterUser | null>,
};

export type HexclaveConvexFactoryOptions = {
  /** Default `unauthorized` error factory for `required` rejections (per-function option wins). */
  unauthorized?: () => Error,
};

/**
 * Hexclave adapter for Convex. `createHexclaveConvex(app)` returns the wrapper
 * surface, matching the factory naming of the other adapters (tRPC/oRPC/Next/
 * TanStack): `hexclave.function(handler, options)` wraps a Convex function
 * handler, resolving the caller from Convex's identity (`ctx.auth`, wired to
 * Hexclave via `getConvexProvidersConfig`) and running the handler inside a
 * `convex.function` span attributed to that user.
 *
 * ```ts
 * const hexclave = createHexclaveConvex(stackServerApp);
 *
 * export const listItems = query({
 *   handler: hexclave.function(async ({ ctx, args, user }) => {
 *     // user: ServerUser (non-null with { required: true })
 *   }, { required: true, kind: "query", name: "listItems" }),
 * });
 * ```
 *
 * NOTE: Convex clients talk over WebSockets and functions receive no Request,
 * so unlike the HTTP adapters this span is attributed by USER only — it does
 * not join the caller's browser operation or carry replay correlation.
 */
export function createHexclaveConvex(app: AdapterServerApp, factoryOptions?: HexclaveConvexFactoryOptions) {
  return {
    function: <TCtx extends ConvexCtx, TArgs, TResult>(
      handler: (options: { ctx: TCtx, args: TArgs, user: AdapterUser | null, hexclave: HexclaveConvexContext }) => TResult | Promise<TResult>,
      options?: HexclaveConvexFunctionOptions,
    ): (ctx: TCtx, args: TArgs) => Promise<TResult> => {
      return async (ctx: TCtx, args: TArgs): Promise<TResult> => {
        const user = await (app.getUser as (options: { from: "convex", ctx: ConvexCtx, or: "return-null" }) => Promise<AdapterUser | null>)({ from: "convex", ctx, or: "return-null" });
        const hexclave: HexclaveConvexContext = { getUser: async () => user };
        return await runAdapterSpan(app, {
          defaultSpanType: "convex.function",
          data: {
            ...options?.kind ? { kind: options.kind } : {},
            ...options?.name ? { name: options.name } : {},
          },
          link: user !== null ? { userId: user.id } : undefined,
          telemetry: options?.telemetry,
        }, async () => {
          if (options?.required && user === null) {
            throw (options.unauthorized ?? factoryOptions?.unauthorized)?.() ?? new Error("You must be signed in to call this Convex function. (Hexclave: no identity on ctx.auth.)");
          }
          return await handler({ ctx, args, user, hexclave });
        });
      };
    },
  };
}

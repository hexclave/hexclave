import { headers as rscHeaders } from "@hexclave/sc/force-react-server";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import type { RequestLike } from "../lib/hexclave-app/common";
import { getServerAppInstrumentation } from "../lib/hexclave-app/apps/implementations/server-app-instrumentation";
import { preCaught } from "../lib/hexclave-app/apps/implementations/telemetry-core";
import { AdapterServerApp, AdapterTelemetryOptions, AdapterUser, HexclaveRequestContext, runGuardedCall, runGuardedRoute, UnauthorizedFactory } from "./adapter-core";

/**
 * Hexclave adapter for Next.js (App Router). Unlike the tRPC/oRPC/Elysia
 * adapters there is no framework instance to hand in: route handlers receive
 * the `Request` directly, and server actions read the ambient request headers
 * via `next/headers` (which is why this adapter only ships in `@hexclave/next`
 * — it is generated out of the other SDK packages).
 *
 * ```ts
 * const hexclave = createHexclaveNext(stackServerApp);
 *
 * // app/api/orders/route.ts
 * export const GET = hexclave.routeHandler(async ({ request, user }) => {
 *   // runs inside a `next.route` span linked to the caller's client session
 *   return Response.json({ orders: await listOrdersFor(user) });
 * }, { required: true });
 *
 * // app/actions.ts ("use server")
 * export const createOrder = hexclave.serverAction(async ({ user }, formData: FormData) => {
 *   // runs inside a `next.server-action` span linked to the caller's client session
 * }, { name: "createOrder", required: true });
 * ```
 */

/** What route handlers wrapped by the adapter receive (as a single object). */
export type HexclaveNextRouteHandlerContext<TRouteContext> = {
  request: Request,
  /** The second argument Next.js passes to the route handler (`{ params }`). */
  context: TRouteContext,
  user: AdapterUser | null,
  hexclave: HexclaveRequestContext,
};

export type HexclaveNextRouteHandlerOptions = {
  /** Reject unauthenticated calls with a 401 before the handler runs; `user` is then non-null. */
  required?: boolean,
  /** Disable or customize the per-route span. @default true */
  telemetry?: AdapterTelemetryOptions,
  /** Response factory for `required` rejections (wins over the factory-level default). @default a JSON 401 response */
  unauthorized?: () => Response | Promise<Response>,
};

export type HexclaveNextServerActionOptions = {
  /** Reject unauthenticated calls; the action's `user` is then non-null. */
  required?: boolean,
  /** The action's name, recorded in the span data (low-cardinality span type stays `next.server-action`). */
  name?: string,
  /** Disable or customize the per-action span. @default true */
  telemetry?: AdapterTelemetryOptions,
  /** Error factory for `required` rejections (wins over the factory-level default). */
  unauthorized?: () => Error,
};

export type HexclaveNextFactoryOptions = {
  /**
   * Default `unauthorized` for every wrapped surface (a per-handler
   * `unauthorized` always wins). One factory serves both surfaces, so it may
   * produce either: a returned `Response` is sent by route handlers, an `Error`
   * is thrown (server actions can only throw, so return an `Error` there).
   */
  unauthorized?: UnauthorizedFactory,
};

/**
 * Loosely matches Next.js's documented `onRequestError` arguments (structural
 * typing on purpose — no `next` type imports, and Next may add fields).
 */
export type HexclaveNextRequestErrorRequest = {
  path?: string,
  method?: string,
  headers?: unknown,
};

export type HexclaveNextRequestErrorContext = {
  routerKind?: string,
  routePath?: string,
  routeType?: string,
};

export type HexclaveNextInstrumentation = {
  // Async because provider/exporter registration must finish before app code
  // starts spans. Next.js awaits an async instrumentation `register` export.
  register: () => Promise<void>,
  onRequestError: (error: unknown, request: HexclaveNextRequestErrorRequest, errorContext?: HexclaveNextRequestErrorContext) => Promise<void>,
  /**
   * Advanced collector/control-plane hook. Runs one callback with every
   * SDK-native telemetry source suppressed in OTel's async context, preventing
   * self-ingestion feedback loops.
   */
  runWithTelemetrySuppressed: <T>(fn: () => Promise<T>) => Promise<T>,
  /**
   * Reports an error the HOST already caught and handled, with no HTTP request
   * to attribute it to.
   *
   * `onRequestError` is Next's hook for errors that escaped a request, so it
   * requires a request. An application that catches its own errors — a global
   * reporting helper, a background job, a queue consumer — has nowhere to send
   * them, and they would otherwise only ever reach `console.error`, which
   * produces a log line rather than a tracked error.
   *
   * Reported with `handled: true`, so these never count against crash-free
   * rate the way an uncaught exception does.
   */
  captureHandledError: (error: unknown, info?: { location?: string, data?: Record<string, unknown> }) => Promise<void>,
};

export type HexclaveNextInstrumentationOptions = {
  /**
   * OpenTelemetry instrumentation instances registered with the managed OTel
   * provider, e.g. `[new PrismaInstrumentation()]`. Libraries that emit spans
   * through the global API directly need no entry here.
   */
  instrumentations?: Instrumentation[],
  /**
   * Whether bare telemetry and `onRequestError` should resolve the current
   * Next.js request's session and W3C propagation headers. Disable this when a
   * control plane records its own telemetry into a separate internal project:
   * the incoming request belongs to a customer project, not the telemetry app.
   *
   * @default true
   */
  requestAttribution?: boolean,
  /**
   * Returns true when automatic SDK telemetry must be suppressed in the
   * current async context. Advanced collector/control-plane hook: pass the
   * runtime's standard tracing-suppression predicate so SDK-native fetch,
   * library, log, and error capture follows the same recursion boundary.
   */
  isTelemetrySuppressed?: () => boolean,
};

const ambientRequestLikeByHeaders = new WeakMap<object, RequestLike>();

async function resolveAmbientNextRequest(): Promise<RequestLike | null> {
  let headers: unknown;
  try {
    headers = await rscHeaders();
  } catch {
    return null;
  }
  if (typeof headers !== "object" || headers === null) return null;
  const existing = ambientRequestLikeByHeaders.get(headers);
  if (existing !== undefined) return existing;
  const requestLike: RequestLike = { headers: headers as { get: (name: string) => string | null } };
  ambientRequestLikeByHeaders.set(headers, requestLike);
  return requestLike;
}

/** Next's `request.headers` can be a `Headers` or a Node dict (values possibly
 * string arrays); normalize to the SDK's RequestLike or undefined. */
function nextRequestToRequestLike(request: HexclaveNextRequestErrorRequest): RequestLike | undefined {
  const headers = request.headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    // Headers-shaped: matches RequestLike's `{ get }` variant directly. The
    // cast mirrors readBaggageHeader's guarded access pattern.
    return { headers: headers as { get: (name: string) => string | null } };
  }
  const normalized: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[name] = value;
    } else if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")) {
      normalized[name] = value.join(", ");
    }
  }
  return { headers: normalized };
}

/**
 * Glue for the customer's `instrumentation.ts`.
 *
 * Next.js compiles that file for Edge as well as Node. Dynamically import this
 * module behind an inline `process.env.NEXT_RUNTIME !== "nodejs"` check (not a
 * helper — Next must see the member expression to drop the Node-only graph
 * from the Edge bundle):
 *
 * ```ts
 * // instrumentation.ts
 * export async function register() {
 *   if (process.env.NEXT_RUNTIME !== "nodejs") return;
 *   const { hexclaveInstrumentation } = await import("@hexclave/next/next");
 *   const { stackServerApp } = await import("./stack");
 *   await hexclaveInstrumentation(stackServerApp).register();
 * }
 * export async function onRequestError(...args: Parameters<HexclaveNextInstrumentation["onRequestError"]>) {
 *   if (process.env.NEXT_RUNTIME !== "nodejs") return;
 *   const { hexclaveInstrumentation } = await import("@hexclave/next/next");
 *   const { stackServerApp } = await import("./stack");
 *   await hexclaveInstrumentation(stackServerApp).onRequestError(...args);
 * }
 * ```
 *
 * `register()` installs the managed OTel provider, official Undici
 * instrumentation, authenticated exporters, and the uncaught-exception monitor
 * (`$error` events via `process.on("uncaughtExceptionMonitor")` —
 * observation-only, never changes crash behavior). Both also self-install at
 * app construction, so keeping them here is redundancy, not a requirement.
 * Next-only, it also installs the ambient request provider: bare `trackEvent` /
 * `withSpan` / logger calls inside a request scope attribute to the caller's
 * session via `next/headers` without passing `{ request }`. Safe under HMR:
 * installs are idempotent per app instance and replace-keyed per project on
 * globalThis. A pre-existing global provider is an explicit conflict instead
 * of a silent fallback; existing-provider applications wire the Hexclave
 * exporter into their provider directly. `onRequestError` records every
 * uncaught server-side error as a `$error` event linked (via the request's
 * headers) to the caller's client session.
 *
 * Libraries using the global API directly (Drizzle's OTel support, the
 * Vercel AI SDK's `experimental_telemetry`) need nothing at all; libraries
 * that ship an instrumentation CLASS plug in via the options:
 *
 * ```ts
 * // instrumentation.ts
 * export async function register() {
 *   if (process.env.NEXT_RUNTIME !== "nodejs") return;
 *   const { PrismaInstrumentation } = await import("@prisma/instrumentation");
 *   const { hexclaveInstrumentation } = await import("@hexclave/next/next");
 *   const { stackServerApp } = await import("./stack");
 *   await hexclaveInstrumentation(stackServerApp, {
 *     instrumentations: [new PrismaInstrumentation()],
 *   }).register();
 * }
 * ```
 *
 * This does not create per-route server spans — Next.js has no hook that wraps
 * a route's async extent. Per-route auto-spans still require the adapter
 * wrappers (`routeHandler` / `serverAction` above).
 */
export function hexclaveInstrumentation(app: AdapterServerApp, options?: HexclaveNextInstrumentationOptions): HexclaveNextInstrumentation {
  const instrumentation = getServerAppInstrumentation(app);
  if (instrumentation === null) {
    throw new Error("hexclaveInstrumentation() requires a StackServerApp instance (created with `new StackServerApp(...)`)");
  }
  return {
    runWithTelemetrySuppressed: async (fn) => await instrumentation.runWithTelemetrySuppressed(fn),
    captureHandledError: (error, info) => preCaught(Promise.resolve().then(async () => await instrumentation.captureServerRequestError(error, {
      mechanism: "captured",
      handled: true,
      data: {
        ...info?.data ?? {},
        ...info?.location === undefined ? {} : { location: info.location },
        mechanism_type: "captured",
        handled: true,
      },
    }))),
    register: async () => {
      instrumentation.ensureOpenTelemetryProvider();
      instrumentation.installServerErrorMonitor();
      instrumentation.setTelemetrySuppressionPredicate(options?.isTelemetrySuppressed ?? null);
      instrumentation.setAmbientRequestProvider(options?.requestAttribution === false ? null : resolveAmbientNextRequest);
      await instrumentation.registerOpenTelemetry(options?.instrumentations ?? []);
    },
    onRequestError: async (error, request, errorContext) => {
      try {
        const digest = typeof error === "object" && error !== null && "digest" in error && typeof error.digest === "string"
          ? error.digest
          : undefined;
        await instrumentation.captureServerRequestError(error, {
          mechanism: "next.onRequestError",
          handled: false,
          ...options?.requestAttribution === false ? {} : { request: nextRequestToRequestLike(request) },
          data: {
            ...typeof request.path === "string" ? { path: request.path } : {},
            ...typeof request.method === "string" ? { method: request.method } : {},
            ...typeof errorContext?.routerKind === "string" ? { router_kind: errorContext.routerKind } : {},
            ...typeof errorContext?.routePath === "string" ? { route_path: errorContext.routePath } : {},
            ...typeof errorContext?.routeType === "string" ? { route_type: errorContext.routeType } : {},
            ...digest !== undefined ? { digest } : {},
          },
        });
      } catch (captureError) {
        console.warn("Hexclave analytics: failed to report a request error:", captureError);
      }
    },
  };
}

export function createHexclaveNext(app: AdapterServerApp, factoryOptions?: HexclaveNextFactoryOptions) {
  return {
    /**
     * Wraps an App Router route handler (`GET`, `POST`, …) in a `next.route`
     * span linked to the caller's client session ({ path, method } in the span
     * data), with the caller resolved as `user`. The wrapped function keeps
     * Next.js's `(request, context)` signature, so export it directly.
     */
    routeHandler: <TRouteContext = unknown>(
      fn: (ctx: HexclaveNextRouteHandlerContext<TRouteContext>) => Response | Promise<Response>,
      options?: HexclaveNextRouteHandlerOptions,
    ) => {
      return async (request: Request, context: TRouteContext): Promise<Response> => {
        return await runGuardedRoute(app, {
          requestInput: request,
          defaultSpanType: "next.route",
          data: { path: new URL(request.url).pathname, method: request.method },
          telemetry: options?.telemetry,
          required: options?.required,
          unauthorized: options?.unauthorized,
          factoryUnauthorized: factoryOptions?.unauthorized,
          surface: "route",
        }, ({ user, hexclave }) => fn({ request, context, user, hexclave }));
      };
    },

    /**
     * Wraps a server action in a `next.server-action` span linked to the
     * caller's client session, prepending a `{ user, hexclave }` context to the
     * action's own arguments — the wrapped action keeps its outward signature,
     * so it works with `<form action={...}>` and direct calls alike.
     *
     * Server actions receive no `Request`; the ambient headers from
     * `next/headers` carry both the session cookies and the
     * `baggage` header (the browser SDK's patched fetch
     * instruments React's action POSTs like any other same-origin request).
     */
    serverAction: <TArgs extends unknown[], TResult>(
      fn: (context: { user: AdapterUser | null, hexclave: HexclaveRequestContext }, ...args: TArgs) => TResult | Promise<TResult>,
      options?: HexclaveNextServerActionOptions,
    ) => {
      return async (...args: TArgs): Promise<TResult> => {
        const requestInput = await resolveAmbientNextRequest()
          ?? throwErr("Hexclave: `serverAction` must be called during a Next.js request (next/headers is unavailable here).");
        return await runGuardedCall(app, {
          requestInput,
          defaultSpanType: "next.server-action",
          data: { ...options?.name !== undefined ? { name: options.name } : {} },
          telemetry: options?.telemetry,
          required: options?.required,
          unauthorized: options?.unauthorized,
          factoryUnauthorized: factoryOptions?.unauthorized,
          surface: "server action",
        }, ({ user, hexclave }) => fn({ user, hexclave }, ...args));
      };
    },
  };
}

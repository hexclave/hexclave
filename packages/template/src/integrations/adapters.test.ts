import { describe, expect, it, vi } from "vitest";
import { createRequestContext, normalizeRequestLike, runGuardedCall, runGuardedRoute, type AdapterServerApp } from "./adapter-core";
import { createHexclaveConvex } from "./convex";
import { createHexclaveElysia, type ElysiaLikeForPlugin } from "./elysia";
import { createHexclaveORPC } from "./orpc";
import { createHexclaveTRPC } from "./trpc";
import { getActiveErrorScope } from "../lib/hexclave-app/apps/implementations/error-scope";

const FAKE_USER = { id: "user-1", displayName: "Test" };

function makeApp(overrides?: { user?: unknown | null }) {
  const user = overrides && "user" in overrides ? overrides.user : FAKE_USER;
  const withSpan = vi.fn(async (_type: string, _options: unknown, fn: (span: unknown) => unknown) => await fn({ spanId: "span-1" }));
  const getUser = vi.fn(async () => user);
  // SAFETY: the adapters only call app.withSpan(type, options, fn) and app.getUser({ tokenStore, or: "return-null" }),
  // so a two-method fixture is sufficient; starting from an empty base means any new StackServerApp dependency of the
  // adapters fails loudly here instead of being silently mocked.
  const app = Object.assign({} as AdapterServerApp, { withSpan, getUser });
  return { app, withSpan, getUser };
}

function makeRequest(headers?: Record<string, string>): Request {
  return new Request("https://api.example.com/x", { headers });
}

describe("adapter-core", () => {
  it("normalizeRequestLike accepts Request / header records, rejects garbage", () => {
    expect(normalizeRequestLike(makeRequest())).not.toBeNull();
    expect(normalizeRequestLike({ headers: { cookie: "a=b" } })).not.toBeNull();
    expect(normalizeRequestLike(null)).toBeNull();
    expect(normalizeRequestLike("nope")).toBeNull();
    expect(normalizeRequestLike({})).toBeNull();
  });

  it("createRequestContext resolves the user lazily and memoizes", async () => {
    const { app, getUser } = makeApp();
    const context = createRequestContext(app, makeRequest());
    expect(getUser).not.toHaveBeenCalled();
    await expect(context.getUser()).resolves.toEqual(FAKE_USER);
    await context.getUser();
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("createRequestContext rejects missing adapter wiring", () => {
    const { app, getUser } = makeApp();
    expect(() => createRequestContext(app, undefined)).toThrow(/could not find a request-like object/);
    expect(getUser).not.toHaveBeenCalled();
  });

  describe("guarded handler spine", () => {
    const guardInfo = {
      defaultSpanType: "test.surface",
      data: {},
      telemetry: undefined,
      required: true,
      unauthorized: undefined,
      factoryUnauthorized: undefined,
      surface: "route",
    };

    it("runs the handler and skips the rejection when a caller is authenticated", async () => {
      const { app } = makeApp();
      const handler = vi.fn(async () => Response.json({ ok: true }));
      const response = await runGuardedRoute(app, { ...guardInfo, requestInput: makeRequest() }, handler);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
    });

    it("answers an unauthenticated route with a 401 by default, without running the handler", async () => {
      const { app } = makeApp({ user: null });
      const handler = vi.fn(async () => Response.json({ ok: true }));
      const response = await runGuardedRoute(app, { ...guardInfo, requestInput: makeRequest() }, handler);
      expect(handler).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("signed in") });
    });

    it("returns a factory-produced Response from a route but throws a factory-produced Error", async () => {
      const { app } = makeApp({ user: null });
      const asResponse = await runGuardedRoute(app, {
        ...guardInfo,
        requestInput: makeRequest(),
        factoryUnauthorized: () => new Response("nope", { status: 418 }),
      }, async () => Response.json({ ok: true }));
      expect(asResponse.status).toBe(418);

      await expect(runGuardedRoute(app, {
        ...guardInfo,
        requestInput: makeRequest(),
        factoryUnauthorized: () => Object.assign(new Error("nope"), { fromFactory: true }),
      }, async () => Response.json({ ok: true }))).rejects.toMatchObject({ fromFactory: true });
    });

    it("prefers a per-handler factory over the factory-level default", async () => {
      const { app } = makeApp({ user: null });
      const response = await runGuardedRoute(app, {
        ...guardInfo,
        requestInput: makeRequest(),
        unauthorized: () => new Response("per-handler", { status: 403 }),
        factoryUnauthorized: () => new Response("factory", { status: 418 }),
      }, async () => Response.json({ ok: true }));
      expect(response.status).toBe(403);
    });

    it("always throws from a throw-only surface, whatever the factory produced", async () => {
      const { app } = makeApp({ user: null });
      const handler = vi.fn(async () => "unreachable");
      await expect(runGuardedCall(app, { ...guardInfo, requestInput: makeRequest(), surface: "server action" }, handler))
        .rejects.toThrow(/signed in to call this server action/);
      expect(handler).not.toHaveBeenCalled();

      await expect(runGuardedCall(app, {
        ...guardInfo,
        requestInput: makeRequest(),
        surface: "server action",
        factoryUnauthorized: () => new Response("nope", { status: 418 }),
      }, handler)).rejects.toBeInstanceOf(Response);
    });

    it("links the span to the request on every guarded surface", async () => {
      const { app, withSpan } = makeApp();
      await runGuardedRoute(app, { ...guardInfo, requestInput: makeRequest() }, async () => Response.json({ ok: true }));
      await runGuardedCall(app, { ...guardInfo, requestInput: makeRequest(), surface: "server action" }, async () => "ok");
      expect(withSpan).toHaveBeenCalledTimes(2);
      for (const [, options] of withSpan.mock.calls) {
        expect((options as { request?: unknown }).request).not.toBeUndefined();
      }
    });

    it("telemetry: false runs the handler with no span at all", async () => {
      const { app, withSpan } = makeApp();
      const response = await runGuardedRoute(app, {
        ...guardInfo,
        requestInput: makeRequest(),
        telemetry: false,
      }, async () => Response.json({ ok: true }));
      expect(response.status).toBe(200);
      expect(withSpan).not.toHaveBeenCalled();
    });

    it("isolates asynchronous request scopes and enriches them with the authenticated user", async () => {
      const first = makeApp({ user: { id: "user-a" } });
      const second = makeApp({ user: { id: "user-b" } });
      const observe = async (app: AdapterServerApp, tag: string) => await runGuardedCall(app, {
        ...guardInfo,
        requestInput: makeRequest(),
        surface: "server action",
      }, async () => {
        getActiveErrorScope()?.setTag("request", tag);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return getActiveErrorScope()?.snapshot();
      });

      const [firstScope, secondScope] = await Promise.all([
        observe(first.app, "a"),
        observe(second.app, "b"),
      ]);

      expect(firstScope).toMatchObject({ user: { id: "user-a" }, tags: { request: "a" } });
      expect(secondScope).toMatchObject({ user: { id: "user-b" }, tags: { request: "b" } });
      expect(getActiveErrorScope()).toBeNull();
    });
  });
});

describe("tRPC adapter", () => {
  const t = { middleware: (fn: (opts: never) => Promise<unknown>) => fn };

  function callMiddleware(middleware: unknown, ctx: Record<string, unknown>) {
    const next = vi.fn(async (opts?: { ctx?: Record<string, unknown> }) => ({ nextCtx: opts?.ctx }));
    const result = (middleware as (opts: unknown) => Promise<unknown>)({ ctx, path: "checkout.create", type: "mutation", next });
    return { next, result };
  }

  it("createContext stashes a lazy context from opts.req", async () => {
    const { app, getUser } = makeApp();
    const hexclave = createHexclaveTRPC(t, app);
    const ctx = hexclave.createContext({ req: makeRequest() });
    expect(getUser).not.toHaveBeenCalled();
    await expect(ctx.hexclave!.getUser()).resolves.toEqual(FAKE_USER);
  });

  it("middleware wraps the procedure in a request-linked span and injects ctx.user", async () => {
    const { app, withSpan } = makeApp();
    const hexclave = createHexclaveTRPC(t, app);
    const ctx = { ...hexclave.createContext({ req: makeRequest() }), db: { name: "main" } } as Record<string, unknown>;
    const { next, result } = callMiddleware(hexclave.middleware(), ctx);
    await result;
    expect(withSpan).toHaveBeenCalledTimes(1);
    const [spanType, options] = withSpan.mock.calls[0];
    expect(spanType).toBe("trpc.procedure");
    expect((options as { data: unknown }).data).toEqual({ path: "checkout.create", type: "mutation" });
    expect((options as { request: unknown }).request).not.toBeUndefined();
    expect(next).toHaveBeenCalledWith({ ctx: expect.objectContaining({ user: FAKE_USER }) });
    expect(next).toHaveBeenCalledWith({ ctx: expect.objectContaining({ db: { name: "main" } }) });
  });

  it("required: true requires and throws the caller's real tRPC error", async () => {
    const { app } = makeApp({ user: null });
    const unauthorized = () => Object.assign(new Error("UNAUTHORIZED"), { fromFactory: true });
    const hexclave = createHexclaveTRPC(t, app, { unauthorized });
    const ctx = hexclave.createContext({ req: makeRequest() }) as Record<string, unknown>;
    const { next, result } = callMiddleware(hexclave.middleware({ required: true }), ctx);
    await expect(result).rejects.toMatchObject({ fromFactory: true });
    expect(next).not.toHaveBeenCalled();
  });

  it("required: true without an unauthorized factory fails at middleware creation", () => {
    const { app } = makeApp();
    const hexclave = createHexclaveTRPC(t, app);
    expect(() => hexclave.middleware({ required: true })).toThrow(/unauthorized/);
  });

  it("telemetry: false skips the span but still resolves the user", async () => {
    const { app, withSpan } = makeApp();
    const hexclave = createHexclaveTRPC(t, app);
    const ctx = hexclave.createContext({ req: makeRequest() }) as Record<string, unknown>;
    const { next, result } = callMiddleware(hexclave.middleware({ telemetry: false }), ctx);
    await result;
    expect(withSpan).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith({ ctx: expect.objectContaining({ user: FAKE_USER }) });
  });
});

describe("oRPC adapter", () => {
  it("required: true without an unauthorized factory fails fast at creation", () => {
    const { app } = makeApp();
    const hexclave = createHexclaveORPC(app);
    expect(() => hexclave.middleware({ required: true })).toThrow(/unauthorized/);
  });

  it("middleware rejects missing wrapFetchHandler wiring", async () => {
    const { app } = makeApp();
    const middleware = createHexclaveORPC(app).middleware();
    await expect(middleware({
      context: {},
      path: ["x"],
      next: vi.fn(),
    })).rejects.toThrow(/wrapFetchHandler/);
  });

  it("wrapFetchHandler injects the per-request context; middleware resolves the user in a span", async () => {
    const { app, withSpan } = makeApp();
    const hexclave = createHexclaveORPC(app, { unauthorized: () => new Error("nope") });

    const captured: { context?: Record<string, unknown> }[] = [];
    const handler = {
      handle: (request: Request, options?: Record<string, unknown>) => {
        captured.push(options as { context?: Record<string, unknown> });
        return { matched: true, request };
      },
    };
    const handle = hexclave.wrapFetchHandler(handler, { prefix: "/rpc" });
    handle(makeRequest());
    expect(captured[0].context?.hexclave).toBeDefined();
    expect((captured[0] as { prefix?: string }).prefix).toBe("/rpc");

    const middleware = hexclave.middleware();
    const next = vi.fn(async (opts?: { context?: Record<string, unknown> }) => opts?.context);
    await middleware({ context: captured[0].context as never, path: ["checkout", "create"], next });
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0][0]).toBe("orpc.procedure");
    expect((withSpan.mock.calls[0][1] as { data: unknown }).data).toEqual({ path: "checkout.create" });
    expect(next).toHaveBeenCalledWith({ context: expect.objectContaining({ user: FAKE_USER }) });
  });

  it("middleware preserves existing context values and avoids duplicate spans when composed", async () => {
    const { app, withSpan } = makeApp();
    const hexclave = createHexclaveORPC(app, { unauthorized: () => new Error("nope") });
    const publicMiddleware = hexclave.middleware();
    const protectedMiddleware = hexclave.middleware({ required: true });
    const finalNext = vi.fn(async (opts?: { context?: Record<string, unknown> }) => opts?.context);
    const result = await publicMiddleware({
      context: { service: { name: "orders" }, hexclave: createRequestContext(app, makeRequest()) } as never,
      path: ["orders", "create"],
      next: async (publicOptions?: { context?: Record<string, unknown> }) => {
        return await protectedMiddleware({
          context: publicOptions?.context as never,
          path: ["orders", "create"],
          next: finalNext,
        });
      },
    });

    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ service: { name: "orders" }, user: FAKE_USER });
    expect(finalNext).toHaveBeenCalledWith({ context: expect.objectContaining({ service: { name: "orders" }, user: FAKE_USER }) });
  });

  it("required: true throws the caller-provided error for unauthenticated calls", async () => {
    const { app } = makeApp({ user: null });
    const unauthorized = () => Object.assign(new Error("UNAUTHORIZED"), { fromFactory: true });
    const hexclave = createHexclaveORPC(app, { unauthorized });
    const middleware = hexclave.middleware({ required: true });
    const context = { hexclave: createRequestContext(app, makeRequest()) };
    await expect(middleware({ context: context as never, path: ["x"], next: vi.fn() })).rejects.toMatchObject({ fromFactory: true });
  });
});

describe("Elysia adapter", () => {
  it("resolveUser adds the context + user; requireUser guards with a 401", async () => {
    const { app } = makeApp();
    const hexclave = createHexclaveElysia(app);
    const resolved = await hexclave.resolveUser({ request: makeRequest() });
    expect(resolved.user).toEqual(FAKE_USER);

    const okSet: { status?: number | string } = {};
    expect(hexclave.requireUser({ request: makeRequest(), set: okSet, user: resolved.user } as never)).toBeUndefined();

    const failSet: { status?: number | string } = {};
    const body = hexclave.requireUser({ request: makeRequest(), set: failSet, user: null } as never);
    expect(failSet.status).toBe(401);
    expect(body).toMatchObject({ error: expect.stringContaining("signed in") });
  });

  it("factory-level unauthorized customizes requireUser; requireUserWith overrides per route", () => {
    const { app } = makeApp();
    const hexclave = createHexclaveElysia(app, { unauthorized: () => new Response("factory", { status: 403 }) });
    const set: { status?: number | string } = {};
    const result = hexclave.requireUser({ request: makeRequest(), set, user: null } as never);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    const throwing = hexclave.requireUserWith({ unauthorized: () => Object.assign(new Error("PER-ROUTE"), { perRoute: true }) });
    expect(() => throwing({ request: makeRequest(), set: {}, user: null } as never)).toThrow(/PER-ROUTE/);
    expect(hexclave.requireUser({ request: makeRequest(), set: {}, user: FAKE_USER } as never)).toBeUndefined();
  });

  type PluginHooks = {
    onRequest: (ctx: { request: Request }) => void,
    onAfterResponse: (ctx: { request: Request, path?: string, set: { status?: number | string } }) => Promise<void>,
    onError: (ctx: { request: Request, error?: unknown, set: { status?: number | string } }) => Promise<void>,
  };

  function collectPluginHooks(hexclave: ReturnType<typeof createHexclaveElysia>): PluginHooks {
    const hooks: Partial<PluginHooks> = {};
    const elysia: ElysiaLikeForPlugin = {
      onRequest: (scope, fn) => {
        expect(scope).toEqual({ as: "global" });
        hooks.onRequest = fn;
        return elysia;
      },
      onAfterResponse: (scope, fn) => {
        expect(scope).toEqual({ as: "global" });
        hooks.onAfterResponse = fn;
        return elysia;
      },
      onError: (scope, fn) => {
        expect(scope).toEqual({ as: "global" });
        hooks.onError = fn;
        return elysia;
      },
    };
    expect(hexclave.plugin(elysia)).toBe(elysia);
    if (!hooks.onRequest || !hooks.onAfterResponse || !hooks.onError) throw new Error("plugin did not register all hooks");
    return { onRequest: hooks.onRequest, onAfterResponse: hooks.onAfterResponse, onError: hooks.onError };
  }

  it("plugin spans a route via global hooks with backdated start, path/method/status data", async () => {
    const { app, withSpan } = makeApp();
    const hooks = collectPluginHooks(createHexclaveElysia(app));

    const request = new Request("https://api.example.com/orders?page=2", { method: "POST" });
    const beforeMs = Date.now();
    hooks.onRequest({ request });
    await hooks.onAfterResponse({ request, path: "/orders", set: { status: 201 } });

    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0][0]).toBe("elysia.route");
    const options = withSpan.mock.calls[0][1] as { data: unknown, startedAtMs: number, request: unknown };
    expect(options.data).toEqual({ path: "/orders", method: "POST", status: 201 });
    expect(options.startedAtMs).toBeGreaterThanOrEqual(beforeMs);
    expect(options.request).not.toBeUndefined();

    await hooks.onAfterResponse({ request, path: "/orders", set: {} });
    expect(withSpan).toHaveBeenCalledTimes(1);
  });

  it("plugin records errors via onError (message in data.error; onAfterResponse then no-ops)", async () => {
    const { app, withSpan } = makeApp();
    const hooks = collectPluginHooks(createHexclaveElysia(app));

    const request = new Request("https://api.example.com/boom");
    hooks.onRequest({ request });
    await hooks.onError({ request, error: new Error("kaput"), set: { status: 500 } });
    await hooks.onAfterResponse({ request, set: { status: 500 } });

    expect(withSpan).toHaveBeenCalledTimes(1);
    expect((withSpan.mock.calls[0][1] as { data: unknown }).data).toEqual({ path: "/boom", method: "GET", status: 500, error: "kaput" });
  });

  it("plugin defaults status to 200 when Elysia leaves set.status unset", async () => {
    const { app, withSpan } = makeApp();
    const hooks = collectPluginHooks(createHexclaveElysia(app));
    const request = new Request("https://api.example.com/ok");
    hooks.onRequest({ request });
    await hooks.onAfterResponse({ request, path: "/ok", set: {} });
    expect((withSpan.mock.calls[0][1] as { data: { status: number } }).data.status).toBe(200);
  });

  it("plugin skips requests already spanned by a handler() wrapper (no double spans)", async () => {
    const { app, withSpan } = makeApp();
    const hexclave = createHexclaveElysia(app);
    const hooks = collectPluginHooks(hexclave);

    const request = new Request("https://api.example.com/wrapped", { method: "GET" });
    hooks.onRequest({ request });
    const wrapped = hexclave.handler(async () => "ok");
    await wrapped({ request, path: "/wrapped", set: {}, user: FAKE_USER, hexclave: createRequestContext(app, request) } as never);
    await hooks.onAfterResponse({ request, path: "/wrapped", set: { status: 200 } });

    expect(withSpan).toHaveBeenCalledTimes(1);
    expect((withSpan.mock.calls[0][1] as { data: unknown }).data).toEqual({ path: "/wrapped", method: "GET" });
  });

  it("plugin respects factory-level telemetry: false", async () => {
    const { app, withSpan } = makeApp();
    const hooks = collectPluginHooks(createHexclaveElysia(app, { telemetry: false }));
    const request = new Request("https://api.example.com/quiet");
    hooks.onRequest({ request });
    await hooks.onAfterResponse({ request, path: "/quiet", set: {} });
    expect(withSpan).not.toHaveBeenCalled();
  });

  it("handler wraps the route in an elysia.route span with path + method", async () => {
    const { app, withSpan } = makeApp();
    const hexclave = createHexclaveElysia(app);
    const wrapped = hexclave.handler(async (ctx) => `hello ${(ctx as { user?: { id: string } }).user?.id}`);
    const result = await wrapped({
      request: new Request("https://api.example.com/me", { method: "GET" }),
      path: "/me",
      set: {},
      user: FAKE_USER,
      hexclave: createRequestContext(app, makeRequest()),
    } as never);
    expect(result).toBe("hello user-1");
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0][0]).toBe("elysia.route");
    expect((withSpan.mock.calls[0][1] as { data: unknown }).data).toEqual({ path: "/me", method: "GET" });
  });
});

describe("Convex adapter", () => {
  const convexCtx = { auth: { getUserIdentity: async () => ({ subject: "user-1" }) } };

  it("resolves the caller from convex identity and runs inside a convex.function span", async () => {
    const { app, withSpan, getUser } = makeApp();
    const hexclave = createHexclaveConvex(app);
    const wrapped = hexclave.function(async ({ user, args }) => `${(user as { id: string }).id}:${(args as { n: number }).n}`, { kind: "query", name: "listItems" });
    const result = await wrapped(convexCtx as never, { n: 7 });
    expect(result).toBe("user-1:7");
    expect(getUser).toHaveBeenCalledWith({ from: "convex", ctx: convexCtx, or: "return-null" });
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0][0]).toBe("convex.function");
    expect(withSpan.mock.calls[0][1]).toMatchObject({ userId: "user-1", data: { kind: "query", name: "listItems" } });
  });

  it("passes the hexclave context bag to the handler (memoized user resolution)", async () => {
    const { app } = makeApp();
    const hexclave = createHexclaveConvex(app);
    const wrapped = hexclave.function(async ({ hexclave: requestHexclave }) => await requestHexclave.getUser());
    await expect(wrapped(convexCtx as never, {})).resolves.toEqual(FAKE_USER);
  });

  it("required: true rejects unauthenticated calls inside telemetry; telemetry: false skips the span", async () => {
    const { app, withSpan } = makeApp({ user: null });
    const hexclave = createHexclaveConvex(app);
    const guarded = hexclave.function(async () => "never", { required: true });
    await expect(guarded(convexCtx as never, {})).rejects.toThrow(/signed in/);
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0][0]).toBe("convex.function");
    expect(withSpan.mock.calls[0][1]).toMatchObject({ data: {} });

    const { app: app2, withSpan: withSpan2 } = makeApp();
    const bare = createHexclaveConvex(app2).function(async () => "ok", { telemetry: false });
    await expect(bare(convexCtx as never, {})).resolves.toBe("ok");
    expect(withSpan2).not.toHaveBeenCalled();
  });

  it("uses the factory-level unauthorized default; the per-function factory wins", async () => {
    const { app } = makeApp({ user: null });
    const factoryUnauthorized = () => Object.assign(new Error("FACTORY"), { fromFactory: true });
    const hexclave = createHexclaveConvex(app, { unauthorized: factoryUnauthorized });
    await expect(hexclave.function(async () => "never", { required: true })(convexCtx as never, {})).rejects.toMatchObject({ fromFactory: true });

    const perFunction = () => Object.assign(new Error("PER-FUNCTION"), { perFunction: true });
    await expect(hexclave.function(async () => "never", { required: true, unauthorized: perFunction })(convexCtx as never, {})).rejects.toMatchObject({ perFunction: true });
  });
});

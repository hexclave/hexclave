import { describe, expect, it, vi } from "vitest";
import { type AdapterServerApp } from "./adapter-core";
import { createHexclaveTanStackStart } from "./tanstack-start";

const state = vi.hoisted(() => ({
  getRequestHeader: undefined as ((name: string) => string | undefined) | undefined,
}));
vi.mock("@hexclave/tanstack-start/tanstack-start-server-context", () => ({
  get getRequestHeader() { return state.getRequestHeader; },
}));

const REQUEST_HEADERS: Record<string, string | undefined> = {
  "cookie": "a=b",
  "baggage": "span-context-header",
};

function enterServerRequestScope() {
  state.getRequestHeader = (name: string) => REQUEST_HEADERS[name];
}

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

describe("TanStack Start adapter: serverFn", () => {
  it("wraps the handler in a tanstack-start.server-function span linked via the ambient headers", async () => {
    enterServerRequestScope();
    const { app, withSpan, getUser } = makeApp();
    const hexclave = createHexclaveTanStackStart(app);
    const handler = hexclave.serverFn(async ({ ctx, user }) => {
      return `${(user as { id: string }).id}:${(ctx as { data: number }).data}`;
    }, { name: "getOrders" });
    await expect(handler({ data: 7 })).resolves.toBe("user-1:7");
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0][0]).toBe("tanstack-start.server-function");
    expect(withSpan.mock.calls[0][1]).toMatchObject({ data: { name: "getOrders" } });
    const request = (withSpan.mock.calls[0][1] as { request: { headers: { get: (name: string) => string | null } } }).request;
    expect(request.headers.get("baggage")).toBe("span-context-header");
    expect(request.headers.get("nonexistent")).toBeNull();
    expect(getUser).toHaveBeenCalledWith(expect.objectContaining({ tokenStore: request, or: "return-null" }));
  });

  it("fails loudly outside server-side request handling instead of reporting unauthenticated", async () => {
    state.getRequestHeader = undefined;
    const { app, getUser } = makeApp();
    const hexclave = createHexclaveTanStackStart(app);
    const handler = hexclave.serverFn(async () => "never");
    await expect(handler({})).rejects.toThrow(/server context is unavailable/);
    expect(getUser).not.toHaveBeenCalled();
  });

  it("required: true throws (the default or the caller's factory) for unauthenticated calls", async () => {
    enterServerRequestScope();
    const { app } = makeApp({ user: null });
    const hexclave = createHexclaveTanStackStart(app);
    const fn = vi.fn(async () => "never");
    await expect(hexclave.serverFn(fn, { required: true })({})).rejects.toThrow(/signed in/);
    const unauthorized = () => Object.assign(new Error("UNAUTHORIZED"), { fromFactory: true });
    await expect(hexclave.serverFn(fn, { required: true, unauthorized })({})).rejects.toMatchObject({ fromFactory: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("falls back to the factory-level unauthorized default; per-handler wins", async () => {
    enterServerRequestScope();
    const { app } = makeApp({ user: null });
    const hexclave = createHexclaveTanStackStart(app, { unauthorized: () => Object.assign(new Error("FACTORY"), { fromFactory: true }) });
    const fn = vi.fn(async () => "never");
    await expect(hexclave.serverFn(fn, { required: true })({})).rejects.toMatchObject({ fromFactory: true });
    const perHandler = () => Object.assign(new Error("PER-HANDLER"), { perHandler: true });
    await expect(hexclave.serverFn(fn, { required: true, unauthorized: perHandler })({})).rejects.toMatchObject({ perHandler: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("telemetry: false skips the span but still resolves the user", async () => {
    enterServerRequestScope();
    const { app, withSpan } = makeApp();
    const hexclave = createHexclaveTanStackStart(app);
    const handler = hexclave.serverFn(async ({ user }) => (user as { id: string }).id, { telemetry: false });
    await expect(handler({})).resolves.toBe("user-1");
    expect(withSpan).not.toHaveBeenCalled();
  });
});

describe("TanStack Start adapter: routeHandler", () => {
  it("wraps the method handler in a tanstack-start.route span with path + method", async () => {
    const { app, withSpan } = makeApp();
    const hexclave = createHexclaveTanStackStart(app);
    const handler = hexclave.routeHandler(async ({ request, user }) => {
      return Response.json({ userId: (user as { id: string }).id, method: request.method });
    });
    const response = await handler({ request: new Request("https://app.example.com/api/orders?page=2", { method: "POST" }) });
    await expect(response.json()).resolves.toEqual({ userId: "user-1", method: "POST" });
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0][0]).toBe("tanstack-start.route");
    expect(withSpan.mock.calls[0][1]).toMatchObject({ data: { path: "/api/orders", method: "POST" } });
    expect((withSpan.mock.calls[0][1] as { request: unknown }).request).not.toBeUndefined();
  });

  it("required: true short-circuits unauthenticated calls with a 401 JSON response (or the caller's factory)", async () => {
    const { app } = makeApp({ user: null });
    const hexclave = createHexclaveTanStackStart(app);
    const fn = vi.fn(async () => new Response("never"));
    const response = await hexclave.routeHandler(fn, { required: true })({ request: new Request("https://app.example.com/api/orders") });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("signed in") });
    expect(fn).not.toHaveBeenCalled();

    const custom = await hexclave.routeHandler(fn, {
      required: true,
      unauthorized: () => new Response("custom", { status: 403 }),
    })({ request: new Request("https://app.example.com/api/orders") });
    expect(custom.status).toBe(403);
  });

  it("falls back to the factory-level unauthorized default on route handlers", async () => {
    const { app } = makeApp({ user: null });
    const hexclave = createHexclaveTanStackStart(app, { unauthorized: () => new Response("factory", { status: 418 }) });
    const response = await hexclave.routeHandler(async () => new Response("never"), { required: true })({ request: new Request("https://app.example.com/api/orders") });
    expect(response.status).toBe(418);
  });
});

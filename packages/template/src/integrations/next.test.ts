import { InstrumentationBase } from "@opentelemetry/instrumentation";
import { describe, expect, it, vi } from "vitest";
import { _HexclaveServerAppImplIncomplete } from "../lib/hexclave-app/apps/implementations/server-app-impl";
import { StackServerApp } from "../lib/hexclave-app/apps/interfaces/server-app";
import { type AdapterServerApp } from "./adapter-core";
import { createHexclaveNext, hexclaveInstrumentation } from "./next";

// The adapter reads the ambient server-action headers from `next/headers` (via
// the @hexclave/sc shim); tests provide them here instead of a Next.js request
// scope. `state.headers` is mutable so individual tests can vary the headers.
const state = vi.hoisted(() => ({
  headers: new Headers({ "cookie": "a=b", "baggage": "hexclave.session_replay.segment.id=55555555-5555-4555-8555-555555555555" }),
}));
vi.mock("@hexclave/sc/force-react-server", () => ({
  headers: async () => state.headers,
}));

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

describe("Next.js adapter: routeHandler", () => {
  it("wraps the handler in a next.route span with path + method and injects the user", async () => {
    const { app, withSpan, getUser } = makeApp();
    const hexclave = createHexclaveNext(app);
    const handler = hexclave.routeHandler(async ({ request, context, user }) => {
      return Response.json({ userId: (user as { id: string }).id, method: request.method, context });
    });
    const response = await handler(new Request("https://app.example.com/api/orders?page=2", { method: "POST" }), { params: { id: "7" } });
    await expect(response.json()).resolves.toEqual({ userId: "user-1", method: "POST", context: { params: { id: "7" } } });
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0][0]).toBe("next.route");
    expect(withSpan.mock.calls[0][1]).toMatchObject({ data: { path: "/api/orders", method: "POST" } });
    expect((withSpan.mock.calls[0][1] as { request: unknown }).request).not.toBeUndefined();
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("required: true short-circuits unauthenticated calls with a 401 JSON response inside the span", async () => {
    const { app, withSpan } = makeApp({ user: null });
    const hexclave = createHexclaveNext(app);
    const fn = vi.fn(async () => new Response("never"));
    const handler = hexclave.routeHandler(fn, { required: true });
    const response = await handler(new Request("https://app.example.com/api/orders"), undefined);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("signed in") });
    expect(fn).not.toHaveBeenCalled();
    expect(withSpan).toHaveBeenCalledTimes(1);
  });

  it("required: true uses the caller-provided unauthorized response factory", async () => {
    const { app } = makeApp({ user: null });
    const hexclave = createHexclaveNext(app);
    const handler = hexclave.routeHandler(async () => new Response("never"), {
      required: true,
      unauthorized: () => new Response("custom", { status: 403 }),
    });
    const response = await handler(new Request("https://app.example.com/api/orders"), undefined);
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("custom");
  });

  it("falls back to the factory-level unauthorized default; per-handler wins", async () => {
    const { app } = makeApp({ user: null });
    const hexclave = createHexclaveNext(app, { unauthorized: () => new Response("factory", { status: 418 }) });
    const response = await hexclave.routeHandler(async () => new Response("never"), { required: true })(new Request("https://app.example.com/api/orders"), undefined);
    expect(response.status).toBe(418);

    const overridden = await hexclave.routeHandler(async () => new Response("never"), {
      required: true,
      unauthorized: () => new Response("per-handler", { status: 403 }),
    })(new Request("https://app.example.com/api/orders"), undefined);
    expect(overridden.status).toBe(403);

    const throwing = createHexclaveNext(app, { unauthorized: () => Object.assign(new Error("FACTORY"), { fromFactory: true }) });
    await expect(throwing.routeHandler(async () => new Response("never"), { required: true })(new Request("https://app.example.com/api/orders"), undefined))
      .rejects.toMatchObject({ fromFactory: true });
  });

  it("telemetry: false skips the span but still resolves the user", async () => {
    const { app, withSpan, getUser } = makeApp();
    const hexclave = createHexclaveNext(app);
    const handler = hexclave.routeHandler(async ({ user }) => Response.json({ userId: (user as { id: string }).id }), { telemetry: false });
    const response = await handler(new Request("https://app.example.com/api/orders"), undefined);
    await expect(response.json()).resolves.toEqual({ userId: "user-1" });
    expect(withSpan).not.toHaveBeenCalled();
    expect(getUser).toHaveBeenCalledTimes(1);
  });
});

describe("Next.js adapter: serverAction", () => {
  it("keeps the action's outward signature, prepends { user }, and runs inside a next.server-action span", async () => {
    const { app, withSpan, getUser } = makeApp();
    const hexclave = createHexclaveNext(app);
    const action = hexclave.serverAction(async ({ user }, a: number, b: string) => {
      return `${(user as { id: string }).id}:${a}:${b}`;
    }, { name: "createOrder" });
    await expect(action(7, "x")).resolves.toBe("user-1:7:x");
    expect(withSpan).toHaveBeenCalledTimes(1);
    expect(withSpan.mock.calls[0][0]).toBe("next.server-action");
    expect(withSpan.mock.calls[0][1]).toMatchObject({ data: { name: "createOrder" } });
    const request = (withSpan.mock.calls[0][1] as { request: { headers: Headers } }).request;
    expect(request.headers.get("baggage")).toBe("hexclave.session_replay.segment.id=55555555-5555-4555-8555-555555555555");
    expect(getUser).toHaveBeenCalledWith(expect.objectContaining({ tokenStore: request, or: "return-null" }));
  });

  it("required: true throws (the default or the caller's factory) for unauthenticated calls", async () => {
    const { app } = makeApp({ user: null });
    const hexclave = createHexclaveNext(app);
    const fn = vi.fn(async () => "never");
    await expect(hexclave.serverAction(fn, { required: true })()).rejects.toThrow(/signed in/);
    const unauthorized = () => Object.assign(new Error("UNAUTHORIZED"), { fromFactory: true });
    await expect(hexclave.serverAction(fn, { required: true, unauthorized })()).rejects.toMatchObject({ fromFactory: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("falls back to the factory-level unauthorized default; per-action wins", async () => {
    const { app } = makeApp({ user: null });
    const hexclave = createHexclaveNext(app, { unauthorized: () => Object.assign(new Error("FACTORY"), { fromFactory: true }) });
    const fn = vi.fn(async () => "never");
    await expect(hexclave.serverAction(fn, { required: true })()).rejects.toMatchObject({ fromFactory: true });
    const perAction = () => Object.assign(new Error("PER-ACTION"), { perAction: true });
    await expect(hexclave.serverAction(fn, { required: true, unauthorized: perAction })()).rejects.toMatchObject({ perAction: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("telemetry: false skips the span but still enforces required", async () => {
    const { app, withSpan } = makeApp();
    const hexclave = createHexclaveNext(app);
    const action = hexclave.serverAction(async ({ user }) => (user as { id: string }).id, { telemetry: false, required: true });
    await expect(action()).resolves.toBe("user-1");
    expect(withSpan).not.toHaveBeenCalled();
  });
});

describe("hexclaveInstrumentation", () => {
  function makeRealApp() {
    return new StackServerApp({
      projectId: "00000000-0000-4000-8000-000000000001",
      publishableClientKey: "pck_test",
      secretServerKey: "ssk_test",
      baseUrl: "https://api.example.test",
      tokenStore: "memory",
      noAutomaticPrefetch: true,
      observability: { enabled: true },
    });
  }

  it("rejects structural mocks at setup time (a wrong app must not silently drop errors)", () => {
    const { app } = makeApp();
    expect(() => hexclaveInstrumentation(app)).toThrow(/StackServerApp instance/);
  });

  it("exposes OTel suppression before provider registration", async () => {
    const instrumentation = hexclaveInstrumentation(makeRealApp());
    await expect(instrumentation.runWithTelemetrySuppressed(async () => "suppressed"))
      .resolves.toBe("suppressed");
  });

  it("register() installs the server fetch instrumentation and the uncaught-error monitor", async () => {
    const installSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_ensureOpenTelemetryProvider").mockImplementation(() => {});
    const monitorSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_installServerErrorMonitor").mockImplementation(() => {});
    // Keep the test focused on installs; a real provider would claim the OTel
    // global for the rest of this worker.
    const otelSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_registerOpenTelemetry").mockImplementation(async () => null);
    try {
      const instrumentation = hexclaveInstrumentation(makeRealApp());
      await instrumentation.register();
      await instrumentation.register();
      expect(installSpy).toHaveBeenCalledTimes(3);
      expect(monitorSpy).toHaveBeenCalledTimes(3);
      expect(otelSpy).toHaveBeenCalledTimes(2);
    } finally {
      installSpy.mockRestore();
      monitorSpy.mockRestore();
      otelSpy.mockRestore();
    }
  });

  it("register() wires the next/headers ambient request provider", async () => {
    const providerSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_setAmbientRequestProvider").mockImplementation(() => {});
    const otelSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_registerOpenTelemetry").mockImplementation(async () => null);
    try {
      const instrumentation = hexclaveInstrumentation(makeRealApp());
      await instrumentation.register();
      expect(providerSpy).toHaveBeenCalledTimes(1);
      const provider = providerSpy.mock.calls[0]?.[0];
      expect(provider).toBeTypeOf("function");
    } finally {
      providerSpy.mockRestore();
      otelSpy.mockRestore();
    }
  });

  it("can disable request attribution for an internal control-plane telemetry project", async () => {
    const providerSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_setAmbientRequestProvider").mockImplementation(() => {});
    const suppressionSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_setTelemetrySuppressionPredicate").mockImplementation(() => {});
    const otelSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_registerOpenTelemetry").mockImplementation(async () => null);
    const captureSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_captureServerRequestError").mockImplementation(async () => {});
    try {
      const isTelemetrySuppressed = () => true;
      const instrumentation = hexclaveInstrumentation(makeRealApp(), {
        requestAttribution: false,
        isTelemetrySuppressed,
      });
      await instrumentation.register();
      expect(providerSpy).toHaveBeenCalledWith(null);
      expect(suppressionSpy).toHaveBeenCalledWith(isTelemetrySuppressed);

      await instrumentation.onRequestError(new Error("boom"), {
        path: "/customer-route",
        headers: { cookie: "customer-session" },
      });
      expect(captureSpy).toHaveBeenCalledWith(expect.any(Error), expect.not.objectContaining({ request: expect.anything() }));
    } finally {
      providerSpy.mockRestore();
      suppressionSpy.mockRestore();
      otelSpy.mockRestore();
      captureSpy.mockRestore();
    }
  });

  it("register() passes typed OTel instrumentation entries to the managed SDK", async () => {
    const otelSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_registerOpenTelemetry")
      .mockImplementation(async () => null);
    try {
      class TestInstrumentation extends InstrumentationBase {
        constructor() {
          super("test-instrumentation", "1.0.0", {});
        }

        protected init(): void {}
      }
      const instrumentationEntry = new TestInstrumentation();
      const instrumentation = hexclaveInstrumentation(makeRealApp(), {
        instrumentations: [instrumentationEntry],
      });
      await instrumentation.register();
      expect(otelSpy).toHaveBeenCalledWith([instrumentationEntry]);
    } finally {
      otelSpy.mockRestore();
    }
  });

  it("onRequestError forwards a normalized $error with route metadata, digest, and request headers", async () => {
    const captureSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_captureServerRequestError").mockImplementation(async () => {});
    try {
      const instrumentation = hexclaveInstrumentation(makeRealApp());
      const error = Object.assign(new Error("boom"), { digest: "digest-123" });
      await instrumentation.onRequestError(error, {
        path: "/orders/7",
        method: "GET",
        // Node dict form: string-array values are joined like repeated headers.
        headers: { cookie: "a=b", "x-multi": ["1", "2"] },
      }, { routerKind: "App Router", routePath: "/orders/[id]", routeType: "render" });

      expect(captureSpy).toHaveBeenCalledTimes(1);
      const [capturedError, info] = captureSpy.mock.calls[0];
      expect(capturedError).toBe(error);
      expect(info.mechanism).toBe("next.onRequestError");
      expect(info.handled).toBe(false);
      expect(info.data).toEqual({
        path: "/orders/7",
        method: "GET",
        router_kind: "App Router",
        route_path: "/orders/[id]",
        route_type: "render",
        digest: "digest-123",
      });
      expect(info.request?.headers).toEqual({ cookie: "a=b", "x-multi": "1, 2" });
    } finally {
      captureSpy.mockRestore();
    }
  });

  it("captureHandledError marks explicitly captured errors as handled", async () => {
    const captureSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_captureServerRequestError").mockImplementation(async () => {});
    try {
      const instrumentation = hexclaveInstrumentation(makeRealApp());
      const error = new Error("background job failed");
      await instrumentation.captureHandledError(error, {
        location: "jobs/send-receipt",
        data: { queue: "receipts", handled: false, mechanism_type: "spoofed" },
      });

      expect(captureSpy).toHaveBeenCalledWith(error, {
        mechanism: "captured",
        handled: true,
        data: {
          location: "jobs/send-receipt",
          queue: "receipts",
          handled: true,
          mechanism_type: "captured",
        },
      });
    } finally {
      captureSpy.mockRestore();
    }
  });

  it("onRequestError never throws, even when capture fails", async () => {
    const captureSpy = vi.spyOn(_HexclaveServerAppImplIncomplete.prototype, "_captureServerRequestError").mockImplementation(async () => {
      throw new Error("delivery failed");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const instrumentation = hexclaveInstrumentation(makeRealApp());
      await expect(instrumentation.onRequestError(new Error("boom"), {})).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      captureSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

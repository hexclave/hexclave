import { SpanKind, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHexclaveOtlpLogExporterConfig, buildHexclaveOtlpTraceExporterConfig, registerManagedOtel, resetManagedOtelForTesting } from "./otel-sdk";

describe("Hexclave managed OTel SDK", () => {
  afterEach(async () => {
    await resetManagedOtelForTesting();
    vi.unstubAllGlobals();
  });

  it("targets the authenticated OTLP/HTTP JSON trace endpoint", () => {
    expect(buildHexclaveOtlpTraceExporterConfig({
      analyticsBaseUrl: "https://r.hexclave.com/base-that-must-not-leak",
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "js @hexclave/next@1.2.3",
    })).toMatchInlineSnapshot(`
      {
        "headers": {
          "x-hexclave-access-type": "server",
          "x-hexclave-client-version": "js @hexclave/next@1.2.3",
          "x-hexclave-project-id": "project",
          "x-hexclave-secret-server-key": "secret",
        },
        "url": "https://r.hexclave.com/api/v1/analytics/otlp/v1/traces",
      }
    `);
  });

  it("targets the authenticated OTLP/HTTP JSON logs endpoint", () => {
    expect(buildHexclaveOtlpLogExporterConfig({
      analyticsBaseUrl: "https://r.hexclave.com/base-that-must-not-leak",
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
    }).url).toBe("https://r.hexclave.com/api/v1/analytics/otlp/v1/logs");
  });

  it("shares one process provider across localhost loopback aliases", () => {
    const options = {
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { serviceName: "checkout" },
    };
    const instrumentationRegistration = registerManagedOtel({
      ...options,
      analyticsBaseUrl: "http://127.0.0.1:8102",
    });
    const serverRegistration = registerManagedOtel({
      ...options,
      analyticsBaseUrl: "http://localhost:8102",
    });

    expect(serverRegistration).toBe(instrumentationRegistration);
  });

  it("installs late-supplied instrumentations on the cached registration exactly once", () => {
    const fakeInstrumentation = (name: string) => ({
      instrumentationName: name,
      instrumentationVersion: "1.0.0",
      enable: vi.fn(),
      disable: vi.fn(),
      setTracerProvider: vi.fn(),
      setMeterProvider: vi.fn(),
      setConfig: vi.fn(),
      getConfig: vi.fn(() => ({})),
    });
    const options = {
      analyticsBaseUrl: "http://127.0.0.1:8102",
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { serviceName: "checkout" },
    };
    const eager = registerManagedOtel(options);

    const prisma = fakeInstrumentation("@prisma/instrumentation");
    const late = registerManagedOtel({ ...options, instrumentations: [prisma, prisma] });
    expect(late).toBe(eager);
    expect(prisma.setTracerProvider).toHaveBeenCalledTimes(1);

    const prismaAgain = fakeInstrumentation("@prisma/instrumentation");
    registerManagedOtel({ ...options, instrumentations: [prismaAgain] });
    expect(prismaAgain.setTracerProvider).not.toHaveBeenCalled();
    expect(prismaAgain.enable).not.toHaveBeenCalled();
  });

  it("keeps successful instrumentation registrations marked when a later one fails", () => {
    const fakeInstrumentation = (name: string, enable: () => void = () => {}) => ({
      instrumentationName: name,
      instrumentationVersion: "1.0.0",
      enable: vi.fn(enable),
      disable: vi.fn(),
      setTracerProvider: vi.fn(),
      setMeterProvider: vi.fn(),
      setConfig: vi.fn(),
      getConfig: vi.fn(() => ({})),
    });
    const options = {
      analyticsBaseUrl: "http://127.0.0.1:8102",
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { serviceName: "checkout" },
    };
    registerManagedOtel(options);
    const first = fakeInstrumentation("first");
    const second = fakeInstrumentation("second", () => {
      throw new Error("second instrumentation failed");
    });

    expect(() => registerManagedOtel({ ...options, instrumentations: [first, second] })).toThrow("second instrumentation failed");

    const firstAgain = fakeInstrumentation("first");
    registerManagedOtel({ ...options, instrumentations: [firstAgain] });
    expect(firstAgain.enable).not.toHaveBeenCalled();
  });

  it("still rejects a different project in the same process", () => {
    const options = {
      analyticsBaseUrl: "http://127.0.0.1:8102",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { serviceName: "checkout" },
    };
    registerManagedOtel({
      ...options,
      projectId: "first-project",
    });

    expect(() => registerManagedOtel({
      ...options,
      projectId: "second-project",
    })).toThrow("Hexclave OpenTelemetry is already configured for a different project or service in this process");
  });

  it("throws when a host provider is already registered in managed mode", () => {
    const host = new NodeTracerProvider();
    expect(trace.setGlobalTracerProvider(host)).toBe(true);

    expect(() => registerManagedOtel({
      analyticsBaseUrl: "http://127.0.0.1:8102",
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { serviceName: "checkout" },
    })).toThrow("another global tracer provider is already registered");
  });

  it("adopts a host provider in auto mode", () => {
    const host = new NodeTracerProvider();
    expect(trace.setGlobalTracerProvider(host)).toBe(true);

    const registration = registerManagedOtel({
      analyticsBaseUrl: "http://127.0.0.1:8102",
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { serviceName: "checkout" },
      existingProviderConflict: "adopt",
    });

    expect(registration.provider).toBe(trace.getTracerProvider());
    expect(registerManagedOtel({
      analyticsBaseUrl: "http://127.0.0.1:8102",
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { serviceName: "checkout" },
      existingProviderConflict: "adopt",
    })).toBe(registration);
  });

  it("emits the official OTLP/HTTP JSON identity and timestamp representation", async () => {
    let body = "";
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        body = Buffer.concat(chunks).toString("utf8");
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected the OTLP fixture server to listen on a TCP port");
    const analyticsBaseUrl = new URL("http://127.0.0.1");
    analyticsBaseUrl.port = String(address.port);
    const registration = registerManagedOtel({
      analyticsBaseUrl: analyticsBaseUrl.toString(),
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { serviceName: "checkout" },
    });
    trace.getTracer("fixture").startSpan("checkout").end();
    await registration.forceFlush();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));

    const request: unknown = JSON.parse(body);
    expect(request).toMatchObject({
      resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        startTimeUnixNano: expect.stringMatching(/^\d+$/),
      }] }] }],
    });
  });

  it("emits official OTLP/HTTP JSON LogRecords", async () => {
    let body = "";
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url?.endsWith("/logs")) body = Buffer.concat(chunks).toString("utf8");
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected the OTLP fixture server to listen on a TCP port");
    const analyticsBaseUrl = `http://127.0.0.1:${address.port}`;
    const registration = registerManagedOtel({
      analyticsBaseUrl,
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { serviceName: "checkout" },
    });
    logs.getLogger("fixture", "1.0.0").emit({
      eventName: "checkout.failed",
      severityNumber: SeverityNumber.ERROR,
      body: "boom",
    });
    await registration.forceFlush();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));

    expect(JSON.parse(body)).toMatchObject({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{
        eventName: "checkout.failed",
        severityNumber: 17,
        body: { stringValue: "boom" },
        observedTimeUnixNano: expect.stringMatching(/^\d+$/),
      }] }] }],
    });
  });

  it("uses official Undici instrumentation for outbound fetch spans", async () => {
    let exportedBody = "";
    let exportedMetricBody = "";
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url?.endsWith("/traces") === true) exportedBody = Buffer.concat(chunks).toString("utf8");
        if (request.url?.endsWith("/metrics") === true) exportedMetricBody = Buffer.concat(chunks).toString("utf8");
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected the Undici fixture server to listen on a TCP port");
    const analyticsBaseUrl = "http://127.0.0.1:" + address.port;
    const registration = registerManagedOtel({
      analyticsBaseUrl,
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { serviceName: "checkout" },
      shouldInstrumentOutboundRequest: (url) => url.endsWith("/orders"),
    });

    await fetch(analyticsBaseUrl + "/orders");
    await registration.forceFlush();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));

    const payload: unknown = JSON.parse(exportedBody);
    expect(payload).toMatchObject({
      resourceSpans: [{ scopeSpans: [{
        scope: { name: "@opentelemetry/instrumentation-undici" },
        spans: [{ kind: 3 }],
      }] }],
    });
    expect(exportedMetricBody).toContain('"resourceMetrics"');
    expect(exportedMetricBody).toContain('"name":"hexclave.http.client.request.count"');
    expect(exportedMetricBody).toContain('"name":"hexclave.http.client.request.duration"');
  });

  it("does not export HTTP client metrics when the request span is head-dropped", async () => {
    let exportedMetricBody = "";
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url?.endsWith("/metrics") === true) exportedMetricBody = Buffer.concat(chunks).toString("utf8");
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected the Undici fixture server to listen on a TCP port");
    const analyticsBaseUrl = "http://127.0.0.1:" + address.port;
    const registration = registerManagedOtel({
      analyticsBaseUrl,
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 0,
      resource: { serviceName: "checkout" },
      shouldInstrumentOutboundRequest: (url) => url.endsWith("/orders"),
    });

    await fetch(analyticsBaseUrl + "/orders");
    await registration.forceFlush();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));

    expect(exportedMetricBody).not.toContain('"name":"hexclave.http.client.request.count"');
    expect(exportedMetricBody).not.toContain('"name":"hexclave.http.client.request.duration"');
  });

  it("applies the Sentry-style Next span policy before exporting", async () => {
    let exportedBody = "";
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url?.endsWith("/traces") === true) exportedBody = Buffer.concat(chunks).toString("utf8");
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected the OTLP fixture server to listen on a TCP port");
    const registration = registerManagedOtel({
      analyticsBaseUrl: `http://127.0.0.1:${address.port}`,
      projectId: "project",
      secretServerKey: "secret",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { serviceName: "checkout" },
    });

    const tracer = trace.getTracer("next.js");
    tracer.startSpan("GET", {
      kind: SpanKind.SERVER,
      attributes: { "http.target": "/_next/static/chunks/app.js" },
    }).end();
    tracer.startSpan("GET /api/orders", {
      kind: SpanKind.SERVER,
      attributes: { "http.target": "/api/orders" },
    }).end();
    await registration.forceFlush();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));

    expect(exportedBody).not.toContain("_next/static");
    expect(exportedBody).toContain("/api/orders");
  });
});

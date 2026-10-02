import { createServer, type Server } from "node:http";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StackServerApp } from "../interfaces/server-app";
import { getServerAppInstrumentation } from "./server-app-impl";
import { resetManagedOtelForTesting } from "./otel-sdk";
import { runWithServerRequestContext, type ServerRequestSpanContext } from "./server-request-context";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_FETCH = {
  traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  spanId: "bbbbbbbbbbbbbbbb",
  traceState: "vendor=value",
};

const UNSAMPLED_CLIENT_FETCH = {
  traceId: "cccccccccccccccccccccccccccccccc",
  spanId: "dddddddddddddddd",
  traceFlags: 0,
  traceState: "vendor=value",
};

type CapturedRequest = {
  url: string,
  body: string,
};

const servers: Server[] = [];

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, description: string): Record<string, unknown> {
  if (!isUnknownRecord(value)) throw new Error(`Expected ${description} to be an object`);
  return value;
}

function requiredArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`Expected ${key} to be an array`);
  return value;
}

function decodeOtlpAnyValue(value: unknown): unknown {
  const object = requiredRecord(value, "OTLP AnyValue");
  if (typeof object.stringValue === "string") return object.stringValue;
  if (typeof object.intValue === "string" || typeof object.intValue === "number") return object.intValue;
  if (typeof object.doubleValue === "number") return object.doubleValue;
  if (typeof object.boolValue === "boolean") return object.boolValue;
  if (isUnknownRecord(object.arrayValue)) {
    return requiredArray(object.arrayValue, "values").map((item) => decodeOtlpAnyValue(item));
  }
  if (isUnknownRecord(object.kvlistValue)) {
    const result = new Map<string, unknown>();
    for (const item of requiredArray(object.kvlistValue, "values")) {
      const entry = requiredRecord(item, "OTLP KeyValue");
      if (typeof entry.key !== "string") throw new Error("Expected OTLP KeyValue.key to be a string");
      result.set(entry.key, decodeOtlpAnyValue(entry.value));
    }
    return result;
  }
  throw new Error("Unsupported OTLP AnyValue in test fixture");
}

function attributeValue(record: Record<string, unknown>, key: string): unknown {
  for (const item of requiredArray(record, "attributes")) {
    const attribute = requiredRecord(item, "OTLP attribute");
    if (attribute.key === key) return decodeOtlpAnyValue(attribute.value);
  }
  return undefined;
}

function logRecords(requests: CapturedRequest[]): Record<string, unknown>[] {
  return requests
    .filter((item) => item.url.endsWith("/api/v1/analytics/otlp/v1/logs"))
    .flatMap((request) => {
      const payload = requiredRecord(JSON.parse(request.body), "OTLP logs payload");
      return requiredArray(payload, "resourceLogs").flatMap((resourceLog) => {
        const resource = requiredRecord(resourceLog, "resourceLogs item");
        return requiredArray(resource, "scopeLogs").flatMap((scopeLog) => {
          const scope = requiredRecord(scopeLog, "scopeLogs item");
          return requiredArray(scope, "logRecords").map((record) => requiredRecord(record, "log record"));
        });
      });
    });
}

function spans(requests: CapturedRequest[]): Record<string, unknown>[] {
  const request = requests.find((item) => item.url.endsWith("/api/v1/analytics/otlp/v1/traces"));
  if (request === undefined) return [];
  const payload = requiredRecord(JSON.parse(request.body), "OTLP traces payload");
  return requiredArray(payload, "resourceSpans").flatMap((resourceSpan) => {
    const resource = requiredRecord(resourceSpan, "resourceSpans item");
    return requiredArray(resource, "scopeSpans").flatMap((scopeSpan) => {
      const scope = requiredRecord(scopeSpan, "scopeSpans item");
      return requiredArray(scope, "spans").map((span) => requiredRecord(span, "span"));
    });
  });
}

async function startCollector(): Promise<{ baseUrl: string, requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ url: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected the test OTLP collector to listen on a TCP port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function makeApp(baseUrl: string, traceSampleRate = 1): StackServerApp {
  const app = new StackServerApp({
    projectId: PROJECT_ID,
    publishableClientKey: "pck_test",
    secretServerKey: "ssk_test",
    baseUrl,
    tokenStore: "memory",
    noAutomaticPrefetch: true,
    observability: { enabled: true, traceSampleRate },
    telemetry: { resource: { service: { name: "test-server", version: "test-release" } } },
  });
  return app;
}

async function makeReadyApp(baseUrl: string, traceSampleRate = 1): Promise<StackServerApp> {
  const app = makeApp(baseUrl, traceSampleRate);
  const instrumentation = getServerAppInstrumentation(app);
  if (instrumentation === null) throw new Error("Expected a real server app instrumentation facade");
  await instrumentation.registerOpenTelemetry([]);
  return app;
}

function requestContext(overrides?: Partial<ServerRequestSpanContext>): ServerRequestSpanContext {
  return {
    userId: null,
    refreshTokenId: null,
    sessionReplayId: null,
    sessionReplaySegmentId: null,
    pageViewSpanId: null,
    incomingParent: null,
    ...overrides,
  };
}

afterEach(async () => {
  await resetManagedOtelForTesting();
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("server OTel integration", () => {
  it("exports facade spans through the canonical OTLP traces endpoint", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl);

    await app.withSpan("process-order", async (span) => {
      await span.setData({ order_id: "order-42" });
    });
    await app.flush();

    expect(collector.requests.map((request) => request.url)).toContain("/api/v1/analytics/otlp/v1/traces");
    expect(collector.requests.some((request) => request.url.includes("analytics/events/batch"))).toBe(false);
    expect(spans(collector.requests)).toMatchObject([{
      name: "process-order",
      attributes: expect.arrayContaining([expect.objectContaining({ key: "hexclave.data", value: { stringValue: "{\"order_id\":\"order-42\"}" } })]),
    }]);
  });

  it("preserves an upstream sampled parent and tracestate", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl, 0);

    await runWithServerRequestContext(requestContext({ incomingParent: CLIENT_FETCH }), async () => {
      await app.withSpan("upstream-work", async () => {});
    });
    await app.flush();

    expect(spans(collector.requests)).toMatchObject([{
      name: "upstream-work",
      traceId: CLIENT_FETCH.traceId,
      parentSpanId: CLIENT_FETCH.spanId,
      traceState: CLIENT_FETCH.traceState,
    }]);
  });

  it("preserves an unsampled cross-tier parent instead of creating a new root", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl, 1);

    await app.withSpan("unsampled-request", {
      request: {
        headers: new Headers({
          traceparent: `00-${UNSAMPLED_CLIENT_FETCH.traceId}-${UNSAMPLED_CLIENT_FETCH.spanId}-00`,
          tracestate: UNSAMPLED_CLIENT_FETCH.traceState,
        }),
      },
    }, async () => {});
    await app.flush();

    expect(spans(collector.requests)).toEqual([]);
  });

  it("emits trackEvent as a correlated named OTel LogRecord", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl);
    const context = requestContext({
      userId: "99999999-9999-4999-8999-999999999999",
      refreshTokenId: "44444444-4444-4444-8444-444444444444",
      sessionReplaySegmentId: "55555555-5555-4555-8555-555555555555",
      pageViewSpanId: "6666666666666666",
      incomingParent: CLIENT_FETCH,
    });

    await runWithServerRequestContext(context, async () => {
      await app.trackEvent("checkout_completed", { amount: 42 });
    });

    const records = logRecords(collector.requests);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      eventName: "checkout_completed",
      traceId: CLIENT_FETCH.traceId,
      spanId: CLIENT_FETCH.spanId,
    });
    expect(attributeValue(records[0], "hexclave.signal.type")).toBe("event");
    expect(attributeValue(records[0], "hexclave.user.id")).toBe(context.userId);
    expect(attributeValue(records[0], "hexclave.session_replay.segment.id")).toBe(context.sessionReplaySegmentId);
    expect(attributeValue(records[0], "hexclave.page_view.span_id")).toBe(context.pageViewSpanId);
    expect(attributeValue(records[0], "hexclave.data")).toEqual(new Map([["amount", 42]]));
  });

  it("emits logger calls and bounded automatic errors as OTel LogRecords", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl);
    const instrumentation = getServerAppInstrumentation(app);
    if (instrumentation === null) throw new Error("Expected a real server app instrumentation facade");

    app.logger.warn("cache miss", { key: "user:42" });
    await instrumentation.captureServerRequestError(
      new Error(`boom ${"x".repeat(20_000)}`),
      { mechanism: "next.onRequestError", handled: false, data: { path: "/orders" } },
    );
    await app.flush();

    const records = logRecords(collector.requests);
    const log = records.find((record) => record.eventName === "$log");
    const error = records.find((record) => record.eventName === "$error");
    if (log === undefined || error === undefined) throw new Error("Expected both logger and error LogRecords");
    expect(log).toMatchObject({ severityText: "WARN", body: { stringValue: "cache miss" } });
    expect(attributeValue(log, "hexclave.signal.type")).toBe("log");
    expect(attributeValue(log, "hexclave.data")).toEqual(new Map([["key", "user:42"]]));
    expect(error).toMatchObject({ severityText: "ERROR" });
    expect(attributeValue(error, "hexclave.signal.type")).toBe("error");
    const errorData = attributeValue(error, "hexclave.data");
    if (!(errorData instanceof Map)) throw new Error("Expected structured Hexclave error data");
    expect(errorData.get("mechanism_type")).toBe("next.onRequestError");
    expect(errorData.get("handled")).toBe(false);
    expect(errorData.get("path")).toBe("/orders");
    expect(errorData.get("release")).toBe("test-release");
    const message = errorData.get("message");
    expect(typeof message).toBe("string");
    if (typeof message !== "string") throw new Error("Expected bounded error message");
    expect(message.length).toBeLessThanOrEqual(8_192);
  });

  it("uses the original request context for captured error user and replay correlation", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl);
    const instrumentation = getServerAppInstrumentation(app);
    if (instrumentation === null) throw new Error("Expected a real server app instrumentation facade");
    const resolvedContext = requestContext({
      userId: "99999999-9999-4999-8999-999999999999",
      refreshTokenId: "44444444-4444-4444-8444-444444444444",
      sessionReplaySegmentId: "55555555-5555-4555-8555-555555555555",
      pageViewSpanId: "6666666666666666",
      incomingParent: CLIENT_FETCH,
    });
    const resolveRequestContext = vi.fn(async () => resolvedContext);
    Reflect.set(app, "_resolveServerRequestContext", resolveRequestContext);
    const request = new Request("https://app.example.com/api/orders", {
      headers: { baggage: "hexclave.session_replay.segment.id=55555555-5555-4555-8555-555555555555" },
    });

    await instrumentation.captureServerRequestError(new Error("request failed"), {
      mechanism: "hexclave.smart-route",
      handled: false,
      request,
    });
    await app.flush();

    expect(resolveRequestContext).toHaveBeenCalledWith(request, null);
    const error = logRecords(collector.requests).find((record) => record.eventName === "$error");
    if (error === undefined) throw new Error("Expected the captured error LogRecord");
    expect(error).toMatchObject({ traceId: CLIENT_FETCH.traceId, spanId: CLIENT_FETCH.spanId });
    expect(attributeValue(error, "hexclave.user.id")).toBe(resolvedContext.userId);
    expect(attributeValue(error, "hexclave.refresh_token.id")).toBe(resolvedContext.refreshTokenId);
    expect(attributeValue(error, "hexclave.session_replay.segment.id")).toBe(resolvedContext.sessionReplaySegmentId);
    expect(attributeValue(error, "hexclave.page_view.span_id")).toBe(resolvedContext.pageViewSpanId);
    const errorData = attributeValue(error, "hexclave.data");
    if (!(errorData instanceof Map)) throw new Error("Expected structured Hexclave error data");
    expect(errorData.get("release")).toBe("test-release");
  });

  it("installs late-supplied instrumentations on the cached provider, deduped by name", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl);
    const instrumentation = getServerAppInstrumentation(app);
    if (instrumentation === null) throw new Error("Expected a real server app instrumentation facade");

    const calls: string[] = [];
    const makeFakeInstrumentation = (name: string): Instrumentation => ({
      instrumentationName: name,
      instrumentationVersion: "0.0.0-test",
      enable: () => {
        calls.push(`enable:${name}`);
      },
      disable: () => {
        calls.push(`disable:${name}`);
      },
      setTracerProvider: () => {
        calls.push(`tracer:${name}`);
      },
      setMeterProvider: () => {},
      getConfig: () => ({}),
      setConfig: () => {},
    });

    await instrumentation.registerOpenTelemetry([makeFakeInstrumentation("test-late-instrumentation")]);
    expect(calls).toContain("tracer:test-late-instrumentation");
    const callsAfterFirstInstall = calls.length;

    await instrumentation.registerOpenTelemetry([makeFakeInstrumentation("test-late-instrumentation")]);
    expect(calls.length).toBe(callsAfterFirstInstall);
  });

  it("keeps capture metadata authoritative over colliding adapter-supplied data", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl);
    const instrumentation = getServerAppInstrumentation(app);
    if (instrumentation === null) throw new Error("Expected a real server app instrumentation facade");

    await instrumentation.captureServerRequestError(new Error("boom"), {
      mechanism: "next.onRequestError",
      handled: false,
      data: { handled: true, mechanism_type: "spoofed.mechanism", level: "info" },
    });
    await app.flush();

    const error = logRecords(collector.requests).find((record) => record.eventName === "$error");
    if (error === undefined) throw new Error("Expected the captured error LogRecord");
    const errorData = attributeValue(error, "hexclave.data");
    if (!(errorData instanceof Map)) throw new Error("Expected structured Hexclave error data");
    expect(errorData.get("handled")).toBe(false);
    expect(errorData.get("mechanism_type")).toBe("next.onRequestError");
    expect(errorData.get("level")).toBe("info");
  });

  it("stamps request correlation and the incoming parent onto logger records inside a request scope", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl);
    const context = requestContext({
      userId: "99999999-9999-4999-8999-999999999999",
      refreshTokenId: "44444444-4444-4444-8444-444444444444",
      sessionReplaySegmentId: "55555555-5555-4555-8555-555555555555",
      pageViewSpanId: "6666666666666666",
      incomingParent: CLIENT_FETCH,
    });

    await runWithServerRequestContext(context, async () => {
      app.logger.warn("scoped log", { key: "user:42" });
    });
    await app.flush();

    const log = logRecords(collector.requests).find((record) => record.eventName === "$log");
    if (log === undefined) throw new Error("Expected the scoped logger LogRecord");
    expect(log).toMatchObject({
      traceId: CLIENT_FETCH.traceId,
      spanId: CLIENT_FETCH.spanId,
      body: { stringValue: "scoped log" },
    });
    expect(attributeValue(log, "hexclave.user.id")).toBe(context.userId);
    expect(attributeValue(log, "hexclave.refresh_token.id")).toBe(context.refreshTokenId);
    expect(attributeValue(log, "hexclave.session_replay.segment.id")).toBe(context.sessionReplaySegmentId);
    expect(attributeValue(log, "hexclave.page_view.span_id")).toBe(context.pageViewSpanId);
  });

  it("attributes bare ambient-request logger calls asynchronously via the framework provider", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl);
    const instrumentation = getServerAppInstrumentation(app);
    if (instrumentation === null) throw new Error("Expected a real server app instrumentation facade");
    const context = requestContext({
      userId: "99999999-9999-4999-8999-999999999999",
      pageViewSpanId: "6666666666666666",
      incomingParent: CLIENT_FETCH,
    });
    Reflect.set(app, "_resolveServerRequestContext", async () => context);
    instrumentation.setAmbientRequestProvider(async () => ({ headers: new Headers() }));

    try {
      app.logger.info("ambient log");
      await vi.waitFor(async () => {
        await app.flush();
        expect(logRecords(collector.requests).find((record) => record.eventName === "$log")).toBeDefined();
      });
      const log = logRecords(collector.requests).find((record) => record.eventName === "$log");
      if (log === undefined) throw new Error("Expected the ambient logger LogRecord");
      expect(log).toMatchObject({ traceId: CLIENT_FETCH.traceId, spanId: CLIENT_FETCH.spanId });
      expect(attributeValue(log, "hexclave.user.id")).toBe(context.userId);
      expect(attributeValue(log, "hexclave.page_view.span_id")).toBe(context.pageViewSpanId);
    } finally {
      instrumentation.setAmbientRequestProvider(null);
    }
  });

  it("emits public manual captures with scoped enrichment and event IDs", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl);

    const exceptionEventId = app.withErrorScope((scope) => {
      scope.setUser({ id: "server-user" });
      scope.setTag("route", "checkout");
      scope.addBreadcrumb({ category: "http", message: "POST /checkout" });
      return app.captureException(new Error("server payment failed"), { handled: true });
    });
    const messageEventId = app.captureMessage("server degraded", { level: "warning" });
    const normalizedEventId = app.captureEvent({
      message: "normalized server failure",
      name: "ServerFailure",
      handled: false,
    });
    expect(app.lastEventId()).toBe(normalizedEventId);
    await app.flush();

    const errors = logRecords(collector.requests).filter((record) => record.eventName === "$error");
    expect(errors).toHaveLength(3);
    const exception = errors.find((record) => attributeValue(record, "hexclave.event.id") === exceptionEventId);
    const message = errors.find((record) => attributeValue(record, "hexclave.event.id") === messageEventId);
    const normalized = errors.find((record) => attributeValue(record, "hexclave.event.id") === normalizedEventId);
    if (exception === undefined || message === undefined || normalized === undefined) {
      throw new Error("Expected each manual server capture to retain its event ID");
    }
    const exceptionData = attributeValue(exception, "hexclave.data");
    const messageData = attributeValue(message, "hexclave.data");
    const normalizedData = attributeValue(normalized, "hexclave.data");
    if (!(exceptionData instanceof Map) || !(messageData instanceof Map) || !(normalizedData instanceof Map)) {
      throw new Error("Expected structured manual capture data");
    }
    expect(exceptionData.get("event_id")).toBe(exceptionEventId);
    expect(exceptionData.get("message")).toBe("server payment failed");
    expect(exceptionData.get("handled")).toBe(true);
    expect(exceptionData.get("user")).toEqual(new Map([["id", "server-user"]]));
    expect(exceptionData.get("tags")).toEqual(new Map([["route", "checkout"]]));
    expect(messageData.get("event_id")).toBe(messageEventId);
    expect(messageData.get("level")).toBe("warning");
    expect(messageData.get("name")).toBe("Message");
    expect(normalizedData.get("event_id")).toBe(normalizedEventId);
    expect(normalizedData.get("name")).toBe("ServerFailure");
    expect(normalizedData.get("handled")).toBe(false);
  });

  it("honors head sampling for local roots while retaining sampled upstream work", async () => {
    const collector = await startCollector();
    const app = await makeReadyApp(collector.baseUrl, 0);

    await app.withSpan("local-dropped", async () => {});
    await runWithServerRequestContext(requestContext({ incomingParent: CLIENT_FETCH }), async () => {
      await app.withSpan("upstream-kept", async () => {});
    });
    await app.flush();

    expect(spans(collector.requests).map((span) => span.name)).toEqual(["upstream-kept"]);
  });

  it("rejects structural non-instances at the framework instrumentation boundary", () => {
    expect(getServerAppInstrumentation({ withSpan: () => {}, getUser: () => {} })).toBeNull();
    expect(getServerAppInstrumentation(null)).toBeNull();
  });

  it("tears down the registry-owned observer idempotently without a crash listener", async () => {
    const collector = await startCollector();
    const processOn = vi.spyOn(process, "on");
    const processRemoveListener = vi.spyOn(process, "removeListener");
    const app = makeApp(collector.baseUrl);
    const instrumentation = getServerAppInstrumentation(app);
    if (instrumentation === null) throw new Error("Expected a real server app instrumentation facade");

    const monitorInstallsAfterConstruction = processOn.mock.calls.filter(([event]) => event === "uncaughtExceptionMonitor").length;
    const monitorRemovalsAfterConstruction = processRemoveListener.mock.calls.filter(([event]) => event === "uncaughtExceptionMonitor").length;
    instrumentation.installServerErrorMonitor();
    expect(processOn.mock.calls.filter(([event]) => event === "uncaughtExceptionMonitor")).toHaveLength(monitorInstallsAfterConstruction);
    expect(processOn.mock.calls.some(([event]) => event === "uncaughtException")).toBe(false);

    instrumentation.uninstallErrorIntegrations();
    expect(processRemoveListener.mock.calls.filter(([event]) => event === "uncaughtExceptionMonitor")).toHaveLength(monitorRemovalsAfterConstruction + 1);
    instrumentation.uninstallErrorIntegrations();
    expect(processRemoveListener.mock.calls.filter(([event]) => event === "uncaughtExceptionMonitor")).toHaveLength(monitorRemovalsAfterConstruction + 1);

    instrumentation.installServerErrorMonitor();
    expect(processOn.mock.calls.filter(([event]) => event === "uncaughtExceptionMonitor")).toHaveLength(monitorInstallsAfterConstruction + 1);
    instrumentation.uninstallErrorIntegrations();
  });
});

import { context, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHexclaveBrowserOtlpLogExporter, registerManagedBrowserOtel, resetManagedBrowserOtelForTesting, type BrowserOtlpDeliveryOutcome } from "./browser-otel-sdk";

const loggerProviders: LoggerProvider[] = [];

function makeLogProvider(
  outcomes: BrowserOtlpDeliveryOutcome[],
  batchSize = 1,
  exporterOptions: {
    offlineQueue?: { dbName?: string, maxQueueSize?: number, maxQueueBytes?: number },
    flushDeadlineMs?: number,
    shutdownDeadlineMs?: number,
    sendClientReports?: boolean,
  } = {},
) {
  const exporter = createHexclaveBrowserOtlpLogExporter({
    analyticsBaseUrl: "https://analytics.example.test",
    projectId: "project",
    clientVersion: "test",
    getRequestHeaders: async () => ({ "x-hexclave-access-token": "fixture-token" }),
    onOutcome: (outcome) => outcomes.push(outcome),
    flushDeadlineMs: 10_000,
    shutdownDeadlineMs: 2_000,
    ...exporterOptions,
  });
  const processor = new BatchLogRecordProcessor({ exporter, maxExportBatchSize: batchSize, scheduledDelayMillis: 60_000 });
  const provider = Object.assign(new LoggerProvider({ processors: [processor] }), { exporter });
  loggerProviders.push(provider);
  return provider;
}

function response(status: number, body?: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers });
}

function stubResponses(responses: Response[]) {
  const remaining = [...responses];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => remaining.shift() ?? response(500));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function settleExportStart(): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) await Promise.resolve();
}

afterEach(async () => {
  await Promise.all(loggerProviders.splice(0).map(async (provider) => await provider.shutdown()));
  await resetManagedBrowserOtelForTesting();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("managed browser OpenTelemetry", () => {
  it("rejects present-but-invalid positive integer options instead of silently defaulting", () => {
    const base = {
      analyticsBaseUrl: "https://analytics.example.test",
      projectId: "project",
      clientVersion: "test",
      getRequestHeaders: async () => ({}),
    };
    expect(() => createHexclaveBrowserOtlpLogExporter({ ...base, flushDeadlineMs: -1 })).toThrow(/flushDeadlineMs/);
    expect(() => createHexclaveBrowserOtlpLogExporter({ ...base, shutdownDeadlineMs: 1.5 })).toThrow(/shutdownDeadlineMs/);
    expect(() => createHexclaveBrowserOtlpLogExporter({ ...base, offlineQueue: { maxQueueSize: 0 } })).toThrow(/maxQueueSize/);
  });

  it("keeps conflicting page ownership protection while allowing a fresh test lifecycle", async () => {
    const makeOptions = (projectId: string) => ({
      analyticsBaseUrl: "https://analytics.example.test",
      projectId,
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { service: { name: "storefront" } },
      getRequestHeaders: async () => ({}),
      networkCapture: { enabled: true, allowOrigins: null, denyOrigins: null, ignoreUrls: [] },
      getPropagationPolicy: () => ({ allowedOrigins: [], allowLocalhost: false, correlationBaggage: true }),
      getAmbientOtelContext: () => null,
    });

    const firstRegistration = registerManagedBrowserOtel(makeOptions("project-a"));
    expect(() => registerManagedBrowserOtel(makeOptions("project-b"))).toThrow(
      "Hexclave browser OpenTelemetry is already configured for a different project or resource on this page",
    );

    await resetManagedBrowserOtelForTesting();
    const secondRegistration = registerManagedBrowserOtel(makeOptions("project-b"));
    expect(secondRegistration).not.toBe(firstRegistration);
  });

  it("omits the baggage propagator half when correlation baggage is disabled", async () => {
    const makeOptions = (correlationBaggage: boolean) => ({
      analyticsBaseUrl: "https://analytics.example.test",
      projectId: "project-baggage",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { service: { name: "storefront" } },
      getRequestHeaders: async () => ({}),
      networkCapture: { enabled: true, allowOrigins: null, denyOrigins: null, ignoreUrls: [] },
      getPropagationPolicy: () => ({ allowedOrigins: [], allowLocalhost: false, correlationBaggage }),
      getAmbientOtelContext: () => null,
    });
    const inject = (): Map<string, string> => {
      const baggageContext = propagation.setBaggage(
        context.active(),
        propagation.createBaggage({ "hexclave.session_replay.segment.id": { value: "segment-1" } }),
      );
      const carrier = new Map<string, string>();
      propagation.inject(baggageContext, carrier, {
        set(target, key, value) {
          target.set(key, value);
        },
      });
      return carrier;
    };

    registerManagedBrowserOtel(makeOptions(false));
    expect(inject().get("baggage")).toBeUndefined();

    await resetManagedBrowserOtelForTesting();
    registerManagedBrowserOtel(makeOptions(true));
    expect(inject().get("baggage")).toContain("segment-1");
  });

  it("does not let same-project owners disagree about the page-global baggage policy", async () => {
    const makeOptions = (correlationBaggage: boolean) => ({
      analyticsBaseUrl: "https://analytics.example.test",
      projectId: "project-shared",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { service: { name: "storefront" } },
      getRequestHeaders: async () => ({}),
      networkCapture: { enabled: true, allowOrigins: null, denyOrigins: null, ignoreUrls: [] },
      getPropagationPolicy: () => ({ allowedOrigins: [], allowLocalhost: false, correlationBaggage }),
      getAmbientOtelContext: () => null,
    });

    registerManagedBrowserOtel(makeOptions(true));
    expect(() => registerManagedBrowserOtel(makeOptions(false))).toThrow(
      "Hexclave browser OpenTelemetry is already configured for a different project or resource on this page",
    );
  });

  it("resolves rotating credentials for each OTLP export", async () => {
    const receivedUrls: string[] = [];
    const receivedAccessTokens: string[] = [];
    let receivedContentType = "";
    const server = createServer((request, response) => {
      receivedUrls.push(request.url ?? "");
      receivedAccessTokens.push(typeof request.headers["x-hexclave-access-token"] === "string"
        ? request.headers["x-hexclave-access-token"]
        : "");
      receivedContentType = request.headers["content-type"] ?? "";
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected the browser OTLP fixture server to listen on a TCP port");
    const analyticsBaseUrl = new URL("http://127.0.0.1");
    analyticsBaseUrl.port = String(address.port);
    let accessToken = "old-user-token";
    const getRequestHeaders = vi.fn(async () => ({
      "x-hexclave-access-token": accessToken,
      "x-hexclave-access-type": "client",
    }));
    const registration = registerManagedBrowserOtel({
      analyticsBaseUrl: `${analyticsBaseUrl.toString()}prefix-that-must-not-leak`,
      projectId: "project",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { service: { name: "storefront" } },
      getRequestHeaders,
      networkCapture: { enabled: true, allowOrigins: null, denyOrigins: null, ignoreUrls: [] },
      getPropagationPolicy: () => ({ allowedOrigins: [], allowLocalhost: false, correlationBaggage: true }),
      getAmbientOtelContext: () => null,
    });

    trace.getTracer("browser-fixture").startSpan("checkout").end();
    logs.getLogger("browser-fixture").emit({ body: "old-user-log" });
    const registrationAfterRotation = await registration.flushBeforeAuthenticationChange();
    accessToken = "new-user-token";
    trace.getTracer("browser-fixture").startSpan("signed-in-again").end();
    logs.getLogger("browser-fixture").emit({ body: "new-user-log" });
    await registrationAfterRotation.forceFlush();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));

    expect(getRequestHeaders).toHaveBeenCalledTimes(4);
    const otlpPaths = ["/api/v1/analytics/otlp/v1/logs", "/api/v1/analytics/otlp/v1/traces"];
    expect(receivedUrls.slice(0, 2).sort()).toEqual(otlpPaths);
    expect(receivedUrls.slice(2).sort()).toEqual(otlpPaths);
    expect(receivedAccessTokens).toEqual(["old-user-token", "old-user-token", "new-user-token", "new-user-token"]);
    expect(receivedContentType).toBe("application/json");
  });

  it("replaces the managed providers when their pre-authentication flush and shutdown both fail", async () => {
    let accessToken = "old-user-token";
    const receivedAccessTokens: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      receivedAccessTokens.push(headers.get("x-hexclave-access-token") ?? "");
      return response(200, "{}");
    }));
    const registration = registerManagedBrowserOtel({
      analyticsBaseUrl: "https://analytics.example.test",
      projectId: "project",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { service: { name: "storefront" } },
      getRequestHeaders: async () => ({ "x-hexclave-access-token": accessToken }),
      flushDeadlineMs: 25,
      shutdownDeadlineMs: 25,
      networkCapture: { enabled: true, allowOrigins: null, denyOrigins: null, ignoreUrls: [] },
      getPropagationPolicy: () => ({ allowedOrigins: [], allowLocalhost: false, correlationBaggage: true }),
      getAmbientOtelContext: () => null,
    });
    vi.spyOn(registration.provider, "forceFlush").mockRejectedValueOnce(new Error("fixture flush failure"));
    const shutdown = registration.provider.shutdown.bind(registration.provider);
    vi.spyOn(registration.provider, "shutdown").mockImplementationOnce(async () => {
      await shutdown();
      throw new Error("fixture shutdown failure");
    });

    trace.getTracer("browser-fixture").startSpan("before-sign-out").end();
    logs.getLogger("browser-fixture").emit({ body: "before-sign-out" });
    const registrationAfterRotation = await registration.flushBeforeAuthenticationChange();

    expect(registrationAfterRotation.provider).not.toBe(registration.provider);
    expect(registrationAfterRotation.loggerProvider).not.toBe(registration.loggerProvider);
    expect(warning).toHaveBeenCalledWith(
      "Hexclave browser OpenTelemetry flush failed during authentication rotation; the provider was replaced so buffered telemetry cannot cross users.",
      { flushError: expect.any(Error), shutdownError: expect.any(Error) },
    );
    expect(registration.enableHttpInstrumentation()).toBe(false);
    accessToken = "new-user-token";
    trace.getTracer("browser-fixture").startSpan("after-sign-in").end();
    logs.getLogger("browser-fixture").emit({ body: "after-sign-in" });
    await registrationAfterRotation.forceFlush();
    expect(receivedAccessTokens.at(-2)).toBe("new-user-token");
    expect(receivedAccessTokens.at(-1)).toBe("new-user-token");
  });

  it("exports an open snapshot of system spans at start, superseded by the end-write", async () => {
    type ExportedSpan = { name: string, spanId: string, endTimeUnixNano: string };
    const exportedSpans: ExportedSpan[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url === "/api/v1/analytics/otlp/v1/traces") {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            resourceSpans?: { scopeSpans?: { spans?: ExportedSpan[] }[] }[],
          };
          for (const resourceSpan of body.resourceSpans ?? []) {
            for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
              exportedSpans.push(...scopeSpan.spans ?? []);
            }
          }
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected the browser OTLP fixture server to listen on a TCP port");
    const waitFor = async (predicate: () => boolean, what: string) => {
      for (let attempt = 0; attempt < 250; attempt++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for ${what}`);
    };

    const registration = registerManagedBrowserOtel({
      analyticsBaseUrl: `http://127.0.0.1:${address.port}`,
      projectId: "project",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { service: { name: "storefront" } },
      getRequestHeaders: async () => ({}),
      networkCapture: { enabled: true, allowOrigins: null, denyOrigins: null, ignoreUrls: [] },
      getPropagationPolicy: () => ({ allowedOrigins: [], allowLocalhost: false, correlationBaggage: true }),
      getAmbientOtelContext: () => null,
    });

    const tracer = trace.getTracer("browser-fixture");
    const customSpan = tracer.startSpan("checkout", { attributes: { "hexclave.signal.type": "custom_span" } });
    const systemSpan = tracer.startSpan("$page-view", { attributes: { "hexclave.signal.type": "system_span" } });
    const systemSpanId = systemSpan.spanContext().spanId;

    await waitFor(() => exportedSpans.some((span) => span.spanId === systemSpanId), "the open system-span snapshot export");
    expect(exportedSpans).toHaveLength(1);
    expect(exportedSpans[0]).toMatchObject({ name: "$page-view", spanId: systemSpanId, endTimeUnixNano: "0" });

    customSpan.end();
    systemSpan.end();
    await registration.forceFlush();
    await waitFor(() => exportedSpans.length >= 3, "the batched end-writes");
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));

    const finalSystemWrite = [...exportedSpans].reverse().find((span) => span.spanId === systemSpanId);
    expect(finalSystemWrite?.endTimeUnixNano).not.toBe("0");
    expect(exportedSpans.filter((span) => span.name === "checkout")).toHaveLength(1);
  });

  it("stops after bounded transient retries and reports retry exhaustion", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = stubResponses([response(503), response(503), response(503)]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes);

    provider.getLogger("transport-fixture").emit({ body: "retry me" });
    const flush = provider.forceFlush();
    await settleExportStart();
    await vi.advanceTimersByTimeAsync(1_500);
    await flush;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outcomes).toMatchObject([{ outcome: "queued", reason: "retry_exhausted", attempts: 3, statusCode: 503 }]);
  });

  it("autonomously drains a durable batch after bounded backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = stubResponses([
      response(503),
      response(503),
      response(503),
      response(200, "{}", { "content-type": "application/json" }),
    ]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes);

    provider.getLogger("transport-fixture").emit({ body: "durable retry" });
    const initialFlush = provider.forceFlush();
    await settleExportStart();
    await vi.advanceTimersByTimeAsync(1_500);
    await initialFlush;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outcomes).toMatchObject([{ outcome: "queued", reason: "retry_exhausted" }]);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(outcomes).toMatchObject([
      { outcome: "queued", reason: "retry_exhausted" },
      { outcome: "accepted", reason: "accepted" },
    ]);
  });

  it("drains due batches when the browser reconnects", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onlineTarget = new EventTarget();
    vi.stubGlobal("window", onlineTarget);
    const fetchMock = stubResponses([
      response(503),
      response(503),
      response(503),
      response(200, "{}", { "content-type": "application/json" }),
    ]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes);

    provider.getLogger("transport-fixture").emit({ body: "reconnect me" });
    const initialFlush = provider.forceFlush();
    await settleExportStart();
    await vi.advanceTimersByTimeAsync(1_500);
    await initialFlush;
    await vi.advanceTimersByTimeAsync(10_000);

    onlineTarget.dispatchEvent(new Event("online"));
    await settleExportStart();
    await provider.exporter.forceFlush();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(outcomes).toMatchObject([
      { outcome: "queued", reason: "retry_exhausted" },
      { outcome: "accepted", reason: "accepted" },
    ]);
  });

  it("uses a bounded keepalive flush for pagehide without changing page ownership", async () => {
    vi.useFakeTimers();
    const lifecycleTarget = new EventTarget();
    vi.stubGlobal("window", lifecycleTarget);
    vi.stubGlobal("document", lifecycleTarget);
    const fetchMock = stubResponses([response(200, "{}", { "content-type": "application/json" })]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes);

    provider.getLogger("transport-fixture").emit({ body: "flush on pagehide" });
    lifecycleTarget.dispatchEvent(new Event("pagehide"));
    await settleExportStart();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
    await vi.waitFor(() => expect(outcomes).toMatchObject([{ outcome: "accepted", reason: "accepted" }]));
  });

  it("drops queued batches when authentication generation advances", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let accessToken = "old-user-token";
    const fetchMock = stubResponses([
      response(503),
      response(503),
      response(503),
      response(200, "{}", { "content-type": "application/json" }),
    ]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const exporter = createHexclaveBrowserOtlpLogExporter({
      analyticsBaseUrl: "https://analytics.example.test",
      projectId: "project",
      clientVersion: "test",
      getRequestHeaders: async () => ({ "x-hexclave-access-token": accessToken }),
      onOutcome: (outcome) => outcomes.push(outcome),
      flushDeadlineMs: 10_000,
      shutdownDeadlineMs: 2_000,
    });
    const provider = Object.assign(new LoggerProvider({
      processors: [new BatchLogRecordProcessor({ exporter, maxExportBatchSize: 1, scheduledDelayMillis: 60_000 })],
    }), { exporter });
    loggerProviders.push(provider);

    provider.getLogger("transport-fixture").emit({ body: "must not cross users" });
    const initialFlush = provider.forceFlush();
    await settleExportStart();
    await vi.advanceTimersByTimeAsync(1_500);
    await initialFlush;
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await exporter.advanceAuthGeneration();
    accessToken = "new-user-token";
    provider.getLogger("transport-fixture").emit({ body: "new user" });
    await provider.forceFlush();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const receivedTokens = fetchMock.mock.calls.map((call) => new Headers(call[1]?.headers).get("x-hexclave-access-token"));
    expect(receivedTokens).toEqual(["old-user-token", "old-user-token", "old-user-token", "new-user-token"]);
    expect(outcomes).toMatchObject([
      { outcome: "queued", reason: "retry_exhausted" },
      { outcome: "dropped", reason: "auth_generation_mismatch" },
      { outcome: "accepted", reason: "accepted" },
    ]);
  });

  it("honors Retry-After without retrying before the hinted time", async () => {
    vi.useFakeTimers();
    const fetchMock = stubResponses([
      response(429, undefined, { "retry-after": "5" }),
      response(200, "{}", { "content-type": "application/json" }),
    ]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes);

    provider.getLogger("transport-fixture").emit({ body: "rate limited" });
    const flush = provider.forceFlush();
    await settleExportStart();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcomes).toMatchObject([{ outcome: "accepted", reason: "accepted", attempts: 2 }]);
  });

  it("drops permanent responses without retrying", async () => {
    const fetchMock = stubResponses([response(401)]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes);

    provider.getLogger("transport-fixture").emit({ body: "do not retry" });
    await provider.forceFlush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(outcomes).toMatchObject([{ outcome: "dropped", reason: "permanent_failure", attempts: 1, statusCode: 401 }]);
  });

  it("queues a payload-free client report in the same auth-isolated delivery queue", async () => {
    const fetchMock = stubResponses([response(401), response(200, "{}", { "content-type": "application/json" })]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes, 1, { sendClientReports: true });

    provider.getLogger("transport-fixture").emit({ body: "report the drop" });
    await provider.forceFlush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).pathname).toBe("/api/v1/analytics/client-reports");
    const reportBody = fetchMock.mock.calls[1]?.[1]?.body;
    if (!(reportBody instanceof Uint8Array)) throw new Error("client report body should be JSON bytes");
    expect(JSON.parse(new TextDecoder().decode(reportBody))).toMatchObject({
      discarded_events: [{ reason: "permanent_failure", category: "log_item", quantity: 1 }],
      idempotency_key: expect.stringContaining("hexclave-client-report-logs-"),
    });
    expect(outcomes).toMatchObject([{ outcome: "dropped", reason: "permanent_failure" }]);
  });

  it("does not create client-report feedback when a report is retried or purged", async () => {
    const fetchMock = stubResponses([response(401), response(503)]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes, 1, { sendClientReports: true });

    provider.getLogger("transport-fixture").emit({ body: "report only the original drop" });
    await provider.forceFlush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).pathname).toBe("/api/v1/analytics/client-reports");
    expect(outcomes).toHaveLength(1);
    expect(outcomes).toMatchObject([{ outcome: "dropped", reason: "permanent_failure" }]);

    await provider.exporter.advanceAuthGeneration();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcomes).toHaveLength(1);
  });

  it("reports oversized batches before opening the network", async () => {
    const fetchMock = stubResponses([]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes);

    provider.getLogger("transport-fixture").emit({ body: "x".repeat(1_100_000) });
    await provider.forceFlush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcomes).toMatchObject([{ outcome: "dropped", reason: "oversized", attempts: 0, droppedItemCount: 1 }]);
    expect(outcomes[0]?.bodyBytes).toBeGreaterThan(1_048_576);
  });

  it("surfaces OTLP partial success as a partial outcome", async () => {
    const fetchMock = stubResponses([
      response(200, JSON.stringify({ partialSuccess: { rejectedLogRecords: 1, errorMessage: "one invalid record" } }), { "content-type": "application/json" }),
    ]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes, 2);

    provider.getLogger("transport-fixture").emit({ body: "partially accepted" });
    provider.getLogger("transport-fixture").emit({ body: "also accepted" });
    await provider.forceFlush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(outcomes).toMatchObject([{ outcome: "partial", reason: "partial_failure", droppedItemCount: 1, message: "one invalid record" }]);
  });

  it("recognizes the metrics partial-success field (rejectedDataPoints)", async () => {
    const fetchMock = stubResponses([
      response(200, JSON.stringify({ partialSuccess: { rejectedDataPoints: "1", errorMessage: "one invalid point" } }), { "content-type": "application/json" }),
    ]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes, 2);

    provider.getLogger("transport-fixture").emit({ body: "partially accepted" });
    provider.getLogger("transport-fixture").emit({ body: "also accepted" });
    await provider.forceFlush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(outcomes).toMatchObject([{ outcome: "partial", reason: "partial_failure", droppedItemCount: 1, message: "one invalid point" }]);
  });

  it("preserves the serialized event identity across retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = stubResponses([response(503), response(200, "{}", { "content-type": "application/json" })]);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes);
    const eventId = "0123456789abcdef0123456789abcdef";

    provider.getLogger("transport-fixture").emit({ body: { event_id: eventId, message: "identity" } });
    const flush = provider.forceFlush();
    await settleExportStart();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush;
    const bodies = await Promise.all(fetchMock.mock.calls.map(async (call) => await new Response(call[1]?.body ?? null).text()));

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain(eventId);
    expect(bodies[1]).toContain(eventId);
    expect(bodies[0]).toBe(bodies[1]);
    expect(outcomes).toMatchObject([{ outcome: "accepted", attempts: 2 }]);
  });

  it("makes forceFlush and shutdown wait for the in-flight request", async () => {
    let resolveResponse = (_value: Response): void => {
      throw new Error("The fixture response resolver was used before initialization");
    };
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => await responsePromise);
    vi.stubGlobal("fetch", fetchMock);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const provider = makeLogProvider(outcomes);
    provider.getLogger("transport-fixture").emit({ body: "wait for me" });

    const flush = provider.forceFlush();
    await settleExportStart();
    expect(fetchMock).toHaveBeenCalledOnce();
    let flushSettled = false;
    const observedFlush = flush.then(() => {
      flushSettled = true;
    });
    await Promise.resolve();
    expect(flushSettled).toBe(false);
    resolveResponse(response(200, "{}", { "content-type": "application/json" }));
    await observedFlush;
    expect(flushSettled).toBe(true);

    let resolveShutdownResponse = (_value: Response): void => {
      throw new Error("The shutdown response resolver was used before initialization");
    };
    const shutdownResponse = new Promise<Response>((resolve) => {
      resolveShutdownResponse = resolve;
    });
    fetchMock.mockImplementation(async () => await shutdownResponse);
    provider.getLogger("transport-fixture").emit({ body: "close me" });
    const shutdown = provider.shutdown();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    let shutdownSettled = false;
    const observedShutdown = shutdown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    resolveShutdownResponse(response(200, "{}", { "content-type": "application/json" }));
    await observedShutdown;
    expect(shutdownSettled).toBe(true);
  });

  it("bounds managed forceFlush while retaining a timed-out batch for delivery", async () => {
    vi.useFakeTimers();
    let useRecoveryResponse = false;
    const blockedResponse = new Promise<Response>(() => {});
    const fetchMock = vi.fn(async () => useRecoveryResponse
      ? response(200, "{}", { "content-type": "application/json" })
      : await blockedResponse);
    vi.stubGlobal("fetch", fetchMock);
    const outcomes: BrowserOtlpDeliveryOutcome[] = [];
    const registration = registerManagedBrowserOtel({
      analyticsBaseUrl: "https://analytics.example.test",
      projectId: "project",
      clientVersion: "test",
      traceSampleRate: 1,
      resource: { service: { name: "storefront" } },
      getRequestHeaders: async () => ({ "x-hexclave-access-token": "fixture-token" }),
      onOutcome: (outcome) => outcomes.push(outcome),
      flushDeadlineMs: 25,
      shutdownDeadlineMs: 25,
      networkCapture: { enabled: true, allowOrigins: null, denyOrigins: null, ignoreUrls: [] },
      getPropagationPolicy: () => ({ allowedOrigins: [], allowLocalhost: false, correlationBaggage: true }),
      getAmbientOtelContext: () => null,
    });

    logs.getLogger("transport-fixture").emit({ body: "deadline" });
    const flush = registration.forceFlush(25);
    const flushResult = flush.then(() => null, (error: unknown) => error);
    await settleExportStart();
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(25);
    await expect(flushResult).resolves.toMatchObject({ name: "BrowserOtlpDeadlineError" });
    await settleExportStart();
    expect(outcomes).toMatchObject([{ outcome: "queued", reason: "deadline" }]);

    useRecoveryResponse = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcomes).toMatchObject([
      { outcome: "queued", reason: "deadline" },
      { outcome: "accepted", reason: "accepted" },
    ]);
  });
});

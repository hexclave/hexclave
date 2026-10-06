// @vitest-environment jsdom

import { propagation, trace } from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { logs } from "@opentelemetry/api-logs";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventTracker, type EventTrackerDeps } from "./event-tracker";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const SEGMENT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ROOT = {
  traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  spanId: "bbbbbbbbbbbbbbbb",
  traceState: "vendor=value",
};

const loggerProviders: LoggerProvider[] = [];
const tracerProviders: BasicTracerProvider[] = [];

function installOtel(): {
  logsExporter: InMemoryLogRecordExporter,
  spansExporter: InMemorySpanExporter,
  loggerProvider: LoggerProvider,
} {
  const logsExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logsExporter })],
  });
  loggerProviders.push(loggerProvider);
  logs.setGlobalLoggerProvider(loggerProvider);

  const spansExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spansExporter)],
  });
  tracerProviders.push(tracerProvider);
  if (!trace.setGlobalTracerProvider(tracerProvider)) throw new Error("Could not install test TracerProvider");
  return { logsExporter, spansExporter, loggerProvider };
}

function makeTracker(overrides?: Partial<EventTrackerDeps>): EventTracker {
  return new EventTracker({
    projectId: PROJECT_ID,
    resource: { service: { name: "browser-test" } },
    clientVersion: "test-version",
    sessionReplaySegmentId: SEGMENT_ID,
    sessionRootContext: SESSION_ROOT,
    productAnalyticsEnabled: true,
    ...overrides,
  });
}

class MockPerformanceObserver {
  static supportedEntryTypes = ["navigation", "paint", "largest-contentful-paint", "layout-shift", "event", "first-input"];
  static instances: MockPerformanceObserver[] = [];

  observedType: string | null = null;

  constructor(private readonly callback: (list: { getEntries: () => unknown[] }) => void) {
    MockPerformanceObserver.instances.push(this);
  }

  observe(options: { type: string }) {
    this.observedType = options.type;
  }

  disconnect() {}

  emit(entries: unknown[]) {
    this.callback({ getEntries: () => entries });
  }

  static byType(type: string): MockPerformanceObserver {
    const instance = MockPerformanceObserver.instances.find((candidate) => candidate.observedType === type);
    if (!instance) throw new Error(`No observer registered for ${type}`);
    return instance;
  }
}

afterEach(async () => {
  vi.useRealTimers();
  document.body.replaceChildren();
  Reflect.set(globalThis, "hexclaveCapturedErrors", []);
  MockPerformanceObserver.instances = [];
  trace.disable();
  logs.disable();
  propagation.disable();
  await Promise.all(loggerProviders.splice(0).map(async (provider) => await provider.shutdown()));
  await Promise.all(tracerProviders.splice(0).map(async (provider) => await provider.shutdown()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EventTracker OTel autocapture", () => {
  it("does not re-report a failed background OTLP flush as an application error", async () => {
    vi.useFakeTimers();
    const forceFlushOtel = vi.fn(async () => {
      throw new Error("OTLP endpoint unavailable");
    });
    const tracker = makeTracker({ forceFlushOtel });
    document.body.innerHTML = "<button id=checkout>Checkout</button>";
    tracker.start();
    document.querySelector("#checkout")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    Reflect.set(globalThis, "hexclaveCapturedErrors", []);

    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    await vi.advanceTimersByTimeAsync(0);

    expect(forceFlushOtel).toHaveBeenCalledOnce();
    expect(Reflect.get(globalThis, "hexclaveCapturedErrors")).toEqual([]);
    tracker.stop();
  });

  it("emits explicit product events as named LogRecords, never a legacy batch", async () => {
    const otel = installOtel();
    const forceFlush = vi.fn(async () => await otel.loggerProvider.forceFlush());
    const tracker = makeTracker({ forceFlushOtel: forceFlush });

    await tracker.trackCustomEvent("checkout_completed", { amount: 42 }, { parent: SESSION_ROOT });

    expect(forceFlush).toHaveBeenCalledOnce();
    expect(otel.logsExporter.getFinishedLogRecords()).toMatchObject([{
      eventName: "checkout_completed",
      spanContext: { traceId: SESSION_ROOT.traceId, spanId: SESSION_ROOT.spanId },
      attributes: {
        "hexclave.signal.type": "event",
        "hexclave.session_replay.segment.id": SEGMENT_ID,
        "hexclave.data": { amount: 42 },
      },
    }]);
  });

  it("inert-ifies never-ended CHILD facades on the sign-out sweep", async () => {
    installOtel();
    const tracker = makeTracker();
    const parent = tracker.startSpan("parent-op");
    const child = parent.startSpan("child-op");
    const grandchild = child.startSpan("grandchild-op");
    expect(grandchild.isEnded).toBe(false);

    tracker.clearBuffer();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(parent.isEnded).toBe(true);
    expect(child.isEnded).toBe(true);
    expect(grandchild.isEnded).toBe(true);
  });

  it("keeps the parent registered for the sign-out sweep after a child ends", async () => {
    installOtel();
    const tracker = makeTracker();
    const parent = tracker.startSpan("parent-op");
    const child = parent.startSpan("child-op");
    await child.end();
    expect(parent.isEnded).toBe(false);

    tracker.clearBuffer();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(parent.isEnded).toBe(true);
  });

  it("sends the real W3C traceparent (not correlation-only baggage) on span.fetch", async () => {
    installOtel();
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    const tracker = makeTracker({
      getPropagationPolicy: () => ({ selfOrigin: "https://app.example.com", allowedOrigins: ["https://api.example.com"], allowLocalhost: false, correlationBaggage: true }),
    });

    const span = tracker.startSpan("db.query");
    await span.fetch("https://api.example.com/data");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const headers = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
    const traceparent = headers.get("traceparent");
    expect(traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
    expect(headers.get("baggage")).toContain(SEGMENT_ID);
    await span.end();
  });

  it("spanPropagation.enabled=false strips correlation baggage from span.fetch but keeps traceparent", async () => {
    installOtel();
    propagation.setGlobalPropagator(new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    const tracker = makeTracker({
      getPropagationPolicy: () => ({ selfOrigin: "https://app.example.com", allowedOrigins: ["https://api.example.com"], allowLocalhost: false, correlationBaggage: false }),
    });

    const span = tracker.startSpan("db.query");
    await span.fetch("https://api.example.com/data");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const headers = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
    expect(headers.get("traceparent")).toBe(`00-${span.traceId}-${span.spanId}-01`);
    expect(headers.get("baggage")).toBeNull();
    await span.end();
  });

  it("records web-vitals metrics once per page view at span end, not per intermediate update", () => {
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    installOtel();
    const tracker = makeTracker();
    const recorder = Reflect.get(tracker, "_webVitalsMetricRecorder");
    const record = vi.spyOn(recorder, "record");
    tracker.start();

    MockPerformanceObserver.byType("largest-contentful-paint").emit([{ startTime: 900.2 }]);
    MockPerformanceObserver.byType("largest-contentful-paint").emit([{ startTime: 1500.7 }]);
    expect(record).not.toHaveBeenCalled();

    tracker.stop();
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0]).toMatchObject({ lcp_ms: 1501 });
  });

  it("rejects invalid public event names and cyclic structured data before OTel", async () => {
    const otel = installOtel();
    const tracker = makeTracker();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(tracker.trackCustomEvent("$reserved")).rejects.toThrow();
    await expect(tracker.trackCustomEvent("valid", cyclic)).rejects.toThrow();
    expect(otel.logsExporter.getFinishedLogRecords()).toHaveLength(0);
  });

  it("records page views as OTel spans and clicks as child-correlated LogRecords", async () => {
    const otel = installOtel();
    const tracker = makeTracker({ forceFlushOtel: async () => await otel.loggerProvider.forceFlush() });
    document.body.innerHTML = "<button id=checkout>Checkout</button>";
    tracker.start();
    const pageViewSpanId = tracker.getCurrentPageViewSpanId();
    if (pageViewSpanId === null) throw new Error("Expected startup to create a page-view span");

    document.querySelector("#checkout")?.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 20,
      clientY: 30,
    }));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    await tracker.flush();

    const click = otel.logsExporter.getFinishedLogRecords().find((record) => record.eventName === "$click");
    if (click === undefined) throw new Error("Expected a click LogRecord");
    expect(click.spanContext).toMatchObject({ traceId: SESSION_ROOT.traceId, spanId: pageViewSpanId });
    expect(click.attributes).toMatchObject({
      "hexclave.signal.type": "event",
      "hexclave.session_replay.segment.id": SEGMENT_ID,
      "hexclave.page_view.span_id": pageViewSpanId,
    });
    expect(click.attributes["hexclave.data"]).toMatchObject({ tag_name: "button", text: "Checkout" });

    const pageView = otel.spansExporter.getFinishedSpans().find((span) => span.name === "$page-view");
    if (pageView === undefined) throw new Error("Expected a page-view span");
    expect(pageView.spanContext()).toMatchObject({ traceId: SESSION_ROOT.traceId, spanId: pageViewSpanId });
    expect(pageView.parentSpanContext).toMatchObject({ spanId: SESSION_ROOT.spanId });
    tracker.stop();
  });

  it("exposes the current page view as the ambient OTel context with correlation baggage", () => {
    installOtel();
    const tracker = makeTracker();
    const preStart = tracker.getAmbientOtelContext();
    if (preStart === null) throw new Error("Expected a session-root ambient before the first page view");
    expect(trace.getSpanContext(preStart)).toMatchObject({ traceId: SESSION_ROOT.traceId, spanId: SESSION_ROOT.spanId });
    expect(propagation.getBaggage(preStart)?.getEntry("hexclave.page_view.span_id")).toBeUndefined();
    expect(makeTracker({ sessionRootContext: undefined }).getAmbientOtelContext()).toBeNull();

    tracker.start();
    const pageViewSpanId = tracker.getCurrentPageViewSpanId();
    if (pageViewSpanId === null) throw new Error("Expected startup to create a page-view span");
    const ambient = tracker.getAmbientOtelContext();
    if (ambient === null) throw new Error("Expected an ambient context once the page-view span exists");
    expect(trace.getSpanContext(ambient)).toMatchObject({ traceId: SESSION_ROOT.traceId, spanId: pageViewSpanId });
    const baggage = propagation.getBaggage(ambient);
    expect(baggage?.getEntry("hexclave.page_view.span_id")?.value).toBe(pageViewSpanId);
    expect(baggage?.getEntry("hexclave.session_replay.segment.id")?.value).toBe(SEGMENT_ID);
    expect(tracker.getAmbientOtelContext()).toBe(ambient);

    window.history.pushState({}, "", "/next-page");
    const afterNavigation = tracker.getAmbientOtelContext();
    if (afterNavigation === null) throw new Error("Expected an ambient context after navigation");
    expect(trace.getSpanContext(afterNavigation)?.spanId).toBe(tracker.getCurrentPageViewSpanId());
    expect(trace.getSpanContext(afterNavigation)?.spanId).not.toBe(pageViewSpanId);

    tracker.stop();
    expect(tracker.getAmbientOtelContext()).toBeNull();
  });

  it("keeps a click local until dead-click classification has completed", async () => {
    vi.useFakeTimers();
    const otel = installOtel();
    const tracker = makeTracker({ forceFlushOtel: async () => await otel.loggerProvider.forceFlush() });
    document.body.innerHTML = "<button id=dead>Does nothing</button>";
    tracker.start();

    document.querySelector("#dead")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tracker.flush();
    expect(otel.logsExporter.getFinishedLogRecords().find((record) => record.eventName === "$click")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(3_000);
    await tracker.flush();
    const click = otel.logsExporter.getFinishedLogRecords().find((record) => record.eventName === "$click");
    if (click === undefined) throw new Error("Expected classified click");
    expect(click.attributes["hexclave.data"]).toMatchObject({ dead: 1 });
    tracker.stop();
  });

  it("drops locally staged autocapture when browser identity rotates", async () => {
    const otel = installOtel();
    const tracker = makeTracker({ forceFlushOtel: async () => await otel.loggerProvider.forceFlush() });
    document.body.innerHTML = "<button id=pending>Pending</button>";
    tracker.start();
    document.querySelector("#pending")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    tracker.clearBuffer();
    await tracker.flush();

    expect(otel.logsExporter.getFinishedLogRecords().find((record) => record.eventName === "$click")).toBeUndefined();
    tracker.stop();
  });

  it("does not install product autocapture when analytics is disabled", async () => {
    const otel = installOtel();
    const tracker = makeTracker({ productAnalyticsEnabled: false });
    document.body.innerHTML = "<button id=ignored>Ignored</button>";
    tracker.start();
    document.querySelector("#ignored")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    await tracker.flush();

    expect(otel.logsExporter.getFinishedLogRecords()).toHaveLength(0);
    expect(otel.spansExporter.getFinishedSpans()).toHaveLength(0);
    tracker.stop();
  });

  it("records opted-in integrity events through the same LogRecord contract", async () => {
    const otel = installOtel();
    const tracker = makeTracker({
      integritySignals: true,
      forceFlushOtel: async () => await otel.loggerProvider.forceFlush(),
    });
    document.body.innerHTML = "<main id=target>Menu target</main>";
    tracker.start();
    document.querySelector("#target")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    await tracker.flush();

    const event = otel.logsExporter.getFinishedLogRecords().find((record) => record.eventName === "$context-menu");
    expect(event?.attributes["hexclave.signal.type"]).toBe("event");
    tracker.stop();
  });
});

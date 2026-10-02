import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOtelSpanFacade, type OtelSpanFacadeCapabilities } from "./otel-span-facade";
import { getAmbientSpanContexts } from "./span-context";

const providers: NodeTracerProvider[] = [];
const contextManagers: AsyncLocalStorageContextManager[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.shutdown();
  for (const manager of contextManagers.splice(0)) manager.disable();
  context.disable();
  propagation.disable();
});

function fixture() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  providers.push(provider);
  const contextManager = new AsyncLocalStorageContextManager().enable();
  contextManagers.push(contextManager);
  if (!context.setGlobalContextManager(contextManager)) {
    throw new Error("Expected the OTel facade test to install its isolated context manager");
  }
  if (!propagation.setGlobalPropagator(new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  }))) {
    throw new Error("Expected the OTel facade test to install its isolated propagator");
  }
  const trackEvent = vi.fn(async () => {});
  const capabilities: OtelSpanFacadeCapabilities = {
    trackEvent,
    getSpanPropagationHeaders: (span) => ({ traceparent: `00-${span.traceId}-${span.spanId}-01` }),
    fetch: async () => new Response(null, { status: 204 }),
  };
  return { exporter, provider, trackEvent, capabilities };
}

describe("OTel Span facade", () => {
  it("binds the facade to both OTel and Hexclave ambient context during run", async () => {
    const { provider, capabilities } = fixture();
    const span = createOtelSpanFacade({
      tracer: provider.getTracer("facade-test"),
      spanType: "bound",
      capabilities,
    });

    await span.run(async () => {
      expect(trace.getSpan(context.active())?.spanContext().spanId).toBe(span.spanId);
      expect(getAmbientSpanContexts()).toEqual([span.spanContext()]);
    });
    expect(getAmbientSpanContexts()).toEqual([]);
    await span.end();
  });

  it("uses real OTel hierarchy, context, attributes, links, and lifecycle", async () => {
    const { exporter, provider, capabilities } = fixture();
    const tracer = provider.getTracer("facade-test", "1.0.0");
    const linked = tracer.startSpan("linked");
    linked.end();
    const root = createOtelSpanFacade({
      tracer,
      spanType: "checkout",
      startOptions: {
        data: { cartSize: 2 },
        links: [{ traceId: linked.spanContext().traceId, spanId: linked.spanContext().spanId }],
      },
      correlationAttributes: { "hexclave.session_replay.id": "replay" },
      capabilities,
    });

    await root.run(() => {
      expect(trace.getSpan(context.active())?.spanContext()).toMatchObject(root.spanContext());
      expect(propagation.getBaggage(context.active())?.getEntry("hexclave.session_replay.id")?.value).toBe("replay");
    });
    const child = root.startSpan("charge");
    await child.setData({ provider: "stripe" });
    await child.end();
    await child.end();
    await root.end();

    const spans = exporter.getFinishedSpans();
    const exportedRoot = spans.find((span) => span.name === "checkout");
    const exportedChild = spans.find((span) => span.name === "charge");
    expect(exportedRoot).toBeDefined();
    expect(exportedChild).toBeDefined();
    expect(exportedChild?.parentSpanContext?.spanId).toBe(root.spanId);
    expect(exportedRoot?.attributes).toMatchObject({
      "hexclave.signal.type": "custom_span",
      "hexclave.data": JSON.stringify({ cartSize: 2 }),
      "hexclave.session_replay.id": "replay",
    });
    expect(exportedRoot?.links).toHaveLength(1);
    expect(exportedRoot?.links[0]?.context.spanId).toBe(linked.spanContext().spanId);
    expect(spans.filter((span) => span.name === "charge")).toHaveLength(1);
  });

  it("marks a failed withSpan callback as an OTel error and rethrows it", async () => {
    const { exporter, provider, capabilities } = fixture();
    const root = createOtelSpanFacade({
      tracer: provider.getTracer("facade-test"),
      spanType: "request",
      capabilities,
    });

    await expect(root.withSpan("database", async () => {
      throw new Error("connection lost");
    })).rejects.toThrow("connection lost");
    await root.end();

    const failed = exporter.getFinishedSpans().find((span) => span.name === "database");
    expect(failed?.status).toEqual({ code: SpanStatusCode.ERROR, message: "connection lost" });
    expect(failed?.attributes["hexclave.data"]).toBe(JSON.stringify({ error: "connection lost" }));
  });

  it("announces EVERY facade (children included) through onStarted, before use", async () => {
    const { provider, capabilities } = fixture();
    const started: { spanType: string, spanId: string, isEnded: boolean }[] = [];
    const root = createOtelSpanFacade({
      tracer: provider.getTracer("facade-test"),
      spanType: "checkout",
      capabilities: {
        ...capabilities,
        onStarted: (span) => started.push({ spanType: span.spanType, spanId: span.spanId, isEnded: span.isEnded }),
      },
    });
    const child = root.startSpan("charge");
    await root.withSpan("refund", async () => {});
    await child.end();
    await root.end();

    expect(started.map((entry) => entry.spanType)).toEqual(["checkout", "charge", "refund"]);
    expect(started.every((entry) => !entry.isEnded)).toBe(true);
    expect(started[1]?.spanId).toBe(child.spanId);
  });

  it("ends and deregisters a span when onStarted rejects", () => {
    const { exporter, provider, capabilities } = fixture();
    const onEnded = vi.fn();
    const registrationError = new Error("span registry unavailable");

    expect(() => createOtelSpanFacade({
      tracer: provider.getTracer("facade-test"),
      spanType: "checkout",
      capabilities: {
        ...capabilities,
        onStarted: () => { throw registrationError; },
        onEnded,
      },
    })).toThrow(registrationError);

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["checkout"]);
  });

  it("preserves the registration error when cleanup rejects", () => {
    const { exporter, provider, capabilities } = fixture();
    const registrationError = new Error("span registry unavailable");
    const cleanupError = new Error("span cleanup unavailable");

    expect(() => createOtelSpanFacade({
      tracer: provider.getTracer("facade-test"),
      spanType: "checkout",
      capabilities: {
        ...capabilities,
        onStarted: () => { throw registrationError; },
        onEnded: () => { throw cleanupError; },
      },
    })).toThrow(registrationError);

    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["checkout"]);
  });

  it("lets the official propagator preserve an upstream tracestate", async () => {
    const { provider, capabilities } = fixture();
    const span = createOtelSpanFacade({
      tracer: provider.getTracer("facade-test"),
      spanType: "continued",
      startOptions: {
        parent: {
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
          traceState: "vendor=value",
        },
      },
      capabilities,
    });

    expect(span.getSpanPropagationHeaders()).toMatchObject({
      traceparent: `00-11111111111111111111111111111111-${span.spanId}-01`,
      tracestate: "vendor=value",
    });
    await span.end();
  });
});

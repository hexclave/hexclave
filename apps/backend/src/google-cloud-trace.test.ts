import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { TraceIdRatioFilteringSpanProcessor } from "./google-cloud-trace";

function createTestProvider(sampleRate: number) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new TraceIdRatioFilteringSpanProcessor(sampleRate, new SimpleSpanProcessor(exporter))],
  });
  return { exporter, tracer: provider.getTracer("google-cloud-trace-test") };
}

describe("TraceIdRatioFilteringSpanProcessor", () => {
  it("forwards roughly the configured fraction of traces", () => {
    const { exporter, tracer } = createTestProvider(0.05);
    const traceCount = 20_000;
    for (let i = 0; i < traceCount; i++) {
      tracer.startSpan("root").end();
    }
    const forwardedFraction = exporter.getFinishedSpans().length / traceCount;
    expect(forwardedFraction).toBeGreaterThan(0.04);
    expect(forwardedFraction).toBeLessThan(0.06);
  });

  it("keeps or drops all spans of a trace together", () => {
    const { exporter, tracer } = createTestProvider(0.5);
    const traceCount = 200;
    for (let i = 0; i < traceCount; i++) {
      // No context manager is registered here, so parents are passed explicitly.
      const root = tracer.startSpan("root");
      const child = tracer.startSpan("child", {}, trace.setSpan(ROOT_CONTEXT, root));
      tracer.startSpan("grandchild", {}, trace.setSpan(ROOT_CONTEXT, child)).end();
      child.end();
      root.end();
    }
    const spanCountsByTraceId = new Map<string, number>();
    for (const span of exporter.getFinishedSpans()) {
      const traceId = span.spanContext().traceId;
      spanCountsByTraceId.set(traceId, (spanCountsByTraceId.get(traceId) ?? 0) + 1);
    }
    expect(spanCountsByTraceId.size).toBeGreaterThan(0);
    expect(spanCountsByTraceId.size).toBeLessThan(traceCount);
    expect([...spanCountsByTraceId.values()].every((count) => count === 3)).toBe(true);
  });

  it("forwards everything at a sample rate of 1", () => {
    const { exporter, tracer } = createTestProvider(1);
    for (let i = 0; i < 100; i++) {
      tracer.startSpan("root").end();
    }
    expect(exporter.getFinishedSpans()).toHaveLength(100);
  });
});

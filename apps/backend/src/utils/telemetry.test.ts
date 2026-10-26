import * as sharedTelemetry from "@hexclave/shared/dist/utils/telemetry";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, expect, it } from "vitest";
import * as backendTelemetry from "./telemetry";

// Both telemetry modules are imported above, i.e. before any provider is registered, and the
// provider is registered through the backend's copy of @opentelemetry/api (the one Sentry uses),
// which is not necessarily the copy @hexclave/shared resolves. This mirrors any entrypoint that
// imports shared code before `@/instrument` runs.
const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

afterAll(() => {
  trace.disable();
});

it.each([
  ["@hexclave/shared", sharedTelemetry],
  ["backend", backendTelemetry],
])("%s traceSpan records spans when imported before the tracer provider is registered", async (name, telemetry) => {
  exporter.reset();
  await telemetry.traceSpan({ description: `${name} span`, attributes: { foo: "bar" } }, async (span) => {
    expect(span.isRecording()).toBe(true);
  });
  expect(exporter.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes }))).toEqual([
    { name: `STACK: ${name} span`, attributes: { foo: "bar" } },
  ]);
});

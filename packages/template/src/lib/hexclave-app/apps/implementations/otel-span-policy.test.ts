import { ROOT_CONTEXT, SpanKind, trace, TraceFlags } from "@opentelemetry/api";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { createManagedOtelSampler, shouldIgnoreNextFrameworkSpan } from "./otel-span-policy";

describe("managed OTel span policy", () => {
  it.each([
    ["GET /_next/static/chunks/app.js", {}],
    ["GET", { "http.target": "/_next/static/chunks/app.js" }],
    ["middleware GET", { "url.path": "/_next/static/chunks/app.js" }],
    ["GET", { "url.full": "https://dashboard.example/_next/static/chunks/app.js" }],
  ])("ignores Next static asset %s", (name, attributes) => {
    expect(shouldIgnoreNextFrameworkSpan({ name, kind: SpanKind.SERVER, attributes })).toBe(true);
  });

  it("matches Sentry's other low-value Next span patterns", () => {
    expect(shouldIgnoreNextFrameworkSpan({ name: "GET /__nextjs_original-stack-frame", kind: SpanKind.SERVER, attributes: {} })).toBe(true);
    expect(shouldIgnoreNextFrameworkSpan({ name: "GET /404", kind: SpanKind.SERVER, attributes: {} })).toBe(true);
    expect(shouldIgnoreNextFrameworkSpan({ name: "NextServer.getRequestHandler", kind: SpanKind.INTERNAL, attributes: {} })).toBe(true);
    expect(shouldIgnoreNextFrameworkSpan({ name: "middleware POST", kind: SpanKind.INTERNAL, attributes: { "sentry.drop_transaction": true } })).toBe(true);
  });

  it.each([
    ["OPTIONS", "OPTIONS", SpanKind.SERVER],
    ["middleware OPTIONS", "OPTIONS", SpanKind.INTERNAL],
    ["HEAD", "HEAD", SpanKind.SERVER],
  ])("skips Sentry-style Next %s request spans", (name, method, kind) => {
    expect(shouldIgnoreNextFrameworkSpan({
      name,
      kind,
      attributes: {
        "http.method": method,
        "http.target": "/api/projects/current",
        "next.span_category": "nextjs",
      },
    })).toBe(true);
  });

  it.each([
    ["POST /api/latest/analytics/events/batch", SpanKind.SERVER, "/api/latest/analytics/events/batch"],
    ["middleware POST", SpanKind.INTERNAL, "/api/v1/analytics/otlp/v1/traces"],
    ["POST /api/v1/analytics/events/batch", SpanKind.SERVER, "/api/v1/analytics/events/batch"],
    ["POST /api/latest/analytics/envelope", SpanKind.SERVER, "/api/latest/analytics/envelope"],
    ["POST /api/v1/analytics/envelope", SpanKind.SERVER, "/api/v1/analytics/envelope"],
    ["POST /api/latest/analytics/otlp/v1/traces", SpanKind.SERVER, "/api/latest/analytics/otlp/v1/traces"],
    ["POST /api/v1/analytics/otlp/v1/traces", SpanKind.SERVER, "/api/v1/analytics/otlp/v1/traces"],
    ["POST /api/latest/analytics/otlp/v1/logs", SpanKind.SERVER, "/api/latest/analytics/otlp/v1/logs"],
    ["POST /api/v1/analytics/otlp/v1/logs", SpanKind.SERVER, "/api/v1/analytics/otlp/v1/logs"],
    ["POST /api/latest/analytics/otlp/v1/metrics", SpanKind.SERVER, "/api/latest/analytics/otlp/v1/metrics"],
    ["POST /api/v1/analytics/otlp/v1/metrics", SpanKind.SERVER, "/api/v1/analytics/otlp/v1/metrics"],
    ["POST /api/latest/analytics/client-reports", SpanKind.SERVER, "/api/latest/analytics/client-reports"],
    ["POST /api/v1/analytics/client-reports", SpanKind.SERVER, "/api/v1/analytics/client-reports"],
    ["POST /api/latest/analytics/attachments", SpanKind.SERVER, "/api/latest/analytics/attachments"],
    ["POST /api/v1/analytics/attachments", SpanKind.SERVER, "/api/v1/analytics/attachments"],
    ["POST /api/latest/session-replays/batch", SpanKind.SERVER, "/api/latest/session-replays/batch"],
    ["POST /api/v1/session-replays/batch", SpanKind.SERVER, "/api/v1/session-replays/batch"],
  ])("drops recursive telemetry ingestion request %s", (name, kind, path) => {
    expect(shouldIgnoreNextFrameworkSpan({
      name,
      kind,
      attributes: { "http.target": path },
    })).toBe(true);
  });

  it("keeps application and background roots visible", () => {
    expect(shouldIgnoreNextFrameworkSpan({ name: "GET /api/orders", kind: SpanKind.SERVER, attributes: { "http.target": "/api/orders" } })).toBe(false);
    expect(shouldIgnoreNextFrameworkSpan({ name: "GET", kind: SpanKind.SERVER, attributes: { "http.target": "/api/latest/internal/issues/reconciler" } })).toBe(false);
    expect(shouldIgnoreNextFrameworkSpan({ name: "GET", kind: SpanKind.SERVER, attributes: { "http.target": "/api/projects/current" } })).toBe(false);
  });

  it("makes the ignore decision before parent-based sampling", () => {
    const sampler = createManagedOtelSampler(1);
    const ignored = sampler.shouldSample(
      ROOT_CONTEXT,
      "0123456789abcdef0123456789abcdef",
      "GET",
      SpanKind.SERVER,
      { "http.target": "/_next/static/chunks/app.js" },
      [],
    );
    const retained = sampler.shouldSample(
      ROOT_CONTEXT,
      "0123456789abcdef0123456789abcdef",
      "GET",
      SpanKind.SERVER,
      { "http.target": "/api/orders" },
      [],
    );

    expect(ignored.decision).toBe(SamplingDecision.NOT_RECORD);
    expect(retained.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it("drops orphan start-response lifecycle spans but keeps children", () => {
    const sampler = createManagedOtelSampler(1);
    const parentContext = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    });
    const root = sampler.shouldSample(
      ROOT_CONTEXT,
      "0123456789abcdef0123456789abcdef",
      "start response",
      SpanKind.INTERNAL,
      {
        "next.span_category": "nextjs",
        "next.span_type": "NextNodeServer.startResponse",
      },
      [],
    );
    const child = sampler.shouldSample(
      parentContext,
      "0123456789abcdef0123456789abcdef",
      "start response",
      SpanKind.INTERNAL,
      {
        "next.span_category": "nextjs",
        "next.span_type": "NextNodeServer.startResponse",
      },
      [],
    );

    expect(root.decision).toBe(SamplingDecision.NOT_RECORD);
    expect(child.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });
});

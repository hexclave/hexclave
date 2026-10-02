import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { isTracingSuppressed } from "@opentelemetry/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureInternalRequestError, isTelemetryIngestionPath, runWithInternalRequestObservability } from "./internal-observability";
import { resolveCustomerRequestObservability } from "./customer-request-observability";

const state = vi.hoisted(() => {
  const setData = vi.fn(async () => {});
  const end = vi.fn(async () => {});
  const addTrustedBackendSpanLink = vi.fn(async () => {});
  const trustedWriter = Symbol.for("hexclave.analytics.trusted-span-link-writer.v1");
  const span = {
    setData,
    end,
    run: vi.fn(async (fn: () => Promise<Response>) => await fn()),
    [trustedWriter]: addTrustedBackendSpanLink,
  };
  const startSpan = vi.fn(() => span);
  const captureHexclaveServerRequestError = vi.fn(async () => {});
  const runWithTelemetrySuppressed = vi.fn(async (fn: () => Promise<Response>) => await fn());
  const recordBackendRequestMetrics = vi.fn();
  return { addTrustedBackendSpanLink, captureHexclaveServerRequestError, end, recordBackendRequestMetrics, runWithTelemetrySuppressed, setData, span, startSpan };
});

vi.mock("@/hexclave", () => ({
  getHexclaveServerApp: () => ({ startSpan: state.startSpan }),
}));

vi.mock("@hexclave/js/otel", () => ({
  captureHexclaveServerRequestError: state.captureHexclaveServerRequestError,
}));

vi.mock("./node-telemetry-suppression", () => ({
  runWithNodeTelemetrySuppressed: state.runWithTelemetrySuppressed,
}));

vi.mock("./backend-request-metrics", () => ({
  recordBackendRequestMetrics: state.recordBackendRequestMetrics,
}));

describe("internal backend observability", () => {
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });

  afterAll(() => {
    context.disable();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HEXCLAVE_SELF_TELEMETRY_ENABLED", "true");
  });

  it("captures an unexpected smart-route failure with request-aware issue correlation", async () => {
    const error = new Error("query failed");
    const request = new Request("http://localhost:8102/api/v1/internal/sign-up-rules-stats?secret=never-record-this", { method: "GET" });

    await captureInternalRequestError(error, request, "request-error");

    expect(state.captureHexclaveServerRequestError).toHaveBeenCalledWith(expect.any(Object), error, {
      handled: false,
      mechanism: "hexclave.smart-route",
      request,
      data: {
        request_id: "request-error",
        method: "GET",
        path: "/api/v1/internal/sign-up-rules-stats",
      },
    });
  });

  it("does not recursively capture failures from telemetry ingestion", async () => {
    await captureInternalRequestError(
      new Error("telemetry failed"),
      new Request("http://localhost:8102/api/v1/analytics/otlp/v1/logs", { method: "POST" }),
      "request-telemetry",
    );

    expect(state.captureHexclaveServerRequestError).not.toHaveBeenCalled();
  });

  it.each([
    "/api/latest/analytics/events/batch",
    "/api/v1/analytics/events/batch",
    "/api/latest/analytics/envelope",
    "/api/v1/analytics/envelope",
    "/api/latest/analytics/otlp/v1/traces",
    "/api/v1/analytics/otlp/v1/traces",
    "/api/latest/analytics/otlp/v1/logs",
    "/api/v1/analytics/otlp/v1/logs",
    "/api/latest/analytics/otlp/v1/metrics",
    "/api/v1/analytics/otlp/v1/metrics",
    "/api/latest/analytics/client-reports",
    "/api/v1/analytics/client-reports",
    "/api/latest/analytics/attachments",
    "/api/v1/analytics/attachments",
    "/api/latest/session-replays/batch",
    "/api/v1/session-replays/batch",
  ])("recognizes the exact recursive ingestion path %s", (pathname) => {
    expect(isTelemetryIngestionPath(pathname)).toBe(true);
    expect(isTelemetryIngestionPath(`${pathname}/extra`)).toBe(false);
  });

  it("suppresses Prisma/OTel instrumentation while handling telemetry ingestion", async () => {
    const request = new Request("http://localhost:8102/api/v1/analytics/events/batch", { method: "POST" });
    let suppressed = false;
    const response = await runWithInternalRequestObservability(request, "request-1", async () => {
      suppressed = isTracingSuppressed(context.active());
      return new Response(null, { status: 202 });
    });

    expect(response.status).toBe(202);
    expect(suppressed).toBe(true);
    expect(state.runWithTelemetrySuppressed).toHaveBeenCalledOnce();
    expect(state.startSpan).not.toHaveBeenCalled();
    expect(state.recordBackendRequestMetrics).not.toHaveBeenCalled();
  });

  it("parents internal requests under the incoming sampled W3C client span", async () => {
    const request = new Request("http://localhost:8102/api/latest/users?secret=never-record-this", {
      method: "GET",
      headers: {
        traceparent: "00-0123456789abcdef0123456789abcdef-fedcba9876543210-01",
        "x-hexclave-project-id": "internal",
      },
    });
    const response = await runWithInternalRequestObservability(request, "request-2", async () => new Response(null, { status: 503 }));

    expect(response.status).toBe(503);
    expect(state.startSpan).toHaveBeenCalledWith("hexclave.api.request", {
      parent: {
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "fedcba9876543210",
        traceFlags: 1,
      },
      data: {
        request_id: "request-2",
        method: "GET",
        path: "/api/latest/users",
      },
    });
    expect(state.setData).toHaveBeenCalledWith({ status_code: 503, error: "HTTP 503" });
    expect(state.end).toHaveBeenCalledOnce();
    expect(state.recordBackendRequestMetrics).toHaveBeenCalledWith({
      durationMs: expect.any(Number),
      method: "GET",
      statusCode: 503,
    });
  });

  it("links the internal request span to the authenticated customer client span", async () => {
    const request = new Request("http://localhost:8102/api/latest/users", {
      method: "GET",
      headers: {
        traceparent: "00-0123456789abcdef0123456789abcdef-fedcba9876543210-01",
        "x-hexclave-project-id": "customer-project",
      },
    });
    await runWithInternalRequestObservability(request, "request-3", async () => {
      resolveCustomerRequestObservability({
        projectId: "customer-project",
        branchId: "main",
        userId: "user",
        refreshTokenId: "refresh",
        headers: request.headers,
      });
      return new Response(null, { status: 200 });
    });

    expect(state.addTrustedBackendSpanLink).toHaveBeenCalledWith({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "fedcba9876543210",
      linkedProjectId: "customer-project",
      linkedBranchId: "main",
    });
  });

  it("parents an internal-dashboard client span without adding a cross-project link", async () => {
    const request = new Request("http://localhost:8102/api/latest/users", {
      method: "GET",
      headers: {
        traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
        "x-hexclave-project-id": "internal",
      },
    });
    await runWithInternalRequestObservability(request, "request-internal", async () => {
      resolveCustomerRequestObservability({
        projectId: "internal",
        branchId: "main",
        userId: "user",
        refreshTokenId: "refresh",
        headers: request.headers,
      });
      return new Response(null, { status: 200 });
    });

    expect(state.startSpan).toHaveBeenCalledWith("hexclave.api.request", expect.objectContaining({
      parent: {
        traceId: "cccccccccccccccccccccccccccccccc",
        spanId: "dddddddddddddddd",
        traceFlags: 1,
      },
    }));
    expect(state.addTrustedBackendSpanLink).not.toHaveBeenCalled();
  });

  it("does not force an internal request to become a root when the wire has no parent", async () => {
    const request = new Request("http://localhost:8102/api/latest/internal/issues/reconciler", {
      method: "GET",
      headers: {
        "x-hexclave-project-id": "internal",
      },
    });

    await runWithInternalRequestObservability(request, "request-ambient", async () => new Response(null, { status: 200 }));

    expect(state.startSpan).toHaveBeenCalledWith("hexclave.api.request", {
      data: {
        request_id: "request-ambient",
        method: "GET",
        path: "/api/latest/internal/issues/reconciler",
      },
    });
  });

  it("preserves an unsampled internal parent so parent-based sampling can drop the request", async () => {
    const request = new Request("http://localhost:8102/api/latest/users", {
      method: "GET",
      headers: {
        traceparent: "00-0123456789abcdef0123456789abcdef-fedcba9876543210-00",
        "x-hexclave-project-id": "internal",
      },
    });

    await runWithInternalRequestObservability(request, "request-unsampled", async () => new Response(null, { status: 200 }));

    expect(state.startSpan).toHaveBeenCalledWith("hexclave.api.request", {
      parent: {
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "fedcba9876543210",
        traceFlags: 0,
      },
      data: {
        request_id: "request-unsampled",
        method: "GET",
        path: "/api/latest/users",
      },
    });
  });

  it("keeps customer requests as rooted internal spans with a verified link", async () => {
    const request = new Request("http://localhost:8102/api/latest/users", {
      method: "GET",
      headers: {
        traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
        "x-hexclave-project-id": "customer-project",
      },
    });
    await runWithInternalRequestObservability(request, "request-customer", async () => {
      resolveCustomerRequestObservability({
        projectId: "customer-project",
        branchId: "main",
        userId: "user",
        refreshTokenId: "refresh",
        headers: request.headers,
      });
      return new Response(null, { status: 200 });
    });

    expect(state.startSpan).toHaveBeenCalledWith("hexclave.api.request", expect.objectContaining({ root: true }));
    expect(state.addTrustedBackendSpanLink).toHaveBeenCalledWith({
      traceId: "cccccccccccccccccccccccccccccccc",
      spanId: "dddddddddddddddd",
      linkedProjectId: "customer-project",
      linkedBranchId: "main",
    });
  });

  it("keeps the verified customer link when the request handler throws", async () => {
    const request = new Request("http://localhost:8102/api/latest/users", {
      method: "GET",
      headers: {
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        "x-hexclave-project-id": "customer-project",
      },
    });

    await expect(runWithInternalRequestObservability(request, "request-4", async () => {
      resolveCustomerRequestObservability({
        projectId: "customer-project",
        branchId: "main",
        userId: "user",
        refreshTokenId: "refresh",
        headers: request.headers,
      });
      throw new Error("handler failed after authentication");
    })).rejects.toThrow("handler failed after authentication");

    expect(state.addTrustedBackendSpanLink).toHaveBeenCalledWith({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      linkedProjectId: "customer-project",
      linkedBranchId: "main",
    });
    expect(state.recordBackendRequestMetrics).toHaveBeenCalledWith({
      durationMs: expect.any(Number),
      method: "GET",
      statusCode: undefined,
    });
  });
});

import { getHexclaveServerApp } from "@/hexclave";
import type { Span, SpanContext } from "@hexclave/js";
import { captureHexclaveServerRequestError } from "@hexclave/js/otel";
import { getEnvBoolean } from "@hexclave/shared/dist/utils/env";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { context, isSpanContextValid, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { suppressTracing, W3CTraceContextPropagator } from "@opentelemetry/core";
import { recordBackendRequestMetrics } from "./backend-request-metrics";
import { getVerifiedCustomerRequestLinkTarget, runWithCustomerRequestObservability } from "./customer-request-observability";
import { runWithNodeTelemetrySuppressed } from "./node-telemetry-suppression";
import { isTelemetryIngestionPath } from "./telemetry/ingestion-paths";

export { isTelemetryIngestionPath } from "./telemetry/ingestion-paths";

const TRUSTED_SPAN_LINK_WRITER = Symbol.for("hexclave.analytics.trusted-span-link-writer.v1");
const traceContextPropagator = new W3CTraceContextPropagator();

function isInternalProjectRequest(request: Request): boolean {
  return (request.headers.get("x-hexclave-project-id") ?? request.headers.get("x-stack-project-id")) === "internal";
}

export async function captureInternalRequestError(error: unknown, request: Request, requestId: string): Promise<void> {
  const pathname = new URL(request.url).pathname;
  if (!getEnvBoolean("HEXCLAVE_SELF_TELEMETRY_ENABLED") || isTelemetryIngestionPath(pathname)) return;

  await captureHexclaveServerRequestError(getHexclaveServerApp(), error, {
    handled: false,
    mechanism: "hexclave.smart-route",
    request,
    data: {
      request_id: requestId,
      method: request.method,
      path: pathname,
    },
  });
}

function getIncomingParent(request: Request): SpanContext | null {
  const extractedContext = traceContextPropagator.extract(ROOT_CONTEXT, request.headers, {
    keys: () => ["traceparent", "tracestate"],
    get: (carrier, key) => carrier.get(key) ?? undefined,
  });
  const incoming = trace.getSpanContext(extractedContext);
  if (
    incoming === undefined
    || !isSpanContextValid(incoming)
  ) return null;

  return {
    traceId: incoming.traceId,
    spanId: incoming.spanId,
    traceFlags: incoming.traceFlags,
    ...incoming.traceState === undefined ? {} : { traceState: incoming.traceState.serialize() },
  };
}

function addTrustedBackendSpanLink(span: Span, link: {
  traceId: string,
  spanId: string,
  projectId: string,
  branchId: string,
}): Promise<void> {
  if (!(TRUSTED_SPAN_LINK_WRITER in span)) {
    throw new Error("The internal request span does not support trusted target-scoped links");
  }
  const writer = span[TRUSTED_SPAN_LINK_WRITER];
  if (typeof writer !== "function") {
    throw new Error("The internal request span has an invalid trusted-link writer");
  }
  return writer({
    traceId: link.traceId,
    spanId: link.spanId,
    linkedProjectId: link.projectId,
    linkedBranchId: link.branchId,
  });
}

export async function runWithInternalRequestObservability(
  request: Request,
  requestId: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  const requestPath = new URL(request.url).pathname;
  return await runWithCustomerRequestObservability(request, async () => {
    if (isTelemetryIngestionPath(requestPath)) {
      return await runWithNodeTelemetrySuppressed(
        async () => await context.with(suppressTracing(context.active()), fn),
      );
    }

    const internalProjectRequest = isInternalProjectRequest(request);
    const incomingParent = internalProjectRequest ? getIncomingParent(request) : null;
    const span = getHexclaveServerApp().startSpan("hexclave.api.request", {
      ...internalProjectRequest
        ? incomingParent === null ? {} : { parent: incomingParent }
        : { root: true },
      data: {
        request_id: requestId,
        method: request.method,
        path: requestPath,
      },
    });
    const startedAt = performance.now();
    let statusCode: number | undefined;
    return await span.run(async () => {
      try {
        const response = await fn();
        statusCode = response.status;
        runAsynchronously(span.setData({
          status_code: response.status,
          ...response.status >= 500 ? { error: `HTTP ${response.status}` } : {},
        }), { noErrorLogging: true });
        return response;
      } catch (error) {
        runAsynchronously(span.setData({
          error: error instanceof Error ? error.message : String(error),
        }), { noErrorLogging: true });
        throw error;
      } finally {
        recordBackendRequestMetrics({
          durationMs: performance.now() - startedAt,
          method: request.method,
          statusCode,
        });
        const clientLink = internalProjectRequest ? null : getVerifiedCustomerRequestLinkTarget();
        if (clientLink !== null) {
          runAsynchronously(addTrustedBackendSpanLink(span, clientLink), { noErrorLogging: true });
        }
        runAsynchronously(span.end(), { noErrorLogging: true });
      }
    });
  });
}

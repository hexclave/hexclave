import { hexclaveServerApp } from "../../../../hexclave";

export const runtime = "nodejs";

const SERVER_TELEMETRY_ERROR_MESSAGE = "Hexclave observability demo: server operation failed";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function getDelayMs(request: Request): number {
  const rawDelay = Number(new URL(request.url).searchParams.get("delay") ?? 0);
  if (!Number.isFinite(rawDelay)) return 0;
  return Math.min(Math.max(Math.round(rawDelay), 0), 1200);
}

export async function POST(request: Request): Promise<Response> {
  const shouldFail = new URL(request.url).searchParams.get("failure") === "1";
  const delayMs = getDelayMs(request);

  return await hexclaveServerApp.withSpan("demo.http.request", {
    request,
    data: {
      route: "/error-tracking-demo/api/telemetry",
      method: "POST",
      delay_ms: delayMs,
    },
  }, async (requestSpan) => {
    await requestSpan.trackEvent("demo.server.operation.started", {
      failure_requested: shouldFail,
      delay_ms: delayMs,
    });
    hexclaveServerApp.logger.info("demo server operation started", {
      route: "observability-demo",
      failure_requested: shouldFail,
    });

    await requestSpan.withSpan("demo.database.lookup", {
      data: { table: "demo_orders", rows: 3 },
    }, async (databaseSpan) => {
      await databaseSpan.setData({ result: "demo fixture" });
      hexclaveServerApp.logger.debug("demo database lookup complete", {
        rows: 3,
      });
    });
    const cacheSpan = hexclaveServerApp.startSpan("demo.cache.read", {
      data: { key: "demo-order-001", hit: true },
    });
    await cacheSpan.trackEvent("demo.cache.hit", { key: "demo-order-001" });
    await cacheSpan.end();
    await hexclaveServerApp.trackEvent("demo.server.bare.event", {
      route: "observability-demo",
      request_scope: true,
    }, { request });

    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }

    if (shouldFail) {
      const error = new Error(SERVER_TELEMETRY_ERROR_MESSAGE);
      error.name = "HexclaveDemoServerTelemetryError";
      hexclaveServerApp.captureException(error, {
        handled: true,
        mechanism: "demo.server.telemetry",
        tags: {
          demo: "observability",
          outcome: "failure",
        },
      });
      hexclaveServerApp.logger.error("demo server operation failed", {
        route: "observability-demo",
        failure: true,
      });
      await requestSpan.setData({ outcome: "error" });
      return Response.json({
        ok: false,
        message: SERVER_TELEMETRY_ERROR_MESSAGE,
        traceId: requestSpan.traceId,
        spanId: requestSpan.spanId,
      }, { status: 500, headers: NO_STORE_HEADERS });
    }

    await requestSpan.trackEvent("demo.server.operation.completed", {
      outcome: "success",
      delay_ms: delayMs,
    });
    hexclaveServerApp.logger.info("demo server operation completed", {
      route: "observability-demo",
      delay_ms: delayMs,
    });
    await requestSpan.setData({ outcome: "success" });

    return Response.json({
      ok: true,
      traceId: requestSpan.traceId,
      spanId: requestSpan.spanId,
      spanType: requestSpan.spanType,
      delayMs,
    }, { headers: NO_STORE_HEADERS });
  });
}

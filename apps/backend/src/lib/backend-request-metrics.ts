import { metrics, type Attributes } from "@opentelemetry/api";
import backendPackageJson from "../../package.json";

const meter = metrics.getMeter("@hexclave/backend-http", backendPackageJson.version);
const requestCount = meter.createCounter("hexclave.http.server.request.count", {
  description: "Number of HTTP requests handled by the Hexclave backend",
  unit: "{request}",
});
const requestDuration = meter.createHistogram("hexclave.http.server.request.duration", {
  description: "Duration of HTTP requests handled by the Hexclave backend",
  unit: "s",
});

function normalizeMethod(method: string): string {
  return /^[A-Za-z]{1,16}$/u.test(method) ? method.toUpperCase() : "_OTHER";
}

export function recordBackendRequestMetrics(options: {
  durationMs: number,
  method: string,
  statusCode: number | undefined,
}): void {
  const attributes: Attributes = {
    "http.request.method": normalizeMethod(options.method),
    ...options.statusCode === undefined ? {} : {
      "http.response.status_code": options.statusCode,
    },
  };
  requestCount.add(1, attributes);
  requestDuration.record(Math.max(0, options.durationMs) / 1_000, attributes);
}

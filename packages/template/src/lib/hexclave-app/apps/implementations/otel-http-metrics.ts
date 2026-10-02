import { SpanKind, SpanStatusCode, type Attributes, type HrTime, type Meter } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

export type HttpClientMetricSpan = {
  kind: SpanKind,
  attributes: Attributes,
  duration: HrTime,
  status: { code: SpanStatusCode },
};

const OTHER_METHOD = "_OTHER";

function stringAttribute(attributes: Attributes, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === "string" ? value : undefined;
}

function numberAttribute(attributes: Attributes, key: string): number | undefined {
  const value = attributes[key];
  return typeof value === "number" ? value : undefined;
}

function normalizeMethod(method: string): string {
  if (!/^[A-Za-z]{1,16}$/u.test(method)) return OTHER_METHOD;
  return method.toUpperCase();
}

function normalizedStatusCode(statusCode: number | undefined): number | undefined {
  if (statusCode === undefined || !Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599) return undefined;
  return statusCode;
}

function normalizedErrorType(errorType: string | undefined): string | undefined {
  if (errorType === undefined || errorType.length === 0) return undefined;
  return /^[A-Za-z0-9_.:-]{1,64}$/u.test(errorType) ? errorType : "error";
}

function durationSeconds(duration: HrTime): number {
  return Math.max(0, duration[0] + duration[1] / 1e9);
}

function httpClientMetricAttributes(span: HttpClientMetricSpan): Attributes | null {
  if (span.kind !== SpanKind.CLIENT) return null;
  const method = stringAttribute(span.attributes, "http.request.method")
    ?? stringAttribute(span.attributes, "http.method");
  if (method === undefined) return null;

  const statusCode = numberAttribute(span.attributes, "http.response.status_code")
    ?? numberAttribute(span.attributes, "http.status_code");
  const errorType = stringAttribute(span.attributes, "error.type")
    ?? (span.status.code === SpanStatusCode.ERROR ? "error" : undefined);
  const attributes: Attributes = {
    "http.request.method": normalizeMethod(method),
  };
  const normalizedStatus = normalizedStatusCode(statusCode);
  if (normalizedStatus !== undefined) attributes["http.response.status_code"] = normalizedStatus;
  const normalizedError = normalizedErrorType(errorType);
  if (normalizedError !== undefined) attributes["error.type"] = normalizedError;
  return attributes;
}

export type HexclaveHttpMetricSpanProcessor = SpanProcessor & {
  record(span: HttpClientMetricSpan): void,
};

/**
 * Spanmetrics-style HTTP client metrics: observations come from recorded
 * CLIENT spans, not from HTTP instrumentation hooks. `SpanProcessor.onEnd`
 * only runs for recording spans, so head-sampled-out requests do not produce
 * metrics — the same contract as a Collector spanmetrics connector.
 */
export function createHexclaveHttpMetricSpanProcessor(meter: Meter): HexclaveHttpMetricSpanProcessor {
  let requestCount: ReturnType<Meter["createCounter"]> | null = null;
  let requestDuration: ReturnType<Meter["createHistogram"]> | null = null;
  const record = (span: HttpClientMetricSpan): void => {
    const attributes = httpClientMetricAttributes(span);
    if (attributes === null) return;
    requestCount ??= meter.createCounter("hexclave.http.client.request.count", {
      description: "Number of outbound HTTP requests observed by the Hexclave SDK",
      unit: "{request}",
    });
    requestDuration ??= meter.createHistogram("hexclave.http.client.request.duration", {
      description: "Duration of outbound HTTP requests observed by the Hexclave SDK",
      unit: "s",
    });
    requestCount.add(1, attributes);
    requestDuration.record(durationSeconds(span.duration), attributes);
  };

  return {
    onStart(): void {},
    onEnd(span: ReadableSpan): void {
      record(span);
    },
    record,
    async shutdown(): Promise<void> {},
    async forceFlush(): Promise<void> {},
  };
}

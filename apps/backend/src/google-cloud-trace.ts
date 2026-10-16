import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { Context, ROOT_CONTEXT } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, ReadableSpan, SamplingDecision, Span, SpanExporter, SpanProcessor, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import * as Sentry from "@sentry/node";
import type { GoogleCloudTracePlan } from "./instrumentation-plan";

// Google's OTLP ingestion endpoint for Cloud Trace. It accepts OTLP/HTTP JSON
// (what OTLPTraceExporter sends) and requires a Google OAuth access token plus
// a gcp.project_id resource attribute on every span.
const googleTelemetryTracesUrl = "https://telemetry.googleapis.com/v1/traces";
const metadataServerTokenUrl = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const accessTokenRefreshMarginMs = 5 * 60 * 1000;

export function createGoogleCloudTraceSpanProcessor(plan: GoogleCloudTracePlan): SpanProcessor {
  const getAccessToken = createMetadataServerAccessTokenProvider();
  const exporter = new OTLPTraceExporter({
    url: googleTelemetryTracesUrl,
    headers: async () => ({
      Authorization: `Bearer ${await getAccessToken()}`,
      "x-goog-user-project": plan.projectId,
    }),
  });
  const batchProcessor = new BatchSpanProcessor(new ErrorReportingSpanExporter(exporter));
  return plan.spanProcessorSampleRate >= 1
    ? batchProcessor
    : new TraceIdRatioFilteringSpanProcessor(plan.spanProcessorSampleRate, batchProcessor);
}

/**
 * Forwards only spans whose trace ID falls into the configured ratio. Sentry owns
 * the global sampler, which may sample more than we want to pay Cloud Trace for
 * (e.g. everything, when Sentry is disabled but Cloud Trace is not), so this
 * sampling has to happen per processor rather than in the provider.
 * Deciding on the trace ID (instead of randomly per span) keeps every span of a
 * sampled trace together, and matches what other services using the standard
 * TraceIdRatioBasedSampler would decide for the same trace.
 */
export class TraceIdRatioFilteringSpanProcessor implements SpanProcessor {
  private readonly sampler: TraceIdRatioBasedSampler;

  constructor(sampleRate: number, private readonly inner: SpanProcessor) {
    this.sampler = new TraceIdRatioBasedSampler(sampleRate);
  }

  private isSampled(span: Span | ReadableSpan): boolean {
    return this.sampler.shouldSample(ROOT_CONTEXT, span.spanContext().traceId).decision === SamplingDecision.RECORD_AND_SAMPLED;
  }

  onStart(span: Span, parentContext: Context): void {
    if (this.isSampled(span)) {
      this.inner.onStart(span, parentContext);
    }
  }

  onEnd(span: ReadableSpan): void {
    if (this.isSampled(span)) {
      this.inner.onEnd(span);
    }
  }

  async forceFlush(): Promise<void> {
    await this.inner.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }
}

/**
 * OpenTelemetry reports export failures only through its diag logger, which is
 * a no-op unless configured, so a broken token or revoked permission would
 * otherwise silently drop every trace.
 */
class ErrorReportingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.inner.export(spans, (result) => {
      if (result.error != null) {
        captureError("google-cloud-trace-export", result.error);
      }
      resultCallback(result);
    });
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    await this.inner.forceFlush?.();
  }
}

function createMetadataServerAccessTokenProvider(): () => Promise<string> {
  let cached: { accessToken: string, expiresAtPerformanceMs: number } | undefined;
  let inFlight: Promise<string> | undefined;
  return async () => {
    if (cached != null && performance.now() < cached.expiresAtPerformanceMs - accessTokenRefreshMarginMs) {
      return cached.accessToken;
    }
    inFlight ??= (async () => {
      try {
        cached = await fetchMetadataServerAccessToken();
        return cached.accessToken;
      } finally {
        inFlight = undefined;
      }
    })();
    return await inFlight;
  };
}

async function fetchMetadataServerAccessToken() {
  const requestedAtPerformanceMs = performance.now();
  // Without suppression, the instrumented fetch would create a span for every
  // token refresh, which would itself be exported to Cloud Trace.
  const response = await Sentry.suppressTracing(async () => await fetch(metadataServerTokenUrl, {
    headers: { "Metadata-Flavor": "Google" },
  }));
  if (!response.ok) {
    throw new HexclaveAssertionError(`Google Cloud metadata server returned ${response.status} for the service account access token. Cloud Trace export only works on Google Cloud runtimes (e.g. Cloud Run).`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" || body == null
    || !("access_token" in body) || typeof body.access_token !== "string"
    || !("expires_in" in body) || typeof body.expires_in !== "number"
  ) {
    throw new HexclaveAssertionError("Google Cloud metadata server returned an unexpected access token response shape");
  }
  return {
    accessToken: body.access_token,
    expiresAtPerformanceMs: requestedAtPerformanceMs + body.expires_in * 1000,
  };
}

import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { sentryBaseConfig } from "@hexclave/shared/dist/utils/sentry";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, NoopSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import * as Sentry from "@sentry/node";
import backendPackageJson from "../package.json";
import { createBackendInstrumentationPlan } from "./instrumentation-plan";
import { initPerfStats } from "./lib/dev-perf-stats";
import { getSentryRelease } from "./sentry-release";
import { prepareBackendSentryEvent, sanitizeBackendSentrySpan } from "./sentry-scrubbing";

globalThis.global = globalThis;
// The Elysia process is the Node runtime; set the marker before shared helpers that still ask for Next runtime metadata.
// eslint-disable-next-line no-restricted-syntax
process.env.NEXT_RUNTIME ??= "nodejs";

let registered = false;

export function registerBackendInstrumentation() {
  if (registered) {
    return;
  }
  registered = true;

  const portPrefix = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81");
  const nodeEnvironment = getNodeEnvironment();
  const sentryDsn = getEnvVariable("NEXT_PUBLIC_SENTRY_DSN", "");
  const plan = createBackendInstrumentationPlan({
    ci: getEnvVariable("CI", ""),
    nodeEnvironment,
    otlpEndpoint: getEnvVariable("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
    otlpTracesEndpoint: getEnvVariable("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", ""),
    portPrefix,
    sentryDsn,
    sentryTracesSampleRate: sentryBaseConfig.tracesSampleRate,
  });
  const openTelemetrySpanProcessors = plan.otlpTracesEndpoint == null
    ? plan.sentryEnabled ? [] : [new NoopSpanProcessor()]
    : [new BatchSpanProcessor(new OTLPTraceExporter({ url: plan.otlpTracesEndpoint }))];
  const openTelemetryInstrumentations = plan.sentryEnabled || plan.otlpTracesEndpoint == null
    ? []
    : [
      new PrismaInstrumentation(),
      ...getNodeAutoInstrumentations(),
    ];

  process.title = `stack-backend:${portPrefix} (node/elysia)`;
  initPerfStats();

  // Sentry owns the one global OpenTelemetry provider in every environment.
  // When Sentry is disabled but an OTLP destination exists, register the Node and
  // Prisma instrumentations explicitly. With no exporter, the no-op processor keeps
  // request context available without paying to patch every instrumented library.
  Sentry.init({
    ignoreErrors: sentryBaseConfig.ignoreErrors,
    normalizeDepth: sentryBaseConfig.normalizeDepth,
    maxValueLength: sentryBaseConfig.maxValueLength,
    debug: sentryBaseConfig.debug,
    tracesSampleRate: plan.tracesSampleRate,
    openTelemetryInstrumentations,
    openTelemetrySpanProcessors,
    dsn: sentryDsn,
    enabled: plan.sentryEnabled,
    sendDefaultPii: false,
    includeLocalVariables: false,
    environment: getEnvVariable("VERCEL_ENV", nodeEnvironment),
    release: getSentryRelease({
      packageName: backendPackageJson.name,
      packageVersion: backendPackageJson.version,
    }),
    beforeSend: prepareBackendSentryEvent,
    beforeSendSpan: sanitizeBackendSentrySpan,
    beforeSendTransaction: prepareBackendSentryEvent,
  });
}

export async function closeBackendInstrumentation(timeoutMs = 2000): Promise<void> {
  // Sentry shuts down its provider and every additional span processor passed
  // above, so there is only one lifecycle to flush during graceful shutdown.
  if (!await Sentry.close(timeoutMs)) {
    throw new Error(`Backend instrumentation did not close within ${timeoutMs}ms`);
  }
}

registerBackendInstrumentation();

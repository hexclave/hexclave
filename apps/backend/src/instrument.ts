import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { sentryBaseConfig } from "@hexclave/shared/dist/utils/sentry";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import * as Sentry from "@sentry/node";
import backendPackageJson from "../package.json";
import { getHexclaveServerApp } from "./hexclave";
import { createBackendInstrumentationPlan } from "./instrumentation-plan";
import { initPerfStats } from "./lib/dev-perf-stats";
import { isNodeTelemetrySuppressed, registerNodeTelemetrySuppressionRunner } from "./lib/node-telemetry-suppression";
import { getSentryRelease } from "./sentry-release";
import { prepareBackendSentryEvent, sanitizeBackendSentrySpan } from "./sentry-scrubbing";

globalThis.global = globalThis;
// The Elysia process is the Node runtime; set the marker before shared helpers that still ask for Next runtime metadata.
// eslint-disable-next-line no-restricted-syntax
process.env.NEXT_RUNTIME ??= "nodejs";

let registered = false;
let disableBackendInstrumentations: (() => void) | null = null;

function hasTelemetrySuppressionSetter(value: object): value is object & {
  _setTelemetrySuppressionPredicate(predicate: (() => boolean) | null): void,
} {
  return "_setTelemetrySuppressionPredicate" in value
    && typeof value._setTelemetrySuppressionPredicate === "function";
}

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

  process.title = `stack-backend:${portPrefix} (node/elysia)`;
  initPerfStats();

  const hexclaveServerApp = getHexclaveServerApp();
  if (!hasTelemetrySuppressionSetter(hexclaveServerApp)) {
    throw new Error("The backend Hexclave server app does not expose telemetry suppression registration");
  }
  hexclaveServerApp._setTelemetrySuppressionPredicate(isNodeTelemetrySuppressed);

  disableBackendInstrumentations = registerInstrumentations({
    instrumentations: [new PrismaInstrumentation()],
  });

  Sentry.init({
    ignoreErrors: sentryBaseConfig.ignoreErrors,
    normalizeDepth: sentryBaseConfig.normalizeDepth,
    maxValueLength: sentryBaseConfig.maxValueLength,
    debug: sentryBaseConfig.debug,
    tracesSampleRate: 0,
    skipOpenTelemetrySetup: true,
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

  registerNodeTelemetrySuppressionRunner(
    async (fn) => await context.with(suppressTracing(context.active()), fn),
  );
}

export async function closeBackendInstrumentation(timeoutMs = 2000): Promise<void> {
  disableBackendInstrumentations?.();
  disableBackendInstrumentations = null;
  const [, sentryClosed] = await Promise.all([
    getHexclaveServerApp().flush(),
    Sentry.close(timeoutMs),
  ]);
  if (!sentryClosed) {
    throw new Error(`Backend instrumentation did not close within ${timeoutMs}ms`);
  }
}

registerBackendInstrumentation();

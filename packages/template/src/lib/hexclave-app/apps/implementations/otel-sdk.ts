import { context, metrics, propagation, trace, type Context, type Span } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_NAMESPACE, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { HEXCLAVE_PAGE_VIEW_SPAN_ID_BAGGAGE_KEY, HEXCLAVE_SESSION_REPLAY_ID_BAGGAGE_KEY, HEXCLAVE_SESSION_REPLAY_SEGMENT_ID_BAGGAGE_KEY } from "@hexclave/shared/dist/utils/span-context-codec";
import { ignoreUnhandledRejection } from "@hexclave/shared/dist/utils/promises";
import type { ManagedOtelOptions, ManagedOtelRegistration } from "./otel-managed";
import { createManagedOtelSampler } from "./otel-span-policy";
import { createHexclaveHttpMetricSpanProcessor } from "./otel-http-metrics";

export type {
  HexclaveOtelResource,
  ManagedOtelOptions,
  ManagedOtelRegistration,
} from "./otel-managed";
export {
  isOtelTracingSuppressed,
  runWithOtelTracingSuppressed,
} from "./otel-managed";
export { createHexclaveHttpMetricSpanProcessor };

const OTLP_TRACES_PATH = "/api/v1/analytics/otlp/v1/traces";
const OTLP_LOGS_PATH = "/api/v1/analytics/otlp/v1/logs";
const OTLP_METRICS_PATH = "/api/v1/analytics/otlp/v1/metrics";
const OTLP_METRIC_EXPORT_INTERVAL_MS = 60_000;
const CORRELATION_BAGGAGE_KEYS = [
  HEXCLAVE_SESSION_REPLAY_ID_BAGGAGE_KEY,
  HEXCLAVE_SESSION_REPLAY_SEGMENT_ID_BAGGAGE_KEY,
  HEXCLAVE_PAGE_VIEW_SPAN_ID_BAGGAGE_KEY,
] as const;

class HexclaveCorrelationSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const baggage = propagation.getBaggage(parentContext);
    for (const key of CORRELATION_BAGGAGE_KEYS) {
      const value = baggage?.getEntry(key)?.value;
      if (value !== undefined) span.setAttribute(key, value);
    }
  }

  onEnd(_span: ReadableSpan): void {}
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

export type HexclaveOtelExporterOptions = Pick<ManagedOtelOptions, "analyticsBaseUrl" | "projectId" | "secretServerKey" | "clientVersion">;

export function buildHexclaveOtlpTraceExporterConfig(options: HexclaveOtelExporterOptions): {
  url: string,
  headers: Record<string, string>,
} {
  return {
    url: new URL(OTLP_TRACES_PATH, options.analyticsBaseUrl).toString(),
    headers: {
      "x-hexclave-project-id": options.projectId,
      "x-hexclave-access-type": "server",
      "x-hexclave-client-version": options.clientVersion,
      "x-hexclave-secret-server-key": options.secretServerKey,
    },
  };
}

export function buildHexclaveOtlpLogExporterConfig(options: HexclaveOtelExporterOptions): {
  url: string,
  headers: Record<string, string>,
} {
  return {
    ...buildHexclaveOtlpTraceExporterConfig(options),
    url: new URL(OTLP_LOGS_PATH, options.analyticsBaseUrl).toString(),
  };
}

export function buildHexclaveOtlpMetricExporterConfig(options: HexclaveOtelExporterOptions): {
  url: string,
  headers: Record<string, string>,
} {
  return {
    ...buildHexclaveOtlpTraceExporterConfig(options),
    url: new URL(OTLP_METRICS_PATH, options.analyticsBaseUrl).toString(),
  };
}

/** Exporter for applications that already own their OTel TracerProvider. */
export function createHexclaveOtlpTraceExporter(options: HexclaveOtelExporterOptions): OTLPTraceExporter {
  return new OTLPTraceExporter(buildHexclaveOtlpTraceExporterConfig(options));
}

/** Log exporter for applications that already own their OTel LoggerProvider. */
export function createHexclaveOtlpLogExporter(options: HexclaveOtelExporterOptions): OTLPLogExporter {
  return new OTLPLogExporter(buildHexclaveOtlpLogExporterConfig(options));
}

/** Metric exporter for applications that already own their OTel MeterProvider. */
export function createHexclaveOtlpMetricExporter(options: HexclaveOtelExporterOptions): OTLPMetricExporter {
  return new OTLPMetricExporter(buildHexclaveOtlpMetricExporterConfig(options));
}

/** Copies allowlisted Hexclave baggage into exported span attributes. */
export function createHexclaveCorrelationSpanProcessor(): SpanProcessor {
  return new HexclaveCorrelationSpanProcessor();
}

function adoptExistingGlobals(): ManagedOtelRegistration {
  return {
    provider: trace.getTracerProvider(),
    loggerProvider: logs.getLoggerProvider(),
    meterProvider: metrics.getMeterProvider(),
    forceFlush: async () => {},
    shutdown: async () => {},
  };
}

function cacheAdoptedRegistration(signature: string, value: ManagedOtelRegistration): ManagedOtelRegistration {
  managedRegistration = {
    signature,
    value,
    installInstrumentations: () => {},
  };
  return value;
}

function shouldAdoptExistingProvider(options: ManagedOtelOptions): boolean {
  return options.existingProviderConflict === "adopt";
}

let managedRegistration: {
  signature: string,
  value: ManagedOtelRegistration,
  installInstrumentations: (instrumentations: NonNullable<ManagedOtelOptions["instrumentations"]>) => void,
} | null = null;

/**
 * Next can compile the instrumentation and SSR graphs with different local
 * API URL spellings. They still target the same development service, so the
 * process-wide provider identity must not treat loopback aliases as separate
 * exporters. Keep the actual exporter URL unchanged; this is only an
 * ownership comparison.
 */
function canonicalizeRegistrationUrl(url: string): string {
  const parsed = new URL(url);
  switch (parsed.hostname) {
    case "localhost":
    case "127.0.0.1":
    case "[::1]": {
      parsed.hostname = "loopback";
      break;
    }
    default: {
      break;
    }
  }
  return parsed.toString();
}

function registrationSignature(options: ManagedOtelOptions): string {
  const exporter = buildHexclaveOtlpTraceExporterConfig(options);
  return JSON.stringify({
    url: canonicalizeRegistrationUrl(exporter.url),
    projectId: options.projectId,
    serviceName: options.resource.serviceName,
    serviceNamespace: options.resource.serviceNamespace,
    serviceVersion: options.resource.serviceVersion,
    traceSampleRate: options.traceSampleRate,
  });
}

/**
 * Installs Hexclave's managed Node SDK exactly once. Managed mode treats a
 * pre-existing global as a configuration error. Auto mode (`adopt`) uses the
 * host provider instead of throwing, including when the host registers after
 * construction but before this function runs.
 */
export function registerManagedOtel(options: ManagedOtelOptions): ManagedOtelRegistration {
  const signature = registrationSignature(options);
  if (managedRegistration !== null) {
    if (managedRegistration.signature !== signature) {
      throw new Error("Hexclave OpenTelemetry is already configured for a different project or service in this process");
    }
    managedRegistration.installInstrumentations(options.instrumentations ?? []);
    return managedRegistration.value;
  }

  const exporter = createHexclaveOtlpTraceExporter(options);
  const metricExporter = createHexclaveOtlpMetricExporter(options);
  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: options.resource.serviceName,
  };
  if (options.resource.serviceNamespace !== undefined) {
    attributes[ATTR_SERVICE_NAMESPACE] = options.resource.serviceNamespace;
  }
  if (options.resource.serviceVersion !== undefined) {
    attributes[ATTR_SERVICE_VERSION] = options.resource.serviceVersion;
  }
  const resource = resourceFromAttributes(attributes);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: OTLP_METRIC_EXPORT_INTERVAL_MS,
  });
  const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
  const provider = new NodeTracerProvider({
    resource,
    sampler: createManagedOtelSampler(options.traceSampleRate),
    spanProcessors: [
      createHexclaveCorrelationSpanProcessor(),
      createHexclaveHttpMetricSpanProcessor(meterProvider.getMeter("@hexclave/node-http", options.clientVersion)),
      new BatchSpanProcessor(exporter),
    ],
  });

  // The rollback paths below only ever disable globals THIS call successfully
  // installed: a pre-existing host-owned global makes the corresponding set*
  // call return false (the OTel API refuses to overwrite), which throws BEFORE
  // the matching disable() is ever reached. disable() resets a slot to the
  // API's noop default — exactly the pre-install state, since our install
  // succeeding proves nothing else was registered in that slot.
  if (!trace.setGlobalTracerProvider(provider)) {
    ignoreUnhandledRejection(meterProvider.shutdown());
    ignoreUnhandledRejection(provider.shutdown());
    if (shouldAdoptExistingProvider(options)) {
      return cacheAdoptedRegistration(signature, adoptExistingGlobals());
    }
    throw new Error("Hexclave could not install its managed OpenTelemetry provider because another global tracer provider is already registered. Configure that provider with Hexclave's OTLP endpoint instead of enabling managed mode.");
  }
  const contextManager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(contextManager)) {
    ignoreUnhandledRejection(meterProvider.shutdown());
    ignoreUnhandledRejection(provider.shutdown());
    trace.disable();
    contextManager.disable();
    throw new Error("Hexclave installed its tracer provider but could not install the OpenTelemetry async context manager because another manager is already registered");
  }
  const propagator = new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  });
  if (!propagation.setGlobalPropagator(propagator)) {
    ignoreUnhandledRejection(meterProvider.shutdown());
    ignoreUnhandledRejection(provider.shutdown());
    trace.disable();
    context.disable();
    contextManager.disable();
    throw new Error("Hexclave installed its tracer provider but could not install the W3C trace context and baggage propagator because another propagator is already registered");
  }

  if (!metrics.setGlobalMeterProvider(meterProvider)) {
    ignoreUnhandledRejection(meterProvider.shutdown());
    ignoreUnhandledRejection(provider.shutdown());
    trace.disable();
    context.disable();
    propagation.disable();
    contextManager.disable();
    throw new Error("Hexclave installed its managed OpenTelemetry tracer but could not install its managed MeterProvider because another global meter provider is already registered. Configure that provider with Hexclave's OTLP endpoint instead of enabling managed mode.");
  }

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: createHexclaveOtlpLogExporter(options) })],
  });
  if (logs.setGlobalLoggerProvider(loggerProvider) !== loggerProvider) {
    ignoreUnhandledRejection(loggerProvider.shutdown());
    ignoreUnhandledRejection(meterProvider.shutdown());
    ignoreUnhandledRejection(provider.shutdown());
    metrics.disable();
    trace.disable();
    context.disable();
    propagation.disable();
    contextManager.disable();
    throw new Error("Hexclave installed its tracer provider but could not install its managed OpenTelemetry LoggerProvider because another global logger provider is already registered");
  }

  const httpInstrumentation = new UndiciInstrumentation({
    ignoreRequestHook: (request) => options.shouldInstrumentOutboundRequest?.(new URL(request.path, request.origin).toString()) === false,
  });
  const installedInstrumentationNames = new Set<string>();
  const instrumentationDisposers: (() => void)[] = [];
  const installInstrumentations = (instrumentations: NonNullable<ManagedOtelOptions["instrumentations"]>): void => {
    const requestedNames = new Set<string>();
    const missing = instrumentations.filter((instrumentation) => {
      if (installedInstrumentationNames.has(instrumentation.instrumentationName) || requestedNames.has(instrumentation.instrumentationName)) return false;
      requestedNames.add(instrumentation.instrumentationName);
      return true;
    });
    if (missing.length === 0) return;
    for (const instrumentation of missing) {
      instrumentationDisposers.push(registerInstrumentations({
        instrumentations: [instrumentation],
        tracerProvider: provider,
      }));
      installedInstrumentationNames.add(instrumentation.instrumentationName);
    }
  };
  installInstrumentations([httpInstrumentation, ...options.instrumentations ?? []]);
  const value: ManagedOtelRegistration = {
    provider,
    loggerProvider,
    meterProvider,
    forceFlush: async () => {
      await Promise.all([provider.forceFlush(), loggerProvider.forceFlush(), meterProvider.forceFlush(), metricExporter.forceFlush()]);
    },
    shutdown: async () => {
      for (const dispose of instrumentationDisposers) dispose();
      instrumentationDisposers.length = 0;
      await Promise.all([provider.shutdown(), loggerProvider.shutdown(), meterProvider.shutdown()]);
      contextManager.disable();
    },
  };
  managedRegistration = { signature, value, installInstrumentations };
  return value;
}

/** Test-only global cleanup; production registrations intentionally live for the process lifetime. */
export async function resetManagedOtelForTesting(): Promise<void> {
  if (managedRegistration !== null) await managedRegistration.value.shutdown();
  managedRegistration = null;
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
  logs.disable();
}

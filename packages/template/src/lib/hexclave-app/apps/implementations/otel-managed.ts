import { context, type MeterProvider, type TracerProvider } from "@opentelemetry/api";
import { type LoggerProvider as ApiLoggerProvider } from "@opentelemetry/api-logs";
import { isTracingSuppressed, suppressTracing } from "@opentelemetry/core";
import type { Instrumentation } from "@opentelemetry/instrumentation";

/**
 * Browser-safe OTel helpers and managed-registration types.
 *
 * The real Node TracerProvider / Undici / async_hooks graph lives in
 * `otel-sdk.ts` and must never be statically imported from modules that the
 * client SDK barrel can reach (StackProvider → StackServerApp → server-app-impl).
 */

export type HexclaveOtelResource = {
  serviceName: string,
  serviceNamespace?: string,
  serviceVersion?: string,
};

export type ManagedOtelOptions = {
  analyticsBaseUrl: string,
  projectId: string,
  secretServerKey: string,
  clientVersion: string,
  traceSampleRate: number,
  resource: HexclaveOtelResource,
  instrumentations?: Instrumentation[],
  shouldInstrumentOutboundRequest?: (url: string) => boolean,
  /**
   * `throw` is managed mode. `adopt` is auto mode: if a host already claimed
   * the global tracer, use that provider instead of failing the process.
   */
  existingProviderConflict?: "throw" | "adopt",
};

export type ManagedOtelRegistration = {
  provider: TracerProvider,
  loggerProvider: ApiLoggerProvider,
  meterProvider: MeterProvider,
  forceFlush: () => Promise<void>,
  shutdown: () => Promise<void>,
};

export function isOtelTracingSuppressed(): boolean {
  return isTracingSuppressed(context.active());
}

export async function runWithOtelTracingSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  return await context.with(suppressTracing(context.active()), fn);
}

/**
 * Browser-only OpenTelemetry integration for applications that own their web
 * TracerProvider. The async header factory is resolved for every OTLP export,
 * so it can obtain a fresh Hexclave session rather than freezing credentials.
 */
export {
  createHexclaveBrowserCorrelationSpanProcessor,
  createHexclaveBrowserOtlpTraceExporter,
  createHexclaveBrowserOtlpLogExporter,
  createHexclaveHttpMetricSpanProcessor,
  type HexclaveBrowserOtelExporterOptions,
} from "../lib/hexclave-app/apps/implementations/browser-otel-sdk";

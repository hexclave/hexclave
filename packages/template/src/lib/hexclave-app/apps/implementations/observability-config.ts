import type { ErrorAttachmentTransport, ErrorBeforeSend, ErrorEventProcessor, PendingErrorAttachment } from "../interfaces/error-capture";
import type { NetworkOptions } from "./network-capture";

export { type NetworkOptions } from "./network-capture";

export type ErrorCaptureOptions = {
  /** Whether global uncaught-error capture is enabled. @default true */
  enabled?: boolean,
  /** Error-message substrings to drop locally, merged with SDK defaults. */
  ignoreErrors?: string[],
  /** Processors run in registration order before `beforeSend`. */
  eventProcessors?: readonly ErrorEventProcessor[],
  /** Final app-level processor. Return an event to replace/accept or null to drop. */
  beforeSend?: ErrorBeforeSend,
  /** Injectable private-item transport. The default client transport calls Hexclave's attachment API. */
  attachmentTransport?: ErrorAttachmentTransport,
  /** Receives bytes that need retrying when no transport is available or an upload fails. */
  onAttachmentPending?: (attachment: PendingErrorAttachment) => void | PromiseLike<void>,
};

/** JSON-safe form used by SSR/client-app serialization. Runtime callbacks are local policy. */
export type ErrorCaptureOptionsJson = Omit<ErrorCaptureOptions, "eventProcessors" | "beforeSend" | "attachmentTransport" | "onAttachmentPending">;

export const DEFAULT_CONSOLE_CAPTURE_LEVELS: ("log" | "warn" | "error" | "info" | "debug")[] = ["warn", "error"];

export type LogsOptions = {
  /**
   * Console methods mirrored into structured log records. Original console
   * calls always run first. Pass an empty array to disable console capture.
   *
   * @default ["warn", "error"]
   */
  captureConsole?: ("log" | "warn" | "error" | "info" | "debug")[],
};

export type SpanPropagationOptions = {
  /** Set false to stop attaching Hexclave correlation baggage. Standard OTel trace context remains independent. @default true */
  enabled?: boolean,
  /** Extra exact origins allowed to receive the propagation header. */
  allowedOrigins?: string[],
  /** Include exact origins derived from trusted domains. @default true */
  useTrustedDomains?: boolean,
};

export type OpenTelemetryProviderMode = "managed" | "existing-provider" | "auto";

export type OpenTelemetryOptions = {
  /**
   * Who owns the process-wide OpenTelemetry provider.
   *
   * `managed` installs a Node provider, parent-aware sampler, Hexclave OTLP
   * exporter, W3C propagators, and async context manager. A pre-existing
   * global is a configuration error. `existing-provider` leaves every global
   * untouched; configure the application's provider with the exports from that
   * framework package's Node-only `/otel` entrypoint. `auto` installs when the
   * process has no provider and adopts the host provider when one is already
   * registered, including the case where the host registers after construction
   * but before the async Node SDK load finishes.
   *
   * @default "managed"
   */
  provider?: OpenTelemetryProviderMode,
};

export function resolveOpenTelemetryProviderMode(
  provider: OpenTelemetryProviderMode | undefined,
): OpenTelemetryProviderMode {
  return provider ?? "managed";
}

export function shouldInstallManagedOtel(provider: OpenTelemetryProviderMode): boolean {
  switch (provider) {
    case "existing-provider": {
      return false;
    }
    case "managed":
    case "auto": {
      return true;
    }
    default: {
      const unexpected: never = provider;
      throw new Error(`Unexpected OpenTelemetry provider: ${JSON.stringify(unexpected)}`);
    }
  }
}

export function resolveClientOpenTelemetryProvider(
  provider: OpenTelemetryProviderMode | undefined,
  observabilityEnabled: boolean,
  analyticsEnabled = false,
): "managed" | "existing-provider" | "disabled" {
  if (observabilityEnabled) {
    const mode = resolveOpenTelemetryProviderMode(provider);
    switch (mode) {
      case "existing-provider": {
        return "existing-provider";
      }
      case "managed":
      case "auto": {
        return "managed";
      }
      default: {
        const unexpected: never = mode;
        throw new Error(`Unexpected OpenTelemetry provider: ${JSON.stringify(unexpected)}`);
      }
    }
  }
  if (!analyticsEnabled) return "disabled";
  return provider === "existing-provider" ? "existing-provider" : "managed";
}

export function existingProviderConflictFor(provider: OpenTelemetryProviderMode): "throw" | "adopt" {
  switch (provider) {
    case "managed": {
      return "throw";
    }
    case "auto": {
      return "adopt";
    }
    case "existing-provider": {
      throw new Error("existing-provider does not register a managed SDK");
    }
    default: {
      const unexpected: never = provider;
      throw new Error(`Unexpected OpenTelemetry provider: ${JSON.stringify(unexpected)}`);
    }
  }
}

export type ObservabilityOptions = {
  /**
   * Whether logs, errors, spans, and code instrumentation are enabled.
   *
   * Off by default: observability installs global side effects (error/console
   * hooks, fetch/XHR instrumentation, an OpenTelemetry provider, outgoing
   * trace headers) and the backend rejects its data unless the project's
   * Observability app is enabled — so it must be a deliberate opt-in rather
   * than something an SDK upgrade turns on for existing apps.
   *
   * @default false
   */
  enabled?: boolean,
  /**
   * Root-trace sampling probability in [0, 1]. Managed mode uses OTel's
   * parent-based ratio sampler, so an upstream sampling decision is preserved.
   * Existing-provider mode leaves sampling entirely to that provider.
   *
   * This rate samples traces only. Session replays, product events, logs, and
   * errors are independent signals and are not gated on it.
   *
   * @default 0.1
   */
  traceSampleRate?: number,
  errorCapture?: ErrorCaptureOptions,
  logs?: LogsOptions,
  spanPropagation?: SpanPropagationOptions,
  network?: NetworkOptions,
  openTelemetry?: OpenTelemetryOptions,
};

export type ObservabilityOptionsJson = Omit<ObservabilityOptions, "errorCapture"> & {
  errorCapture?: ErrorCaptureOptionsJson,
};

/**
 * Keep processor functions out of the serialized app payload. Passing callback
 * references through an SSR boundary is both non-serializable and misleading:
 * the hydrated client cannot execute a server closure, so it must start with a
 * callback-free policy unless the caller configures it locally again.
 */
export function observabilityOptionsToJson(options: ObservabilityOptions | undefined): ObservabilityOptionsJson | undefined {
  if (options === undefined) return undefined;
  const { errorCapture, ...rest } = options;
  if (errorCapture === undefined) return rest;
  const {
    eventProcessors: _eventProcessors,
    beforeSend: _beforeSend,
    attachmentTransport: _attachmentTransport,
    onAttachmentPending: _onAttachmentPending,
    ...jsonErrorCapture
  } = errorCapture;
  return {
    ...rest,
    errorCapture: jsonErrorCapture,
  };
}

/**
 * Single source of truth for the observability umbrella gate. Every call site
 * that previously spelled the gate as `?.enabled === false` (default-on) must
 * go through this helper so the opt-in default cannot drift between the
 * scattered checks in the client and server app implementations.
 */
export function isObservabilityEnabled(options: ObservabilityOptions | ObservabilityOptionsJson | undefined): boolean {
  return options?.enabled === true;
}

export function normalizeTraceSampleRate(options: ObservabilityOptions | undefined): number {
  const sampleRate = options?.traceSampleRate ?? 0.1;
  if (typeof sampleRate !== "number" || !(sampleRate >= 0 && sampleRate <= 1)) {
    throw new Error("Hexclave analytics: observability.traceSampleRate must be a number between 0 and 1");
  }
  return sampleRate;
}

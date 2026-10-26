type BackendInstrumentationPlanOptions = {
  ci: string,
  googleCloudTraceSampleRate: string,
  nodeEnvironment: string,
  otelResourceAttributes: string,
  otlpEndpoint: string,
  otlpTracesEndpoint: string,
  portPrefix: string,
  sentryDsn: string,
};

export type GoogleCloudTracePlan = {
  projectId: string,
  /** Fraction of all traces that should end up in Cloud Trace (HEXCLAVE_GOOGLE_CLOUD_TRACE_SAMPLE_RATE). */
  sampleRate: number,
  /**
   * Trace-ID ratio the Cloud Trace span processor applies on top of the provider's own sampling decision, so that
   * `tracesSampleRate * spanProcessorSampleRate === sampleRate`.
   */
  spanProcessorSampleRate: number,
};

export type BackendInstrumentationPlan = {
  googleCloudTrace: GoogleCloudTracePlan | undefined,
  otlpTracesEndpoint: string | undefined,
  sentryEnabled: boolean,
  tracesSampleRate: number,
};

export function createBackendInstrumentationPlan(options: BackendInstrumentationPlanOptions): BackendInstrumentationPlan {
  if (options.ci !== "") {
    return {
      googleCloudTrace: undefined,
      otlpTracesEndpoint: undefined,
      sentryEnabled: false,
      tracesSampleRate: 0,
    };
  }

  // Matches the pre-Elysia @sentry/nextjs gating: Sentry was enabled whenever the DSN
  // was set and we were neither in development nor in CI (CI is short-circuited above).
  // An exact-match on "production" would be too narrow — a self-hoster or staging deploy
  // with a custom NODE_ENV (e.g. "staging", "preview") would silently drop all error
  // reporting. We additionally exclude "test" so test runs never report to Sentry.
  const sentryEnabled = options.sentryDsn !== ""
    && options.nodeEnvironment !== "development"
    && options.nodeEnvironment !== "test";
  const configuredOtlpTracesEndpoint = options.otlpTracesEndpoint.trim();
  const configuredOtlpEndpoint = options.otlpEndpoint.trim();
  const otlpTracesEndpoint = configuredOtlpTracesEndpoint !== ""
    ? validateOtlpEndpoint("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", configuredOtlpTracesEndpoint)
    : configuredOtlpEndpoint !== ""
      ? appendTracesPath(validateOtlpEndpoint("OTEL_EXPORTER_OTLP_ENDPOINT", configuredOtlpEndpoint))
      : options.nodeEnvironment === "development"
        ? `http://localhost:${options.portPrefix}31/v1/traces`
        : undefined;

  const googleCloudTraceTarget = parseGoogleCloudTraceTarget(options.googleCloudTraceSampleRate, options.otelResourceAttributes);

  // Sentry owns the one global provider, so this single rate decides which traces every destination can see. Sentry
  // itself never receives traces (instrument.ts drops every transaction before sending), so the rate only has to
  // serve the other destinations.
  // - With Sentry enabled, the provider samples at Cloud Trace's rate. Recording a span through Sentry's processor
  //   costs real CPU per request, so there is no point in recording more traces than Cloud Trace keeps.
  // - With Sentry disabled, every trace is recorded and Cloud Trace's processor applies its own ratio filter.
  const tracesSampleRate = otlpTracesEndpoint == null && googleCloudTraceTarget == null
    ? 0
    : sentryEnabled
      ? googleCloudTraceTarget?.sampleRate ?? 1
      : 1;

  return {
    googleCloudTrace: googleCloudTraceTarget == null ? undefined : {
      ...googleCloudTraceTarget,
      // The provider's decision is random per trace (Sentry's sample_rand) and the processor's filter is based on the
      // trace ID, so the two are independent and their rates multiply.
      spanProcessorSampleRate: Math.min(1, googleCloudTraceTarget.sampleRate / tracesSampleRate),
    },
    otlpTracesEndpoint,
    sentryEnabled,
    tracesSampleRate,
  };
}

function parseGoogleCloudTraceTarget(sampleRateValue: string, otelResourceAttributes: string): Omit<GoogleCloudTracePlan, "spanProcessorSampleRate"> | undefined {
  if (sampleRateValue.trim() === "") {
    return undefined;
  }
  const sampleRate = Number(sampleRateValue);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1) {
    throw new Error(`HEXCLAVE_GOOGLE_CLOUD_TRACE_SAMPLE_RATE must be a number in (0, 1], got: ${JSON.stringify(sampleRateValue)}`);
  }
  // Google's Telemetry API rejects spans whose resource lacks gcp.project_id.
  // Sentry builds the global provider's resource from OTEL_RESOURCE_ATTRIBUTES,
  // so that env var is the only way to put the attribute on every span; reading
  // the project ID from it too keeps a single source of truth.
  const projectId = parseOtelResourceAttributes(otelResourceAttributes).get("gcp.project_id");
  if (projectId == null || projectId === "") {
    throw new Error("HEXCLAVE_GOOGLE_CLOUD_TRACE_SAMPLE_RATE is set, but OTEL_RESOURCE_ATTRIBUTES does not contain gcp.project_id (e.g. OTEL_RESOURCE_ATTRIBUTES=gcp.project_id=my-project,service.name=hexclave-backend)");
  }
  return { projectId, sampleRate };
}

function parseOtelResourceAttributes(value: string): Map<string, string> {
  // Format per the OpenTelemetry spec: comma-separated key=value pairs with
  // percent-encoded values.
  const attributes = new Map<string, string>();
  for (const pair of value.split(",")) {
    if (pair.trim() === "") {
      continue;
    }
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(`OTEL_RESOURCE_ATTRIBUTES contains an entry without "=": ${JSON.stringify(pair)}`);
    }
    attributes.set(pair.slice(0, separatorIndex).trim(), decodeURIComponent(pair.slice(separatorIndex + 1).trim()));
  }
  return attributes;
}

function validateOtlpEndpoint(environmentVariableName: string, value: string) {
  // A bare `new URL(value)` throws TypeError("Invalid URL") without naming the source,
  // which is useless during a boot crash-loop — the operator can't tell which env var is
  // malformed. This narrow try/catch is NOT error swallowing: it rethrows immediately
  // (fail early, fail loud), just with the env var name and offending value attached.
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${environmentVariableName} is not a valid URL: ${JSON.stringify(value)}`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${environmentVariableName} must use HTTP or HTTPS, got: ${JSON.stringify(url.protocol)}`);
  }
  return url.toString();
}

function appendTracesPath(value: string) {
  const url = new URL(value);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`;
  return url.toString();
}

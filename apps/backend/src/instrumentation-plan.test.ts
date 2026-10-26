import { describe, expect, it } from "vitest";
import { createBackendInstrumentationPlan } from "./instrumentation-plan";

const baseOptions = {
  ci: "",
  googleCloudTraceSampleRate: "",
  nodeEnvironment: "production",
  otelResourceAttributes: "",
  otlpEndpoint: "",
  otlpTracesEndpoint: "",
  portPrefix: "81",
  sentryDsn: "",
};

describe("createBackendInstrumentationPlan", () => {
  it("samples no traces when Sentry is the only destination, since Sentry drops them anyway", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      sentryDsn: "https://public@example.invalid/1",
    })).toMatchInlineSnapshot(`
      {
        "googleCloudTrace": undefined,
        "otlpTracesEndpoint": undefined,
        "sentryEnabled": true,
        "tracesSampleRate": 0,
      }
    `);
  });

  it("records every trace for an OTLP destination even when Sentry is enabled", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      otlpTracesEndpoint: "https://otel.example.com/v1/traces",
      sentryDsn: "https://public@example.invalid/1",
    })).toMatchObject({ sentryEnabled: true, tracesSampleRate: 1 });
  });

  it("exports development traces through the local collector", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      nodeEnvironment: "development",
      portPrefix: "93",
    })).toMatchInlineSnapshot(`
      {
        "googleCloudTrace": undefined,
        "otlpTracesEndpoint": "http://localhost:9331/v1/traces",
        "sentryEnabled": false,
        "tracesSampleRate": 1,
      }
    `);
  });

  it("supports a self-hosted OTLP destination without enabling Sentry", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      otlpTracesEndpoint: "https://otel.example.com/v1/traces",
    })).toMatchInlineSnapshot(`
      {
        "googleCloudTrace": undefined,
        "otlpTracesEndpoint": "https://otel.example.com/v1/traces",
        "sentryEnabled": false,
        "tracesSampleRate": 1,
      }
    `);
  });

  it("derives the traces URL from the standard all-signals OTLP endpoint", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      otlpEndpoint: "https://otel.example.com/collector",
    })).toMatchInlineSnapshot(`
      {
        "googleCloudTrace": undefined,
        "otlpTracesEndpoint": "https://otel.example.com/collector/v1/traces",
        "sentryEnabled": false,
        "tracesSampleRate": 1,
      }
    `);
  });

  it("does not send telemetry from CI even when destinations are configured", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      ci: "true",
      otlpTracesEndpoint: "https://otel.example.com/v1/traces",
      sentryDsn: "https://public@example.invalid/1",
    })).toMatchInlineSnapshot(`
      {
        "googleCloudTrace": undefined,
        "otlpTracesEndpoint": undefined,
        "sentryEnabled": false,
        "tracesSampleRate": 0,
      }
    `);
  });

  // The pre-Elysia @sentry/nextjs setup enabled Sentry for any non-development,
  // non-CI environment with a DSN — not just NODE_ENV=production. These tests pin
  // that behavior so staging/preview-like NODE_ENV values keep error reporting.
  it("enables Sentry for a custom non-development NODE_ENV such as staging", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      nodeEnvironment: "staging",
      sentryDsn: "https://public@example.invalid/1",
    }).sentryEnabled).toBe(true);
  });

  it("does not enable Sentry in development even when a DSN is set", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      nodeEnvironment: "development",
      sentryDsn: "https://public@example.invalid/1",
    }).sentryEnabled).toBe(false);
  });

  it("does not enable Sentry in test even when a DSN is set", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      nodeEnvironment: "test",
      sentryDsn: "https://public@example.invalid/1",
    }).sentryEnabled).toBe(false);
  });

  it("does not enable Sentry when the DSN is empty", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
    }).sentryEnabled).toBe(false);
  });

  it("does not enable Sentry in CI even with a DSN and a production NODE_ENV", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      ci: "true",
      sentryDsn: "https://public@example.invalid/1",
    }).sentryEnabled).toBe(false);
  });

  it("names the offending environment variable when the OTLP endpoint is not a URL", () => {
    expect(() => createBackendInstrumentationPlan({
      ...baseOptions,
      otlpEndpoint: "not a url",
    })).toThrowErrorMatchingInlineSnapshot(`[Error: OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL: "not a url"]`);
  });

  it("names the offending environment variable when the traces endpoint is not a URL", () => {
    expect(() => createBackendInstrumentationPlan({
      ...baseOptions,
      otlpTracesEndpoint: "::::",
    })).toThrowErrorMatchingInlineSnapshot(`[Error: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is not a valid URL: "::::"]`);
  });

  it("rejects non-HTTP exporter endpoints", () => {
    expect(() => createBackendInstrumentationPlan({
      ...baseOptions,
      otlpTracesEndpoint: "file:///tmp/traces",
    })).toThrowErrorMatchingInlineSnapshot(`[Error: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must use HTTP or HTTPS, got: "file:"]`);
  });

  it("samples at Cloud Trace's rate when it is enabled alongside Sentry", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      googleCloudTraceSampleRate: "0.05",
      otelResourceAttributes: "service.name=hexclave-backend,gcp.project_id=my%2Dproject",
      sentryDsn: "https://public@example.invalid/1",
    })).toMatchInlineSnapshot(`
      {
        "googleCloudTrace": {
          "projectId": "my-project",
          "sampleRate": 0.05,
          "spanProcessorSampleRate": 1,
        },
        "otlpTracesEndpoint": undefined,
        "sentryEnabled": true,
        "tracesSampleRate": 0.05,
      }
    `);
  });

  it("records every trace for Cloud Trace's own ratio filter when Sentry is disabled", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      googleCloudTraceSampleRate: "0.05",
      otelResourceAttributes: "gcp.project_id=my-project",
    })).toMatchInlineSnapshot(`
      {
        "googleCloudTrace": {
          "projectId": "my-project",
          "sampleRate": 0.05,
          "spanProcessorSampleRate": 0.05,
        },
        "otlpTracesEndpoint": undefined,
        "sentryEnabled": false,
        "tracesSampleRate": 1,
      }
    `);
  });

  it("does not send Cloud Trace telemetry from CI", () => {
    expect(createBackendInstrumentationPlan({
      ...baseOptions,
      ci: "true",
      googleCloudTraceSampleRate: "0.05",
      otelResourceAttributes: "gcp.project_id=my-project",
    }).googleCloudTrace).toBeUndefined();
  });

  it("requires gcp.project_id in the resource attributes when Cloud Trace is enabled", () => {
    expect(() => createBackendInstrumentationPlan({
      ...baseOptions,
      googleCloudTraceSampleRate: "0.05",
      otelResourceAttributes: "service.name=hexclave-backend",
    })).toThrowErrorMatchingInlineSnapshot(`[Error: HEXCLAVE_GOOGLE_CLOUD_TRACE_SAMPLE_RATE is set, but OTEL_RESOURCE_ATTRIBUTES does not contain gcp.project_id (e.g. OTEL_RESOURCE_ATTRIBUTES=gcp.project_id=my-project,service.name=hexclave-backend)]`);
  });

  it.each(["0", "-0.1", "1.5", "five percent", "NaN"])("rejects the Cloud Trace sample rate %j", (sampleRate) => {
    expect(() => createBackendInstrumentationPlan({
      ...baseOptions,
      googleCloudTraceSampleRate: sampleRate,
      otelResourceAttributes: "gcp.project_id=my-project",
    })).toThrowError(`HEXCLAVE_GOOGLE_CLOUD_TRACE_SAMPLE_RATE must be a number in (0, 1], got: ${JSON.stringify(sampleRate)}`);
  });

  it("rejects malformed resource attributes when Cloud Trace is enabled", () => {
    expect(() => createBackendInstrumentationPlan({
      ...baseOptions,
      googleCloudTraceSampleRate: "0.05",
      otelResourceAttributes: "gcp.project_id",
    })).toThrowErrorMatchingInlineSnapshot(`[Error: OTEL_RESOURCE_ATTRIBUTES contains an entry without "=": "gcp.project_id"]`);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { inferTelemetryResource, resolveTelemetryResource, snapshotTelemetryOptions, telemetryOptionsToJson } from "./telemetry-config";

describe("telemetry resource config", () => {
  const inferenceEnvVars = ["HEXCLAVE_SERVICE_NAME", "VERCEL_PROJECT_NAME", "npm_package_name", "SITE_NAME", "VERCEL_GIT_COMMIT_SHA", "COMMIT_REF", "npm_package_version", "VERCEL_ENV", "NODE_ENV"] as const;
  const clearInferenceEnv = () => {
    for (const name of inferenceEnvVars) vi.stubEnv(name, "");
  };
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("infers a tier-suffixed service identity when the app configured none", () => {
    clearInferenceEnv();
    vi.stubEnv("VERCEL_PROJECT_NAME", "acme-shop");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    vi.stubEnv("VERCEL_ENV", "production");

    expect(resolveTelemetryResource(undefined, "server")).toEqual({
      service: { name: "acme-shop-server", version: "abc123" },
      deploymentEnvironmentName: "production",
    });
    expect(resolveTelemetryResource(undefined, "browser").service.name).toBe("acme-shop-browser");
  });

  it("falls back to the bare tier when nothing names the service", () => {
    clearInferenceEnv();
    expect(inferTelemetryResource("browser")).toEqual({ service: { name: "browser" } });
  });

  it("treats a blank env value as absent rather than an empty service name", () => {
    clearInferenceEnv();
    vi.stubEnv("VERCEL_PROJECT_NAME", "");
    expect(inferTelemetryResource("server").service.name).toBe("server");
  });

  it("prefers an explicit resource over inference", () => {
    clearInferenceEnv();
    vi.stubEnv("VERCEL_PROJECT_NAME", "ignored");
    expect(resolveTelemetryResource({ resource: { service: { name: "checkout-api" } } }, "server")).toEqual({
      service: { name: "checkout-api" },
    });
  });

  it("still rejects an explicit resource that is malformed", () => {
    expect(() => resolveTelemetryResource({ resource: { service: { name: "" } } }, "server")).toThrow();
  });

  it("snapshots nested service identity and primitive-array attributes", () => {
    const zones = ["iad1"];
    const options = {
      resource: {
        service: { name: "dashboard", namespace: "hexclave" },
        attributes: { zones },
      },
    };
    const snapshot = snapshotTelemetryOptions(options);

    options.resource.service.name = "mutated";
    zones.push("sfo1");

    expect(snapshot?.resource).toEqual({
      service: { name: "dashboard", namespace: "hexclave" },
      attributes: { zones: ["iad1"] },
    });
  });

  it("omits waitUntil at the runtime serialization boundary", () => {
    const waitUntil = () => {};
    expect(telemetryOptionsToJson({
      resource: { service: { name: "api" } },
      waitUntil,
    })).toEqual({ resource: { service: { name: "api" } } });
  });
});

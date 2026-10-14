import { describe, expect, it } from "vitest";
import { parseGoogleCloudProfilerConfig } from "./google-cloud-profiler";

const cloudRun = { cloudRunService: "hexclave-backend-prod", cloudRunRevision: "hexclave-backend-prod-00057-abc" };

describe("parseGoogleCloudProfilerConfig", () => {
  it("is disabled when unset or false", () => {
    expect(parseGoogleCloudProfilerConfig({ enabled: "", ...cloudRun })).toBeUndefined();
    expect(parseGoogleCloudProfilerConfig({ enabled: "false", ...cloudRun })).toBeUndefined();
    expect(parseGoogleCloudProfilerConfig({ enabled: "", cloudRunService: "", cloudRunRevision: "" })).toBeUndefined();
  });

  it("uses the Cloud Run service and revision as the service context", () => {
    expect(parseGoogleCloudProfilerConfig({ enabled: " true ", ...cloudRun })).toMatchInlineSnapshot(`
      {
        "service": "hexclave-backend-prod",
        "version": "hexclave-backend-prod-00057-abc",
      }
    `);
  });

  it("rejects values other than true or false", () => {
    expect(() => parseGoogleCloudProfilerConfig({ enabled: "1", ...cloudRun })).toThrowErrorMatchingInlineSnapshot(`[Error: HEXCLAVE_GOOGLE_CLOUD_PROFILER_ENABLED must be "true" or "false", got: "1"]`);
  });

  it("rejects being enabled outside Cloud Run", () => {
    expect(() => parseGoogleCloudProfilerConfig({ enabled: "true", cloudRunService: "", cloudRunRevision: "" })).toThrowErrorMatchingInlineSnapshot(`[Error: HEXCLAVE_GOOGLE_CLOUD_PROFILER_ENABLED is only supported on Cloud Run (K_SERVICE and K_REVISION must be set)]`);
  });
});

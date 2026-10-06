import { describe, expect, it } from "vitest";
import { buildTelemetryMaterializationMessage, decodeBackgroundJobEnvelope, decodeQstashMessage } from "./qstash-outbox";

describe("QStash outbox job contracts", () => {
  it("uses a compact, deterministic telemetry materialization pointer", () => {
    const first = buildTelemetryMaterializationMessage({
      tenancyId: "00000000-0000-4000-8000-000000000001",
      batchId: "envelope:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const second = buildTelemetryMaterializationMessage({
      tenancyId: "00000000-0000-4000-8000-000000000001",
      batchId: "envelope:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(first).toEqual(second);
    expect(first.jobType).toBe("telemetry-materialization");
    expect(first.message.url).toBe("/api/latest/internal/telemetry/materialize");
    expect(first.message.body).toEqual({
      tenancyId: "00000000-0000-4000-8000-000000000001",
      batchId: "envelope:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(first.message.flowControl).toEqual({
      key: "telemetry-materialization.00000000-0000-4000-8000-000000000001",
      parallelism: 4,
    });
  });

  it("decodes outbox rows without a job envelope while validating the envelope when present", () => {
    expect(decodeQstashMessage({
      url: "/api/latest/internal/external-db-sync/sync-engine",
      body: { tenancyId: "tenancy-id" },
    })).toEqual({
      url: "/api/latest/internal/external-db-sync/sync-engine",
      body: { tenancyId: "tenancy-id" },
    });

    expect(decodeBackgroundJobEnvelope({
      schemaVersion: 1,
      jobId: "job-id",
      jobType: "telemetry-materialization",
      tenancyId: "tenancy-id",
      deduplicationKey: "job-key",
      payload: { batchId: "batch-id" },
    })).toEqual({
      schemaVersion: 1,
      jobId: "job-id",
      jobType: "telemetry-materialization",
      tenancyId: "tenancy-id",
      deduplicationKey: "job-key",
      payload: { batchId: "batch-id" },
    });

    expect(() => decodeBackgroundJobEnvelope({
      schemaVersion: 1,
      jobId: "job-id",
      jobType: "unknown",
      tenancyId: null,
      deduplicationKey: "job-key",
      payload: {},
    })).toThrow("qstashOptions.job is invalid");
  });

  it("rejects network-path, backslash-prefixed, and normalized-control outbox URLs", () => {
    for (const url of [
      "//attacker.example.test/job",
      String.raw`/\attacker.example.test/job`,
      "/\t\\attacker.example.test/job",
      "/\n\\attacker.example.test/job",
      "/\r\\attacker.example.test/job",
    ]) {
      expect(() => decodeQstashMessage({ url, body: {} })).toThrow("internal relative paths");
    }
    expect(decodeQstashMessage({ url: "/api/latest/internal/job", body: {} }).url)
      .toBe("/api/latest/internal/job");
  });
});

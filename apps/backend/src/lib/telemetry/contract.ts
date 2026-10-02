import type { Json } from "@hexclave/shared/dist/utils/json";

export type TelemetryBatchId = string;

export type TelemetryScope = {
  tenancyId: string;
  projectId: string;
  branchId: string;
};

export const TELEMETRY_BATCH_ID_MAX_BYTES = 512;

export function assertTelemetryBatchId(batchId: string): TelemetryBatchId {
  if (batchId.length === 0) throw new Error("Telemetry batch ID must not be empty");
  if (Buffer.byteLength(batchId, "utf8") > TELEMETRY_BATCH_ID_MAX_BYTES) {
    throw new Error(`Telemetry batch ID must be at most ${TELEMETRY_BATCH_ID_MAX_BYTES} bytes`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(batchId)) {
    throw new Error("Telemetry batch ID must not contain control characters");
  }
  return batchId;
}

export type BackgroundJobType =
  | "external-db-sync"
  | "telemetry-materialization";

export type BackgroundJobEnvelope<TPayload extends Record<string, Json>> = {
  schemaVersion: 1;
  jobId: string;
  jobType: BackgroundJobType;
  tenancyId: string | null;
  deduplicationKey: string;
  payload: TPayload;
};

export function buildBackgroundJobEnvelope<TPayload extends Record<string, Json>>(options: {
  jobType: BackgroundJobType,
  jobId: string,
  tenancyId: string | null,
  deduplicationKey: string,
  payload: TPayload,
}): BackgroundJobEnvelope<TPayload> {
  if (options.jobId.length === 0) throw new Error("Background job IDs must not be empty");
  if (options.deduplicationKey.length === 0) throw new Error("Background job deduplication keys must not be empty");
  return {
    schemaVersion: 1,
    jobId: options.jobId,
    jobType: options.jobType,
    tenancyId: options.tenancyId,
    deduplicationKey: options.deduplicationKey,
    payload: options.payload,
  };
}

export function buildBackgroundJobKey(
  jobType: BackgroundJobType,
  scope: Pick<TelemetryScope, "tenancyId">,
  identity: string,
): string {
  assertTelemetryBatchId(identity);
  return `${jobType}:${scope.tenancyId}:${identity}`;
}

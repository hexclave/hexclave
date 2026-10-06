import { globalPrismaClient, type PrismaClientTransaction } from "@/prisma-client";
import type { Json } from "@hexclave/shared/dist/utils/json";
import {
  buildBackgroundJobEnvelope,
  buildBackgroundJobKey,
  type BackgroundJobEnvelope,
  type BackgroundJobType,
} from "./telemetry/contract";

export type QstashFlowControl = {
  key: string;
  parallelism: number;
};

export type QstashDelay = number | `${bigint}s` | `${bigint}m` | `${bigint}h` | `${bigint}d`;

export type QstashMessage<TPayload extends Record<string, Json>> = {
  url: string;
  body: TPayload;
  flowControl?: QstashFlowControl;
  delay?: QstashDelay;
  job?: BackgroundJobEnvelope<Record<string, Json>>;
};

export type QstashOutboxMessage<TPayload extends Record<string, Json>> = {
  jobType: BackgroundJobType;
  tenancyId: string | null;
  deduplicationKey: string;
  message: QstashMessage<TPayload>;
};


function isQstashDelay(value: unknown): value is QstashDelay {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
  return typeof value === "string" && /^\d+[smhd]$/u.test(value);
}

function isBackgroundJobType(value: unknown): value is BackgroundJobType {
  if (typeof value !== "string") return false;
  switch (value) {
    case "external-db-sync": {
      return true;
    }
    case "telemetry-materialization": {
      return true;
    }
    default: {
      return false;
    }
  }
}

export function decodeBackgroundJobEnvelope(value: unknown): BackgroundJobEnvelope<Record<string, Json>> {
  const envelope = asJsonObject(value, "OutgoingRequest qstashOptions.job is invalid");
  const payload = asJsonObject(envelope.payload, "OutgoingRequest qstashOptions.job is invalid");
  if (envelope.schemaVersion !== 1
    || typeof envelope.jobId !== "string"
    || envelope.jobId.length === 0
    || !isBackgroundJobType(envelope.jobType)
    || !(envelope.tenancyId === null || typeof envelope.tenancyId === "string")
    || typeof envelope.deduplicationKey !== "string"
    || envelope.deduplicationKey.length === 0) {
    throw new Error("OutgoingRequest qstashOptions.job is invalid");
  }
  return {
    schemaVersion: 1,
    jobId: envelope.jobId,
    jobType: envelope.jobType,
    tenancyId: envelope.tenancyId,
    deduplicationKey: envelope.deduplicationKey,
    payload,
  };
}

// Decoded QStash options are plain JSON objects; this checks only that the
// value is a non-array object (with a caller-supplied failure message) so
// field-level validation can stay at the call site where the expected schema
// is known.
function asJsonObject(value: unknown, failureMessage: string): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(failureMessage);
  // SAFETY: every value decoded here originates from the OutgoingRequest
  // "qstashOptions" jsonb column, so members can only be JSON values; the
  // check above pins down the top level as a non-array object.
  return value as Record<string, Json>;
}

function assertMessage(message: QstashMessage<Record<string, Json>>): void {
  if (!/^\/(?![\\/])/u.test(message.url) || /[\u0000-\u0020\u007f]/u.test(message.url)) {
    throw new Error("QStash outbox URLs must be internal relative paths");
  }
  if (message.flowControl !== undefined) {
    if (!/^[a-zA-Z0-9._-]+$/.test(message.flowControl.key)) {
      throw new Error("QStash flow-control keys must be non-empty and contain only alphanumerics, hyphens, underscores, or periods");
    }
    if (!Number.isSafeInteger(message.flowControl.parallelism) || message.flowControl.parallelism < 1) {
      throw new Error("QStash flow-control parallelism must be a positive integer");
    }
  }
  if (message.delay !== undefined && !isQstashDelay(message.delay)) {
    throw new Error("QStash delays must not be empty");
  }
}

export function decodeQstashMessage(value: unknown): QstashMessage<Record<string, Json>> {
  const options = asJsonObject(value, "OutgoingRequest qstashOptions must be a JSON object");

  const url = options.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("OutgoingRequest qstashOptions.url must be a non-empty string");
  }

  // Presence is tested with `in` rather than `!== undefined`: the record's
  // values are typed Json (which jsonb guarantees), so only missing keys can
  // yield undefined and the compiler rightly rejects undefined comparisons.
  const body = "body" in options ? asJsonObject(options.body, "OutgoingRequest qstashOptions.body must be a JSON object") : {};
  const job = "job" in options ? decodeBackgroundJobEnvelope(options.job) : undefined;

  let flowControl: QstashFlowControl | undefined;
  if ("flowControl" in options) {
    const rawFlowControl = asJsonObject(options.flowControl, "OutgoingRequest qstashOptions.flowControl is invalid");
    if (typeof rawFlowControl.key !== "string" || typeof rawFlowControl.parallelism !== "number") {
      throw new Error("OutgoingRequest qstashOptions.flowControl is invalid");
    }
    flowControl = {
      key: rawFlowControl.key,
      parallelism: rawFlowControl.parallelism,
    };
  }

  let delay: QstashDelay | undefined;
  if ("delay" in options) {
    if (!isQstashDelay(options.delay)) {
      throw new Error("OutgoingRequest qstashOptions.delay is invalid");
    }
    delay = options.delay;
  }

  const message: QstashMessage<Record<string, Json>> = { url, body };
  if (flowControl !== undefined) message.flowControl = flowControl;
  if (delay !== undefined) message.delay = delay;
  if (job !== undefined) message.job = job;
  assertMessage(message);
  return message;
}

export async function enqueueQstashMessage<TPayload extends Record<string, Json>>(
  options: QstashOutboxMessage<TPayload>,
  client: PrismaClientTransaction = globalPrismaClient,
): Promise<void> {
  assertMessage(options.message);
  if (options.deduplicationKey.length === 0) throw new Error("QStash outbox deduplication keys must not be empty");
  const job = buildBackgroundJobEnvelope({
    jobType: options.jobType,
    jobId: options.deduplicationKey,
    tenancyId: options.tenancyId,
    deduplicationKey: options.deduplicationKey,
    payload: options.message.body,
  });

  const qstashOptions: QstashMessage<TPayload> = {
    url: options.message.url,
    body: options.message.body,
    job,
  };
  if (options.message.flowControl !== undefined) qstashOptions.flowControl = options.message.flowControl;
  if (options.message.delay !== undefined) qstashOptions.delay = options.message.delay;

  await client.$executeRaw`
    INSERT INTO "OutgoingRequest" ("id", "createdAt", "qstashOptions", "startedFulfillingAt", "deduplicationKey")
    VALUES (
      gen_random_uuid(),
      NOW(),
      ${JSON.stringify(qstashOptions)}::jsonb,
      NULL,
      ${options.deduplicationKey}
    )
    ON CONFLICT ("deduplicationKey") WHERE "startedFulfillingAt" IS NULL DO NOTHING
  `;
}

export function buildTelemetryMaterializationMessage(options: {
  tenancyId: string;
  batchId: string;
  apiPath?: string;
}): QstashOutboxMessage<{ tenancyId: string, batchId: string }> {
  const deduplicationKey = buildBackgroundJobKey(
    "telemetry-materialization",
    { tenancyId: options.tenancyId },
    options.batchId,
  );
  return {
    jobType: "telemetry-materialization",
    tenancyId: options.tenancyId,
    deduplicationKey,
    message: {
      url: options.apiPath ?? "/api/latest/internal/telemetry/materialize",
      body: {
        tenancyId: options.tenancyId,
        batchId: options.batchId,
      },
      flowControl: {
        key: `telemetry-materialization.${options.tenancyId}`,
        parallelism: 4,
      },
      delay: "5s",
    },
  };
}

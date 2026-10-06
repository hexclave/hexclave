import { randomUUID } from "node:crypto";
import { retryTransaction, globalPrismaClient, type PrismaClientTransaction } from "@/prisma-client";
import type {
  ErrorIngestClientReportBucket,
  ErrorIngestClientReportCategory,
  ErrorIngestClientReportEntry,
  ErrorIngestClientReportProjection,
  ErrorIngestClientReportReason,
  ErrorIngestProtocolProjection,
} from "./error-ingest-protocol-adapter";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { anyVersionUuidPattern as UUID_PATTERN } from "@hexclave/shared/dist/utils/uuids";

export const ERROR_INGEST_CLIENT_REPORT_PROTOCOLS = ["otlp_logs", "otlp_traces", "sentry_envelope", "client_report"] as const;
export type ErrorIngestClientReportProtocol = typeof ERROR_INGEST_CLIENT_REPORT_PROTOCOLS[number];

export type ErrorIngestClientReportScope = {
  tenancyId: string,
  projectId: string,
  branchId: string,
};

export type ErrorIngestClientReportRow = {
  tenancyId: string,
  projectId: string,
  branchId: string,
  id: string,
  protocol: ErrorIngestClientReportProtocol,
  bucket: ErrorIngestClientReportBucket,
  reason: string,
  category: string,
  quantity: number,
  idempotencyKey: string,
  reportedAt: Date,
};

export type ErrorIngestClientReportRequest = {
  clientReport: ErrorIngestClientReportProjection,
  idempotencyKey: string,
  timestampMs?: number,
};

export const ERROR_INGEST_CLIENT_REPORT_MIN_CLOCK_DRIFT_MS = 55 * 60 * 1_000;

export class ErrorIngestClientReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrorIngestClientReportParseError";
  }
}

const SECRET_TEXT_RE = /(?:bearer\s+|basic\s+|-----begin [^-]*private key-----|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;

const REPORT_BUCKETS: readonly ErrorIngestClientReportBucket[] = [
  "discarded_events",
  "rate_limited_events",
  "filtered_events",
  "filtered_sampling_events",
];
const MAX_REPORT_ROWS = 100;
const MAX_REPORT_QUANTITY = 1_000_000_000;
export const ERROR_INGEST_CLIENT_REPORT_REASON_CATEGORY_MAX_BYTES = 64;
export const ERROR_INGEST_CLIENT_REPORT_IDEMPOTENCY_KEY_MAX_BYTES = 256;

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validateScope(scope: ErrorIngestClientReportScope): void {
  if (!UUID_PATTERN.test(scope.tenancyId)) throw new Error("Error ingest client report tenancyId must be a UUID");
  if (!isBoundedText(scope.projectId, ERROR_INGEST_CLIENT_REPORT_IDEMPOTENCY_KEY_MAX_BYTES)) throw new Error("Error ingest client report projectId is invalid");
  if (!isBoundedText(scope.branchId, ERROR_INGEST_CLIENT_REPORT_IDEMPOTENCY_KEY_MAX_BYTES)) throw new Error("Error ingest client report branchId is invalid");
}

function validateProtocol(protocol: ErrorIngestClientReportProtocol): void {
  if (!ERROR_INGEST_CLIENT_REPORT_PROTOCOLS.includes(protocol)) {
    throw new Error("Error ingest client report protocol is invalid");
  }
}

function validateEntry(entry: ErrorIngestClientReportEntry): void {
  if (
    !isBoundedText(entry.reason, ERROR_INGEST_CLIENT_REPORT_REASON_CATEGORY_MAX_BYTES)
    || !isBoundedText(entry.category, ERROR_INGEST_CLIENT_REPORT_REASON_CATEGORY_MAX_BYTES)
  ) {
    throw new Error("Error ingest client report reason and category must be bounded strings");
  }
  if (!Number.isSafeInteger(entry.quantity) || entry.quantity <= 0 || entry.quantity > MAX_REPORT_QUANTITY) {
    throw new Error("Error ingest client report quantity is outside the supported range");
  }
}

function isReportQuantity(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_REPORT_QUANTITY;
}

function parseReportTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;

  let timestampMs: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ErrorIngestClientReportParseError("Error ingest client report timestamp is invalid");
    timestampMs = Math.round(Math.abs(value) >= 100_000_000_000 ? value : value * 1_000);
  } else if (typeof value === "string") {
    if (!isBoundedText(value, 64)) throw new ErrorIngestClientReportParseError("Error ingest client report timestamp is invalid");
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new ErrorIngestClientReportParseError("Error ingest client report timestamp is invalid");
    timestampMs = parsed;
  } else {
    throw new ErrorIngestClientReportParseError("Error ingest client report timestamp is invalid");
  }

  if (!Number.isSafeInteger(timestampMs) || !Number.isFinite(new Date(timestampMs).getTime())) {
    throw new ErrorIngestClientReportParseError("Error ingest client report timestamp is outside the supported date range");
  }
  return timestampMs;
}

export function normalizeErrorIngestClientReportReportedAt(
  request: ErrorIngestClientReportRequest,
  sentAt: Date | null,
  receivedAt: Date,
): Date {
  if (!(receivedAt instanceof Date) || !Number.isFinite(receivedAt.getTime())) {
    throw new Error("Error ingest client report receivedAt must be a valid date");
  }
  if (request.timestampMs === undefined) return receivedAt;
  const clientTimestamp = new Date(request.timestampMs);
  if (!Number.isFinite(clientTimestamp.getTime())) throw new Error("Error ingest client report timestamp is invalid");
  if (sentAt === null || !Number.isFinite(sentAt.getTime())) return clientTimestamp;

  const clockDriftMs = receivedAt.getTime() - sentAt.getTime();
  return Math.abs(clockDriftMs) >= ERROR_INGEST_CLIENT_REPORT_MIN_CLOCK_DRIFT_MS
    ? new Date(clientTimestamp.getTime() + clockDriftMs)
    : clientTimestamp;
}

function entriesForBucket(
  projection: ErrorIngestClientReportProjection,
  bucket: ErrorIngestClientReportBucket,
): readonly ErrorIngestClientReportEntry[] {
  switch (bucket) {
    case "discarded_events": {
      return projection.discarded_events;
    }
    case "rate_limited_events": {
      return projection.rate_limited_events;
    }
    case "filtered_events": {
      return projection.filtered_events;
    }
    case "filtered_sampling_events": {
      return projection.filtered_sampling_events;
    }
  }
}

function parseReportEntries(value: unknown, field: string): ErrorIngestClientReportEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REPORT_ROWS) throw new ErrorIngestClientReportParseError(`${field} must be an array with at most ${MAX_REPORT_ROWS} entries`);
  return value.map((entry) => {
    if (!isRecord(entry)) throw new ErrorIngestClientReportParseError(`${field} entries must be objects`);
    const reason = entry.reason;
    const category = entry.category;
    const quantity = entry.quantity;
    if (
      !isBoundedText(reason, ERROR_INGEST_CLIENT_REPORT_REASON_CATEGORY_MAX_BYTES)
      || !isBoundedText(category, ERROR_INGEST_CLIENT_REPORT_REASON_CATEGORY_MAX_BYTES)
    ) {
      throw new ErrorIngestClientReportParseError(`${field} reason and category are not supported bounded values`);
    }
    if (SECRET_TEXT_RE.test(reason) || SECRET_TEXT_RE.test(category)) {
      throw new ErrorIngestClientReportParseError(`${field} reason and category must not contain secret-bearing text`);
    }
    if (!isReportQuantity(quantity)) {
      throw new ErrorIngestClientReportParseError(`${field} quantity is outside the supported range`);
    }
    return { reason, category, quantity };
  });
}

export function parseErrorIngestClientReportRequest(value: unknown): ErrorIngestClientReportRequest {
  if (!isRecord(value)) throw new ErrorIngestClientReportParseError("Error ingest client report must be an object");
  if (!isBoundedText(value.idempotency_key, ERROR_INGEST_CLIENT_REPORT_IDEMPOTENCY_KEY_MAX_BYTES)) throw new ErrorIngestClientReportParseError("Error ingest client report idempotency_key is required and must be bounded");
  if (SECRET_TEXT_RE.test(value.idempotency_key)) throw new ErrorIngestClientReportParseError("Error ingest client report idempotency_key must not contain secret-bearing text");
  const timestampMs = parseReportTimestamp(value.timestamp);
  const clientReport = {
    discarded_events: parseReportEntries(value.discarded_events, "discarded_events"),
    rate_limited_events: parseReportEntries(value.rate_limited_events, "rate_limited_events"),
    filtered_events: parseReportEntries(value.filtered_events, "filtered_events"),
    filtered_sampling_events: parseReportEntries(value.filtered_sampling_events, "filtered_sampling_events"),
  } satisfies ErrorIngestClientReportProjection;
  if (Object.values(clientReport).reduce((count, entries) => count + entries.length, 0) > MAX_REPORT_ROWS) {
    throw new ErrorIngestClientReportParseError(`Error ingest client report contains more than ${MAX_REPORT_ROWS} entries`);
  }
  const request: ErrorIngestClientReportRequest = {
    clientReport,
    idempotencyKey: value.idempotency_key,
  };
  if (timestampMs !== undefined) request.timestampMs = timestampMs;
  return request;
}

export function buildErrorIngestClientReportRows(
  scope: ErrorIngestClientReportScope,
  protocol: ErrorIngestClientReportProtocol,
  projection: Pick<ErrorIngestProtocolProjection, "clientReport" | "idempotencyKey">,
  reportedAt = new Date(),
): readonly ErrorIngestClientReportRow[] {
  validateScope(scope);
  validateProtocol(protocol);
  if (!(reportedAt instanceof Date) || Number.isNaN(reportedAt.getTime())) {
    throw new Error("Error ingest client report reportedAt must be a valid date");
  }
  if (!isBoundedText(projection.idempotencyKey, ERROR_INGEST_CLIENT_REPORT_IDEMPOTENCY_KEY_MAX_BYTES)) throw new Error("Error ingest client report idempotency key is invalid");

  const aggregated = new Map<string, { bucket: ErrorIngestClientReportBucket, reason: string, category: string, quantity: number }>();
  let entryCount = 0;
  for (const bucket of REPORT_BUCKETS) {
    for (const entry of entriesForBucket(projection.clientReport, bucket)) {
      entryCount += 1;
      if (entryCount > MAX_REPORT_ROWS) throw new Error("Error ingest client report contains too many entries");
      validateEntry(entry);
      const key = JSON.stringify([bucket, entry.reason, entry.category]);
      const existing = aggregated.get(key);
      if (existing === undefined) {
        aggregated.set(key, { bucket, reason: entry.reason, category: entry.category, quantity: entry.quantity });
      } else {
        existing.quantity = Math.min(existing.quantity + entry.quantity, MAX_REPORT_QUANTITY);
      }
    }
  }
  return [...aggregated.values()].map((entry) => ({
    ...scope,
    id: randomUUID(),
    protocol,
    bucket: entry.bucket,
    reason: entry.reason,
    category: entry.category,
    quantity: entry.quantity,
    idempotencyKey: projection.idempotencyKey,
    reportedAt,
  }));
}

export function buildErrorIngestClientReportRequestRows(
  scope: ErrorIngestClientReportScope,
  request: ErrorIngestClientReportRequest,
  reportedAt = new Date(),
): readonly ErrorIngestClientReportRow[] {
  return buildErrorIngestClientReportRows(
    scope,
    "client_report",
    request,
    request.timestampMs === undefined ? reportedAt : new Date(request.timestampMs),
  );
}

async function persistErrorIngestClientReportRows(
  rows: readonly ErrorIngestClientReportRow[],
  client: typeof globalPrismaClient,
): Promise<number> {
  if (rows.length === 0) return 0;
  return await retryTransaction(client, async (tx: PrismaClientTransaction) => {
    const result = await tx.errorIngestClientReport.createMany({
      data: rows.map((row) => ({ ...row })),
      skipDuplicates: true,
    });
    return result.count;
  });
}

export async function persistErrorIngestClientReportProjection(
  scope: ErrorIngestClientReportScope,
  protocol: ErrorIngestClientReportProtocol,
  projection: Pick<ErrorIngestProtocolProjection, "clientReport" | "idempotencyKey">,
  client: typeof globalPrismaClient = globalPrismaClient,
  reportedAt = new Date(),
): Promise<number> {
  return await persistErrorIngestClientReportRows(buildErrorIngestClientReportRows(scope, protocol, projection, reportedAt), client);
}

export async function persistErrorIngestClientReportRequest(
  scope: ErrorIngestClientReportScope,
  request: ErrorIngestClientReportRequest,
  client: typeof globalPrismaClient = globalPrismaClient,
  reportedAt = new Date(),
): Promise<number> {
  return await persistErrorIngestClientReportRows(buildErrorIngestClientReportRequestRows(scope, request, reportedAt), client);
}

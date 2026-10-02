import { classifyTelemetrySignal, TELEMETRY_MAX_LOG_MESSAGE_BYTES, truncateUtf8Bytes, type LogLevel, type TelemetryResource } from "@hexclave/shared/dist/utils/analytics-wire";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { isJsonSerializable, type Json } from "@hexclave/shared/dist/utils/json";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { createHash } from "crypto";
import { stripLoneSurrogates, type ClickHouseClient } from "./clickhouse";
import { computeGrouping, computeGroupingWithReadableConfigs, getGroupingHashProvenance } from "./issues/grouping";
import { readGroupingFingerprint } from "./issues/grouping-fingerprint";
import { resolveGroupingConfig, type GroupingConfigResolution, type GroupingRuntimeConfig } from "./issues/grouping-config";
import { serializeGroupingProvenance } from "./issues/grouping-provenance";
import type { IssueBatchDelta } from "./issues/issue-materialization-contract";
import { buildTelemetryResourceFields } from "./telemetry/resource";
import { scrubErrorIngestPayload } from "./error-ingest";
import { normalizeErrorEnvelope } from "@hexclave/shared/dist/utils/error-envelope";
import { writeTelemetryDestinations, type TelemetryWritePlan } from "./telemetry/write-plan";

export type BatchEventWireItem = {
  event_type: string,
  event_at_ms: number,
  data: unknown,
  trace_id?: string,
  span_id?: string,
  page_view_span_id?: string,
  message?: string,
  level?: LogLevel,
};

export type BatchSignalContext = {
  projectId: string,
  branchId: string,
  userId: string | null,
  refreshTokenId: string | null,
  sessionReplayId: string | null,
  sessionReplaySegmentId: string | null,
  runtime: "browser" | "server",
  resource: TelemetryResource | null,
  producer: "sdk",
  groupingConfig?: GroupingRuntimeConfig,
};

export type TelemetryLens = "product" | "observability";

export function getTelemetryLens(eventType: string): TelemetryLens {
  return classifyTelemetrySignal(eventType, "event").lens === "analytics"
    ? "product"
    : "observability";
}

export function getBatchDeduplicationToken(batchId: string): string {
  return `${batchId}:analytics_internal.events`;
}

export function computeOccurrenceId(batchId: string, ordinal: number): string {
  return createHash("sha256").update(`${batchId}:${ordinal}`, "utf8").digest("hex").slice(0, 32);
}

const NATIVE_EVENT_ID_RE = /^[0-9a-f]{32}$/iu;

function getNativeEventId(event: BatchEventWireItem): string | null {
  const eventId = readStringField(event.data, "event_id");
  return eventId !== null && NATIVE_EVENT_ID_RE.test(eventId) ? eventId.toLowerCase() : null;
}

function getOccurrenceId(event: BatchEventWireItem, batchId: string, ordinal: number): string {
  return getNativeEventId(event) ?? computeOccurrenceId(batchId, ordinal);
}

export type NormalizedEventBatch = {
  productEvents: ReturnType<typeof buildBaseEventRow>[],
  logOccurrences: ReturnType<typeof buildLogRow>[],
  issueInputs: IssueBatchDelta[],
};

export type NativeTelemetryWritePlan = TelemetryWritePlan<IssueBatchDelta>;

function scrubBatchEvent(event: BatchEventWireItem): BatchEventWireItem {
  const result = scrubErrorIngestPayload(event.data);
  if (result.value === undefined) throw new Error("Telemetry event data could not be normalized for durable storage");
  return { ...event, data: result.value };
}

// The parse step between wire data and the ClickHouse `data` column: wire data
// always originates from a JSON request body (or in-repo JSON literals), so the
// serializability check never fails in practice — it is what lets the storable
// value carry a precise Json type through the writers instead of `unknown`.
function toStorableTelemetryData(data: unknown): { [key: string]: Json } {
  if (!isJsonSerializable(data)) throw new Error("Telemetry event data must be JSON-serializable");
  if (data !== null && typeof data === "object" && !Array.isArray(data)) return data;
  return { "$value": data };
}

function scrubBatchMessage(message: string): string {
  const result = scrubErrorIngestPayload(message);
  if (typeof result.value !== "string") throw new Error("Telemetry log message could not be normalized for durable storage");
  return result.value;
}

function serializeErrorEnvelope(data: unknown): string {
  const serialized = JSON.stringify(normalizeErrorEnvelope(data));
  return stripLoneSurrogates(serialized);
}

function requireLogMessage(event: BatchEventWireItem): string {
  if (event.message === undefined) throw new Error("$log event is missing its validated message");
  return event.message;
}

function readBooleanField(data: unknown, key: string): boolean | null {
  const value = isRecord(data) ? data[key] : undefined;
  return typeof value === "boolean" ? value : null;
}

function requireBooleanField(data: unknown, key: string): boolean {
  const value = readBooleanField(data, key);
  if (value === null) {
    throw new StatusError(StatusError.BadRequest, `$error event is missing a boolean ${key} field`);
  }
  return value;
}

function readStringField(data: unknown, key: string): string | null {
  const value = isRecord(data) ? data[key] : undefined;
  return typeof value === "string" ? value : null;
}

type ErrorGroupingFields = ReturnType<typeof buildErrorGroupingFields>;

type GroupedErrorOccurrence = {
  event: BatchEventWireItem,
  grouping: ReturnType<typeof computeGrouping>,
  occurrenceId: string,
};

function buildErrorGroupingFields(event: BatchEventWireItem, context: Pick<BatchSignalContext, "runtime">, groupingConfig: GroupingConfigResolution) {
  const name = readStringField(event.data, "name") ?? "Error";
  const message = readStringField(event.data, "message") ?? "";
  const stack = readStringField(event.data, "stack");
  const synthetic = readBooleanField(event.data, "synthetic") === true;
  const level = event.level ?? "error";

  const grouping = computeGroupingWithReadableConfigs({
    type: name,
    message,
    stack,
    platform: context.runtime === "browser" ? "javascript" : "node",
    fingerprint: readGroupingFingerprint(event.data),
    synthetic,
  }, groupingConfig);
  const groupingProvenance = getGroupingHashProvenance(grouping);

  return {
    grouping,
    columns: {
      issue_hash: grouping.ownerHash,
      issue_hashes: [grouping.ownerHash, ...grouping.aliasHashes],
      issue_grouping_config: grouping.configId,
      issue_variant: grouping.variant,
      issue_grouping_provenance: serializeGroupingProvenance(groupingProvenance),
      grouping_degraded: grouping.variant === "degraded" ? 1 : 0,
      error_type: name,
      error_culprit: grouping.culprit,
      error_frames: JSON.stringify(grouping.frames),
      error_envelope: serializeErrorEnvelope(event.data),
      message: truncateUtf8Bytes(stripLoneSurrogates(message), TELEMETRY_MAX_LOG_MESSAGE_BYTES),
      level,
    },
  };
}

export function normalizeErrorOccurrence(
  event: BatchEventWireItem,
  context: {
    runtime: BatchSignalContext["runtime"],
    serviceName: string | null,
    deploymentEnvironmentName: string | null,
    groupingConfig?: GroupingRuntimeConfig,
  },
  batchId: string,
  ordinal: number,
) {
  if (event.event_type !== "$error") throw new Error("normalizeErrorOccurrence requires a $error event");
  const errorFields = buildErrorGroupingFields(event, context, resolveGroupingConfig(context.groupingConfig));
  const issueInput = collectIssueInputs([{
    event,
    grouping: errorFields.grouping,
    occurrenceId: computeOccurrenceId(batchId, ordinal),
  }], context)[0] ?? throwErr("collectIssueInputs must produce one issue input for one grouped occurrence");
  return {
    columns: {
      occurrence_id: computeOccurrenceId(batchId, ordinal),
      batch_id: batchId,
      ...errorFields.columns,
    },
    issueInput,
  };
}

function buildBaseEventRow(event: BatchEventWireItem, context: BatchSignalContext) {
  {
    const resourceFields = context.resource === null ? null : buildTelemetryResourceFields(context.resource);
    return {
      event_type: event.event_type,
      event_at: new Date(event.event_at_ms),
      data: stripLoneSurrogates(toStorableTelemetryData(event.data)),
      producer: context.producer,
      runtime: context.runtime,
      ...resourceFields,
      project_id: context.projectId,
      branch_id: context.branchId,
      user_id: context.userId,
      team_id: null,
      refresh_token_id: context.refreshTokenId,
      session_replay_id: context.sessionReplayId,
      session_replay_segment_id: context.sessionReplaySegmentId,
      trace_id: event.trace_id ?? null,
      span_id: event.span_id ?? null,
      page_view_span_id: event.page_view_span_id ?? null,
    };
  }
}

function buildLogRow(
  event: BatchEventWireItem,
  context: BatchSignalContext,
  occurrenceId: string,
  batchId: string,
  errorFields: ErrorGroupingFields | null,
) {
  const otelBase = buildBaseEventRow(event, context);
  return {
    ...otelBase,
    occurrence_id: occurrenceId,
    batch_id: batchId,
    body: JSON.stringify(event.event_type === "$log"
      ? { type: "string", value: stripLoneSurrogates(scrubBatchMessage(requireLogMessage(event))) }
      : { type: "null", value: null }),
    data: stripLoneSurrogates(toStorableTelemetryData(event.data)),
    level: event.event_type === "$log" ? event.level : "",
    error_envelope: "{}",
    ...errorFields?.columns,
  };
}

function collectIssueInputs(grouped: readonly GroupedErrorOccurrence[], context: {
  runtime: BatchSignalContext["runtime"],
  serviceName: string | null,
  deploymentEnvironmentName: string | null,
}): IssueBatchDelta[] {
  const byHash = new Map<string, IssueBatchDelta>();

  for (const { event, grouping, occurrenceId } of grouped) {
    const eventAt = new Date(event.event_at_ms);
    const existing = byHash.get(grouping.ownerHash);
    if (existing !== undefined) {
      existing.count += 1;
      if (eventAt < existing.firstEventAt) existing.firstEventAt = eventAt;
      if (eventAt > existing.lastEventAt) existing.lastEventAt = eventAt;
      existing.aliasHashes = [...new Set([...existing.aliasHashes, ...grouping.aliasHashes])];
      const incomingProvenance = getGroupingHashProvenance(grouping);
      for (const candidate of incomingProvenance) {
        const alreadyRecorded = existing.groupingProvenance.some((recorded) =>
          serializeGroupingProvenance([recorded]) === serializeGroupingProvenance([candidate])
        );
        if (!alreadyRecorded) existing.groupingProvenance.push(candidate);
      }
      continue;
    }
    const groupingProvenance = getGroupingHashProvenance(grouping);
    byHash.set(grouping.ownerHash, {
      ownerHash: grouping.ownerHash,
      aliasHashes: grouping.aliasHashes,
      occurrenceId,
      groupingConfigId: grouping.configId,
      groupingProvenance,
      type: readStringField(event.data, "name") ?? "Error",
      value: readStringField(event.data, "message") ?? "",
      culprit: grouping.culprit,
      platform: context.runtime === "browser" ? "javascript" : "node",
      count: 1,
      firstEventAt: eventAt,
      lastEventAt: eventAt,
      serviceName: context.serviceName,
      deploymentEnvironmentName: context.deploymentEnvironmentName,
      release: readStringField(event.data, "release"),
      level: event.level ?? readStringField(event.data, "level") ?? "error",
      handled: requireBooleanField(event.data, "handled"),
      synthetic: readBooleanField(event.data, "synthetic") === true,
    });
  }

  return [...byHash.values()];
}

export function normalizeBatchEvents(
  events: BatchEventWireItem[],
  context: BatchSignalContext,
  batchId: string,
): NormalizedEventBatch {
  const groupingConfig = resolveGroupingConfig(context.groupingConfig);
  const grouped: GroupedErrorOccurrence[] = [];

  const productEvents: ReturnType<typeof buildBaseEventRow>[] = [];
  const logOccurrences: ReturnType<typeof buildLogRow>[] = [];

  events.forEach((rawEvent, ordinal) => {
    if (getTelemetryLens(rawEvent.event_type) === "product") {
      productEvents.push(buildBaseEventRow(rawEvent, context));
      return;
    }
    const event = scrubBatchEvent(rawEvent);
    const occurrenceId = getOccurrenceId(event, batchId, ordinal);
    const errorFields = event.event_type === "$error"
      ? buildErrorGroupingFields(event, context, groupingConfig)
      : null;
    if (errorFields !== null) {
      grouped.push({
        event,
        grouping: errorFields.grouping,
        occurrenceId,
      });
    }
    logOccurrences.push(buildLogRow(event, context, occurrenceId, batchId, errorFields));
  });

  return { productEvents, logOccurrences, issueInputs: collectIssueInputs(grouped, {
    runtime: context.runtime,
    serviceName: context.resource?.service.name ?? null,
    deploymentEnvironmentName: context.resource?.deploymentEnvironmentName ?? null,
  }) };
}

export function buildTelemetryWritePlan(
  normalized: NormalizedEventBatch,
  batchId: string,
): NativeTelemetryWritePlan {
  return {
    batchId,
    destinations: [{
      table: "analytics_internal.events",
      values: [...normalized.productEvents, ...normalized.logOccurrences],
      deduplicationToken: getBatchDeduplicationToken(batchId),
    }],
    issueInputs: normalized.issueInputs,
  };
}

export async function insertBatchEvents(
  clickhouseClient: ClickHouseClient,
  plan: NativeTelemetryWritePlan,
): Promise<void> {
  await writeTelemetryDestinations(clickhouseClient, plan.destinations);
}

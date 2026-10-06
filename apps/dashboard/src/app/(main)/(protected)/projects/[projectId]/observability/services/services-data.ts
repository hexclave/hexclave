import {
  parseServiceIdentityRow,
  serviceIdentityEquals,
  serviceIdentityLabel,
  type ServiceIdentity,
} from "../service-identity";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import type { RowData } from "../../analytics/shared";
import { isObservabilityTimeRangeHours, type ObservabilityTimeRangeHours } from "../filters";
import { getBucketGranularity, type BucketGranularity } from "../bucket-granularity";

export type ServiceTimeRangeHours = ObservabilityTimeRangeHours;

export const DEFAULT_SERVICE_TIME_RANGE_HOURS: ServiceTimeRangeHours = 24;

export const MAX_TIMELINE_SERVICES = 50;

function assertServiceTimeRange(hours: number): asserts hours is ServiceTimeRangeHours {
  if (!isObservabilityTimeRangeHours(hours)) {
    throw new Error(`Unsupported services time range: ${hours}`);
  }
}

export type ServiceSummary = {
  identity: ServiceIdentity,
  spanCount: number,
  traceCount: number,
  requestCount: number,
  errorCount: number,
  openSpanCount: number,
  instanceCount: number,
  p95DurationMs: number | null,
  baselineRequestCount: number,
  baselineErrorCount: number,
  baselineP95DurationMs: number | null,
  sampledSpanCount: number,
  lastSeenAt: string,
  lastErrorAt: string | null,
};

export type ServiceDependency = {
  source: ServiceIdentity,
  target: ServiceIdentity,
  callCount: number,
  errorCount: number,
  p95DurationMs: number | null,
};

export type ServiceTimelineBucket = {
  bucketMs: number,
  requestCount: number,
  errorCount: number,
};

export type ServiceTimeline = {
  identity: ServiceIdentity,
  buckets: ServiceTimelineBucket[],
};

export type ServiceBucketGranularity = BucketGranularity;

export const getServiceBucketGranularity = getBucketGranularity;

function errorPredicateSql(statusColumn: string, dataColumn: string): string {
  return `(
    ${statusColumn} = 'error'
    OR JSONExtractUInt(${dataColumn}, 'http.response.status_code') >= 500
    OR JSONExtractUInt(${dataColumn}, 'http.status_code') >= 500
  )`;
}

const SPAN_ERROR_SQL = errorPredicateSql("status_code", "data");

const REQUEST_SPAN_SQL = "kind IN ('server', 'client')";
const REQUEST_ERROR_SQL = `${REQUEST_SPAN_SQL} AND ${SPAN_ERROR_SQL}`;

export function getServicesSummaryQuery(hours: number): {
  query: string,
  params: Record<string, number>,
} {
  assertServiceTimeRange(hours);
  return {
    query: `
/* services:summary */
WITH
  now64(3) AS range_end,
  range_end - INTERVAL {hours:UInt32} HOUR AS range_start,
  range_start - INTERVAL {hours:UInt32} HOUR AS baseline_start
SELECT
  coalesce(service_namespace, '') AS service_namespace,
  service_name,
  countIf(started_at >= range_start) AS span_count,
  uniqCombined64If(trace_id, started_at >= range_start) AS trace_count,
  countIf(${REQUEST_SPAN_SQL} AND started_at >= range_start) AS request_count,
  countIf(${REQUEST_ERROR_SQL} AND started_at >= range_start) AS error_count,
  countIf(ended_at IS NULL AND started_at >= range_start) AS open_span_count,
  uniqIf(
    service_instance_id,
    service_instance_id IS NOT NULL AND service_instance_id != '' AND started_at >= range_start
  ) AS instance_count,
  countIf(producer = 'hexclave-backend' AND started_at >= range_start) AS sampled_span_count,
  countIf(${REQUEST_SPAN_SQL} AND started_at < range_start) AS baseline_request_count,
  countIf(${REQUEST_ERROR_SQL} AND started_at < range_start) AS baseline_error_count,
  if(
    countIf(${REQUEST_SPAN_SQL} AND ended_at IS NOT NULL AND ended_at >= started_at AND started_at >= range_start) = 0,
    NULL,
    round(quantileTDigestIf(0.95)(
      dateDiff('microsecond', started_at, ended_at) / 1000,
      ${REQUEST_SPAN_SQL} AND ended_at IS NOT NULL AND ended_at >= started_at AND started_at >= range_start
    ), 2)
  ) AS p95_duration_ms,
  if(
    countIf(${REQUEST_SPAN_SQL} AND ended_at IS NOT NULL AND ended_at >= started_at AND started_at < range_start) = 0,
    NULL,
    round(quantileTDigestIf(0.95)(
      dateDiff('microsecond', started_at, ended_at) / 1000,
      ${REQUEST_SPAN_SQL} AND ended_at IS NOT NULL AND ended_at >= started_at AND started_at < range_start
    ), 2)
  ) AS baseline_p95_duration_ms,
  max(started_at) AS last_seen_at,
  if(
    countIf(${REQUEST_ERROR_SQL} AND started_at >= range_start) = 0,
    NULL,
    maxIf(started_at, ${REQUEST_ERROR_SQL} AND started_at >= range_start)
  ) AS last_error_at
FROM default.spans
WHERE started_at >= baseline_start
  AND service_name IS NOT NULL
  AND service_name != ''
GROUP BY service_namespace, service_name
ORDER BY request_count DESC, span_count DESC, service_namespace ASC, service_name ASC
LIMIT 500
`,
    params: { hours },
  };
}

export function getServiceTimelineQuery(hours: number): {
  query: string,
  params: Record<string, number>,
} {
  assertServiceTimeRange(hours);
  const granularity = getServiceBucketGranularity(hours);
  return {
    query: `
/* services:timeline */
WITH
  toStartOfInterval(now64(3), ${granularity.stepSql}) AS current_bucket_start,
  current_bucket_start - ${granularity.historySql} AS range_start,
  current_bucket_start + ${granularity.stepSql} AS range_end,
  top_services AS (
    SELECT
      coalesce(service_namespace, '') AS top_service_namespace,
      service_name AS top_service_name
    FROM default.spans
    WHERE started_at >= range_start
      AND started_at < range_end
      AND service_name IS NOT NULL
      AND service_name != ''
    GROUP BY top_service_namespace, top_service_name
    ORDER BY count() DESC
    LIMIT ${MAX_TIMELINE_SERVICES}
  )
SELECT
  coalesce(spans.service_namespace, '') AS service_namespace,
  spans.service_name AS service_name,
  toStartOfInterval(spans.started_at, ${granularity.stepSql}) AS bucket_start,
  countIf(${REQUEST_SPAN_SQL}) AS request_count,
  countIf(${REQUEST_ERROR_SQL}) AS error_count
FROM default.spans AS spans
INNER JOIN top_services
  ON coalesce(spans.service_namespace, '') = top_services.top_service_namespace
  AND spans.service_name = top_services.top_service_name
WHERE spans.started_at >= range_start
  AND spans.started_at < range_end
GROUP BY service_namespace, service_name, bucket_start
ORDER BY service_namespace ASC, service_name ASC, bucket_start ASC
`,
    params: { hours },
  };
}

export function getServiceDependenciesQuery(hours: number): {
  query: string,
  params: Record<string, number>,
} {
  assertServiceTimeRange(hours);
  return {
    query: `
/* services:dependencies */
WITH
now64(3) - INTERVAL {hours:UInt32} HOUR AS range_start,
-- trace_services has one row per trace/service identity, so single-service
-- traces cannot contain a dependency edge and need not enter the span join.
multi_service_traces AS (
  SELECT trace_id
  FROM default.trace_services
  GROUP BY trace_id
  HAVING count() > 1
),
child_spans AS (
  SELECT
    trace_id,
    parent_span_id,
    coalesce(service_namespace, '') AS service_namespace,
    service_name,
    started_at,
    ended_at,
    status_code,
    data
  FROM default.spans
  WHERE trace_id IN multi_service_traces
    AND started_at >= range_start
    AND parent_span_id IS NOT NULL
    AND service_name IS NOT NULL
    AND service_name != ''
),
-- Keep the hash-table side of this high-cardinality join identity-only. A
-- shared projection would make ClickHouse retain every parent's payload data.
parent_spans AS (
  SELECT
    trace_id,
    span_id,
    coalesce(service_namespace, '') AS service_namespace,
    service_name
  FROM default.spans
  WHERE trace_id IN multi_service_traces
    AND started_at >= range_start
    AND service_name IS NOT NULL
    AND service_name != ''
),
dependency_edges AS (
  SELECT
    parent.service_namespace AS source_service_namespace,
    parent.service_name AS source_service_name,
    child.service_namespace AS target_service_namespace,
    child.service_name AS target_service_name,
    child.started_at AS edge_started_at,
    child.ended_at AS edge_ended_at,
    child.status_code AS edge_status_code,
    child.data AS edge_data
  FROM child_spans AS child
  INNER JOIN parent_spans AS parent
    ON child.trace_id = parent.trace_id
    AND child.parent_span_id = parent.span_id
  WHERE (
      child.service_namespace != parent.service_namespace
      OR child.service_name != parent.service_name
    )
)
SELECT
  source_service_namespace,
  source_service_name,
  target_service_namespace,
  target_service_name,
  count() AS call_count,
  countIf(${errorPredicateSql("edge_status_code", "edge_data")}) AS error_count,
  if(
    countIf(edge_ended_at IS NOT NULL AND edge_ended_at >= edge_started_at) = 0,
    NULL,
    round(quantileTDigestIf(0.95)(
      dateDiff('microsecond', edge_started_at, edge_ended_at) / 1000,
      edge_ended_at IS NOT NULL AND edge_ended_at >= edge_started_at
    ), 2)
  ) AS p95_duration_ms
FROM dependency_edges
GROUP BY
  source_service_namespace,
  source_service_name,
  target_service_namespace,
  target_service_name
ORDER BY call_count DESC
LIMIT 500
`,
    params: { hours },
  };
}

function requiredNumber(row: RowData, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Analytics ${key} must be a finite number`);
  }
  return value;
}

function optionalNumber(row: RowData, key: string): number | null {
  const value = row[key];
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Analytics ${key} must be a finite number or null`);
  }
  return value;
}

function requiredString(row: RowData, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`Analytics ${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(row: RowData, key: string): string | null {
  const value = row[key];
  if (value == null) return null;
  if (typeof value !== "string" || value === "") {
    throw new Error(`Analytics ${key} must be a non-empty string or null`);
  }
  return value;
}

export function parseServiceSummaryRow(row: RowData): ServiceSummary {
  return {
    identity: parseServiceIdentityRow(row),
    spanCount: requiredNumber(row, "span_count"),
    traceCount: requiredNumber(row, "trace_count"),
    requestCount: requiredNumber(row, "request_count"),
    errorCount: requiredNumber(row, "error_count"),
    openSpanCount: requiredNumber(row, "open_span_count"),
    instanceCount: requiredNumber(row, "instance_count"),
    p95DurationMs: optionalNumber(row, "p95_duration_ms"),
    baselineRequestCount: requiredNumber(row, "baseline_request_count"),
    baselineErrorCount: requiredNumber(row, "baseline_error_count"),
    baselineP95DurationMs: optionalNumber(row, "baseline_p95_duration_ms"),
    sampledSpanCount: requiredNumber(row, "sampled_span_count"),
    lastSeenAt: requiredString(row, "last_seen_at"),
    lastErrorAt: optionalString(row, "last_error_at"),
  };
}

export function parseServiceDependencyRow(row: RowData): ServiceDependency {
  return {
    source: parseServiceIdentityRow({
      service_namespace: row.source_service_namespace,
      service_name: row.source_service_name,
    }),
    target: parseServiceIdentityRow({
      service_namespace: row.target_service_namespace,
      service_name: row.target_service_name,
    }),
    callCount: requiredNumber(row, "call_count"),
    errorCount: requiredNumber(row, "error_count"),
    p95DurationMs: optionalNumber(row, "p95_duration_ms"),
  };
}

export function parseServiceTimestamp(value: string): Date {
  const trimmed = value.trim();
  const normalized = trimmed.replace(" ", "T")
    + (trimmed.includes("Z") || trimmed.includes("+") ? "" : "Z");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid service timestamp: ${value}`);
  }
  return date;
}

export function buildServiceTimelines(
  rows: readonly RowData[],
  hours: ServiceTimeRangeHours,
  nowMs: number,
): Map<string, ServiceTimeline> {
  const granularity = getServiceBucketGranularity(hours);
  const latestBucketMs = Math.floor(nowMs / granularity.stepMs) * granularity.stepMs;
  const earliestBucketMs = latestBucketMs - (granularity.bucketCount - 1) * granularity.stepMs;

  const timelines = new Map<string, ServiceTimeline>();
  for (const row of rows) {
    const identity = parseServiceIdentityRow(row);
    const bucketMs = parseServiceTimestamp(requiredString(row, "bucket_start")).getTime();
    if (bucketMs < earliestBucketMs || bucketMs > latestBucketMs) continue;

    const key = serviceIdentityLabel(identity);
    let timeline = timelines.get(key);
    if (timeline == null) {
      timeline = {
        identity,
        buckets: Array.from({ length: granularity.bucketCount }, (_unused, index) => ({
          bucketMs: earliestBucketMs + index * granularity.stepMs,
          requestCount: 0,
          errorCount: 0,
        })),
      };
      timelines.set(key, timeline);
    }

    const index = (bucketMs - earliestBucketMs) / granularity.stepMs;
    if (!Number.isInteger(index)) {
      throw new Error(`Service timeline bucket ${bucketMs} is not aligned to the ${granularity.label} grid`);
    }
    const bucket = timeline.buckets[index];
    bucket.requestCount += requiredNumber(row, "request_count");
    bucket.errorCount += requiredNumber(row, "error_count");
  }
  return timelines;
}

export function serviceErrorRate(summary: ServiceSummary): number | null {
  if (summary.sampledSpanCount > 0) return null;
  if (summary.requestCount === 0) return null;
  return summary.errorCount / summary.requestCount;
}

export type ServiceAttentionReason =
  | "error-burst"
  | "new-errors"
  | "error-spike"
  | "latency-regression"
  | "went-silent";

export type ServiceAttentionSignal = {
  identity: ServiceIdentity,
  summary: ServiceSummary,
  reasons: ServiceAttentionReason[],
  score: number,
  latestBucketErrorCount: number | null,
};

export const ATTENTION_THRESHOLDS = {
  minSpikeErrors: 5,
  spikeRatio: 2,
  minBurstErrors: 3,
  burstRatio: 3,
  latencyRegressionRatio: 1.5,
  minLatencyRegressionMs: 50,
  minSilentBaselineRequests: 20,
} as const;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function detectServiceAttention(
  summary: ServiceSummary,
  timeline: ServiceTimeline | null,
): ServiceAttentionSignal | null {
  const reasons: ServiceAttentionReason[] = [];
  let score = 0;

  const latestBucket = timeline == null ? null : timeline.buckets.at(-1) ?? null;
  const latestBucketErrorCount = latestBucket?.errorCount ?? null;

  if (timeline != null && latestBucket != null) {
    const priorErrorCounts = timeline.buckets.slice(0, -1).map((bucket) => bucket.errorCount);
    const typicalErrors = median(priorErrorCounts);
    if (
      latestBucket.errorCount >= ATTENTION_THRESHOLDS.minBurstErrors
      && latestBucket.errorCount >= Math.max(1, typicalErrors) * ATTENTION_THRESHOLDS.burstRatio
    ) {
      reasons.push("error-burst");
      score += 1000 + latestBucket.errorCount;
    }
  }

  if (summary.baselineErrorCount === 0 && summary.errorCount >= ATTENTION_THRESHOLDS.minSpikeErrors) {
    reasons.push("new-errors");
    score += 500 + summary.errorCount;
  } else if (
    summary.errorCount >= ATTENTION_THRESHOLDS.minSpikeErrors
    && summary.errorCount >= summary.baselineErrorCount * ATTENTION_THRESHOLDS.spikeRatio
    && summary.baselineErrorCount > 0
  ) {
    reasons.push("error-spike");
    score += 300 + summary.errorCount;
  }

  if (
    summary.p95DurationMs != null
    && summary.baselineP95DurationMs != null
    && summary.p95DurationMs >= summary.baselineP95DurationMs * ATTENTION_THRESHOLDS.latencyRegressionRatio
    && summary.p95DurationMs - summary.baselineP95DurationMs >= ATTENTION_THRESHOLDS.minLatencyRegressionMs
  ) {
    reasons.push("latency-regression");
    score += 200 + (summary.p95DurationMs - summary.baselineP95DurationMs);
  }

  if (
    summary.requestCount === 0
    && summary.baselineRequestCount >= ATTENTION_THRESHOLDS.minSilentBaselineRequests
  ) {
    reasons.push("went-silent");
    score += 400 + summary.baselineRequestCount;
  }

  if (reasons.length === 0) return null;
  return {
    identity: summary.identity,
    summary,
    reasons,
    score,
    latestBucketErrorCount,
  };
}

export function rankServiceAttention(
  summaries: readonly ServiceSummary[],
  timelines: ReadonlyMap<string, ServiceTimeline>,
): ServiceAttentionSignal[] {
  return summaries
    .map((summary) => detectServiceAttention(summary, timelines.get(serviceIdentityLabel(summary.identity)) ?? null))
    .filter((signal): signal is ServiceAttentionSignal => signal != null)
    .sort((left, right) => (
      right.score - left.score
      || stringCompare(serviceIdentityLabel(left.identity), serviceIdentityLabel(right.identity))
    ));
}

export function relativeChange(current: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return (current - baseline) / baseline;
}

export function dependenciesForService(
  dependencies: readonly ServiceDependency[],
  identity: ServiceIdentity,
): {
  incoming: ServiceDependency[],
  outgoing: ServiceDependency[],
} {
  return {
    incoming: dependencies.filter((dependency) => serviceIdentityEquals(dependency.target, identity)),
    outgoing: dependencies.filter((dependency) => serviceIdentityEquals(dependency.source, identity)),
  };
}

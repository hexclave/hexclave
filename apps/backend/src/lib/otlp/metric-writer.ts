import { createHash } from "crypto";
import { stripLoneSurrogates, type ClickHouseClient } from "@/lib/clickhouse";
import {
  type CanonicalOtlpExemplar,
  type CanonicalOtlpExponentialHistogramDataPoint,
  type CanonicalOtlpHistogramDataPoint,
  type CanonicalOtlpMetric,
  type CanonicalOtlpMetricData,
  type CanonicalOtlpMetricsRequest,
  type CanonicalOtlpNumberDataPoint,
  type CanonicalOtlpResourceMetrics,
  type CanonicalOtlpScopeMetrics,
  type CanonicalOtlpSummaryDataPoint,
} from "./metrics";
import { attributesJson, scrubOtlpValue, type OtlpTenantContext } from "./trace-writer";
import type { OtlpAttributeValue, OtlpAttributes } from "./json";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import type { Json } from "@hexclave/shared/dist/utils/json";

export type OtlpMetricInsertRow = {
  project_id: string,
  branch_id: string,
  metric_name: string,
  metric_description: string,
  metric_unit: string,
  metric_type: "gauge" | "sum" | "histogram" | "exponential_histogram" | "summary",
  aggregation_temporality: number,
  is_monotonic: number,
  metric_metadata: string,
  resource_attributes: string,
  resource_dropped_attributes: number,
  resource_schema_url: string,
  scope_name: string | null,
  scope_version: string | null,
  scope_attributes: string,
  scope_dropped_attributes: number,
  scope_schema_url: string,
  attributes: string,
  data_point: string,
  start_time_unix_nano: string | null,
  time_unix_nano: string,
  point_flags: number,
  exemplar_trace_id: string | null,
  exemplar_span_id: string | null,
  point_id: string,
  producer: "sdk",
  runtime: "server" | "browser",
  user_id: string | null,
  team_id: null,
  refresh_token_id: string | null,
};

type MetricPoint =
  | CanonicalOtlpNumberDataPoint
  | CanonicalOtlpHistogramDataPoint
  | CanonicalOtlpExponentialHistogramDataPoint
  | CanonicalOtlpSummaryDataPoint;

function stableAttributeValue(value: OtlpAttributeValue): Json {
  if (value.type === "kvlist") return { type: value.type, value: stableAttributes(value.value) };
  if (value.type === "array") return { type: value.type, value: value.value.map(stableAttributeValue) };
  return { type: value.type, value: value.value };
}

function stableAttributes(attributes: OtlpAttributes): Record<string, Json> {
  const entries = [...attributes.entries()].sort(([left], [right]) => stringCompare(left, right));
  return Object.fromEntries(entries.map(([key, entry]) => [key, stableAttributeValue(entry)]));
}

// The canonical metric types keep attributes as Maps, so the trees we hash and
// store mix plain JSON with OtlpAttributes maps until stableValue flattens them.
type StableMetricInput = Json | OtlpAttributes | readonly StableMetricInput[] | { readonly [key: string]: StableMetricInput };

function stableValue(value: StableMetricInput): Json {
  if (value instanceof Map) return stableAttributes(value);
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => stringCompare(left, right)).map(([key, entry]) => [key, stableValue(entry)]));
}

function stableJson(value: StableMetricInput): string {
  return JSON.stringify(stripLoneSurrogates(stableValue(value)));
}

function scrubbedStablePoint(point: MetricPoint): Json {
  const stablePoint: { [key: string]: StableMetricInput } = {
    ...point,
    attributes: scrubOtlpValue(stableAttributes(point.attributes), "OTLP metric point attributes"),
  };
  if ("exemplars" in point) {
    stablePoint.exemplars = point.exemplars.map((pointExemplar) => ({
      ...pointExemplar,
      filteredAttributes: scrubOtlpValue(stableAttributes(pointExemplar.filteredAttributes), "OTLP metric exemplar attributes"),
    }));
  }
  return stableValue(stablePoint);
}

function firstExemplar(point: MetricPoint): CanonicalOtlpExemplar | null {
  if (!("exemplars" in point)) return null;
  return point.exemplars[0] ?? null;
}

function metricType(data: CanonicalOtlpMetricData): OtlpMetricInsertRow["metric_type"] {
  if (data.type === "exponentialHistogram") return "exponential_histogram";
  return data.type;
}

function pointId(
  resourceMetrics: CanonicalOtlpResourceMetrics,
  scopeMetric: CanonicalOtlpScopeMetrics,
  metric: CanonicalOtlpMetric,
  data: CanonicalOtlpMetricData,
  point: MetricPoint,
  tenant: OtlpTenantContext,
): string {
  return createHash("sha256").update(stableJson({
    projectId: tenant.projectId,
    branchId: tenant.branchId,
    resource: {
      attributes: resourceMetrics.resource.attributes,
      schemaUrl: resourceMetrics.schemaUrl,
    },
    metric: {
      name: metric.name,
      unit: metric.unit,
      type: data.type,
    },
    scope: {
      name: scopeMetric.scope.name,
      version: scopeMetric.scope.version,
      attributes: scopeMetric.scope.attributes,
      schemaUrl: scopeMetric.schemaUrl,
    },
    point: {
      startTimeUnixNano: point.startTimeUnixNano,
      timeUnixNano: point.timeUnixNano,
      attributes: point.attributes,
    },
  })).digest("hex");
}

function rowForPoint(
  resourceMetrics: CanonicalOtlpResourceMetrics,
  scopeMetric: CanonicalOtlpScopeMetrics,
  metric: CanonicalOtlpMetric,
  data: CanonicalOtlpMetricData,
  point: MetricPoint,
  tenant: OtlpTenantContext,
): OtlpMetricInsertRow {
  const exemplar = firstExemplar(point);
  return {
    project_id: tenant.projectId,
    branch_id: tenant.branchId,
    metric_name: metric.name,
    metric_description: metric.description,
    metric_unit: metric.unit,
    metric_type: metricType(data),
    aggregation_temporality: data.type === "sum" || data.type === "histogram" || data.type === "exponentialHistogram"
      ? data.aggregationTemporality
      : 0,
    is_monotonic: data.type === "sum" && data.isMonotonic ? 1 : 0,
    metric_metadata: attributesJson(metric.metadata),
    resource_attributes: attributesJson(resourceMetrics.resource.attributes),
    resource_dropped_attributes: resourceMetrics.resource.droppedAttributesCount,
    resource_schema_url: resourceMetrics.schemaUrl,
    scope_name: scopeMetric.scope.name === "" ? null : scopeMetric.scope.name,
    scope_version: scopeMetric.scope.version === "" ? null : scopeMetric.scope.version,
    scope_attributes: attributesJson(scopeMetric.scope.attributes),
    scope_dropped_attributes: scopeMetric.scope.droppedAttributesCount,
    scope_schema_url: scopeMetric.schemaUrl,
    attributes: attributesJson(point.attributes),
    data_point: stableJson(scrubbedStablePoint(point)),
    start_time_unix_nano: point.startTimeUnixNano,
    time_unix_nano: point.timeUnixNano,
    point_flags: point.flags,
    exemplar_trace_id: exemplar?.traceId ?? null,
    exemplar_span_id: exemplar?.spanId ?? null,
    point_id: pointId(resourceMetrics, scopeMetric, metric, data, point, tenant),
    producer: "sdk",
    runtime: tenant.userId === null ? "server" : "browser",
    user_id: tenant.userId,
    team_id: null,
    refresh_token_id: tenant.refreshTokenId,
  };
}

function rowsForData(
  resourceMetrics: CanonicalOtlpResourceMetrics,
  scopeMetric: CanonicalOtlpScopeMetrics,
  metric: CanonicalOtlpMetric,
  data: CanonicalOtlpMetricData,
  tenant: OtlpTenantContext,
): OtlpMetricInsertRow[] {
  return data.dataPoints.map((point) => rowForPoint(resourceMetrics, scopeMetric, metric, data, point, tenant));
}

export function buildOtlpMetricRows(request: CanonicalOtlpMetricsRequest, tenant: OtlpTenantContext): OtlpMetricInsertRow[] {
  return request.resourceMetrics.flatMap((resourceMetrics) => resourceMetrics.scopeMetrics.flatMap((scopeMetric) => scopeMetric.metrics.flatMap((metric) => rowsForData(resourceMetrics, scopeMetric, metric, metric.data, tenant))));
}

export function getOtlpMetricsDeduplicationToken(rows: OtlpMetricInsertRow[], tenant: OtlpTenantContext): string {
  return createHash("sha256").update(stableJson({
    tenant: {
      projectId: tenant.projectId,
      branchId: tenant.branchId,
      userId: tenant.userId,
      refreshTokenId: tenant.refreshTokenId,
    },
    rows,
  })).digest("hex");
}

export async function insertOtlpMetrics(client: ClickHouseClient, request: CanonicalOtlpMetricsRequest, tenant: OtlpTenantContext): Promise<void> {
  const rows = buildOtlpMetricRows(request, tenant);
  if (rows.length === 0) return;
  await client.insert({
    table: "analytics_internal.metrics",
    values: rows,
    format: "JSONEachRow",
    clickhouse_settings: {
      date_time_input_format: "best_effort",
      async_insert: 0,
      wait_for_async_insert: 1,
      insert_deduplication_token: getOtlpMetricsDeduplicationToken(rows, tenant),
    },
  });
}

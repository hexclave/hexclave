import { getClickhouseAdminClientForMetrics, type ClickHouseClient } from "@/lib/clickhouse";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const OTLP_METRIC_QUERY_HOURS = [1, 24, 168, 720] as const;
export type OtlpMetricQueryHours = (typeof OTLP_METRIC_QUERY_HOURS)[number];

export const OTLP_METRIC_TYPES = ["gauge", "sum", "histogram", "exponential_histogram", "summary"] as const;
export type OtlpMetricType = (typeof OTLP_METRIC_TYPES)[number];

const DEFAULT_HOURS: OtlpMetricQueryHours = 24;
const MAX_CATALOG_ROWS = 200;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const NANOSECONDS_PER_HOUR = 3_600_000_000_000n;
const OTLP_METRIC_QUERY_HOURS_SET = new Set<number>(OTLP_METRIC_QUERY_HOURS);

type OtlpMetricQueryTenancy = {
  project: { id: string },
  branchId: string,
};

type RawCatalogRow = {
  metric_name: string,
  metric_description: string,
  metric_unit: string,
  metric_type: string,
  aggregation_temporality: number | string,
  is_monotonic: number | string,
  point_count: number | string,
  latest_time_unix_nano: number | string,
};

type RawSeriesRow = {
  bucket_start_unix_nano: number | string,
  point_count: number | string,
  numeric_value: number | null,
  minimum_value: number | null,
  maximum_value: number | null,
  exemplar_trace_id: string | null,
  exemplar_span_id: string | null,
};

export type OtlpMetricQueryRequest = {
  hours?: number,
  metricName?: string,
  metricType?: string,
};

export type OtlpMetricCatalogEntry = {
  metric_name: string,
  metric_description: string,
  metric_unit: string,
  metric_type: OtlpMetricType,
  aggregation_temporality: number,
  is_monotonic: boolean,
  point_count: number,
  latest_time_unix_nano: string,
  supports_numeric_aggregation: boolean,
};

export type OtlpMetricSeriesPoint = {
  bucket_start_unix_nano: string,
  point_count: number,
  numeric_value: number | null,
  minimum_value: number | null,
  maximum_value: number | null,
  exemplar: {
    trace_id: string,
    span_id: string,
  } | null,
};

export type OtlpMetricQueryResponse = {
  window: {
    start_time_unix_nano: string,
    end_time_unix_nano: string,
    hours: OtlpMetricQueryHours,
  },
  catalog: OtlpMetricCatalogEntry[],
  selected_metric_name: string | null,
  selected_metric_type: OtlpMetricType | null,
  series: OtlpMetricSeriesPoint[],
  partial: {
    has_unsupported_metric_types: boolean,
    unsupported_metric_types: OtlpMetricType[],
  },
};

export function parseOtlpMetricQueryHours(raw: number | undefined): OtlpMetricQueryHours {
  const hours = raw ?? DEFAULT_HOURS;
  if (!Number.isInteger(hours) || !isOtlpMetricQueryHours(hours)) {
    throw new StatusError(StatusError.BadRequest, `hours must be one of ${OTLP_METRIC_QUERY_HOURS.join(", ")}`);
  }
  return hours;
}

function isOtlpMetricQueryHours(value: number): value is OtlpMetricQueryHours {
  return OTLP_METRIC_QUERY_HOURS_SET.has(value);
}

export function parseOtlpMetricQueryType(raw: string | undefined): OtlpMetricType | null {
  if (raw == null) return null;
  if (!isOtlpMetricType(raw)) {
    throw new StatusError(StatusError.BadRequest, `metric_type must be one of ${OTLP_METRIC_TYPES.join(", ")}`);
  }
  return raw;
}

function isOtlpMetricType(value: string): value is OtlpMetricType {
  return OTLP_METRIC_TYPES.some((metricType) => metricType === value);
}

function parseMetricType(raw: string): OtlpMetricType {
  if (!isOtlpMetricType(raw)) {
    throw new Error(`ClickHouse returned an unknown OTLP metric type: ${raw}`);
  }
  return raw;
}

function parseCount(raw: number | string, field: string): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`ClickHouse returned an invalid ${field}: ${String(raw)}`);
  }
  return value;
}

export function parseOtlpMetricUint64(raw: number | string, field: string): string {
  if (typeof raw === "string") {
    if (!/^\d+$/.test(raw)) throw new Error(`ClickHouse returned an invalid ${field}: ${raw}`);
    return raw;
  }
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw new Error(`ClickHouse returned an unsafe ${field}; ClickHouse must serialize UInt64 values as strings`);
  }
  return String(raw);
}

function parseNullableFiniteNumber(raw: number | null, field: string): number | null {
  if (raw === null) return null;
  if (!Number.isFinite(raw)) throw new Error(`ClickHouse returned an invalid ${field}`);
  return raw;
}

export function getOtlpMetricBucketNanoseconds(hours: OtlpMetricQueryHours): bigint {
  if (hours === 1) return 300n * 1_000_000_000n;
  if (hours === 24) return 3_600n * 1_000_000_000n;
  if (hours === 168) return 21_600n * 1_000_000_000n;
  return 86_400n * 1_000_000_000n;
}

function buildOtlpMetricCatalogQuerySql(options: { where: string, limit: number }): string {
  return `
SELECT
  metric_name,
  argMax(metric_description, (time_unix_nano, created_at, point_id)) AS metric_description,
  argMax(metric_unit, (time_unix_nano, created_at, point_id)) AS metric_unit,
  metric_type,
  argMax(aggregation_temporality, (time_unix_nano, created_at, point_id)) AS aggregation_temporality,
  argMax(is_monotonic, (time_unix_nano, created_at, point_id)) AS is_monotonic,
  count() AS point_count,
  toString(max(time_unix_nano)) AS latest_time_unix_nano
FROM analytics_internal.metrics FINAL
PREWHERE ${options.where}
GROUP BY metric_name, metric_type
ORDER BY point_count DESC, metric_name ASC, metric_type ASC
LIMIT ${options.limit}
`;
}

export function buildOtlpMetricCatalogQuery(hours: OtlpMetricQueryHours): string {
  return buildOtlpMetricCatalogQuerySql({
    where: `project_id = {projectId:String}
  AND branch_id = {branchId:String}
  AND time_unix_nano >= toUnixTimestamp64Nano(now64(9) - INTERVAL {hours:UInt32} HOUR)`,
    limit: MAX_CATALOG_ROWS,
  });
}

export function buildOtlpMetricCatalogEntryQuery(withMetricType: boolean): string {
  return buildOtlpMetricCatalogQuerySql({
    where: `project_id = {projectId:String}
  AND branch_id = {branchId:String}
  AND metric_name = {metricName:String}
  ${withMetricType ? "AND metric_type = {metricType:String}" : ""}
  AND time_unix_nano >= toUnixTimestamp64Nano(now64(9) - INTERVAL {hours:UInt32} HOUR)`,
    limit: OTLP_METRIC_TYPES.length,
  });
}

export function buildOtlpMetricSeriesQuery(hours: OtlpMetricQueryHours): string {
  return `
WITH
  intDiv(m.time_unix_nano, {bucketNanoseconds:UInt64}) * {bucketNanoseconds:UInt64} AS bucket_start_unix_nano_value,
  m.metric_type IN ('gauge', 'sum') AND JSONHas(m.data_point, 'value', 'value') AS has_number_value,
  m.metric_type IN ('histogram', 'exponential_histogram', 'summary')
    AND JSONHas(m.data_point, 'count')
    AND JSONExtractString(m.data_point, 'count') != ''
    AND JSONExtractRaw(m.data_point, 'sum') != 'null' AS has_distribution_value,
  m.metric_type IN ('histogram', 'exponential_histogram')
    AND JSONExtractRaw(m.data_point, 'min') != 'null' AS has_distribution_min,
  m.metric_type IN ('histogram', 'exponential_histogram')
    AND JSONExtractRaw(m.data_point, 'max') != 'null' AS has_distribution_max
SELECT
  toString(bucket_start_unix_nano_value) AS bucket_start_unix_nano,
  count() AS point_count,
  if(countIf(has_number_value) > 0,
    avgIf(JSONExtractFloat(m.data_point, 'value', 'value'), has_number_value),
    if(sumIf(toFloat64OrZero(JSONExtractString(m.data_point, 'count')), has_distribution_value) = 0,
      NULL,
      sumIf(JSONExtractFloat(m.data_point, 'sum'), has_distribution_value) / sumIf(toFloat64OrZero(JSONExtractString(m.data_point, 'count')), has_distribution_value)
    )
  ) AS numeric_value,
  if(countIf(has_number_value) > 0,
    minIf(JSONExtractFloat(m.data_point, 'value', 'value'), has_number_value),
    if(countIf(has_distribution_min) = 0, NULL, minIf(JSONExtractFloat(m.data_point, 'min'), has_distribution_min))
  ) AS minimum_value,
  if(countIf(has_number_value) > 0,
    maxIf(JSONExtractFloat(m.data_point, 'value', 'value'), has_number_value),
    if(countIf(has_distribution_max) = 0, NULL, maxIf(JSONExtractFloat(m.data_point, 'max'), has_distribution_max))
  ) AS maximum_value,
  argMaxIf(m.exemplar_trace_id, m.time_unix_nano, m.exemplar_trace_id IS NOT NULL AND m.exemplar_trace_id != '' AND m.exemplar_span_id IS NOT NULL AND m.exemplar_span_id != '') AS exemplar_trace_id,
  argMaxIf(m.exemplar_span_id, m.time_unix_nano, m.exemplar_trace_id IS NOT NULL AND m.exemplar_trace_id != '' AND m.exemplar_span_id IS NOT NULL AND m.exemplar_span_id != '') AS exemplar_span_id
FROM analytics_internal.metrics AS m FINAL
PREWHERE m.project_id = {projectId:String}
  AND m.branch_id = {branchId:String}
  AND m.metric_name = {metricName:String}
  AND m.metric_type = {metricType:String}
  AND m.time_unix_nano >= toUnixTimestamp64Nano(now64(9) - INTERVAL {hours:UInt32} HOUR)
GROUP BY bucket_start_unix_nano_value
ORDER BY bucket_start_unix_nano_value ASC
LIMIT 1000
`;
}

export function parseOtlpMetricCatalogRows(rows: RawCatalogRow[]): OtlpMetricCatalogEntry[] {
  return rows.map((row) => {
    const metricType = parseMetricType(row.metric_type);
    return {
      metric_name: row.metric_name,
      metric_description: row.metric_description,
      metric_unit: row.metric_unit,
      metric_type: metricType,
      aggregation_temporality: parseCount(row.aggregation_temporality, "aggregation_temporality"),
      is_monotonic: parseCount(row.is_monotonic, "is_monotonic") === 1,
      point_count: parseCount(row.point_count, "point_count"),
      latest_time_unix_nano: parseOtlpMetricUint64(row.latest_time_unix_nano, "latest_time_unix_nano"),
      supports_numeric_aggregation: true,
    };
  });
}

export function parseOtlpMetricSeriesRows(rows: RawSeriesRow[]): OtlpMetricSeriesPoint[] {
  return rows.map((row) => {
    const traceId = row.exemplar_trace_id;
    const spanId = row.exemplar_span_id;
    return {
      bucket_start_unix_nano: parseOtlpMetricUint64(row.bucket_start_unix_nano, "bucket_start_unix_nano"),
      point_count: parseCount(row.point_count, "point_count"),
      numeric_value: parseNullableFiniteNumber(row.numeric_value, "numeric_value"),
      minimum_value: parseNullableFiniteNumber(row.minimum_value, "minimum_value"),
      maximum_value: parseNullableFiniteNumber(row.maximum_value, "maximum_value"),
      exemplar: traceId != null && spanId != null && traceId !== "" && spanId !== ""
        ? { trace_id: traceId, span_id: spanId }
        : null,
    };
  });
}

function queryWindow(hours: OtlpMetricQueryHours): OtlpMetricQueryResponse["window"] {
  const end = BigInt(Date.now()) * NANOSECONDS_PER_MILLISECOND;
  return {
    start_time_unix_nano: String(end - BigInt(hours) * NANOSECONDS_PER_HOUR),
    end_time_unix_nano: String(end),
    hours,
  };
}

export async function queryOtlpMetrics(options: {
  tenancy: OtlpMetricQueryTenancy,
  request: OtlpMetricQueryRequest,
  client?: ClickHouseClient,
}): Promise<OtlpMetricQueryResponse> {
  const hours = parseOtlpMetricQueryHours(options.request.hours);
  const requestedType = parseOtlpMetricQueryType(options.request.metricType);
  if (requestedType !== null && options.request.metricName == null) {
    throw new StatusError(StatusError.BadRequest, "metric_type requires metric_name");
  }
  const client = options.client ?? getClickhouseAdminClientForMetrics();
  const query_params = {
    projectId: options.tenancy.project.id,
    branchId: options.tenancy.branchId,
    hours,
  };
  const catalogResult = await client.query({
    query: buildOtlpMetricCatalogQuery(hours),
    query_params,
    format: "JSONEachRow",
  });
  const catalog = parseOtlpMetricCatalogRows(await catalogResult.json<RawCatalogRow>());
  let selected = options.request.metricName == null
    ? catalog[0]
    : catalog.find((entry) => entry.metric_name === options.request.metricName
      && (requestedType === null || entry.metric_type === requestedType));
  if (selected === undefined && options.request.metricName != null) {
    const entryParams: typeof query_params & { metricName: string, metricType?: string } = {
      ...query_params,
      metricName: options.request.metricName,
    };
    if (requestedType !== null) entryParams.metricType = requestedType;
    const entryResult = await client.query({
      query: buildOtlpMetricCatalogEntryQuery(requestedType !== null),
      query_params: entryParams,
      format: "JSONEachRow",
    });
    selected = parseOtlpMetricCatalogRows(await entryResult.json<RawCatalogRow>()).at(0);
    if (selected !== undefined) catalog.push(selected);
  }
  const window = queryWindow(hours);
  const unsupportedMetricTypes = [...new Set(catalog.filter((entry) => !entry.supports_numeric_aggregation).map((entry) => entry.metric_type))];
  if (selected === undefined) {
    return {
      window,
      catalog,
      selected_metric_name: null,
      selected_metric_type: null,
      series: [],
      partial: {
        has_unsupported_metric_types: unsupportedMetricTypes.length > 0,
        unsupported_metric_types: unsupportedMetricTypes,
      },
    };
  }

  const seriesResult = await client.query({
    query: buildOtlpMetricSeriesQuery(hours),
    query_params: {
      ...query_params,
      metricName: selected.metric_name,
      metricType: selected.metric_type,
      bucketNanoseconds: getOtlpMetricBucketNanoseconds(hours).toString(),
    },
    format: "JSONEachRow",
  });
  return {
    window,
    catalog,
    selected_metric_name: selected.metric_name,
    selected_metric_type: selected.metric_type,
    series: parseOtlpMetricSeriesRows(await seriesResult.json<RawSeriesRow>()),
    partial: {
      has_unsupported_metric_types: unsupportedMetricTypes.length > 0,
      unsupported_metric_types: unsupportedMetricTypes,
    },
  };
}

import { isDateValue, parseClickHouseDate, type RowData } from "../../analytics/shared";
import type { ServiceIdentity } from "../service-identity";
import { getBucketGranularity, type BucketGranularity } from "../bucket-granularity";

export type TraceTimeRangeHours = 1 | 24 | 168 | 720;

export type TraceVolumeBucket = {
  bucketMs: number,
  count: number,
};


export function getTraceVolumeQuery(
  hours: TraceTimeRangeHours,
  service: ServiceIdentity | null,
): {
  query: string,
  params: Record<string, string | number>,
} {
  const granularity = getBucketGranularity(hours);
  const serviceCondition = service == null ? "" : `
  AND r.trace_id IN (
    SELECT trace_id
    FROM default.trace_services
    WHERE coalesce(service_namespace, '') = {serviceNamespace:String}
      AND service_name = {serviceName:String}
  )`;

  return {
    query: `
WITH
  toStartOfInterval(now64(3), ${granularity.stepSql}) AS range_end,
  range_end - ${granularity.historySql} AS range_start
SELECT
  toStartOfInterval(r.started_at, ${granularity.stepSql}) AS bucket_start,
  count() AS trace_count
FROM default.trace_roots AS r
WHERE r.started_at >= range_start
  AND r.started_at < range_end + ${granularity.stepSql}
  AND r.page_view_span_id IS NULL
  ${serviceCondition}
GROUP BY bucket_start
ORDER BY bucket_start ASC
WITH FILL
  FROM range_start
  TO range_end + ${granularity.stepSql}
  STEP ${granularity.stepSql}
`,
    params: service == null ? {} : {
      serviceNamespace: service.namespace,
      serviceName: service.name,
    },
  };
}

export function parseTraceVolumeRows(rows: RowData[]): TraceVolumeBucket[] {
  return rows.map((row) => {
    const bucketStart = row.bucket_start;
    const traceCount = typeof row.trace_count === "number"
      ? row.trace_count
      : typeof row.trace_count === "string"
        ? Number(row.trace_count)
        : Number.NaN;
    if (!isDateValue(bucketStart) || !Number.isSafeInteger(traceCount) || traceCount < 0) {
      throw new Error("Trace volume query returned an invalid bucket");
    }
    return {
      bucketMs: parseClickHouseDate(bucketStart).getTime(),
      count: traceCount,
    };
  });
}

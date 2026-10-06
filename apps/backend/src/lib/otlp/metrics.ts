import { isW3cSpanId, isW3cTraceId } from "@hexclave/shared/dist/utils/analytics-wire";
import {
  DEFAULT_OTLP_ATTRIBUTE_LIMITS,
  OtlpJsonRequestError,
  otlpArray,
  otlpRecord,
  otlpString,
  type OtlpAttributeValue,
  type OtlpAttributes,
} from "./json";

export { OtlpJsonRequestError as OtlpMetricsRequestError } from "./json";
export type { OtlpAttributeValue, OtlpAttributes } from "./json";

const MAX_UINT64 = 18_446_744_073_709_551_615n;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MIN_INT64 = -9_223_372_036_854_775_808n;
const MAX_UINT32 = 4_294_967_295n;
const MIN_INT32 = -2_147_483_648;
const MAX_INT32 = 2_147_483_647;

export type OtlpMetricsNormalizationLimits = {
  maxResourceMetrics: number,
  maxScopeMetricsPerResource: number,
  maxMetricsPerScope: number,
  maxDataPointsPerMetric: number,
  maxAttributesPerList: number,
  maxAttributeArrayValues: number,
  maxAttributeDepth: number,
  maxExemplarsPerDataPoint: number,
  maxHistogramBuckets: number,
  maxQuantileValues: number,
};

export const DEFAULT_OTLP_METRICS_NORMALIZATION_LIMITS: OtlpMetricsNormalizationLimits = {
  maxResourceMetrics: 128,
  maxScopeMetricsPerResource: 128,
  maxMetricsPerScope: 1_024,
  maxDataPointsPerMetric: 10_000,
  maxAttributesPerList: DEFAULT_OTLP_ATTRIBUTE_LIMITS.maxAttributesPerList,
  maxAttributeArrayValues: DEFAULT_OTLP_ATTRIBUTE_LIMITS.maxAttributeArrayValues,
  maxAttributeDepth: DEFAULT_OTLP_ATTRIBUTE_LIMITS.maxDepth,
  maxExemplarsPerDataPoint: 256,
  maxHistogramBuckets: 10_000,
  maxQuantileValues: 256,
};

export type CanonicalOtlpResource = {
  attributes: OtlpAttributes,
  droppedAttributesCount: number,
};

export type CanonicalOtlpInstrumentationScope = {
  name: string,
  version: string,
  attributes: OtlpAttributes,
  droppedAttributesCount: number,
};

export type CanonicalOtlpScopeMetrics = {
  scope: CanonicalOtlpInstrumentationScope,
  schemaUrl: string,
  metrics: CanonicalOtlpMetric[],
};

export type CanonicalOtlpResourceMetrics = {
  resource: CanonicalOtlpResource,
  schemaUrl: string,
  scopeMetrics: CanonicalOtlpScopeMetrics[],
};

export type CanonicalOtlpMetricsRequest = {
  resourceMetrics: CanonicalOtlpResourceMetrics[],
};

export type CanonicalOtlpMetricNumber = number | "NaN" | "Infinity" | "-Infinity";

export type CanonicalOtlpMetricValue =
  | { type: "double", value: CanonicalOtlpMetricNumber }
  | { type: "int", value: string };

export type CanonicalOtlpExemplar = {
  filteredAttributes: OtlpAttributes,
  timeUnixNano: string,
  value: CanonicalOtlpMetricValue,
  spanId: string | null,
  traceId: string | null,
};

type CanonicalOtlpDataPointBase = {
  attributes: OtlpAttributes,
  startTimeUnixNano: string | null,
  timeUnixNano: string,
  flags: number,
};

export type CanonicalOtlpNumberDataPoint = CanonicalOtlpDataPointBase & {
  value: CanonicalOtlpMetricValue,
  exemplars: CanonicalOtlpExemplar[],
};

export type CanonicalOtlpHistogramDataPoint = CanonicalOtlpDataPointBase & {
  count: string,
  sum: CanonicalOtlpMetricNumber | null,
  bucketCounts: string[],
  explicitBounds: number[],
  exemplars: CanonicalOtlpExemplar[],
  min: CanonicalOtlpMetricNumber | null,
  max: CanonicalOtlpMetricNumber | null,
};

export type CanonicalOtlpExponentialHistogramBuckets = {
  offset: number,
  bucketCounts: string[],
};

export type CanonicalOtlpExponentialHistogramDataPoint = CanonicalOtlpDataPointBase & {
  count: string,
  sum: CanonicalOtlpMetricNumber | null,
  scale: number,
  zeroCount: string,
  positive: CanonicalOtlpExponentialHistogramBuckets | null,
  negative: CanonicalOtlpExponentialHistogramBuckets | null,
  zeroThreshold: number,
  exemplars: CanonicalOtlpExemplar[],
  min: CanonicalOtlpMetricNumber | null,
  max: CanonicalOtlpMetricNumber | null,
};

export type CanonicalOtlpSummaryQuantile = {
  quantile: number,
  value: number,
};

export type CanonicalOtlpSummaryDataPoint = CanonicalOtlpDataPointBase & {
  count: string,
  sum: CanonicalOtlpMetricNumber,
  quantileValues: CanonicalOtlpSummaryQuantile[],
};

export type OtlpAggregationTemporality = 1 | 2;

export type CanonicalOtlpMetricData =
  | { type: "gauge", dataPoints: CanonicalOtlpNumberDataPoint[] }
  | { type: "sum", dataPoints: CanonicalOtlpNumberDataPoint[], aggregationTemporality: OtlpAggregationTemporality, isMonotonic: boolean }
  | { type: "histogram", dataPoints: CanonicalOtlpHistogramDataPoint[], aggregationTemporality: OtlpAggregationTemporality }
  | { type: "exponentialHistogram", dataPoints: CanonicalOtlpExponentialHistogramDataPoint[], aggregationTemporality: OtlpAggregationTemporality }
  | { type: "summary", dataPoints: CanonicalOtlpSummaryDataPoint[] };

export type CanonicalOtlpMetric = {
  name: string,
  description: string,
  unit: string,
  metadata: OtlpAttributes,
  data: CanonicalOtlpMetricData,
};

function fail(path: string, message: string): never {
  throw new OtlpJsonRequestError(`${path} ${message}`);
}

function recordOrEmpty(value: unknown, path: string): Record<string, unknown> {
  return otlpRecord(value === undefined ? {} : value, path);
}

function repeated(value: unknown, path: string, maximum: number): unknown[] {
  const entries = otlpArray(value === undefined ? [] : value, path);
  if (entries.length > maximum) fail(path, `must contain at most ${maximum} entries`);
  return entries;
}

function uint32(value: unknown, path: string, fallback = 0): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > MAX_UINT32) {
      fail(path, "must be a uint32");
    }
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed > MAX_UINT32) fail(path, "must be a uint32");
    return Number(parsed);
  }
  fail(path, "must be a uint32");
}

function int32(value: unknown, path: string, fallback = 0): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < MIN_INT32 || value > MAX_INT32) {
    fail(path, "must be an int32");
  }
  return value;
}

function boolean(value: unknown, path: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function uint64(value: unknown, path: string, allowZero: boolean): string {
  let normalized: string;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    normalized = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    normalized = String(value);
  } else {
    fail(path, "must be a uint64 decimal string or safe integer");
  }

  const parsed = BigInt(normalized);
  if (parsed > MAX_UINT64) fail(path, "must fit uint64");
  if (!allowZero && parsed === 0n) fail(path, "must be greater than zero");
  return normalized;
}

function int64(value: unknown, path: string): string {
  let normalized: string;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    normalized = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    normalized = String(value);
  } else {
    fail(path, "must be an int64 decimal string or safe integer");
  }

  const parsed = BigInt(normalized);
  if (parsed < MIN_INT64 || parsed > MAX_INT64) fail(path, "must fit int64");
  return normalized;
}

function metricDouble(value: unknown, path: string): CanonicalOtlpMetricNumber {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    return value;
  }
  if (value === "NaN" || value === "Infinity" || value === "-Infinity") return value;
  fail(path, "must be a finite number or an OTLP special double string");
}

function finiteDouble(value: unknown, path: string): number {
  const normalized = metricDouble(value, path);
  if (typeof normalized !== "number" || !Number.isFinite(normalized)) {
    fail(path, "must be finite");
  }
  return normalized;
}

function optionalDouble(value: unknown, path: string): CanonicalOtlpMetricNumber | null {
  return value === undefined ? null : metricDouble(value, path);
}

function metricAttributes(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits, depth = 0): OtlpAttributes {
  const result = new Map<string, OtlpAttributeValue>();
  if (depth > limits.maxAttributeDepth) fail(path, `exceeds the maximum attribute depth of ${limits.maxAttributeDepth}`);
  for (const [index, rawEntry] of repeated(value, path, limits.maxAttributesPerList).entries()) {
    const entryPath = `${path}[${index}]`;
    const entry = otlpRecord(rawEntry, entryPath);
    const key = otlpString(entry.key, `${entryPath}.key`);
    if (key.length === 0) fail(`${entryPath}.key`, "must not be empty");
    if (result.has(key)) fail(path, `contains duplicate key ${JSON.stringify(key)}`);
    result.set(key, metricAnyValue(entry.value, `${entryPath}.value`, limits, depth));
  }
  return result;
}

function metricAnyValue(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits, depth: number): OtlpAttributeValue {
  if (depth > limits.maxAttributeDepth) fail(path, `exceeds the maximum attribute depth of ${limits.maxAttributeDepth}`);
  const item = otlpRecord(value, path);
  const present = ["stringValue", "boolValue", "intValue", "doubleValue", "arrayValue", "kvlistValue", "bytesValue"]
    .filter((key) => item[key] !== undefined);
  if (present.length === 0) return { type: "null", value: null };
  if (present.length !== 1) fail(path, "must contain exactly one AnyValue field");
  const field = present[0];
  if (field === "stringValue") return { type: "string", value: otlpString(item.stringValue, `${path}.stringValue`) };
  if (field === "boolValue") {
    if (typeof item.boolValue !== "boolean") fail(`${path}.boolValue`, "must be a boolean");
    return { type: "boolean", value: item.boolValue };
  }
  if (field === "intValue") return { type: "int", value: int64(item.intValue, `${path}.intValue`) };
  if (field === "doubleValue") return { type: "double", value: finiteDouble(item.doubleValue, `${path}.doubleValue`) };
  if (field === "bytesValue") return { type: "bytes", value: otlpString(item.bytesValue, `${path}.bytesValue`) };
  if (field === "arrayValue") {
    const arrayValue = recordOrEmpty(item.arrayValue, `${path}.arrayValue`);
    const values = repeated(arrayValue.values, `${path}.arrayValue.values`, limits.maxAttributeArrayValues)
      .map((entry, index) => metricAnyValue(entry, `${path}.arrayValue.values[${index}]`, limits, depth + 1));
    return { type: "array", value: values };
  }
  const kvlistValue = recordOrEmpty(item.kvlistValue, `${path}.kvlistValue`);
  return {
    type: "kvlist",
    value: metricAttributes(kvlistValue.values, `${path}.kvlistValue.values`, limits, depth + 1),
  };
}

function resource(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpResource {
  const raw = recordOrEmpty(value, path);
  return {
    attributes: metricAttributes(raw.attributes, `${path}.attributes`, limits),
    droppedAttributesCount: uint32(raw.droppedAttributesCount, `${path}.droppedAttributesCount`),
  };
}

function scope(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpInstrumentationScope {
  const raw = recordOrEmpty(value, path);
  return {
    name: otlpString(raw.name, `${path}.name`, ""),
    version: otlpString(raw.version, `${path}.version`, ""),
    attributes: metricAttributes(raw.attributes, `${path}.attributes`, limits),
    droppedAttributesCount: uint32(raw.droppedAttributesCount, `${path}.droppedAttributesCount`),
  };
}

function aggregationTemporality(value: unknown, path: string): OtlpAggregationTemporality {
  if (value !== 1 && value !== 2) fail(path, "must be OTLP DELTA (1) or CUMULATIVE (2)");
  return value;
}

function metricValue(value: Record<string, unknown>, path: string): CanonicalOtlpMetricValue {
  const hasDouble = value.asDouble !== undefined;
  const hasInt = value.asInt !== undefined;
  if (hasDouble === hasInt) fail(path, "must contain exactly one of asDouble or asInt");
  if (hasDouble) return { type: "double", value: metricDouble(value.asDouble, `${path}.asDouble`) };
  return { type: "int", value: int64(value.asInt, `${path}.asInt`) };
}

function optionalId(value: unknown, path: string, kind: "trace" | "span"): string | null {
  if (value === undefined) return null;
  const normalized = otlpString(value, path);
  if (normalized === "") return null;
  const valid = kind === "trace" ? isW3cTraceId(normalized) : isW3cSpanId(normalized);
  if (!valid) fail(path, `must be an ${kind} ID encoded as ${kind === "trace" ? "32" : "16"} hexadecimal characters`);
  return normalized;
}

function exemplar(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpExemplar {
  const raw = otlpRecord(value, path);
  const traceId = optionalId(raw.traceId, `${path}.traceId`, "trace");
  const spanId = optionalId(raw.spanId, `${path}.spanId`, "span");
  if ((traceId === null) !== (spanId === null)) fail(path, "must provide both traceId and spanId, or neither");
  return {
    filteredAttributes: metricAttributes(raw.filteredAttributes, `${path}.filteredAttributes`, limits),
    timeUnixNano: uint64(raw.timeUnixNano, `${path}.timeUnixNano`, false),
    value: metricValue(raw, path),
    spanId,
    traceId,
  };
}

function pointBase(
  value: Record<string, unknown>,
  path: string,
  limits: OtlpMetricsNormalizationLimits,
  enforceStartBeforeEnd: boolean,
): CanonicalOtlpDataPointBase {
  const timeUnixNano = uint64(value.timeUnixNano, `${path}.timeUnixNano`, false);
  const startTimeUnixNano = value.startTimeUnixNano === undefined
    ? null
    : uint64(value.startTimeUnixNano, `${path}.startTimeUnixNano`, false);
  if (enforceStartBeforeEnd && startTimeUnixNano !== null && BigInt(startTimeUnixNano) > BigInt(timeUnixNano)) {
    fail(path, "startTimeUnixNano must not be after timeUnixNano");
  }
  return {
    attributes: metricAttributes(value.attributes, `${path}.attributes`, limits),
    startTimeUnixNano,
    timeUnixNano,
    flags: uint32(value.flags, `${path}.flags`),
  };
}

function exemplars(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpExemplar[] {
  return repeated(value, path, limits.maxExemplarsPerDataPoint)
    .map((entry, index) => exemplar(entry, `${path}[${index}]`, limits));
}

function numberDataPoint(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits, enforceStartBeforeEnd: boolean): CanonicalOtlpNumberDataPoint {
  const raw = otlpRecord(value, path);
  return {
    ...pointBase(raw, path, limits, enforceStartBeforeEnd),
    value: metricValue(raw, path),
    exemplars: exemplars(raw.exemplars, `${path}.exemplars`, limits),
  };
}

function uint64Array(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): string[] {
  return repeated(value, path, limits.maxHistogramBuckets)
    .map((entry, index) => uint64(entry, `${path}[${index}]`, true));
}

function sumUint64(values: string[], path: string): bigint {
  let total = 0n;
  for (const value of values) {
    total += BigInt(value);
    if (total > MAX_UINT64) fail(path, "has a uint64 sum overflow");
  }
  return total;
}

function requireCountMatchesBuckets(count: string, bucketCounts: string[], path: string): void {
  if (sumUint64(bucketCounts, path) !== BigInt(count)) {
    fail(path, "must equal the sum of bucketCounts");
  }
}

function validateZeroCountSum(count: string, sum: CanonicalOtlpMetricNumber | null, path: string): void {
  if (BigInt(count) === 0n && sum !== null && (typeof sum !== "number" || sum !== 0)) {
    fail(path, "must be zero when count is zero");
  }
}

function validateMinMax(min: CanonicalOtlpMetricNumber | null, max: CanonicalOtlpMetricNumber | null, path: string): void {
  if (typeof min === "number" && typeof max === "number" && min > max) fail(path, "min must not be greater than max");
}

function histogramDataPoint(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpHistogramDataPoint {
  const raw = otlpRecord(value, path);
  const count = uint64(raw.count === undefined ? "0" : raw.count, `${path}.count`, true);
  const sum = optionalDouble(raw.sum, `${path}.sum`);
  const bucketCounts = uint64Array(raw.bucketCounts, `${path}.bucketCounts`, limits);
  const explicitBounds = repeated(raw.explicitBounds, `${path}.explicitBounds`, limits.maxHistogramBuckets)
    .map((entry, index) => finiteDouble(entry, `${path}.explicitBounds[${index}]`));
  if (bucketCounts.length !== 0 && bucketCounts.length !== explicitBounds.length + 1) {
    fail(path, "must contain one more bucket count than explicit bound");
  }
  if (bucketCounts.length === 0 && explicitBounds.length !== 0) {
    fail(path, "must omit explicitBounds when bucketCounts is empty");
  }
  for (let index = 1; index < explicitBounds.length; index += 1) {
    if (explicitBounds[index] <= explicitBounds[index - 1]) fail(`${path}.explicitBounds`, "must be strictly increasing");
  }
  if (bucketCounts.length !== 0) requireCountMatchesBuckets(count, bucketCounts, path);
  validateZeroCountSum(count, sum, `${path}.sum`);
  const min = optionalDouble(raw.min, `${path}.min`);
  const max = optionalDouble(raw.max, `${path}.max`);
  validateMinMax(min, max, path);
  return {
    ...pointBase(raw, path, limits, true),
    count,
    sum,
    bucketCounts,
    explicitBounds,
    exemplars: exemplars(raw.exemplars, `${path}.exemplars`, limits),
    min,
    max,
  };
}

function exponentialBuckets(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpExponentialHistogramBuckets | null {
  if (value === undefined) return null;
  const raw = otlpRecord(value, path);
  return {
    offset: int32(raw.offset, `${path}.offset`),
    bucketCounts: uint64Array(raw.bucketCounts, `${path}.bucketCounts`, limits),
  };
}

function exponentialHistogramDataPoint(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpExponentialHistogramDataPoint {
  const raw = otlpRecord(value, path);
  const count = uint64(raw.count === undefined ? "0" : raw.count, `${path}.count`, true);
  const zeroCount = uint64(raw.zeroCount === undefined ? "0" : raw.zeroCount, `${path}.zeroCount`, true);
  const sum = optionalDouble(raw.sum, `${path}.sum`);
  const positive = exponentialBuckets(raw.positive, `${path}.positive`, limits);
  const negative = exponentialBuckets(raw.negative, `${path}.negative`, limits);
  const allBucketCounts = [
    ...(positive === null ? [] : positive.bucketCounts),
    ...(negative === null ? [] : negative.bucketCounts),
    zeroCount,
  ];
  requireCountMatchesBuckets(count, allBucketCounts, `${path}.count`);
  validateZeroCountSum(count, sum, `${path}.sum`);
  const zeroThreshold = finiteDouble(raw.zeroThreshold === undefined ? 0 : raw.zeroThreshold, `${path}.zeroThreshold`);
  if (zeroThreshold < 0) fail(`${path}.zeroThreshold`, "must not be negative");
  const min = optionalDouble(raw.min, `${path}.min`);
  const max = optionalDouble(raw.max, `${path}.max`);
  validateMinMax(min, max, path);
  return {
    ...pointBase(raw, path, limits, true),
    count,
    sum,
    scale: int32(raw.scale, `${path}.scale`),
    zeroCount,
    positive,
    negative,
    zeroThreshold,
    exemplars: exemplars(raw.exemplars, `${path}.exemplars`, limits),
    min,
    max,
  };
}

function summaryDataPoint(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpSummaryDataPoint {
  const raw = otlpRecord(value, path);
  const count = uint64(raw.count === undefined ? "0" : raw.count, `${path}.count`, true);
  const sum = metricDouble(raw.sum === undefined ? 0 : raw.sum, `${path}.sum`);
  validateZeroCountSum(count, sum, `${path}.sum`);
  const quantileValues: CanonicalOtlpSummaryQuantile[] = [];
  let previousQuantile: number | null = null;
  for (const [index, rawQuantile] of repeated(raw.quantileValues, `${path}.quantileValues`, limits.maxQuantileValues).entries()) {
    const quantilePath = `${path}.quantileValues[${index}]`;
    const quantile = otlpRecord(rawQuantile, quantilePath);
    const quantileValue = finiteDouble(quantile.quantile, `${quantilePath}.quantile`);
    const valueAtQuantile = finiteDouble(quantile.value, `${quantilePath}.value`);
    if (quantileValue < 0 || quantileValue > 1) fail(`${quantilePath}.quantile`, "must be between 0 and 1");
    if (valueAtQuantile < 0) fail(`${quantilePath}.value`, "must not be negative");
    if (previousQuantile !== null && quantileValue <= previousQuantile) {
      fail(`${path}.quantileValues`, "must be strictly increasing");
    }
    previousQuantile = quantileValue;
    quantileValues.push({ quantile: quantileValue, value: valueAtQuantile });
  }
  return {
    ...pointBase(raw, path, limits, true),
    count,
    sum,
    quantileValues,
  };
}

function metricData(value: Record<string, unknown>, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpMetricData {
  const variants = ["gauge", "sum", "histogram", "exponentialHistogram", "summary"]
    .filter((key) => value[key] !== undefined);
  if (variants.length !== 1) fail(path, "must contain exactly one metric data variant");
  const variant = variants[0];
  const data = otlpRecord(value[variant], `${path}.${variant}`);
  if (variant === "gauge") {
    return {
      type: "gauge",
      dataPoints: repeated(data.dataPoints, `${path}.gauge.dataPoints`, limits.maxDataPointsPerMetric)
        .map((entry, index) => numberDataPoint(entry, `${path}.gauge.dataPoints[${index}]`, limits, false)),
    };
  }
  if (variant === "sum") {
    return {
      type: "sum",
      dataPoints: repeated(data.dataPoints, `${path}.sum.dataPoints`, limits.maxDataPointsPerMetric)
        .map((entry, index) => numberDataPoint(entry, `${path}.sum.dataPoints[${index}]`, limits, true)),
      aggregationTemporality: aggregationTemporality(data.aggregationTemporality, `${path}.sum.aggregationTemporality`),
      isMonotonic: boolean(data.isMonotonic, `${path}.sum.isMonotonic`),
    };
  }
  if (variant === "histogram") {
    return {
      type: "histogram",
      dataPoints: repeated(data.dataPoints, `${path}.histogram.dataPoints`, limits.maxDataPointsPerMetric)
        .map((entry, index) => histogramDataPoint(entry, `${path}.histogram.dataPoints[${index}]`, limits)),
      aggregationTemporality: aggregationTemporality(data.aggregationTemporality, `${path}.histogram.aggregationTemporality`),
    };
  }
  if (variant === "exponentialHistogram") {
    return {
      type: "exponentialHistogram",
      dataPoints: repeated(data.dataPoints, `${path}.exponentialHistogram.dataPoints`, limits.maxDataPointsPerMetric)
        .map((entry, index) => exponentialHistogramDataPoint(entry, `${path}.exponentialHistogram.dataPoints[${index}]`, limits)),
      aggregationTemporality: aggregationTemporality(data.aggregationTemporality, `${path}.exponentialHistogram.aggregationTemporality`),
    };
  }
  return {
    type: "summary",
    dataPoints: repeated(data.dataPoints, `${path}.summary.dataPoints`, limits.maxDataPointsPerMetric)
      .map((entry, index) => summaryDataPoint(entry, `${path}.summary.dataPoints[${index}]`, limits)),
  };
}

function metric(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpMetric {
  const raw = otlpRecord(value, path);
  const name = otlpString(raw.name, `${path}.name`);
  if (name.length === 0) fail(`${path}.name`, "must not be empty");
  return {
    name,
    description: otlpString(raw.description, `${path}.description`, ""),
    unit: otlpString(raw.unit, `${path}.unit`, ""),
    metadata: metricAttributes(raw.metadata, `${path}.metadata`, limits),
    data: metricData(raw, path, limits),
  };
}

function scopeMetrics(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpScopeMetrics {
  const raw = otlpRecord(value, path);
  return {
    scope: scope(raw.scope, `${path}.scope`, limits),
    schemaUrl: otlpString(raw.schemaUrl, `${path}.schemaUrl`, ""),
    metrics: repeated(raw.metrics, `${path}.metrics`, limits.maxMetricsPerScope)
      .map((entry, index) => metric(entry, `${path}.metrics[${index}]`, limits)),
  };
}

function resourceMetrics(value: unknown, path: string, limits: OtlpMetricsNormalizationLimits): CanonicalOtlpResourceMetrics {
  const raw = otlpRecord(value, path);
  return {
    resource: resource(raw.resource, `${path}.resource`, limits),
    schemaUrl: otlpString(raw.schemaUrl, `${path}.schemaUrl`, ""),
    scopeMetrics: repeated(raw.scopeMetrics, `${path}.scopeMetrics`, limits.maxScopeMetricsPerResource)
      .map((entry, index) => scopeMetrics(entry, `${path}.scopeMetrics[${index}]`, limits)),
  };
}

export function normalizeOtlpJsonMetricsRequest(
  value: unknown,
  limits: OtlpMetricsNormalizationLimits = DEFAULT_OTLP_METRICS_NORMALIZATION_LIMITS,
): CanonicalOtlpMetricsRequest {
  const request = otlpRecord(value, "body");
  return {
    resourceMetrics: repeated(request.resourceMetrics, "body.resourceMetrics", limits.maxResourceMetrics)
      .map((entry, index) => resourceMetrics(entry, `body.resourceMetrics[${index}]`, limits)),
  };
}

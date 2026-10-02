import protobuf from "protobufjs";
import type { Json } from "@hexclave/shared/dist/utils/json";

// protobufjs is CommonJS-only. Named ESM imports like `{ parse }` fail at
// runtime under Node's native loader (OpenAPI codegen, Next route graphs).
// The default export is the full CJS module namespace.
type Type = protobuf.Type;
const { parse } = protobuf;

// This is the wire-relevant subset of the official opentelemetry-proto
// definitions. Keeping the messages together here makes the HTTP gateway
// independent of generated code while preserving the exact standard field
// numbers and scalar types. Unknown future fields are ignored by protobuf, as
// required for forward-compatible collectors.
const OTLP_PROTO = `
  syntax = "proto3";

  message AnyValue {
    oneof value {
      string string_value = 1;
      bool bool_value = 2;
      int64 int_value = 3;
      double double_value = 4;
      ArrayValue array_value = 5;
      KeyValueList kvlist_value = 6;
      bytes bytes_value = 7;
    }
  }
  message ArrayValue { repeated AnyValue values = 1; }
  message KeyValueList { repeated KeyValue values = 1; }
  message KeyValue { string key = 1; AnyValue value = 2; }
  message InstrumentationScope {
    string name = 1;
    string version = 2;
    repeated KeyValue attributes = 3;
    uint32 dropped_attributes_count = 4;
  }
  message Resource {
    repeated KeyValue attributes = 1;
    uint32 dropped_attributes_count = 2;
  }

  message SpanEvent {
    fixed64 time_unix_nano = 1;
    string name = 2;
    repeated KeyValue attributes = 3;
    uint32 dropped_attributes_count = 4;
  }
  message SpanLink {
    bytes trace_id = 1;
    bytes span_id = 2;
    string trace_state = 3;
    repeated KeyValue attributes = 4;
    uint32 dropped_attributes_count = 5;
    fixed32 flags = 6;
  }
  message SpanStatus {
    string message = 2;
    int32 code = 3;
  }
  message Span {
    bytes trace_id = 1;
    bytes span_id = 2;
    string trace_state = 3;
    bytes parent_span_id = 4;
    string name = 5;
    int32 kind = 6;
    fixed64 start_time_unix_nano = 7;
    fixed64 end_time_unix_nano = 8;
    repeated KeyValue attributes = 9;
    uint32 dropped_attributes_count = 10;
    repeated SpanEvent events = 11;
    uint32 dropped_events_count = 12;
    repeated SpanLink links = 13;
    uint32 dropped_links_count = 14;
    SpanStatus status = 15;
    fixed32 flags = 16;
  }
  message ScopeSpans {
    InstrumentationScope scope = 1;
    repeated Span spans = 2;
    string schema_url = 3;
  }
  message ResourceSpans {
    Resource resource = 1;
    repeated ScopeSpans scope_spans = 2;
    string schema_url = 3;
  }
  message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
  message ExportTracePartialSuccess {
    int64 rejected_spans = 1;
    string error_message = 2;
  }
  message ExportTraceServiceResponse { ExportTracePartialSuccess partial_success = 1; }

  message LogRecord {
    fixed64 time_unix_nano = 1;
    int32 severity_number = 2;
    string severity_text = 3;
    AnyValue body = 5;
    repeated KeyValue attributes = 6;
    uint32 dropped_attributes_count = 7;
    fixed32 flags = 8;
    bytes trace_id = 9;
    bytes span_id = 10;
    fixed64 observed_time_unix_nano = 11;
    string event_name = 12;
  }
  message ScopeLogs {
    InstrumentationScope scope = 1;
    repeated LogRecord log_records = 2;
    string schema_url = 3;
  }
  message ResourceLogs {
    Resource resource = 1;
    repeated ScopeLogs scope_logs = 2;
    string schema_url = 3;
  }
  message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
  message ExportLogsPartialSuccess {
    int64 rejected_log_records = 1;
    string error_message = 2;
  }
  message ExportLogsServiceResponse { ExportLogsPartialSuccess partial_success = 1; }

  message ResourceMetrics {
    Resource resource = 1;
    repeated ScopeMetrics scope_metrics = 2;
    string schema_url = 3;
  }
  message ScopeMetrics {
    InstrumentationScope scope = 1;
    repeated Metric metrics = 2;
    string schema_url = 3;
  }
  message Metric {
    string name = 1;
    string description = 2;
    string unit = 3;
    oneof data {
      Gauge gauge = 5;
      Sum sum = 7;
      Histogram histogram = 9;
      ExponentialHistogram exponential_histogram = 10;
      Summary summary = 11;
    }
    repeated KeyValue metadata = 12;
  }
  message Gauge { repeated NumberDataPoint data_points = 1; }
  message Sum {
    repeated NumberDataPoint data_points = 1;
    int32 aggregation_temporality = 2;
    bool is_monotonic = 3;
  }
  message Histogram {
    repeated HistogramDataPoint data_points = 1;
    int32 aggregation_temporality = 2;
  }
  message ExponentialHistogram {
    repeated ExponentialHistogramDataPoint data_points = 1;
    int32 aggregation_temporality = 2;
  }
  message Summary { repeated SummaryDataPoint data_points = 1; }
  message NumberDataPoint {
    repeated KeyValue attributes = 7;
    fixed64 start_time_unix_nano = 2;
    fixed64 time_unix_nano = 3;
    oneof value {
      double as_double = 4;
      sfixed64 as_int = 6;
    }
    repeated Exemplar exemplars = 5;
    uint32 flags = 8;
  }
  message HistogramDataPoint {
    repeated KeyValue attributes = 9;
    fixed64 start_time_unix_nano = 2;
    fixed64 time_unix_nano = 3;
    fixed64 count = 4;
    optional double sum = 5;
    repeated fixed64 bucket_counts = 6;
    repeated double explicit_bounds = 7;
    repeated Exemplar exemplars = 8;
    uint32 flags = 10;
    optional double min = 11;
    optional double max = 12;
  }
  message ExponentialHistogramDataPoint {
    repeated KeyValue attributes = 1;
    fixed64 start_time_unix_nano = 2;
    fixed64 time_unix_nano = 3;
    fixed64 count = 4;
    optional double sum = 5;
    sint32 scale = 6;
    fixed64 zero_count = 7;
    ExponentialHistogramBuckets positive = 8;
    ExponentialHistogramBuckets negative = 9;
    uint32 flags = 10;
    repeated Exemplar exemplars = 11;
    optional double min = 12;
    optional double max = 13;
    double zero_threshold = 14;
  }
  message ExponentialHistogramBuckets {
    sint32 offset = 1;
    repeated uint64 bucket_counts = 2;
  }
  message SummaryDataPoint {
    repeated KeyValue attributes = 7;
    fixed64 start_time_unix_nano = 2;
    fixed64 time_unix_nano = 3;
    fixed64 count = 4;
    double sum = 5;
    repeated SummaryValueAtQuantile quantile_values = 6;
    uint32 flags = 8;
  }
  message SummaryValueAtQuantile {
    double quantile = 1;
    double value = 2;
  }
  message Exemplar {
    repeated KeyValue filtered_attributes = 7;
    fixed64 time_unix_nano = 2;
    oneof value {
      double as_double = 3;
      sfixed64 as_int = 6;
    }
    bytes span_id = 4;
    bytes trace_id = 5;
  }
  message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
  message ExportMetricsPartialSuccess {
    int64 rejected_data_points = 1;
    string error_message = 2;
  }
  message ExportMetricsServiceResponse { ExportMetricsPartialSuccess partial_success = 1; }
`;

const root = parse(OTLP_PROTO).root;
const traceRequestType = root.lookupType("ExportTraceServiceRequest");
const traceResponseType = root.lookupType("ExportTraceServiceResponse");
const logsRequestType = root.lookupType("ExportLogsServiceRequest");
const logsResponseType = root.lookupType("ExportLogsServiceResponse");
const metricsRequestType = root.lookupType("ExportMetricsServiceRequest");
const metricsResponseType = root.lookupType("ExportMetricsServiceResponse");

export type OtlpSignal = "traces" | "logs" | "metrics";

export class OtlpProtobufError extends Error {}

function requestType(signal: OtlpSignal): Type {
  if (signal === "traces") return traceRequestType;
  if (signal === "logs") return logsRequestType;
  return metricsRequestType;
}

function responseType(signal: OtlpSignal): Type {
  if (signal === "traces") return traceResponseType;
  if (signal === "logs") return logsResponseType;
  return metricsResponseType;
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

// The plain-object message form protobufjs exchanges with our OTLP types under
// the conversion options in `decode`: JSON scalars plus Uint8Array for bytes
// fields (longs and enums are already mapped to strings and numbers).
export type OtlpProtobufMessageValue = string | number | boolean | null | Uint8Array | OtlpProtobufMessageValue[] | { [key: string]: OtlpProtobufMessageValue };
export type OtlpProtobufMessageRecord = { [key: string]: OtlpProtobufMessageValue };

function toOtlpJsonValue(value: OtlpProtobufMessageValue, fieldName?: string): Json {
  if (value instanceof Uint8Array) {
    return fieldName === "traceId" || fieldName === "spanId" || fieldName === "parentSpanId"
      ? bytesToHex(value)
      : bytesToBase64(value);
  }
  if (Array.isArray(value)) return value.map((entry) => toOtlpJsonValue(entry));
  if (typeof value !== "object" || value === null) return value;

  const result: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = toOtlpJsonValue(entry, key);
  }
  return result;
}

function decode(type: Type, body: ArrayBuffer | Uint8Array): Json {
  try {
    const message = type.decode(body instanceof Uint8Array ? body : new Uint8Array(body));
    return toOtlpJsonValue(type.toObject(message, {
      longs: String,
      enums: Number,
      bytes: Uint8Array,
      defaults: false,
      arrays: true,
      objects: true,
    }));
  } catch (error) {
    throw new OtlpProtobufError("Invalid OTLP protobuf request", { cause: error });
  }
}

function encode(type: Type, value: OtlpProtobufMessageRecord): Uint8Array {
  const message = type.fromObject(value);
  const validationError = type.verify(message);
  if (validationError !== null) throw new OtlpProtobufError(`Invalid OTLP protobuf value: ${validationError}`);
  return type.encode(message).finish();
}

export function decodeOtlpProtobufRequest(signal: OtlpSignal, body: ArrayBuffer | Uint8Array): Json {
  return decode(requestType(signal), body);
}

export function encodeOtlpProtobufRequest(signal: OtlpSignal, value: OtlpProtobufMessageRecord): Uint8Array {
  return encode(requestType(signal), value);
}

export function encodeOtlpProtobufResponse(signal: OtlpSignal, value: OtlpProtobufMessageRecord = {}): Uint8Array {
  return encode(responseType(signal), value);
}

export function decodeOtlpProtobufResponse(signal: OtlpSignal, body: ArrayBuffer | Uint8Array): Json {
  return decode(responseType(signal), body);
}

import { isRecord } from "@hexclave/shared/dist/utils/objects";

export class OtlpJsonRequestError extends Error {}

export type OtlpAttributeValue =
  | { type: "string", value: string }
  | { type: "boolean", value: boolean }
  | { type: "int", value: string }
  | { type: "double", value: number }
  | { type: "bytes", value: string }
  | { type: "array", value: OtlpAttributeValue[] }
  | { type: "kvlist", value: OtlpAttributes }
  | { type: "null", value: null };
export type OtlpAttributes = Map<string, OtlpAttributeValue>;

export const DEFAULT_OTLP_ATTRIBUTE_LIMITS = {
  maxDepth: 16,
  maxAttributesPerList: 256,
  maxAttributeArrayValues: 256,
} as const;

export function otlpRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new OtlpJsonRequestError(`${path} must be an object`);
  return value;
}

export function otlpArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new OtlpJsonRequestError(`${path} must be an array`);
  return value;
}

export function otlpString(value: unknown, path: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new OtlpJsonRequestError(`${path} must be a string`);
  return value;
}

export function otlpUint(value: unknown, path: string, fallback = 0): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) throw new OtlpJsonRequestError(`${path} must be a non-negative integer`);
  return parsed;
}

export function otlpUint32(value: unknown, path: string, fallback = 0): number {
  const result = otlpUint(value, path, fallback);
  if (result > 0xffff_ffff) throw new OtlpJsonRequestError(`${path} must be a uint32`);
  return result;
}

function canonicalUint64(result: string, path: string, message: string): string {
  if (!/^\d+$/.test(result)) throw new OtlpJsonRequestError(message);
  const parsed = BigInt(result);
  if (parsed > 18446744073709551615n) throw new OtlpJsonRequestError(message);
  return parsed.toString();
}

export function otlpUnixNano(value: unknown, path: string): string {
  const result = canonicalUint64(otlpString(value, path), path, `${path} must be a positive uint64 string`);
  if (result === "0") throw new OtlpJsonRequestError(`${path} must be a positive uint64 string`);
  return result;
}

export function otlpUnixNanoOrOpen(value: unknown, path: string): string {
  return canonicalUint64(otlpString(value, path), path, `${path} must be a uint64 string`);
}

export function otlpCanonicalUint64String(value: unknown, path: string): string {
  return canonicalUint64(otlpString(value, path), path, `${path} must be a uint64 string`);
}

const MAX_OTLP_ANY_VALUE_DEPTH = DEFAULT_OTLP_ATTRIBUTE_LIMITS.maxDepth;
const MAX_OTLP_ATTRIBUTES_PER_LIST = DEFAULT_OTLP_ATTRIBUTE_LIMITS.maxAttributesPerList;
const MAX_OTLP_ATTRIBUTE_ARRAY_VALUES = DEFAULT_OTLP_ATTRIBUTE_LIMITS.maxAttributeArrayValues;

export function otlpAnyValue(value: unknown, path: string, depth = 0): OtlpAttributeValue {
  if (depth > MAX_OTLP_ANY_VALUE_DEPTH) throw new OtlpJsonRequestError(`${path} exceeds the maximum attribute depth of ${MAX_OTLP_ANY_VALUE_DEPTH}`);
  const item = otlpRecord(value, path);
  const present = ["stringValue", "boolValue", "intValue", "doubleValue", "arrayValue", "kvlistValue", "bytesValue"].filter((key) => item[key] !== undefined);
  if (present.length === 0) return { type: "null", value: null };
  if (present.length !== 1) throw new OtlpJsonRequestError(`${path} must contain exactly one AnyValue field`);
  const field = present[0];
  if (field === "stringValue") return { type: "string", value: otlpString(item.stringValue, `${path}.stringValue`) };
  if (field === "boolValue") {
    if (typeof item.boolValue !== "boolean") throw new OtlpJsonRequestError(`${path}.boolValue must be a boolean`);
    return { type: "boolean", value: item.boolValue };
  }
  if (field === "intValue") {
    const normalized = typeof item.intValue === "number" && Number.isSafeInteger(item.intValue) ? String(item.intValue) : item.intValue;
    if (typeof normalized !== "string" || !/^-?\d+$/.test(normalized)) throw new OtlpJsonRequestError(`${path}.intValue must be an int64 string or safe integer`);
    const parsed = BigInt(normalized);
    if (parsed < -9223372036854775808n || parsed > 9223372036854775807n) throw new OtlpJsonRequestError(`${path}.intValue must fit int64`);
    return { type: "int", value: normalized };
  }
  if (field === "doubleValue") {
    if (typeof item.doubleValue !== "number" || !Number.isFinite(item.doubleValue)) throw new OtlpJsonRequestError(`${path}.doubleValue must be finite`);
    return { type: "double", value: item.doubleValue };
  }
  if (field === "bytesValue") return { type: "bytes", value: otlpString(item.bytesValue, `${path}.bytesValue`) };
  if (field === "arrayValue") {
    const arrayValue = otlpRecord(item.arrayValue, `${path}.arrayValue`);
    const values = otlpArray(arrayValue.values ?? [], `${path}.arrayValue.values`);
    if (values.length > MAX_OTLP_ATTRIBUTE_ARRAY_VALUES) throw new OtlpJsonRequestError(`${path}.arrayValue.values must contain at most ${MAX_OTLP_ATTRIBUTE_ARRAY_VALUES} entries`);
    return { type: "array", value: values.map((entry, index) => otlpAnyValue(entry, `${path}.arrayValue.values[${index}]`, depth + 1)) };
  }
  const kvlistValue = otlpRecord(item.kvlistValue, `${path}.kvlistValue`);
  return { type: "kvlist", value: otlpAttributes(kvlistValue.values ?? [], `${path}.kvlistValue.values`, depth + 1) };
}

export function otlpAttributes(value: unknown, path: string, depth = 0): OtlpAttributes {
  if (depth > MAX_OTLP_ANY_VALUE_DEPTH) throw new OtlpJsonRequestError(`${path} exceeds the maximum attribute depth of ${MAX_OTLP_ANY_VALUE_DEPTH}`);
  const result = new Map<string, OtlpAttributeValue>();
  const entries = otlpArray(value, path);
  if (entries.length > MAX_OTLP_ATTRIBUTES_PER_LIST) throw new OtlpJsonRequestError(`${path} must contain at most ${MAX_OTLP_ATTRIBUTES_PER_LIST} entries`);
  for (const [index, rawEntry] of entries.entries()) {
    const entryPath = `${path}[${index}]`;
    const entry = otlpRecord(rawEntry, entryPath);
    const key = otlpString(entry.key, `${entryPath}.key`);
    if (key.length === 0) throw new OtlpJsonRequestError(`${entryPath}.key must not be empty`);
    if (result.has(key)) throw new OtlpJsonRequestError(`${path} contains duplicate key ${JSON.stringify(key)}`);
    result.set(key, otlpAnyValue(entry.value, `${entryPath}.value`, depth));
  }
  return result;
}

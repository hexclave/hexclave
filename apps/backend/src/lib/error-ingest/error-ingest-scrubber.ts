
export type ErrorIngestScrubbedValue =
  | null
  | boolean
  | number
  | string
  | ErrorIngestScrubbedValue[]
  | ErrorIngestScrubbedRecord;

export type ErrorIngestScrubbedRecord = { [key: string]: ErrorIngestScrubbedValue };

export function isErrorIngestScrubbedRecord(value: ErrorIngestScrubbedValue | undefined): value is ErrorIngestScrubbedRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ErrorIngestScrubLimits = {
  maxDepth: number,
  maxPayloadBytes: number,
  maxStringBytes: number,
  maxKeyBytes: number,
  maxCollectionEntries: number,
};

export const DEFAULT_ERROR_INGEST_SCRUB_LIMITS: Readonly<ErrorIngestScrubLimits> = {
  maxDepth: 8,
  maxPayloadBytes: 256 * 1024,
  maxStringBytes: 8 * 1024,
  maxKeyBytes: 256,
  maxCollectionEntries: 100,
};

export type ErrorIngestScrubResult = {
  value: ErrorIngestScrubbedValue | undefined,
  byteLength: number,
  truncated: boolean,
  dropped: readonly string[],
};

export type ErrorIngestScrubOverrides = {
  dropKeys?: readonly string[],
  urlKeys?: readonly string[],
};

export type ErrorIngestScrubOptions = Partial<ErrorIngestScrubLimits> & {
  overrides?: ErrorIngestScrubOverrides,
};

const FILTERED_VALUE = "[Filtered]";
const TEXT_ENCODER = new TextEncoder();

const SENSITIVE_KEY_PATTERN = /(?:^|[._-])(?:access[-_.]?token|api[-_.]?key|auth(?:entication|orization)?|body|client[-_.]?secret|cookie|credential|form[-_.]?data|header|id[-_.]?token|password|passwd|params?|private[-_.]?key|query(?:[-_.]?string)?|raw[-_.]?body|refresh[-_.]?token|secret|session(?:[-_.]?(?:id|key|token|value|secret))?|set[-_.]?cookie|signature|token)(?:$|[._-])/i;
const URL_KEY_PATTERN = /(?:^|[._-])(?:http[-_.]?target|request[-_.]?(?:target|url)|uri|url)(?:$|[._-])/i;

const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic|Digest)\s+[^\s,;]+/gi;
const PRIVATE_KEY_PATTERN = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL_AUTH_PATTERN = /((?:[a-z][a-z\d+.-]*:)?\/\/)(?:[^/@\s:]+):(?:[^/\s?#]+)@/gi;
const SENSITIVE_ASSIGNMENT_PATTERN = /((["']?)(?:access[-_.]?token|api[-_.]?key|\bauth(?:entication|orization)?\b|client[-_.]?secret|cookie|credential|id[-_.]?token|password|passwd|private[-_.]?key|refresh[-_.]?token|secret|session[-_.]?token|signature|token)\2\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:(?:Bearer|Basic|Digest)\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'&,;}\]]+))/gi;
const SENSITIVE_QUERY_VALUE_PATTERN = /([?&](?:access[-_.]?token|api[-_.]?key|authorization|body|client[-_.]?secret|form[-_.]?data|id[-_.]?token|password|refresh[-_.]?token|secret|session[-_.]?id|signature|token)=)[^&#\s]*/gi;
const SENSITIVE_COMPACT_KEY_PARTS: readonly string[] = [
  "access_token",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "credential",
  "formdata",
  "header",
  "id_token",
  "password",
  "privatekey",
  "query",
  "rawbody",
  "refresh_token",
  "secret",
  "session",
  "signature",
  "token",
  "requestbody",
];

const SAFE_TELEMETRY_IDENTIFIER_KEYS = new Set([
  "hexclavesessionreplayid",
  "hexclavesessionreplaysegmentid",
  "hexclaverefreshtokenid",
]);

type ScrubState = {
  readonly activeObjects: WeakSet<object>,
  readonly dropped: Set<string>,
  truncated: boolean,
};

type ScrubPolicy = "drop" | "url" | "value";

function createState(): ScrubState {
  return {
    activeObjects: new WeakSet<object>(),
    dropped: new Set<string>(),
    truncated: false,
  };
}

function drop(state: ScrubState, path: string, reason: string): void {
  state.truncated = true;
  state.dropped.add(`${path}.${reason}`.slice(0, 160));
}

function snapshotDropped(state: ScrubState): readonly string[] {
  const dropped = [...state.dropped].sort();
  return dropped.length > 64 ? [...dropped.slice(0, 63), "more-drops"] : dropped;
}

function resolveLimits(options: Partial<ErrorIngestScrubLimits> | undefined): ErrorIngestScrubLimits {
  const result: ErrorIngestScrubLimits = { ...DEFAULT_ERROR_INGEST_SCRUB_LIMITS };
  const keys: readonly (keyof ErrorIngestScrubLimits)[] = [
    "maxDepth",
    "maxPayloadBytes",
    "maxStringBytes",
    "maxKeyBytes",
    "maxCollectionEntries",
  ];

  for (const key of keys) {
    const value = options?.[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Error-ingest scrub limit ${key} must be a positive integer`);
    }
    result[key] = value;
  }

  return result;
}

function truncateUtf8(value: string, maxBytes: number, state: ScrubState, path: string): string {
  if (TEXT_ENCODER.encode(value).byteLength <= maxBytes) return value;

  drop(state, path, "string");
  let result = "";
  let byteLength = 0;
  for (const character of value) {
    const characterByteLength = TEXT_ENCODER.encode(character).byteLength;
    if (byteLength + characterByteLength > maxBytes) break;
    result += character;
    byteLength += characterByteLength;
  }
  return result;
}

function scrubString(value: string, state: ScrubState, path: string, maxBytes: number): string {
  const scrubbed = value
    .replace(PRIVATE_KEY_PATTERN, FILTERED_VALUE)
    .replace(
      SENSITIVE_ASSIGNMENT_PATTERN,
      (_match: string, prefix: string, _keyQuote: string, assignment: string) => {
        const quote = assignment.startsWith('"') ? '"' : assignment.startsWith("'") ? "'" : "";
        const unquoted = quote === "" ? assignment : assignment.slice(1, -1);
        const scheme = /^(Bearer|Basic|Digest)\s+/iu.exec(unquoted)?.[1];
        return `${prefix}${quote}${scheme === undefined ? FILTERED_VALUE : `${scheme} ${FILTERED_VALUE}`}${quote}`;
      },
    )
    .replace(AUTH_SCHEME_PATTERN, "$1 " + FILTERED_VALUE)
    .replace(SENSITIVE_QUERY_VALUE_PATTERN, "$1" + FILTERED_VALUE)
    .replace(JWT_PATTERN, FILTERED_VALUE)
    .replace(URL_AUTH_PATTERN, "$1" + FILTERED_VALUE + "@");

  if (scrubbed !== value) state.truncated = true;
  return truncateUtf8(scrubbed, maxBytes, state, path);
}

function scrubUrl(value: string, state: ScrubState, path: string, maxBytes: number): string {
  let pathOnly: string;
  try {
    const parsed = new URL(value);
    pathOnly = `${parsed.origin}${parsed.pathname}`;
  } catch {
    pathOnly = value.split(/[?#]/, 1)[0].replace(URL_AUTH_PATTERN, "$1");
  }
  if (pathOnly !== value) state.truncated = true;
  return scrubString(pathOnly, state, path, maxBytes);
}

function pathForKey(path: string, key: string): string {
  const safeKey = key.toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 64);
  return `${path}.${safeKey === "" ? "field" : safeKey}`;
}

function policyForKey(key: string): ScrubPolicy {
  const compactKey = key.replace(/[._-]/g, "").toLowerCase();
  if (SAFE_TELEMETRY_IDENTIFIER_KEYS.has(compactKey)) return "value";
  if (SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_COMPACT_KEY_PARTS.some((part) => compactKey.includes(part.replaceAll("_", "")))) return "drop";
  if (URL_KEY_PATTERN.test(key)) return "url";
  return "value";
}

function jsonByteLength(value: ErrorIngestScrubbedValue): number {
  return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function defineSafeProperty(
  target: { [key: string]: ErrorIngestScrubbedValue },
  key: string,
  value: ErrorIngestScrubbedValue,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function resolveFieldPolicy(fieldPath: string, key: string, overrides: ErrorIngestScrubOverrides | undefined): ScrubPolicy {
  const builtIn = policyForKey(key);
  if (builtIn === "drop" || matchesOverride(fieldPath, key, overrides?.dropKeys)) return "drop";
  if (matchesOverride(fieldPath, key, overrides?.urlKeys)) return "url";
  return builtIn;
}

function matchesOverride(path: string, key: string, configuredKeys: readonly string[] | undefined): boolean {
  if (configuredKeys === undefined || configuredKeys.length === 0) return false;
  const normalizedPath = path.replace(/^\$\./, "");
  return configuredKeys.some((configuredKey) => {
    if (configuredKey.endsWith(".*")) {
      return normalizedPath.startsWith(`${configuredKey.slice(0, -2)}.`);
    }
    return normalizedPath === configuredKey || key === configuredKey;
  });
}

function scrubMap(
  value: Map<unknown, unknown>,
  state: ScrubState,
  path: string,
  limits: ErrorIngestScrubLimits,
  depth: number,
  overrides: ErrorIngestScrubOverrides | undefined,
): ErrorIngestScrubbedValue | undefined {
  const entries = [...value.entries()]
    .filter((entry): entry is [string, unknown] => typeof entry[0] === "string")
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  const result: { [key: string]: ErrorIngestScrubbedValue } = {};

  if (entries.length > limits.maxCollectionEntries) drop(state, path, "fields");
  for (const [key, rawValue] of entries.slice(0, limits.maxCollectionEntries)) {
    const fieldPath = pathForKey(path, key);
    const policy = resolveFieldPolicy(fieldPath, key, overrides);
    if (policy === "drop") {
      drop(state, fieldPath, "sensitive");
      continue;
    }
    const normalized = scrubNode(rawValue, state, fieldPath, limits, depth + 1, policy, overrides);
    if (normalized === undefined) continue;
    const outputKey = truncateUtf8(key, limits.maxKeyBytes, state, `${fieldPath}.key`);
    if (Object.prototype.hasOwnProperty.call(result, outputKey)) {
      drop(state, fieldPath, "duplicate-key");
      continue;
    }
    defineSafeProperty(result, outputKey, normalized);
    if (jsonByteLength(result) > limits.maxPayloadBytes) {
      delete result[outputKey];
      drop(state, fieldPath, "bytes");
    }
  }
  return jsonByteLength(result) <= limits.maxPayloadBytes ? result : undefined;
}

function ownEnumerableKeys(value: object, state: ScrubState, path: string): string[] {
  try {
    return Object.keys(value).sort();
  } catch {
    drop(state, path, "object");
    return [];
  }
}

function readDataProperty(value: object, key: string, state: ScrubState, path: string): unknown | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      drop(state, path, "accessor");
      return undefined;
    }
    return descriptor.value;
  } catch {
    drop(state, path, "property");
    return undefined;
  }
}

function scrubArray(
  value: readonly unknown[],
  state: ScrubState,
  path: string,
  limits: ErrorIngestScrubLimits,
  depth: number,
  overrides: ErrorIngestScrubOverrides | undefined,
): ErrorIngestScrubbedValue | undefined {
  const result: ErrorIngestScrubbedValue[] = [];
  if (value.length > limits.maxCollectionEntries) drop(state, path, "items");

  const itemCount = Math.min(value.length, limits.maxCollectionEntries);
  for (let index = 0; index < itemCount; index += 1) {
    const itemPath = `${path}[${index}]`;
    const rawValue = readDataProperty(value, String(index), state, itemPath);
    if (rawValue === undefined) continue;
    const normalized = scrubNode(rawValue, state, itemPath, limits, depth + 1, "value", overrides);
    if (normalized === undefined) continue;
    const candidate = [...result, normalized];
    if (jsonByteLength(candidate) > limits.maxPayloadBytes) {
      drop(state, itemPath, "bytes");
      continue;
    }
    result.push(normalized);
  }
  return jsonByteLength(result) <= limits.maxPayloadBytes ? result : undefined;
}

function scrubObject(
  value: object,
  state: ScrubState,
  path: string,
  limits: ErrorIngestScrubLimits,
  depth: number,
  overrides: ErrorIngestScrubOverrides | undefined,
): ErrorIngestScrubbedValue | undefined {
  if (value instanceof Map) return scrubMap(value, state, path, limits, depth, overrides);

  const result: { [key: string]: ErrorIngestScrubbedValue } = {};
  const keys = ownEnumerableKeys(value, state, path);
  if (keys.length > limits.maxCollectionEntries) drop(state, path, "fields");

  for (const key of keys.slice(0, limits.maxCollectionEntries)) {
    const fieldPath = pathForKey(path, key);
    const policy = resolveFieldPolicy(fieldPath, key, overrides);
    if (policy === "drop") {
      drop(state, fieldPath, "sensitive");
      continue;
    }

    const rawValue = readDataProperty(value, key, state, fieldPath);
    if (rawValue === undefined) continue;
    const normalized = scrubNode(rawValue, state, fieldPath, limits, depth + 1, policy, overrides);
    if (normalized === undefined) continue;

    const outputKey = truncateUtf8(key, limits.maxKeyBytes, state, `${fieldPath}.key`);
    if (Object.prototype.hasOwnProperty.call(result, outputKey)) {
      drop(state, fieldPath, "duplicate-key");
      continue;
    }
    defineSafeProperty(result, outputKey, normalized);
    if (jsonByteLength(result) > limits.maxPayloadBytes) {
      delete result[outputKey];
      drop(state, fieldPath, "bytes");
    }
  }
  return jsonByteLength(result) <= limits.maxPayloadBytes ? result : undefined;
}

function scrubNode(
  value: unknown,
  state: ScrubState,
  path: string,
  limits: ErrorIngestScrubLimits,
  depth: number,
  policy: ScrubPolicy,
  overrides: ErrorIngestScrubOverrides | undefined,
): ErrorIngestScrubbedValue | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    drop(state, path, "number");
    return undefined;
  }
  if (typeof value === "string") {
    return policy === "url"
      ? scrubUrl(value, state, path, limits.maxStringBytes)
      : scrubString(value, state, path, limits.maxStringBytes);
  }
  if (typeof value !== "object") {
    drop(state, path, "type");
    return undefined;
  }
  if (depth >= limits.maxDepth) {
    drop(state, path, "depth");
    return undefined;
  }
  if (state.activeObjects.has(value)) {
    drop(state, path, "cycle");
    return undefined;
  }

  state.activeObjects.add(value);
  try {
    if (Array.isArray(value)) return scrubArray(value, state, path, limits, depth, overrides);
    return scrubObject(value, state, path, limits, depth, overrides);
  } finally {
    state.activeObjects.delete(value);
  }
}

export function scrubErrorIngestPayload(
  input: unknown,
  options?: ErrorIngestScrubOptions,
): ErrorIngestScrubResult {
  const limits = resolveLimits(options);
  const state = createState();
  const value = scrubNode(input, state, "$", limits, 0, "value", options?.overrides);
  const byteLength = value === undefined ? 0 : jsonByteLength(value);

  if (value !== undefined && byteLength > limits.maxPayloadBytes) {
    drop(state, "$", "bytes");
    return {
      value: undefined,
      byteLength: 0,
      truncated: state.truncated,
      dropped: snapshotDropped(state),
    };
  }

  return {
    value,
    byteLength,
    truncated: state.truncated,
    dropped: snapshotDropped(state),
  };
}

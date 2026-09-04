import { httpMethodNames } from "@/generated/route-modules";
import { isSafeInboundRequestHost } from "@/lib/request-api-url";
import { sentryBaseConfig } from "@hexclave/shared/dist/utils/sentry";
import type { Event, EventHint } from "@sentry/node";

const knownHttpMethods = new Set<string>(httpMethodNames);

const safeSpanAttributeNames = new Set([
  "sentry.op",
  "sentry.origin",
  "sentry.source",
  "sentry.sample_rate",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "stack.process.concurrent-requests",
  "stack.process.id",
  "stack.request.method",
  "stack.request.request-id",
  "stack.request.host",
  "stack.smart-request.access-type",
  "stack.smart-request.client-version.platform",
  "stack.smart-request.client-version.sdk",
  "stack.smart-request.client-version.version",
]);

// These names are code-owned constants from the request pipeline. Keep this list
// default-deny: other custom span names may interpolate customer data (for example,
// the email sender used to include its recipient in the description).
const safeApplicationSpanDescriptions = new Set([
  "STACK: handling API request",
  "STACK: creating smart request",
  "STACK: smart request parseAuth",
  "STACK: validating smart request",
  "STACK: calling smart route handler callback",
  "STACK: validating smart response",
  "STACK: creating HTTP response from smart response",
]);

type BackendSentrySpan = NonNullable<Event["spans"]>[number];

function getSafeSpanData(data: BackendSentrySpan["data"]): BackendSentrySpan["data"] {
  const filtered = Object.fromEntries(
    Object.entries(data).filter(([attributeName]) => safeSpanAttributeNames.has(attributeName)),
  );
  if ("stack.request.host" in filtered && !isSafeInboundRequestHost(filtered["stack.request.host"])) {
    delete filtered["stack.request.host"];
  }
  return filtered;
}

function getSafeRequestDescription(method: unknown, route: unknown): string | undefined {
  if (typeof method !== "string" || !knownHttpMethods.has(method)) {
    return undefined;
  }
  if (
    typeof route !== "string"
    || (route !== "<unmatched>" && !route.startsWith("/"))
    || route.length > 500
    || route.includes("?")
    || route.includes("#")
    || route.includes("://")
  ) {
    return undefined;
  }
  return `${method} ${route}`;
}

export function sanitizeBackendSentrySpan(span: BackendSentrySpan): BackendSentrySpan {
  // @sentry/node runs beforeSendSpan for the segment/root span as well as its
  // children. For a transaction, the SDK converts event.transaction into this
  // description and then converts it back after the hook; clearing it therefore
  // erases the transaction name entirely. Rebuild request names only from the
  // normalized route pattern, and preserve a small audited set of application
  // span names. Database statements, outbound URLs, and arbitrary custom names
  // remain stripped.
  span.description = getSafeRequestDescription(
    span.data["http.request.method"],
    span.data["http.route"],
  ) ?? (span.description != null && safeApplicationSpanDescriptions.has(span.description)
      ? span.description
      : undefined);
  span.data = getSafeSpanData(span.data);
  return span;
}

// Segment-split so "timeout" does not match "token". Nested secrets under
// boring keys can still leak.
const sensitiveDiagnosticKeySegments = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "authorization",
  "cookie",
  "cookies",
  "token",
  "jwt",
  "otp",
  "key",
  "dsn",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "connectionstring",
  "clientsecret",
  "privatekey",
  "setcookie",
  "bearer",
  "credential",
  "credentials",
  "signature",
]);

const maxDiagnosticDepth = 8;

function matchesSensitiveDiagnosticSegment(part: string): boolean {
  if (sensitiveDiagnosticKeySegments.has(part)) {
    return true;
  }
  if (part.length > 3 && part.endsWith("es") && sensitiveDiagnosticKeySegments.has(part.slice(0, -2))) {
    return true;
  }
  if (part.length > 2 && part.endsWith("s") && sensitiveDiagnosticKeySegments.has(part.slice(0, -1))) {
    return true;
  }
  return false;
}

function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = key
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
  const compact = normalized.replaceAll("_", "");
  if (matchesSensitiveDiagnosticSegment(compact)) {
    return true;
  }
  return normalized.split("_").some((part) => part !== "" && matchesSensitiveDiagnosticSegment(part));
}

function scrubDiagnosticString(value: string): string {
  const scrubbed = value
    .replaceAll(
      /\b(sk_[A-Za-z0-9_-]+|pk_[A-Za-z0-9_-]+|pck_[A-Za-z0-9_-]+|sak_[A-Za-z0-9_-]+|ssk_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      "[redacted]",
    )
    // Pass 1: user:password@, including passwords that contain @ or space.
    // Pass 2: user@ with no password. `[^\s/?#]*@` would also eat prose like
    // `https://api.example.com, page ops@company.com`.
    .replaceAll(/:\/\/[^\s/?#]*:[^/?#]*@/g, "://[redacted]@")
    .replaceAll(/:\/\/[^\s/?#@]*@/g, "://[redacted]@");
  // extras attached in beforeSend skip Sentry's maxValueLength truncation.
  if (scrubbed.length <= sentryBaseConfig.maxValueLength) {
    return scrubbed;
  }
  return `${scrubbed.slice(0, sentryBaseConfig.maxValueLength)}…`;
}

function scrubValue(value: unknown, key: string | undefined, depth: number): unknown {
  if (key != null && isSensitiveDiagnosticKey(key) && value != null) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return scrubDiagnosticString(value);
  }
  if (typeof value === "bigint") {
    return scrubDiagnosticString(value.toString());
  }
  if (value == null || typeof value !== "object") {
    return value;
  }
  if (depth >= maxDiagnosticDepth) {
    return "[truncated]";
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubDiagnosticString(value.message),
      ...(value.cause !== undefined ? { cause: scrubValue(value.cause, undefined, depth + 1) } : {}),
    };
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[bytes ${value.byteLength}]`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, undefined, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [
    nestedKey,
    scrubValue(nestedValue, nestedKey, depth + 1),
  ]));
}

/**
 * `cause` plus `{ ...error }` — extraData is the enumerable own field — then redact.
 */
function getExceptionExtra(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {};
  }
  return {
    ...(error.cause !== undefined ? { cause: scrubValue(error.cause, undefined, 0) } : {}),
    errorProps: scrubValue({ ...error }, undefined, 0),
  };
}

/**
 * Default-deny the request/span/user envelope. extra is cleared here;
 * prepareBackendSentryEvent rebuilds a redacted dump. extraData can still
 * mention identities if a caller put them there.
 */
export function sanitizeBackendSentryEvent<T extends Event>(event: T): T {
  if (event.request != null) {
    event.request = {
      method: event.request.method,
    };
  }
  event.user = undefined;
  const inboundHostTag = event.tags?.host;
  event.tags = isSafeInboundRequestHost(inboundHostTag) ? { host: inboundHostTag } : undefined;
  event.extra = undefined;

  event.breadcrumbs = event.breadcrumbs?.map((breadcrumb) => ({
    type: breadcrumb.type,
    level: breadcrumb.level,
    category: breadcrumb.category,
    timestamp: breadcrumb.timestamp,
  }));

  event.spans = event.spans?.map(sanitizeBackendSentrySpan);

  const traceContext = event.contexts?.trace;
  const requestContext = event.contexts?.["stack-request"];
  const requestId = requestContext?.requestId;
  const requestMethod = requestContext?.method;
  // `route` is the matched route pattern (e.g. `/api/latest/users/[user_id]`), never the
  // concrete path — same safety rationale as the http.route span attribute above.
  const requestRoute = requestContext?.route;
  // Inbound API hostname (api vs api2). Not PII; still default-deny so a crafted
  // value cannot smuggle a URL or path through `stack-request.host`.
  const requestHostCandidate = requestContext?.host;
  const requestHost = isSafeInboundRequestHost(requestHostCandidate) ? requestHostCandidate : undefined;
  const safeRequestDescription = getSafeRequestDescription(requestMethod, requestRoute);
  const safeTraceDescription = getSafeRequestDescription(
    traceContext?.data?.["http.request.method"],
    traceContext?.data?.["http.route"],
  );
  // Sentry retains request.method even when its Node HTTP finalizer discards a
  // custom route on Elysia middleware short-circuits. A fixed placeholder keeps
  // those transactions identifiable without admitting any part of the URL.
  const safeUnmatchedDescription = getSafeRequestDescription(event.request?.method, "<unmatched>");
  if (
    traceContext != null
    && safeRequestDescription == null
    && safeTraceDescription == null
    && safeUnmatchedDescription != null
    && typeof event.request?.method === "string"
  ) {
    traceContext.data = {
      ...(traceContext.data ?? {}),
      "http.request.method": event.request.method,
      "http.route": "<unmatched>",
    };
  }
  const safeTransactionDescription = safeRequestDescription
    ?? safeTraceDescription
    ?? safeUnmatchedDescription;
  if (safeTransactionDescription != null) {
    event.transaction = safeTransactionDescription;
  } else if (event.transaction != null) {
    event.transaction = "backend.request";
  }
  const safeRequestContext = typeof requestId === "string" || requestHost != null
    ? {
      ...(typeof requestId === "string" ? {
        requestId,
        ...(typeof requestMethod === "string" ? { method: requestMethod } : undefined),
        ...(typeof requestRoute === "string" ? { route: requestRoute } : undefined),
      } : undefined),
      ...(requestHost == null ? undefined : { host: requestHost }),
    }
    : undefined;
  if (traceContext != null) {
    traceContext.data = getSafeSpanData(traceContext.data ?? {});
    traceContext.tags = undefined;
    traceContext.links = undefined;
  }
  event.contexts = traceContext == null && safeRequestContext == null
    ? undefined
    : {
      ...(traceContext == null ? {} : { trace: traceContext }),
      ...(safeRequestContext == null ? {} : { "stack-request": safeRequestContext }),
    };

  return event;
}

/**
 * beforeSend entrypoint: scrub the request/span envelope, then rebuild `extra` from
 * captureError's `location` plus the redacted exception dump.
 */
export function prepareBackendSentryEvent<T extends Event>(event: T, hint?: EventHint): T {
  const location = typeof event.extra?.location === "string" ? event.extra.location : undefined;
  sanitizeBackendSentryEvent(event);

  const extra = {
    ...(location != null ? { location } : {}),
    ...getExceptionExtra(hint?.originalException),
  };
  event.extra = Object.keys(extra).length > 0 ? extra : undefined;
  return event;
}

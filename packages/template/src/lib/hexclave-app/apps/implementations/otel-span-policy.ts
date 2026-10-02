import { isSpanContextValid, trace } from "@opentelemetry/api";
import type { Attributes, Context, Link, SpanKind } from "@opentelemetry/api";
import {
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SamplingResult,
} from "@opentelemetry/sdk-trace-base";

const NEXT_DROP_TRANSACTION_ATTRIBUTE = "sentry.drop_transaction";
const TELEMETRY_INGESTION_PATHS = new Set([
  "/api/latest/analytics/events/batch",
  "/api/v1/analytics/events/batch",
  "/api/latest/analytics/envelope",
  "/api/v1/analytics/envelope",
  "/api/latest/analytics/otlp/v1/traces",
  "/api/v1/analytics/otlp/v1/traces",
  "/api/latest/analytics/otlp/v1/logs",
  "/api/v1/analytics/otlp/v1/logs",
  "/api/latest/analytics/otlp/v1/metrics",
  "/api/v1/analytics/otlp/v1/metrics",
  "/api/latest/analytics/client-reports",
  "/api/v1/analytics/client-reports",
  "/api/latest/analytics/attachments",
  "/api/v1/analytics/attachments",
  "/api/latest/session-replays/batch",
  "/api/v1/session-replays/batch",
]);

export type HexclaveManagedSpan = {
  name: string,
  kind: SpanKind,
  attributes: Attributes,
};

function stringAttribute(attributes: Attributes, key: string): string | null {
  const value = attributes[key];
  return typeof value === "string" ? value : null;
}

function spanCandidates(span: HexclaveManagedSpan): string[] {
  return [
    span.name,
    stringAttribute(span.attributes, "http.target"),
    stringAttribute(span.attributes, "url.path"),
    stringAttribute(span.attributes, "url.full"),
  ].filter((value): value is string => value !== null);
}

function pathWithoutQuery(value: string): string {
  const queryStart = value.search(/[?#]/);
  return queryStart === -1 ? value : value.slice(0, queryStart);
}

function isNextStaticAsset(value: string): boolean {
  return /^GET (\/.*)?\/_next\/static\//.test(value)
    || value.includes("/_next/static/");
}

function isNextSourceMapFetch(value: string): boolean {
  return value.includes("/__nextjs_original-stack-frame");
}

function isNextNotFoundRequest(value: string): boolean {
  const path = pathWithoutQuery(value);
  if (path === "/404") return true;
  return /^(GET|HEAD|POST|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH) \/(404|_not-found)$/.test(path)
    || /^(GET|HEAD|POST|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH) \/(404|_not-found)\//.test(path)
    || path === "/_not-found";
}

function candidatePath(value: string): string {
  const withoutQuery = pathWithoutQuery(value);
  const requestTarget = withoutQuery.match(/^[A-Z]+\s+(.+)$/i)?.[1] ?? withoutQuery;
  try {
    return new URL(requestTarget, "http://hexclave.invalid").pathname;
  } catch {
    return requestTarget;
  }
}

function isTelemetryIngestionPath(value: string): boolean {
  return TELEMETRY_INGESTION_PATHS.has(candidatePath(value));
}

function isNextFrameworkSpan(span: HexclaveManagedSpan): boolean {
  return stringAttribute(span.attributes, "next.span_category") === "nextjs";
}

function isNextOptionsOrHeadRequest(span: HexclaveManagedSpan): boolean {
  if (!isNextFrameworkSpan(span)) return false;
  const method = stringAttribute(span.attributes, "http.method")?.toUpperCase();
  return method === "OPTIONS" || method === "HEAD";
}

function isNextStartResponseSpan(span: HexclaveManagedSpan): boolean {
  return isNextFrameworkSpan(span) && (
    span.name === "start response"
    || stringAttribute(span.attributes, "next.span_type") === "NextNodeServer.startResponse"
  );
}

function hasValidParent(context: Context): boolean {
  const parent = trace.getSpanContext(context);
  return parent !== undefined && isSpanContextValid(parent);
}

/**
 * The framework-owned spans Sentry's Next integration drops by default.
 *
 * This is intentionally a pure OTel-start policy rather than a ClickHouse
 * query rule. Once a span is recorded, its sampling decision, parent context,
 * billing, and downstream exporters have already observed it. Applying the
 * rule here keeps storage a faithful index of what the SDK chose to emit and
 * makes the policy safe to change without a data migration.
 */
export function shouldIgnoreNextFrameworkSpan(span: HexclaveManagedSpan): boolean {
  if (span.attributes[NEXT_DROP_TRANSACTION_ATTRIBUTE] === true) return true;
  if (span.name === "NextServer.getRequestHandler") return true;

  if (isNextOptionsOrHeadRequest(span)) return true;

  return spanCandidates(span).some((candidate) =>
    isNextStaticAsset(candidate)
    || isNextSourceMapFetch(candidate)
    || isNextNotFoundRequest(candidate)
    || isTelemetryIngestionPath(candidate));
}

/**
 * Wraps normal parent-based head sampling with a deterministic framework-noise
 * decision. The wrapper runs before ParentBasedSampler so ignored child spans
 * cannot accidentally re-enter the sampled branch through their parent.
 */
export class HexclaveSpanPolicySampler implements Sampler {
  public constructor(
    private readonly delegate: Sampler,
    private readonly shouldIgnore: (span: HexclaveManagedSpan) => boolean,
  ) {}

  public shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    const span = { name: spanName, kind: spanKind, attributes };
    if (
      this.shouldIgnore(span)
      || (isNextStartResponseSpan(span) && !hasValidParent(context))
    ) {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  public toString(): string {
    return `HexclaveSpanPolicySampler{delegate=${this.delegate.toString()}}`;
  }
}

export function createManagedOtelSampler(traceSampleRate: number): Sampler {
  return new HexclaveSpanPolicySampler(
    new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(traceSampleRate),
    }),
    shouldIgnoreNextFrameworkSpan,
  );
}

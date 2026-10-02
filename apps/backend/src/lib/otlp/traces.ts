import { isW3cSpanId, isW3cTraceId } from "@hexclave/shared/dist/utils/analytics-wire";
import type { ErrorIngestScrubbedRecord } from "@/lib/error-ingest/error-ingest-scrubber";
import { OtlpJsonRequestError as OtlpTraceRequestError, otlpArray as array, otlpAttributes as attributes, otlpRecord as record, otlpString as string, otlpUint as uint, otlpUint32 as uint32, otlpUnixNano as unixNano, otlpUnixNanoOrOpen as unixNanoOrOpen, type OtlpAttributes } from "./json";
export { OtlpJsonRequestError as OtlpTraceRequestError } from "./json";
export type { OtlpAttributeValue, OtlpAttributes } from "./json";

export type CanonicalOtlpSpanEvent = {
  name: string,
  timeUnixNano: string,
  attributes: OtlpAttributes,
  droppedAttributesCount: number,
};

export type CanonicalOtlpSpanLink = {
  traceId: string,
  spanId: string,
  traceState: string,
  flags: number,
  attributes: OtlpAttributes,
  droppedAttributesCount: number,
};

export type CanonicalOtlpSpan = {
  traceId: string,
  spanId: string,
  traceState: string,
  parentSpanId: string | null,
  flags: number,
  name: string,
  kind: number,
  startTimeUnixNano: string,
  endTimeUnixNano: string,
  attributes: OtlpAttributes,
  droppedAttributesCount: number,
  events: CanonicalOtlpSpanEvent[],
  droppedEventsCount: number,
  links: CanonicalOtlpSpanLink[],
  droppedLinksCount: number,
  status: { code: number, message: string },
  resource: {
    attributes: OtlpAttributes,
    droppedAttributesCount: number,
    schemaUrl: string,
  },
  scope: {
    name: string,
    version: string,
    attributes: OtlpAttributes,
    droppedAttributesCount: number,
    schemaUrl: string,
  },
  policyScrubbedData?: Readonly<ErrorIngestScrubbedRecord>,
};


function spanEvent(value: unknown, path: string): CanonicalOtlpSpanEvent {
  const event = record(value, path);
  return {
    name: string(event.name, `${path}.name`),
    timeUnixNano: unixNano(event.timeUnixNano, `${path}.timeUnixNano`),
    attributes: attributes(event.attributes ?? [], `${path}.attributes`),
    droppedAttributesCount: uint(event.droppedAttributesCount, `${path}.droppedAttributesCount`),
  };
}

function spanLink(value: unknown, path: string): CanonicalOtlpSpanLink {
  const link = record(value, path);
  const traceId = string(link.traceId, `${path}.traceId`);
  const spanId = string(link.spanId, `${path}.spanId`);
  if (!isW3cTraceId(traceId)) throw new OtlpTraceRequestError(`${path}.traceId must be a valid W3C trace id`);
  if (!isW3cSpanId(spanId)) throw new OtlpTraceRequestError(`${path}.spanId must be a valid W3C span id`);
  return {
    traceId,
    spanId,
    traceState: string(link.traceState, `${path}.traceState`, ""),
    flags: uint32(link.flags, `${path}.flags`),
    attributes: attributes(link.attributes ?? [], `${path}.attributes`),
    droppedAttributesCount: uint(link.droppedAttributesCount, `${path}.droppedAttributesCount`),
  };
}

export function normalizeOtlpJsonTraceRequest(value: unknown): CanonicalOtlpSpan[] {
  const request = record(value, "body");
  const result: CanonicalOtlpSpan[] = [];
  for (const [resourceIndex, rawResourceSpans] of array(request.resourceSpans ?? [], "body.resourceSpans").entries()) {
    const resourcePath = `body.resourceSpans[${resourceIndex}]`;
    const resourceSpans = record(rawResourceSpans, resourcePath);
    const rawResource = record(resourceSpans.resource ?? {}, `${resourcePath}.resource`);
    const resource = {
      attributes: attributes(rawResource.attributes ?? [], `${resourcePath}.resource.attributes`),
      droppedAttributesCount: uint(rawResource.droppedAttributesCount, `${resourcePath}.resource.droppedAttributesCount`),
      schemaUrl: string(resourceSpans.schemaUrl, `${resourcePath}.schemaUrl`, ""),
    };
    for (const [scopeIndex, rawScopeSpans] of array(resourceSpans.scopeSpans ?? [], `${resourcePath}.scopeSpans`).entries()) {
      const scopePath = `${resourcePath}.scopeSpans[${scopeIndex}]`;
      const scopeSpans = record(rawScopeSpans, scopePath);
      const rawScope = record(scopeSpans.scope ?? {}, `${scopePath}.scope`);
      const scope = {
        name: string(rawScope.name, `${scopePath}.scope.name`, ""),
        version: string(rawScope.version, `${scopePath}.scope.version`, ""),
        attributes: attributes(rawScope.attributes ?? [], `${scopePath}.scope.attributes`),
        droppedAttributesCount: uint(rawScope.droppedAttributesCount, `${scopePath}.scope.droppedAttributesCount`),
        schemaUrl: string(scopeSpans.schemaUrl, `${scopePath}.schemaUrl`, ""),
      };
      for (const [spanIndex, rawSpan] of array(scopeSpans.spans ?? [], `${scopePath}.spans`).entries()) {
        const spanPath = `${scopePath}.spans[${spanIndex}]`;
        const span = record(rawSpan, spanPath);
        const traceId = string(span.traceId, `${spanPath}.traceId`);
        const spanId = string(span.spanId, `${spanPath}.spanId`);
        const parentSpanId = string(span.parentSpanId, `${spanPath}.parentSpanId`, "");
        if (!isW3cTraceId(traceId)) throw new OtlpTraceRequestError(`${spanPath}.traceId must be a valid W3C trace id`);
        if (!isW3cSpanId(spanId)) throw new OtlpTraceRequestError(`${spanPath}.spanId must be a valid W3C span id`);
        if (parentSpanId !== "" && !isW3cSpanId(parentSpanId)) throw new OtlpTraceRequestError(`${spanPath}.parentSpanId must be empty or a valid W3C span id`);
        if (parentSpanId === spanId) throw new OtlpTraceRequestError(`${spanPath}.parentSpanId must not equal spanId`);
        const rawStatus = record(span.status ?? {}, `${spanPath}.status`);
        result.push({
          traceId,
          spanId,
          traceState: string(span.traceState, `${spanPath}.traceState`, ""),
          parentSpanId: parentSpanId === "" ? null : parentSpanId,
          flags: uint32(span.flags, `${spanPath}.flags`),
          name: string(span.name, `${spanPath}.name`),
          kind: uint(span.kind, `${spanPath}.kind`),
          startTimeUnixNano: unixNano(span.startTimeUnixNano, `${spanPath}.startTimeUnixNano`),
          endTimeUnixNano: unixNanoOrOpen(span.endTimeUnixNano, `${spanPath}.endTimeUnixNano`),
          attributes: attributes(span.attributes ?? [], `${spanPath}.attributes`),
          droppedAttributesCount: uint(span.droppedAttributesCount, `${spanPath}.droppedAttributesCount`),
          events: array(span.events ?? [], `${spanPath}.events`).map((entry, index) => spanEvent(entry, `${spanPath}.events[${index}]`)),
          droppedEventsCount: uint(span.droppedEventsCount, `${spanPath}.droppedEventsCount`),
          links: array(span.links ?? [], `${spanPath}.links`).map((entry, index) => spanLink(entry, `${spanPath}.links[${index}]`)),
          droppedLinksCount: uint(span.droppedLinksCount, `${spanPath}.droppedLinksCount`),
          status: {
            code: uint(rawStatus.code, `${spanPath}.status.code`),
            message: string(rawStatus.message, `${spanPath}.status.message`, ""),
          },
          resource,
          scope,
        });
        const normalized = result[result.length - 1];
        if (normalized.kind > 5) throw new OtlpTraceRequestError(`${spanPath}.kind must be an OTLP SpanKind`);
        if (normalized.status.code > 2) throw new OtlpTraceRequestError(`${spanPath}.status.code must be an OTLP StatusCode`);
        // endTimeUnixNano 0 is the OPEN-span marker: the SDK exports a
        // snapshot of long-lived system spans (e.g. the current $page-view) at
        // start so their descendants are not parentless in the UI until the
        // span ends. The spans table's ReplacingMergeTree versions rows by
        // end_time_unix_nano, so the eventual end-write supersedes it.
        if (normalized.endTimeUnixNano !== "0" && BigInt(normalized.endTimeUnixNano) < BigInt(normalized.startTimeUnixNano)) {
          throw new OtlpTraceRequestError(`${spanPath}.endTimeUnixNano must not precede startTimeUnixNano`);
        }
      }
    }
  }
  return result;
}

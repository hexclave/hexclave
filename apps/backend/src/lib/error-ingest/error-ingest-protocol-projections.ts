import {
  createErrorIngestItemOutcome,
  createErrorIngestProtocolProjection,
  type ErrorIngestItemDescriptor,
  type ErrorIngestItemOutcomeDetails,
  type ErrorIngestProtocolProjection,
} from "@/lib/error-ingest";
import { getOtlpIssueBatchId } from "@/lib/otlp/log-writer";
import type { CanonicalOtlpLogRecord } from "@/lib/otlp/logs";
import { getOtlpTraceDeduplicationToken, type OtlpTenantContext } from "@/lib/otlp/trace-writer";
import type { CanonicalOtlpSpan } from "@/lib/otlp/traces";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { ErrorIngestPolicyItemOutcome } from "./error-ingest-policy";

export function otlpSpanPolicyItemId(span: Pick<CanonicalOtlpSpan, "traceId" | "spanId">, index: number): string {
  return `span:${index}:${span.traceId}:${span.spanId}`;
}

function policyDetails(outcome: ErrorIngestPolicyItemOutcome): ErrorIngestItemOutcomeDetails {
  switch (outcome.status) {
    case "accepted": { return { status: "accepted" }; }
    case "rejected": { return { status: "rejected", reason: outcome.reason }; }
    default: {
      const exhaustive: never = outcome;
      throw new HexclaveAssertionError(`Unexpected error-ingest policy status: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function createOtlpLogProtocolProjection(
  logRecords: CanonicalOtlpLogRecord[],
  acceptedIndexes: ReadonlySet<number>,
  tenant: OtlpTenantContext,
  policyOutcomes?: readonly ErrorIngestPolicyItemOutcome[],
): ErrorIngestProtocolProjection {
  const policyByItemId = new Map(policyOutcomes?.map((outcome) => [outcome.itemId, outcome]));
  const outcomes = logRecords.map((logRecord, itemIndex) => {
    const item: ErrorIngestItemDescriptor = {
      itemId: `log:${itemIndex}`,
      itemType: "log",
    };
    if (logRecord.errorEnvelope?.eventId != null) item.eventId = logRecord.errorEnvelope.eventId;

    const policyOutcome = policyByItemId.get(item.itemId);
    if (policyOutcome !== undefined) {
      return createErrorIngestItemOutcome(item, policyDetails(policyOutcome));
    }
    if (acceptedIndexes.has(itemIndex)) {
      return createErrorIngestItemOutcome(item, { status: "accepted" });
    }
    return createErrorIngestItemOutcome(item, { status: "rejected", reason: "invalid" });
  });

  return createErrorIngestProtocolProjection(getOtlpIssueBatchId(logRecords, tenant), outcomes);
}

export function createOtlpTraceProtocolProjection(
  spans: CanonicalOtlpSpan[],
  tenant: OtlpTenantContext,
  policyOutcomes?: readonly ErrorIngestPolicyItemOutcome[],
): ErrorIngestProtocolProjection {
  if (policyOutcomes !== undefined && policyOutcomes.length !== spans.length) {
    throw new HexclaveAssertionError("OTLP trace policy outcomes must be one-per-span in span order");
  }
  const outcomes = spans.map((span, spanIndex) => {
    const item: ErrorIngestItemDescriptor = {
      itemId: otlpSpanPolicyItemId(span, spanIndex),
      itemType: "span",
    };
    const policyOutcome = policyOutcomes?.[spanIndex];
    if (policyOutcome === undefined) return createErrorIngestItemOutcome(item, { status: "accepted" });
    if (policyOutcome.itemId !== item.itemId) {
      throw new HexclaveAssertionError("OTLP trace policy outcome order does not match the span order");
    }
    return createErrorIngestItemOutcome(item, policyDetails(policyOutcome));
  });
  return createErrorIngestProtocolProjection(getOtlpTraceDeduplicationToken(spans, tenant), outcomes);
}

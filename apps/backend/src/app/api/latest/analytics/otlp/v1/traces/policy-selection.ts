import type { ErrorIngestPolicyDecision } from "@/lib/error-ingest/error-ingest-policy";
import { otlpSpanPolicyItemId } from "@/lib/error-ingest/error-ingest-protocol-projections";
import type { CanonicalOtlpSpan } from "@/lib/otlp/traces";

export { otlpSpanPolicyItemId };

export function selectOtlpSpansAcceptedByPolicy(
  spans: readonly CanonicalOtlpSpan[],
  policy: ErrorIngestPolicyDecision,
): CanonicalOtlpSpan[] {
  const acceptedItemIds = new Set(policy.acceptedItemIds);
  return spans.flatMap((span, index) => {
    const itemId = otlpSpanPolicyItemId(span, index);
    if (!acceptedItemIds.has(itemId)) return [];
    const scrubbedData = policy.scrubbedData.get(itemId);
    return [scrubbedData === undefined ? span : { ...span, policyScrubbedData: scrubbedData }];
  });
}

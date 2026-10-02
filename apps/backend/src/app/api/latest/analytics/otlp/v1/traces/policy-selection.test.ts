import type { ErrorIngestPolicyDecision } from "@/lib/error-ingest";
import type { CanonicalOtlpSpan } from "@/lib/otlp/traces";
import { describe, expect, it } from "vitest";
import { otlpSpanPolicyItemId, selectOtlpSpansAcceptedByPolicy } from "./policy-selection";

function span(name: string): CanonicalOtlpSpan {
  return {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    traceState: "",
    parentSpanId: null,
    flags: 0,
    name,
    kind: 0,
    startTimeUnixNano: "1720000000000000000",
    endTimeUnixNano: "1720000001000000000",
    attributes: new Map(),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: 0, message: "" },
    resource: { attributes: new Map(), droppedAttributesCount: 0, schemaUrl: "" },
    scope: { name: "test", version: "1", attributes: new Map(), droppedAttributesCount: 0, schemaUrl: "" },
  };
}

describe("OTLP trace policy selection", () => {
  it("does not grant one accepted duplicate identity to a rejected occurrence", () => {
    const spans = [span("first"), span("second")];
    const firstId = otlpSpanPolicyItemId(spans[0], 0);
    const secondId = otlpSpanPolicyItemId(spans[1], 1);
    const policy: ErrorIngestPolicyDecision = {
      acceptedItemIds: [firstId],
      scrubbedData: new Map(),
      outcomes: [
        { itemId: firstId, itemType: "span", status: "accepted", scrubbed: false, scrubbedBytes: 0 },
        { itemId: secondId, itemType: "span", status: "rejected", reason: "invalid", scrubbed: false, scrubbedBytes: 0 },
      ],
    };

    expect(policy.outcomes.map((outcome) => outcome.status)).toEqual(["accepted", "rejected"]);
    expect(selectOtlpSpansAcceptedByPolicy(spans, policy).map((item) => item.name)).toEqual(["first"]);
  });
});

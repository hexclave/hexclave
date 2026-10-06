import { describe, expect, it } from "vitest";
import {
  BAGGAGE_HEADER,
  decodeCorrelationBaggage,
  encodeCorrelationBaggage,
  mergeCorrelationBaggage,
} from "./span-context-codec";

const REPLAY_ID = "11111111-1111-4111-8111-111111111111";
const SEGMENT_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_VIEW_SPAN_ID = "3333333333333333";

describe("Hexclave W3C baggage correlation", () => {
  it("uses the standard baggage carrier and namespaced keys", () => {
    expect(BAGGAGE_HEADER).toBe("baggage");
    const encoded = encodeCorrelationBaggage({
      sessionReplayId: REPLAY_ID,
      sessionReplaySegmentId: SEGMENT_ID,
      pageViewSpanId: PAGE_VIEW_SPAN_ID,
    });

    expect(encoded).toBe(
      `hexclave.session_replay.id=${REPLAY_ID},hexclave.session_replay.segment.id=${SEGMENT_ID},hexclave.page_view.span_id=${PAGE_VIEW_SPAN_ID}`,
    );
    expect(decodeCorrelationBaggage(encoded)).toEqual({
      sessionReplayId: REPLAY_ID,
      sessionReplaySegmentId: SEGMENT_ID,
      pageViewSpanId: PAGE_VIEW_SPAN_ID,
    });
  });

  it("preserves unrelated vendor baggage while replacing Hexclave-owned keys", () => {
    const merged = mergeCorrelationBaggage(
      `vendor.route=checkout,hexclave.session_replay.id=${REPLAY_ID}`,
      { sessionReplayId: "44444444-4444-4444-8444-444444444444" },
    );

    expect(merged).toContain("vendor.route=checkout");
    expect(merged).toContain("hexclave.session_replay.id=44444444-4444-4444-8444-444444444444");
    expect(merged).not.toContain(REPLAY_ID);
  });

  it("returns only valid Hexclave correlation and ignores ordinary baggage", () => {
    expect(decodeCorrelationBaggage(
      "vendor.route=checkout,hexclave.session_replay.id=invalid,hexclave.page_view.span_id=0000000000000000",
    )).toBeNull();
  });

  it("does not emit an empty project-only carrier", () => {
    expect(encodeCorrelationBaggage({ projectId: "ignored" })).toBeNull();
  });
});

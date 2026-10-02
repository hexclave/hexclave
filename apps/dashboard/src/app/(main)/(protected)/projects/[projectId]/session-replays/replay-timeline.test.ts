import { describe, expect, it } from "vitest";
import {
  formatReplayTimelineEventTooltip,
  getReplayTimelineQuery,
  replayTimelineMarkerClassName,
} from "./replay-timeline";

describe("replay timeline", () => {
  it("loads correlated errors from the errors view", () => {
    const query = getReplayTimelineQuery();

    expect(query).toContain("FROM default.events");
    expect(query).toContain("FROM default.errors");
    expect(query).toContain("session_replay_id = {id:String}");
    expect(query).toContain("event_type NOT IN ('$page-view', '$error')");
    expect(query).toContain("FROM default.page_views");
  });

  it("formats an error marker with its normalized name and message", () => {
    expect(formatReplayTimelineEventTooltip({
      eventType: "$error",
      eventAtMs: 1000,
      data: { name: "TypeError", message: "cart.total is not a function" },
    })).toBe("TypeError: cart.total is not a function");
  });

  it("uses the error marker color", () => {
    expect(replayTimelineMarkerClassName("$error")).toContain("bg-red-");
  });
});

import { describe, expect, it } from "vitest";
import {
  eventsHref,
  logsHref,
  sessionReplayHref,
  traceDetailHref,
  tracesHref,
} from "./observability-links";

describe("observability hrefs", () => {
  it("keeps the one-argument trace deep-link", () => {
    expect(traceDetailHref("proj", "0123456789abcdef0123456789abcdef")).toBe(
      "/projects/proj/observability/traces?trace=0123456789abcdef0123456789abcdef",
    );
  });

  it("adds span and event highlight params without dropping the trace id", () => {
    expect(traceDetailHref("proj", {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      eventType: "checkout_completed",
      eventAtMs: 1_720_000_000_000,
    })).toBe(
      "/projects/proj/observability/traces?trace=0123456789abcdef0123456789abcdef&span=0123456789abcdef&event=checkout_completed&at=1720000000000",
    );
  });

  it("omits empty optional highlight fields", () => {
    expect(traceDetailHref("proj", {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: null,
      eventType: "",
    })).toBe("/projects/proj/observability/traces?trace=0123456789abcdef0123456789abcdef");
  });

  it("encodes a replay wall-clock seek", () => {
    expect(sessionReplayHref("proj", "replay-1", { atMs: 1_720_000_000_000 })).toBe(
      "/projects/proj/session-replays/replay-1?at=1720000000000",
    );
    expect(sessionReplayHref("proj", "replay-1")).toBe("/projects/proj/session-replays/replay-1");
  });

  it("points events and logs at their own pages", () => {
    expect(eventsHref("proj")).toBe("/projects/proj/analytics/events");
    expect(logsHref("proj")).toBe("/projects/proj/observability/logs");
    expect(tracesHref("proj")).toBe("/projects/proj/observability/traces");
  });
});

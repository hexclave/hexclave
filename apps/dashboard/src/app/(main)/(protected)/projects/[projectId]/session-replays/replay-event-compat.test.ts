import { EventType, IncrementalSource, NodeType, type eventWithTime } from "@rrweb/types";
import { describe, expect, it } from "vitest";
import { ensureMetaBeforeFirstFullSnapshot, FALLBACK_REPLAY_VIEWPORT } from "./replay-event-compat";

function fullSnapshot(timestamp: number): eventWithTime {
  return {
    type: EventType.FullSnapshot,
    timestamp,
    data: {
      node: { type: NodeType.Document, childNodes: [], id: 1 },
      initialOffset: { left: 0, top: 0 },
    },
  };
}

function meta(timestamp: number): eventWithTime {
  return { type: EventType.Meta, timestamp, data: { href: "https://example.com/", width: 800, height: 600 } };
}

function mouseMove(timestamp: number): eventWithTime {
  return { type: EventType.IncrementalSnapshot, timestamp, data: { source: IncrementalSource.MouseMove, positions: [] } };
}

function viewportResize(timestamp: number, width: number, height: number): eventWithTime {
  return { type: EventType.IncrementalSnapshot, timestamp, data: { source: IncrementalSource.ViewportResize, width, height } };
}

describe("ensureMetaBeforeFirstFullSnapshot", () => {
  it("inserts a synthetic Meta before a bare first FullSnapshot", () => {
    const events = [fullSnapshot(1000), mouseMove(1001)];

    expect(ensureMetaBeforeFirstFullSnapshot(events)).toBe(true);
    expect(events.map((e) => e.type)).toEqual([EventType.Meta, EventType.FullSnapshot, EventType.IncrementalSnapshot]);
    expect(events[0]).toMatchObject({
      timestamp: 1000,
      data: { width: FALLBACK_REPLAY_VIEWPORT.width, height: FALLBACK_REPLAY_VIEWPORT.height },
    });
  });

  it("repairs a single-event chunk so the Replayer constructor has its two events", () => {
    const events = [fullSnapshot(1000)];

    expect(ensureMetaBeforeFirstFullSnapshot(events)).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("prefers the recording's own viewport dimensions over the fallback", () => {
    const events = [fullSnapshot(1000), viewportResize(1200, 1512, 982)];

    expect(ensureMetaBeforeFirstFullSnapshot(events)).toBe(true);
    expect(events[0]).toMatchObject({ data: { width: 1512, height: 982 } });
  });

  it("leaves healthy recordings untouched", () => {
    const events = [meta(999), fullSnapshot(1000), mouseMove(1001)];

    expect(ensureMetaBeforeFirstFullSnapshot(events)).toBe(false);
    expect(events).toHaveLength(3);
  });

  it("is a no-op once repaired, even as later chunks append more snapshots", () => {
    const events = [fullSnapshot(1000), mouseMove(1001)];
    ensureMetaBeforeFirstFullSnapshot(events);
    events.push(fullSnapshot(2000));

    expect(ensureMetaBeforeFirstFullSnapshot(events)).toBe(false);
    expect(events).toHaveLength(4);
  });

  it("does nothing while only incremental events have arrived", () => {
    const events = [mouseMove(1000)];

    expect(ensureMetaBeforeFirstFullSnapshot(events)).toBe(false);
    expect(events).toHaveLength(1);
  });

  it("repairs a FullSnapshot that arrives in a later chunk than the first events", () => {
    const events = [mouseMove(1000), fullSnapshot(1500)];

    expect(ensureMetaBeforeFirstFullSnapshot(events)).toBe(true);
    expect(events.map((e) => e.type)).toEqual([EventType.IncrementalSnapshot, EventType.Meta, EventType.FullSnapshot]);
  });
});

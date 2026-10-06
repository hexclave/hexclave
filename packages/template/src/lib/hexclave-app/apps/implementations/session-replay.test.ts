// @vitest-environment jsdom

import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { describe, expect, it, vi } from "vitest";
import * as errors from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import { canInlineStylesheetLink, getOrRotateSession, SessionRecorder } from "./session-replay";
import { analyticsOptionsFromJson, analyticsOptionsToJson, getSessionReplayOptions } from "./analytics-config";
import { telemetryOptionsToJson } from "./telemetry-config";

const TEST_RESOURCE = { service: { name: "test-client" } } as const;

describe("session replay lifecycle", () => {
  it("rotates after the maximum replay duration even when the tab stays active", () => {
    const key = "session-replay-max-duration-test";
    localStorage.setItem(key, JSON.stringify({
      session_id: "12345678-1234-4123-8123-123456789abc",
      created_at_ms: 1,
      last_activity_ms: 12 * 60 * 60 * 1000,
    }));

    const rotated = getOrRotateSession({ key, nowMs: 12 * 60 * 60 * 1000 + 2 });
    expect(rotated.session_id).not.toBe("12345678-1234-4123-8123-123456789abc");
  });
});

const rrwebMocks = vi.hoisted(() => {
  type TestRrwebEvent = { type: number, timestamp: number, data: Record<string, unknown> };
  let emit: ((event: TestRrwebEvent) => void) | undefined;
  // Faithful to real rrweb: takeFullSnapshot emits a Meta event (type 4)
  // immediately before the FullSnapshot (type 2). The replayer keeps its
  // iframe hidden until the first Meta sizes it, so the recorder must never
  // drop the Meta half of a snapshot — tests rely on the mock modeling this.
  const takeFullSnapshot = vi.fn(() => {
    emit?.({ type: 4, timestamp: Date.now(), data: { href: "https://example.com/", width: 1280, height: 720 } });
    emit?.({ type: 2, timestamp: Date.now(), data: {} });
  });
  const record = Object.assign(vi.fn((options: { emit: (event: TestRrwebEvent) => void }) => {
    emit = options.emit;
    return () => {};
  }), { takeFullSnapshot });
  const emitEvent = (event: TestRrwebEvent) => {
    if (emit === undefined) throw new Error("rrweb record() has not started");
    emit(event);
  };
  return { record, takeFullSnapshot, emitEvent };
});
vi.mock("@rrweb/record", () => ({ record: rrwebMocks.record }));

describe("session replay options", () => {
  it("enables replays by default", () => {
    expect(getSessionReplayOptions(undefined).enabled).toBe(true);
    expect(getSessionReplayOptions({}).enabled).toBe(true);
    expect(getSessionReplayOptions({ replays: {} }).enabled).toBe(true);
    expect(getSessionReplayOptions(undefined).captureKeystrokes).toBe(false);
  });

  it("preserves explicit replay opt-out", () => {
    expect(getSessionReplayOptions({ replays: { enabled: false } }).enabled).toBe(false);
  });
});

describe("analytics option JSON conversion", () => {
  it("preserves top-level analytics options when serializing replay block classes", () => {
    const json = analyticsOptionsToJson({
      enabled: false,
      replays: {
        enabled: true,
        captureKeystrokes: true,
        blockClass: /stack-sensitive/u,
      },
    });

    expect(json?.enabled).toBe(false);
    expect(json?.replays?.enabled).toBe(true);
    expect(json?.replays?.captureKeystrokes).toBe(true);
  });

  it("preserves top-level analytics options when deserializing replay block classes", () => {
    const roundTripped = analyticsOptionsFromJson(analyticsOptionsToJson({
      enabled: false,
      replays: {
        blockClass: /stack-sensitive/u,
      },
    }));

    expect(roundTripped?.enabled).toBe(false);
    expect(roundTripped?.replays?.blockClass).toEqual(/stack-sensitive/u);
  });

  it("omits the function-valued telemetry lifecycle hook from serialized apps", () => {
    const waitUntil = vi.fn();
    expect(telemetryOptionsToJson({ waitUntil })).toBeUndefined();
  });
});

describe("canInlineStylesheetLink", () => {
  function makeLink(sheet: unknown): HTMLLinkElement {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    Object.defineProperty(link, "sheet", { value: sheet });
    return link;
  }

  it("is false when the sheet hasn't been attached", () => {
    expect(canInlineStylesheetLink(makeLink(null))).toBe(false);
  });

  it("is false when reading cssRules throws (cross-origin without CORS)", () => {
    const sheet = {
      get cssRules(): CSSRuleList {
        throw new DOMException("not allowed", "SecurityError");
      },
    };
    expect(canInlineStylesheetLink(makeLink(sheet))).toBe(false);
  });

  it("is false for an empty sheet", () => {
    expect(canInlineStylesheetLink(makeLink({ cssRules: [] }))).toBe(false);
  });

  it("is true for a readable non-empty sheet", () => {
    expect(canInlineStylesheetLink(makeLink({ cssRules: [{}] }))).toBe(true);
  });
});

describe("SessionRecorder stylesheet re-snapshot", () => {
  function makeRecorder(replayOptions: ConstructorParameters<typeof SessionRecorder>[1] = {}) {
    return new SessionRecorder(
      {
        projectId: "test-project",
        resource: TEST_RESOURCE,
        sendBatch: async () => Result.ok(new Response("ok", { status: 200 })),
      },
      replayOptions,
    );
  }

  it("always blocks Hexclave-owned nested replay players", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const recorder = makeRecorder({ blockClass: "customer-secret", blockSelector: ".customer-private" });

    try {
      await startRecorder(recorder);

      expect(rrwebMocks.record).toHaveBeenCalledWith(expect.objectContaining({
        blockClass: "customer-secret",
        blockSelector: "[data-hexclave-session-replay-block], .customer-private",
      }));
    } finally {
      recorder.stop();
      vi.useRealTimers();
    }
  });

  async function startRecorder(recorder: SessionRecorder) {
    recorder.start();
    // Flush the dynamic import("@rrweb/record") microtasks so record() runs and the
    // stylesheet-load listener is attached.
    await vi.advanceTimersByTimeAsync(0);
    expect(rrwebMocks.record).toHaveBeenCalledTimes(1);
  }

  function attachStylesheetLink(options: { sheet: unknown }): HTMLLinkElement {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://example.com/app.css";
    Object.defineProperty(link, "sheet", { value: options.sheet });
    document.head.appendChild(link);
    return link;
  }

  it("re-takes a full snapshot (debounced) when a stylesheet finishes loading during recording", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const recorder = makeRecorder();

    try {
      await startRecorder(recorder);

      const link = attachStylesheetLink({ sheet: { cssRules: [{}] } });
      link.dispatchEvent(new Event("load"));

      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(900);
      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();

      const link2 = attachStylesheetLink({ sheet: { cssRules: [{}] } });
      link2.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(900);
      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      expect(rrwebMocks.takeFullSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(rrwebMocks.takeFullSnapshot).toHaveBeenCalledTimes(1);

      link.remove();
      link2.remove();
    } finally {
      recorder.stop();
      vi.useRealTimers();
    }
  });

  it("suppresses post-sign-out mutations until authentication resumes with a fresh full snapshot", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const recorder = makeRecorder();

    try {
      await startRecorder(recorder);
      recorder.clearBuffer();
      recorder.setSessionReplaySegmentId("next-user-segment");

      rrwebMocks.emitEvent({ type: 3, timestamp: Date.now(), data: {} });
      expect(Reflect.get(recorder, "_events")).toEqual([]);
      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();

      recorder.captureFullSnapshotForCurrentSegment();
      rrwebMocks.emitEvent({ type: 3, timestamp: Date.now() + 1, data: {} });

      expect(rrwebMocks.takeFullSnapshot).toHaveBeenCalledOnce();
      // The Meta event must survive the rotation gate alongside the
      // FullSnapshot — without it the replayer never unhides its iframe and
      // the whole segment plays back as a blank white frame.
      expect(Reflect.get(recorder, "_events")).toMatchObject([
        { type: 4 },
        { type: 2 },
        { type: 3 },
      ]);
    } finally {
      recorder.stop();
      vi.useRealTimers();
    }
  });

  it("does not re-snapshot for stylesheets rrweb can't inline, or for non-stylesheet loads", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const recorder = makeRecorder();

    try {
      await startRecorder(recorder);

      const crossOriginLink = attachStylesheetLink({
        sheet: {
          get cssRules(): CSSRuleList {
            throw new DOMException("not allowed", "SecurityError");
          },
        },
      });
      crossOriginLink.dispatchEvent(new Event("load"));

      const img = document.createElement("img");
      document.body.appendChild(img);
      img.dispatchEvent(new Event("load"));

      await vi.advanceTimersByTimeAsync(10_000);
      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();

      crossOriginLink.remove();
      img.remove();
    } finally {
      recorder.stop();
      vi.useRealTimers();
    }
  });

  it("cancels a pending re-snapshot when recording stops", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const recorder = makeRecorder();

    try {
      await startRecorder(recorder);

      const link = attachStylesheetLink({ sheet: { cssRules: [{}] } });
      link.dispatchEvent(new Event("load"));

      recorder.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();

      link.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();

      link.remove();
    } finally {
      recorder.stop();
      vi.useRealTimers();
    }
  });
});

describe("canInlineStylesheetLink", () => {
  function makeLink(sheet: unknown): HTMLLinkElement {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    Object.defineProperty(link, "sheet", { value: sheet });
    return link;
  }

  it("is false when the sheet hasn't been attached", () => {
    expect(canInlineStylesheetLink(makeLink(null))).toBe(false);
  });

  it("is false when reading cssRules throws (cross-origin without CORS)", () => {
    const sheet = {
      get cssRules(): CSSRuleList {
        throw new DOMException("not allowed", "SecurityError");
      },
    };
    expect(canInlineStylesheetLink(makeLink(sheet))).toBe(false);
  });

  it("is false for an empty sheet", () => {
    expect(canInlineStylesheetLink(makeLink({ cssRules: [] }))).toBe(false);
  });

  it("is true for a readable non-empty sheet", () => {
    expect(canInlineStylesheetLink(makeLink({ cssRules: [{}] }))).toBe(true);
  });
});

describe("SessionRecorder stylesheet re-snapshot", () => {
  function makeRecorder() {
    return new SessionRecorder(
      {
        projectId: "test-project",
        resource: TEST_RESOURCE,
        sendBatch: async () => Result.ok(new Response("ok", { status: 200 })),
      },
      {},
    );
  }

  async function startRecorder(recorder: SessionRecorder) {
    recorder.start();
    // Flush the dynamic import("@rrweb/record") microtasks so record() runs and the
    // stylesheet-load listener is attached.
    await vi.advanceTimersByTimeAsync(0);
    expect(rrwebMocks.record).toHaveBeenCalledTimes(1);
  }

  function attachStylesheetLink(options: { sheet: unknown }): HTMLLinkElement {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://example.com/app.css";
    Object.defineProperty(link, "sheet", { value: options.sheet });
    document.head.appendChild(link);
    return link;
  }

  it("re-takes a full snapshot (debounced) when a stylesheet finishes loading during recording", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const recorder = makeRecorder();

    try {
      await startRecorder(recorder);

      const link = attachStylesheetLink({ sheet: { cssRules: [{}] } });
      link.dispatchEvent(new Event("load"));

      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(900);
      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();

      const link2 = attachStylesheetLink({ sheet: { cssRules: [{}] } });
      link2.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(900);
      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      expect(rrwebMocks.takeFullSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(rrwebMocks.takeFullSnapshot).toHaveBeenCalledTimes(1);

      link.remove();
      link2.remove();
    } finally {
      recorder.stop();
      vi.useRealTimers();
    }
  });

  it("does not re-snapshot for stylesheets rrweb can't inline, or for non-stylesheet loads", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const recorder = makeRecorder();

    try {
      await startRecorder(recorder);

      const crossOriginLink = attachStylesheetLink({
        sheet: {
          get cssRules(): CSSRuleList {
            throw new DOMException("not allowed", "SecurityError");
          },
        },
      });
      crossOriginLink.dispatchEvent(new Event("load"));

      const img = document.createElement("img");
      document.body.appendChild(img);
      img.dispatchEvent(new Event("load"));

      await vi.advanceTimersByTimeAsync(10_000);
      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();

      crossOriginLink.remove();
      img.remove();
    } finally {
      recorder.stop();
      vi.useRealTimers();
    }
  });

  it("cancels a pending re-snapshot when recording stops", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const recorder = makeRecorder();

    try {
      await startRecorder(recorder);

      const link = attachStylesheetLink({ sheet: { cssRules: [{}] } });
      link.dispatchEvent(new Event("load"));

      recorder.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();

      link.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rrwebMocks.takeFullSnapshot).not.toHaveBeenCalled();

      link.remove();
    } finally {
      recorder.stop();
      vi.useRealTimers();
    }
  });
});

describe("SessionRecorder flush", () => {
  it("regenerates the first full snapshot when its upload fails", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    const storageKey = `hexclave:session-replay:v1:test-project`;
    localStorage.setItem(storageKey, JSON.stringify({
      session_id: "test-session",
      created_at_ms: Date.now(),
      last_activity_ms: Date.now(),
    }));

    const sentBodies: string[] = [];
    const recorder = new SessionRecorder(
      {
        projectId: "test-project",
        resource: TEST_RESOURCE,
        sendBatch: async (body) => {
          sentBodies.push(body);
          return sentBodies.length === 1
            ? Result.error(new Error("temporary network failure"))
            : Result.ok(new Response("ok", { status: 200 }));
        },
      },
      {},
    );
    const captureWarningSpy = vi.spyOn(errors, "captureWarning").mockImplementation(() => {});

    try {
      recorder.start();
      await vi.advanceTimersByTimeAsync(0);
      rrwebMocks.emitEvent({ type: 2, timestamp: Date.now(), data: { initial: true } });
      rrwebMocks.emitEvent({ type: 3, timestamp: Date.now() + 1, data: { stale: true } });

      await vi.advanceTimersByTimeAsync(5_000);

      expect(sentBodies).toHaveLength(1);
      expect(JSON.parse(sentBodies[0]).events).toMatchObject([{ type: 2 }, { type: 3 }]);
      expect(rrwebMocks.takeFullSnapshot).toHaveBeenCalledOnce();
      expect(Reflect.get(recorder, "_events")).toMatchObject([{ type: 4 }, { type: 2 }]);

      rrwebMocks.emitEvent({ type: 3, timestamp: Date.now() + 2, data: { fresh: true } });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sentBodies).toHaveLength(2);
      expect(JSON.parse(sentBodies[1]).events).toMatchObject([{ type: 4 }, { type: 2 }, { type: 3 }]);
    } finally {
      recorder.stop();
      captureWarningSpy.mockRestore();
      localStorage.removeItem(storageKey);
      vi.useRealTimers();
    }
  });

  it("silently ignores network errors caused by ad blockers", async () => {
    vi.useFakeTimers();

    const storageKey = `hexclave:session-replay:v1:test-project`;
    localStorage.setItem(storageKey, JSON.stringify({
      session_id: "test-session",
      created_at_ms: Date.now(),
      last_activity_ms: Date.now(),
    }));

    const sentBodies: string[] = [];
    const recorder = new SessionRecorder(
      {
        projectId: "test-project",
        resource: TEST_RESOURCE,
        sendBatch: async (body) => {
          sentBodies.push(body);
          return Result.error(new TypeError("Failed to fetch"));
        },
      },
      {},
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const event1 = { type: 2, timestamp: Date.now(), data: {} };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._events = [event1];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._eventSizes = [JSON.stringify(event1).length];

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (recorder as any)._tick();
      await vi.advanceTimersByTimeAsync(0);

      expect(sentBodies).toHaveLength(1);
      expect(JSON.parse(sentBodies[0])).toMatchObject({
        schema_version: 2,
        resource: TEST_RESOURCE,
      });
      expect(warnSpy).not.toHaveBeenCalled();

      // Unlike ANALYTICS_NOT_ENABLED, ad blocker errors do NOT disable the
      // recorder — subsequent flushes continue attempting delivery.
      const event2 = { type: 3, timestamp: Date.now(), data: {} };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._events = [event2];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._eventSizes = [JSON.stringify(event2).length];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (recorder as any)._tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(sentBodies).toHaveLength(2);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      recorder.stop();
      warnSpy.mockRestore();
      localStorage.removeItem(storageKey);
      vi.useRealTimers();
    }
  });

  it("splits large batches into multiple requests to stay under server 1MB limit", async () => {
    vi.useFakeTimers();

    const storageKey = `hexclave:session-replay:v1:test-project`;
    localStorage.setItem(storageKey, JSON.stringify({
      session_id: "test-session",
      created_at_ms: Date.now(),
      last_activity_ms: Date.now(),
    }));

    const sentBodies: string[] = [];
    const recorder = new SessionRecorder(
      {
        projectId: "test-project",
        resource: TEST_RESOURCE,
        sendBatch: async (body) => {
          sentBodies.push(body);
          return Result.ok(new Response("ok", { status: 200 }));
        },
      },
      {},
    );

    try {
      // Create events that together exceed 900KB (the per-batch cap).
      // Each event is ~500KB, so two events (~1MB) must be split into two batches.
      const largeData = "x".repeat(500_000);
      const event1 = { type: 2, timestamp: Date.now(), data: largeData };
      const event2 = { type: 3, timestamp: Date.now(), data: largeData };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._events = [event1, event2];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._eventSizes = [JSON.stringify(event1).length, JSON.stringify(event2).length];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._approxBytes = JSON.stringify(event1).length + JSON.stringify(event2).length;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (recorder as any)._tick();
      await vi.advanceTimersByTimeAsync(0);

      // Should have sent two separate batches
      expect(sentBodies).toHaveLength(2);

      // Each batch should contain exactly one event
      const batch1 = JSON.parse(sentBodies[0]);
      const batch2 = JSON.parse(sentBodies[1]);
      expect(batch1.events).toHaveLength(1);
      expect(batch2.events).toHaveLength(1);

      // They should have different batch IDs
      expect(batch1.batch_id).not.toBe(batch2.batch_id);
    } finally {
      recorder.stop();
      localStorage.removeItem(storageKey);
      vi.useRealTimers();
    }
  });

  it("keeps all batches from one flush on the segment id captured before sign-out rotation", async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    const storageKey = `hexclave:session-replay:v1:test-project`;
    localStorage.setItem(storageKey, JSON.stringify({
      session_id: "test-session",
      created_at_ms: Date.now(),
      last_activity_ms: Date.now(),
    }));

    const sentBodies: string[] = [];
    const materializedSegments: string[] = [];
    const recorder = new SessionRecorder(
      {
        projectId: "test-project",
        resource: TEST_RESOURCE,
        sendBatch: async (body) => {
          sentBodies.push(body);
          if (sentBodies.length === 1) recorder.setSessionReplaySegmentId("new-segment");
          return Result.ok(new Response("ok", { status: 200 }));
        },
        sessionReplaySegmentId: "old-segment",
        onSessionReplaySegmentMaterialized: async (segmentId) => {
          materializedSegments.push(segmentId);
        },
      },
      {},
    );

    try {
      recorder.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(rrwebMocks.record).toHaveBeenCalledTimes(1);

      const largeData = "x".repeat(500_000);
      rrwebMocks.emitEvent({ type: 2, timestamp: Date.now(), data: { payload: largeData } });
      rrwebMocks.emitEvent({ type: 3, timestamp: Date.now() + 1, data: { payload: largeData } });
      await vi.advanceTimersByTimeAsync(0);

      expect(sentBodies).toHaveLength(2);
      const batch1 = JSON.parse(sentBodies[0]);
      const batch2 = JSON.parse(sentBodies[1]);
      expect(batch1.session_replay_segment_id).toBe("old-segment");
      expect(batch2.session_replay_segment_id).toBe("old-segment");
      expect(materializedSegments).toEqual(["old-segment", "old-segment"]);
    } finally {
      recorder.stop();
      localStorage.removeItem(storageKey);
      vi.useRealTimers();
    }
  });

  it("sends a single oversized event alone without dropping it", async () => {
    vi.useFakeTimers();

    const storageKey = `hexclave:session-replay:v1:test-project`;
    localStorage.setItem(storageKey, JSON.stringify({
      session_id: "test-session",
      created_at_ms: Date.now(),
      last_activity_ms: Date.now(),
    }));

    const sentBodies: string[] = [];
    const recorder = new SessionRecorder(
      {
        projectId: "test-project",
        resource: TEST_RESOURCE,
        sendBatch: async (body) => {
          sentBodies.push(body);
          return Result.ok(new Response("ok", { status: 200 }));
        },
      },
      {},
    );

    try {
      // A single event larger than 900KB — should still be sent (not dropped)
      const hugeData = "y".repeat(1_000_000);
      const hugeEvent = { type: 2, timestamp: Date.now(), data: hugeData };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._events = [hugeEvent];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._eventSizes = [JSON.stringify(hugeEvent).length];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._approxBytes = JSON.stringify(hugeEvent).length;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (recorder as any)._tick();
      await vi.advanceTimersByTimeAsync(0);

      // Sent (not dropped): the transport gzips it under the wire limit.
      expect(sentBodies).toHaveLength(1);
      const batch = JSON.parse(sentBodies[0]);
      expect(batch.events).toHaveLength(1);
    } finally {
      recorder.stop();
      localStorage.removeItem(storageKey);
      vi.useRealTimers();
    }
  });

  it("drops a single event that exceeds the server's decompressed budget", async () => {
    vi.useFakeTimers();

    const storageKey = `hexclave:session-replay:v1:test-project`;
    localStorage.setItem(storageKey, JSON.stringify({
      session_id: "test-session",
      created_at_ms: Date.now(),
      last_activity_ms: Date.now(),
    }));

    const sentBodies: string[] = [];
    const recorder = new SessionRecorder(
      {
        projectId: "test-project",
        resource: TEST_RESOURCE,
        sendBatch: async (body) => {
          sentBodies.push(body);
          return Result.ok(new Response("ok", { status: 200 }));
        },
      },
      {},
    );

    try {
      // >8MB (MAX_SINGLE_EVENT_BYTES) is dropped; the next event still sends.
      const hugeEvent = { type: 2, timestamp: Date.now(), data: "z".repeat(9_000_000) };
      const smallEvent = { type: 3, timestamp: Date.now(), data: "ok" };
      const sizeOf = (e: unknown) => JSON.stringify(e).length;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._events = [hugeEvent, smallEvent];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._eventSizes = [sizeOf(hugeEvent), sizeOf(smallEvent)];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._approxBytes = sizeOf(hugeEvent) + sizeOf(smallEvent);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (recorder as any)._tick();
      await vi.advanceTimersByTimeAsync(0);

      expect(sentBodies).toHaveLength(1);
      const batch = JSON.parse(sentBodies[0]);
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0].type).toBe(3);
    } finally {
      recorder.stop();
      localStorage.removeItem(storageKey);
      vi.useRealTimers();
    }
  });

  it("on a keepalive flush, drops an event over the uncompressed batch target (it can't be gzipped before page tear-down)", async () => {
    vi.useFakeTimers();

    const storageKey = `hexclave:session-replay:v1:test-project`;
    localStorage.setItem(storageKey, JSON.stringify({
      session_id: "test-session",
      created_at_ms: Date.now(),
      last_activity_ms: Date.now(),
    }));

    const sentBodies: string[] = [];
    const recorder = new SessionRecorder(
      {
        projectId: "test-project",
        resource: TEST_RESOURCE,
        sendBatch: async (body) => {
          sentBodies.push(body);
          return Result.ok(new Response("ok", { status: 200 }));
        },
      },
      {},
    );

    try {
      // ~2MB is under the 8MB gzipped ceiling but over the 900KB uncompressed
      // batch target. Keepalive flushes skip gzip, so this event would 413 the
      // server's ~1MB raw body limit; it must be dropped, but the next event
      // (small enough to send raw) still goes out.
      const midEvent = { type: 2, timestamp: Date.now(), data: "z".repeat(2_000_000) };
      const smallEvent = { type: 3, timestamp: Date.now(), data: "ok" };
      const sizeOf = (e: unknown) => new TextEncoder().encode(JSON.stringify(e)).byteLength;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._events = [midEvent, smallEvent];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._eventSizes = [sizeOf(midEvent), sizeOf(smallEvent)];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._approxBytes = sizeOf(midEvent) + sizeOf(smallEvent);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      await (recorder as any)._flush({ keepalive: true });

      expect(sentBodies).toHaveLength(1);
      const batch = JSON.parse(sentBodies[0]);
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0].type).toBe(3);
    } finally {
      recorder.stop();
      localStorage.removeItem(storageKey);
      vi.useRealTimers();
    }
  });

  it("logs a distinct 413 warning and drops the buffered events when the server rejects a batch as too large", async () => {
    vi.useFakeTimers();
    const captureWarningSpy = vi.spyOn(errors, "captureWarning").mockImplementation(() => {});

    const storageKey = `hexclave:session-replay:v1:test-project`;
    localStorage.setItem(storageKey, JSON.stringify({
      session_id: "test-session",
      created_at_ms: Date.now(),
      last_activity_ms: Date.now(),
    }));

    let calls = 0;
    const recorder = new SessionRecorder(
      {
        projectId: "test-project",
        resource: TEST_RESOURCE,
        sendBatch: async () => {
          calls += 1;
          // A poorly-compressible event can clear the client-side caps yet still
          // exceed the server's body limit after gzip → 413.
          return Result.ok(new Response("payload too large", { status: 413 }));
        },
      },
      {},
    );

    try {
      const eventA = { type: 3, timestamp: Date.now(), data: "a" };
      const eventB = { type: 3, timestamp: Date.now(), data: "b" };
      const sizeOf = (e: unknown) => new TextEncoder().encode(JSON.stringify(e)).byteLength;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._events = [eventA, eventB];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._eventSizes = [sizeOf(eventA), sizeOf(eventB)];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._approxBytes = sizeOf(eventA) + sizeOf(eventB);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      await (recorder as any)._flush({ keepalive: false });

      // The 413 stops the loop; no retry of the rejected batch.
      expect(calls).toBe(1);
      expect(captureWarningSpy).toHaveBeenCalledTimes(1);
      const warned = captureWarningSpy.mock.calls[0]?.[1];
      expect(warned).toBeInstanceOf(Error);
      expect((warned as Error).message).toContain("413");
      // Both buffered events are reported as dropped.
      expect((warned as Error).message).toContain("2 buffered event");
    } finally {
      recorder.stop();
      localStorage.removeItem(storageKey);
      captureWarningSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("silently disables when client interface returns ANALYTICS_NOT_ENABLED as an error", async () => {
    vi.useFakeTimers();

    const storageKey = `hexclave:session-replay:v1:test-project`;
    localStorage.setItem(storageKey, JSON.stringify({
      session_id: "test-session",
      created_at_ms: Date.now(),
      last_activity_ms: Date.now(),
    }));

    const sentBodies: string[] = [];
    const recorder = new SessionRecorder(
      {
        projectId: "test-project",
        resource: TEST_RESOURCE,
        sendBatch: async (body) => {
          sentBodies.push(body);
          return Result.error(new KnownErrors.AnalyticsNotEnabled());
        },
      },
      {},
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const event1 = { type: 2, timestamp: Date.now(), data: {} };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._events = [event1];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._eventSizes = [JSON.stringify(event1).length];

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (recorder as any)._tick();
      await vi.advanceTimersByTimeAsync(0);

      expect(sentBodies).toHaveLength(1);
      expect(warnSpy).not.toHaveBeenCalled();

      const event2 = { type: 3, timestamp: Date.now(), data: {} };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._events = [event2];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (recorder as any)._eventSizes = [JSON.stringify(event2).length];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (recorder as any)._tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(sentBodies).toHaveLength(1);
    } finally {
      recorder.stop();
      warnSpy.mockRestore();
      localStorage.removeItem(storageKey);
      vi.useRealTimers();
    }
  });
});

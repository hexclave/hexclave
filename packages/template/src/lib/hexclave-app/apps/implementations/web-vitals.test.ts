import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebVitalsCollector, type WebVitalsCollectorOptions } from "./web-vitals";

class MockPerformanceObserver {
  static supportedEntryTypes = ["navigation", "paint", "largest-contentful-paint", "layout-shift", "event", "first-input"];
  static instances: MockPerformanceObserver[] = [];

  observedType: string | null = null;
  disconnected = false;

  constructor(private readonly callback: (list: { getEntries: () => unknown[] }) => void) {
    MockPerformanceObserver.instances.push(this);
  }

  observe(options: { type: string }) {
    this.observedType = options.type;
  }

  disconnect() {
    this.disconnected = true;
  }

  emit(entries: unknown[]) {
    this.callback({ getEntries: () => entries });
  }

  static byType(type: string): MockPerformanceObserver {
    const instance = MockPerformanceObserver.instances.find((candidate) => candidate.observedType === type);
    if (!instance) throw new Error(`No observer registered for ${type}`);
    return instance;
  }
}

describe("startWebVitalsCollector", () => {
  afterEach(() => {
    MockPerformanceObserver.instances = [];
    vi.unstubAllGlobals();
  });

  function startWithMock(options?: WebVitalsCollectorOptions) {
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    const updates: number[] = [];
    const collector = startWebVitalsCollector(() => updates.push(updates.length), options);
    if (collector === null) throw new Error("collector should start with the mocked observer");
    return { collector, updates };
  }

  it("returns null when PerformanceObserver is unavailable", () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    expect(startWebVitalsCollector(() => {})).toBeNull();
  });

  it("collects TTFB, FCP, and the latest LCP candidate", () => {
    const { collector, updates } = startWithMock();
    MockPerformanceObserver.byType("navigation").emit([{ responseStart: 123.6 }]);
    MockPerformanceObserver.byType("paint").emit([
      { name: "first-paint", startTime: 100 },
      { name: "first-contentful-paint", startTime: 180.4 },
    ]);
    MockPerformanceObserver.byType("largest-contentful-paint").emit([{ startTime: 900.2 }]);
    MockPerformanceObserver.byType("largest-contentful-paint").emit([{ startTime: 1500.7 }]);

    expect(collector.snapshot()).toEqual({ ttfb_ms: 124, fcp_ms: 180, lcp_ms: 1501 });
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });

  it("accumulates CLS per session window and reports the max window", () => {
    const { collector } = startWithMock();
    const shifts = MockPerformanceObserver.byType("layout-shift");
    shifts.emit([
      { startTime: 1000, value: 0.1, hadRecentInput: false },
      { startTime: 1200, value: 0.2, hadRecentInput: false },
    ]);
    shifts.emit([{ startTime: 3000, value: 0.25, hadRecentInput: false }]);
    shifts.emit([{ startTime: 3100, value: 5, hadRecentInput: true }]);

    expect(collector.snapshot().cls).toBeCloseTo(0.3, 4);
  });

  it("estimates INP from the longest interaction (few-interactions case) and ignores sub-threshold or id-less entries", () => {
    const { collector } = startWithMock();
    const events = MockPerformanceObserver.byType("event");
    events.emit([
      { interactionId: 1, duration: 80 },
      { interactionId: 2, duration: 250 },
      { interactionId: 0, duration: 900 },
      { interactionId: 3, duration: 10 },
    ]);
    expect(collector.snapshot().inp_ms).toBe(250);

    events.emit([{ interactionId: 2, duration: 400 }]);
    expect(collector.snapshot().inp_ms).toBe(400);
  });

  it("reports a fast first interaction that the thresholded event observer omits", () => {
    const { collector } = startWithMock();

    MockPerformanceObserver.byType("first-input").emit([{ interactionId: 4, duration: 18 }]);

    expect(collector.snapshot().inp_ms).toBe(18);
  });

  it("uses the longest observed interaction when a complete native interaction count is unavailable", () => {
    const { collector } = startWithMock();
    MockPerformanceObserver.byType("event").emit([
      { interactionId: 1, duration: 100 },
      { interactionId: 2, duration: 500 },
      { interactionId: 3, duration: 250 },
    ]);

    expect(collector.snapshot().inp_ms).toBe(500);
  });

  it("freezes the snapshot after disconnect", () => {
    const { collector } = startWithMock();
    MockPerformanceObserver.byType("paint").emit([{ name: "first-contentful-paint", startTime: 50 }]);
    collector.disconnect();
    expect(MockPerformanceObserver.instances.every((instance) => instance.disconnected)).toBe(true);
    expect(collector.snapshot()).toEqual({ fcp_ms: 50 });
  });

  describe("soft-nav mode", () => {
    it("marks the snapshot and installs no load-metric observers", () => {
      const { collector } = startWithMock({ mode: "soft-nav", navStartTime: 5000 });
      expect(collector.snapshot()).toEqual({ soft_nav: 1 });
      const observedTypes = MockPerformanceObserver.instances.map((instance) => instance.observedType);
      expect(observedTypes).not.toContain("navigation");
      expect(observedTypes).not.toContain("paint");
      expect(observedTypes).not.toContain("largest-contentful-paint");
      expect(observedTypes).toContain("layout-shift");
      expect(observedTypes).toContain("event");
    });

    it("excludes buffered entries from before the navigation", () => {
      const { collector } = startWithMock({ mode: "soft-nav", navStartTime: 5000 });
      MockPerformanceObserver.byType("layout-shift").emit([
        { startTime: 4000, value: 0.5, hadRecentInput: false },
        { startTime: 5200, value: 0.1, hadRecentInput: false },
      ]);
      MockPerformanceObserver.byType("event").emit([
        { startTime: 4500, interactionId: 1, duration: 900 },
        { startTime: 5300, interactionId: 2, duration: 120 },
      ]);
      expect(collector.snapshot()).toEqual({ soft_nav: 1, cls: 0.1, inp_ms: 120 });
    });

    it("indexes the INP percentile from the interaction count within the window", () => {
      const mutablePerformance = { interactionCount: 120, now: () => 6000 };
      vi.stubGlobal("performance", mutablePerformance);
      const { collector } = startWithMock({ mode: "soft-nav", navStartTime: 5000 });
      mutablePerformance.interactionCount = 130;
      MockPerformanceObserver.byType("event").emit([
        { startTime: 5300, interactionId: 2, duration: 300 },
        { startTime: 5400, interactionId: 3, duration: 90 },
      ]);
      expect(collector.snapshot().inp_ms).toBe(300);
    });
  });
});

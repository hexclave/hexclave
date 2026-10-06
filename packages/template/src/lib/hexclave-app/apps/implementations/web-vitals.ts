import type { Attributes, Histogram, Meter } from "@opentelemetry/api";

/**
 * Minimal web-vitals collection (TTFB / FCP / LCP / CLS / INP / FPS) built directly on
 * PerformanceObserver — intentionally NOT the `web-vitals` npm package, both to
 * avoid a dependency and because we need a snapshot-able accumulator. The
 * caller stores the snapshot on the current `$page-view` span and records the
 * same observation through the native OTel Metrics path.
 *
 * Scope: the EventTracker attaches one collector per `$page-view` span and
 * freezes its values when that span ends (SPA navigation or pagehide).
 *
 * - `initial` mode covers the tab's hard load: all five load metrics plus FPS.
 * - `soft-nav` mode covers a SPA navigation: CLS, INP, and FPS, windowed to
 *   entries after the navigation started. TTFB/FCP/LCP describe the HARD load
 *   and reporting them per soft-nav would be a lie, so those observers are not
 *   installed at all. The snapshot carries `soft_nav: 1` so dashboard
 *   percentiles never mix LCP-less soft-nav rows into load metrics.
 */

export type WebVitalsSnapshot = {
  /** Time to first byte of the navigation response, ms. */
  ttfb_ms?: number,
  /** First contentful paint, ms. */
  fcp_ms?: number,
  /** Largest contentful paint (latest candidate), ms. */
  lcp_ms?: number,
  /** Cumulative layout shift, session-window maximum per the CLS definition. */
  cls?: number,
  /** Interaction to next paint, estimated like the web-vitals library (p98-ish). */
  inp_ms?: number,
  /** Approximate visible animation frame rate, sampled in one-second windows. */
  fps?: number,
  /** Present (1) when the collector ran in soft-nav mode — CLS/INP/FPS describe
   * the SPA navigation window and the hard-load metrics are intentionally absent. */
  soft_nav?: 1,
};

export type WebVitalsCollectorOptions =
  | { mode: "initial" }
  | { mode: "soft-nav", navStartTime: number };

export type WebVitalsCollector = {
  snapshot: () => WebVitalsSnapshot,
  /** Stops all observers; snapshot() keeps returning the frozen values. */
  disconnect: () => void,
};

type WebVitalsMetricKey = "ttfb_ms" | "fcp_ms" | "lcp_ms" | "cls" | "inp_ms" | "fps";
type WebVitalsHistogram = Pick<Histogram, "record">;
type WebVitalsMeter = Pick<Meter, "createHistogram">;

const WEB_VITAL_METRICS: readonly {
  key: WebVitalsMetricKey,
  name: string,
  description: string,
  unit: string,
  bucketBoundaries: number[],
}[] = [
  {
    key: "lcp_ms",
    name: "hexclave.web.vitals.lcp",
    description: "Largest Contentful Paint observed in a browser page view",
    unit: "ms",
    bucketBoundaries: [250, 500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 8000, 12000],
  },
  {
    key: "fcp_ms",
    name: "hexclave.web.vitals.fcp",
    description: "First Contentful Paint observed in a browser page view",
    unit: "ms",
    bucketBoundaries: [100, 250, 500, 900, 1200, 1800, 2400, 3000, 4000, 6000],
  },
  {
    key: "cls",
    name: "hexclave.web.vitals.cls",
    description: "Cumulative Layout Shift observed in a browser page view",
    unit: "1",
    bucketBoundaries: [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6, 1],
  },
  {
    key: "inp_ms",
    name: "hexclave.web.vitals.inp",
    description: "Interaction to Next Paint observed in a browser page view",
    unit: "ms",
    bucketBoundaries: [16, 40, 80, 120, 200, 300, 500, 800, 1200],
  },
  {
    key: "ttfb_ms",
    name: "hexclave.web.vitals.ttfb",
    description: "Time to First Byte observed in a browser page view",
    unit: "ms",
    bucketBoundaries: [50, 100, 200, 400, 800, 1200, 1800, 2500, 4000],
  },
  {
    key: "fps",
    name: "hexclave.web.vitals.fps",
    description: "Animation frame rate observed while a browser page view was visible",
    unit: "frame/s",
    bucketBoundaries: [5, 10, 15, 20, 25, 30, 40, 50, 55, 60],
  },
];

/**
 * Web Vitals are per-page-view DISTRIBUTION samples, so they are recorded as
 * histograms: every observation contributes to sum/count/buckets, and averages
 * and threshold splits stay truthful. A gauge would be wrong here — OTel's
 * synchronous Gauge keeps only the LAST value per attribute set within an
 * export interval (several SPA navigations within one interval would collapse
 * to one sample) and cumulative last-value re-exports a stale reading every
 * interval afterwards. The low-cardinality navigation attribute keeps hard
 * loads and SPA navigation samples distinguishable for queries.
 */
export class OtlpWebVitalsMetricRecorder {
  private readonly _histograms: Map<WebVitalsMetricKey, WebVitalsHistogram>;

  constructor(meter: WebVitalsMeter) {
    const histograms = new Map<WebVitalsMetricKey, WebVitalsHistogram>();
    for (const metric of WEB_VITAL_METRICS) {
      histograms.set(metric.key, meter.createHistogram(metric.name, {
        description: metric.description,
        unit: metric.unit,
        advice: { explicitBucketBoundaries: metric.bucketBoundaries },
      }));
    }
    this._histograms = histograms;
  }

  record(snapshot: WebVitalsSnapshot): void {
    const attributes: Attributes = {
      "hexclave.web.vitals.navigation": snapshot.soft_nav === 1 ? "soft" : "initial",
    };
    for (const metric of WEB_VITAL_METRICS) {
      const value = snapshot[metric.key];
      if (value === undefined || !Number.isFinite(value)) continue;
      this._histograms.get(metric.key)?.record(value, attributes);
    }
  }
}

const INP_DURATION_THRESHOLD_MS = 40;
const INP_LONGEST_KEPT = 10;
type LongestInteraction = { id: number, durationMs: number };

function supportsEntryType(type: string): boolean {
  // SAFETY: lib.dom types `supportedEntryTypes` as always present, but
  // pre-2019 browsers lack the static — the absent case is what this probes.
  const supported = PerformanceObserver.supportedEntryTypes as readonly string[] | undefined;
  return Array.isArray(supported) && supported.includes(type);
}

function nativeInteractionCount(): number | null {
  // SAFETY: `interactionCount` (event-timing spec) is missing from lib.dom's
  // Performance; reading it as a possibly-absent unknown claims nothing.
  const value = (performance as Performance & { interactionCount?: unknown }).interactionCount;
  return typeof value === "number" ? value : null;
}

/**
 * Starts collecting; returns null where PerformanceObserver is unavailable
 * (SSR, ancient browsers, some webviews). `onUpdate` fires whenever any metric
 * changes — the caller decides how to persist the snapshot to spans and
 * Metrics (updates within one flush window coalesce into a single wire row, so
 * no extra throttling is needed here).
 */
export function startWebVitalsCollector(onUpdate: (snapshot: WebVitalsSnapshot) => void, options: WebVitalsCollectorOptions = { mode: "initial" }): WebVitalsCollector | null {
  if (typeof PerformanceObserver !== "function" || typeof performance === "undefined") return null;

  const softNav = options.mode === "soft-nav";
  const entryCutoffTime = softNav ? options.navStartTime : 0;
  const interactionCountBase = softNav ? nativeInteractionCount() ?? 0 : 0;

  const state: WebVitalsSnapshot = softNav ? { soft_nav: 1 } : {};
  const observers: PerformanceObserver[] = [];
  const notify = () => onUpdate({ ...state });

  let fpsFrameHandle: number | null = null;
  let fpsWindowStart: number | null = null;
  let fpsFrameCount = 0;
  const sampleFrame = (timestamp: number) => {
    fpsWindowStart ??= timestamp;
    fpsFrameCount += 1;
    const elapsed = timestamp - fpsWindowStart;
    if (elapsed >= 1000) {
      state.fps = Math.round((fpsFrameCount * 1000 / elapsed) * 10) / 10;
      fpsWindowStart = timestamp;
      fpsFrameCount = 0;
      notify();
    }
    fpsFrameHandle = requestAnimationFrame(sampleFrame);
  };
  if (typeof requestAnimationFrame === "function") {
    fpsFrameHandle = requestAnimationFrame(sampleFrame);
  }

  let clsSessionValue = 0;
  let clsSessionFirstTs = 0;
  let clsSessionLastTs = 0;

  const longestInteractions: LongestInteraction[] = [];
  const longestById = new Map<number, LongestInteraction>();

  const recordInteraction = (entry: PerformanceEntry): boolean => {
    if (entry.startTime < entryCutoffTime) return false;
    if (!("interactionId" in entry) || typeof entry.interactionId !== "number" || entry.interactionId === 0) return false;
    if (typeof entry.duration !== "number") return false;

    const existing = longestById.get(entry.interactionId);
    if (existing) {
      existing.durationMs = Math.max(existing.durationMs, entry.duration);
    } else {
      longestInteractions.push({ id: entry.interactionId, durationMs: entry.duration });
      longestById.set(entry.interactionId, longestInteractions[longestInteractions.length - 1]);
    }
    longestInteractions.sort((a, b) => b.durationMs - a.durationMs);
    while (longestInteractions.length > INP_LONGEST_KEPT) {
      const dropped = longestInteractions.pop();
      if (dropped !== undefined) longestById.delete(dropped.id);
    }

    const currentCount = nativeInteractionCount();
    const index = currentCount !== null
      ? Math.min(Math.floor(Math.max(currentCount - interactionCountBase, 0) / 50), longestInteractions.length - 1)
      : 0;
    const inp = Math.round(longestInteractions[index].durationMs);
    if (inp === state.inp_ms) return false;
    state.inp_ms = inp;
    return true;
  };

  const tryObserve = (type: string, callback: (entries: PerformanceEntry[]) => void, extraOptions?: { durationThreshold?: number }) => {
    if (!supportsEntryType(type)) return;
    try {
      const observer = new PerformanceObserver((list) => {
        callback(list.getEntries());
      });
      // SAFETY: `durationThreshold` (event-timing spec) is missing from
      // lib.dom's PerformanceObserverInit; browsers that predate it ignore
      // unknown members, so the widened literal is a valid observe() argument.
      observer.observe({ type, buffered: true, ...extraOptions } as PerformanceObserverInit);
      observers.push(observer);
    } catch {
      // A browser advertising the type but rejecting the observe options just
      // means this one metric is missing from the snapshot.
    }
  };

  if (!softNav) {
    tryObserve("navigation", (entries) => {
      for (const entry of entries) {
        if ("responseStart" in entry && typeof entry.responseStart === "number" && entry.responseStart > 0) {
          state.ttfb_ms = Math.round(entry.responseStart);
          notify();
        }
      }
    });

    tryObserve("paint", (entries) => {
      for (const entry of entries) {
        if (entry.name === "first-contentful-paint") {
          state.fcp_ms = Math.round(entry.startTime);
          notify();
        }
      }
    });

    tryObserve("largest-contentful-paint", (entries) => {
      if (entries.length === 0) return;
      state.lcp_ms = Math.round(entries[entries.length - 1].startTime);
      notify();
    });
  }

  tryObserve("layout-shift", (entries) => {
    let changed = false;
    for (const entry of entries) {
      if (entry.startTime < entryCutoffTime) continue;
      if (!("value" in entry) || typeof entry.value !== "number") continue;
      if ("hadRecentInput" in entry && entry.hadRecentInput === true) continue;
      const ts = entry.startTime;
      if (clsSessionValue > 0 && ts - clsSessionLastTs < 1000 && ts - clsSessionFirstTs < 5000) {
        clsSessionValue += entry.value;
      } else {
        clsSessionValue = entry.value;
        clsSessionFirstTs = ts;
      }
      clsSessionLastTs = ts;
      if (clsSessionValue > (state.cls ?? 0)) {
        state.cls = Math.round(clsSessionValue * 10_000) / 10_000;
        changed = true;
      }
    }
    if (changed) notify();
  });

  tryObserve("event", (entries) => {
    let changed = false;
    for (const entry of entries) {
      if (recordInteraction(entry)) changed = true;
    }
    if (changed) notify();
  }, { durationThreshold: INP_DURATION_THRESHOLD_MS });

  tryObserve("first-input", (entries) => {
    let changed = false;
    for (const entry of entries) {
      if (recordInteraction(entry)) changed = true;
    }
    if (changed) notify();
  });

  return {
    snapshot: () => ({ ...state }),
    disconnect: () => {
      if (fpsFrameHandle !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(fpsFrameHandle);
        fpsFrameHandle = null;
      }
      for (const observer of observers) {
        try {
          observer.disconnect();
        } catch {
        }
      }
      observers.length = 0;
    },
  };
}

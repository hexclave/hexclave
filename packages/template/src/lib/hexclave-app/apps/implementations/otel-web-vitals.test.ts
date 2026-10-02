import type { Attributes, Histogram, Meter, MetricOptions } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { OtlpWebVitalsMetricRecorder } from "./web-vitals";

class FakeHistogram implements Pick<Histogram, "record"> {
  constructor(
    private readonly name: string,
    private readonly values: Map<string, { value: number, attributes: Attributes }[]>,
  ) {}

  record(value: number, attributes: Attributes = {}): void {
    const entries = this.values.get(this.name) ?? [];
    entries.push({ value, attributes });
    this.values.set(this.name, entries);
  }
}

class FakeMeter implements Pick<Meter, "createHistogram"> {
  readonly values = new Map<string, { value: number, attributes: Attributes }[]>();
  readonly options = new Map<string, MetricOptions | undefined>();

  createHistogram(name: string, options?: MetricOptions): Histogram {
    this.options.set(name, options);
    return new FakeHistogram(name, this.values);
  }
}

describe("OtlpWebVitalsMetricRecorder", () => {
  it("records finite browser samples as native histogram observations with navigation scope", () => {
    const meter = new FakeMeter();
    const recorder = new OtlpWebVitalsMetricRecorder(meter);

    recorder.record({ lcp_ms: 1234, cls: 0.04, fps: Infinity, soft_nav: 1 });

    expect(meter.values.get("hexclave.web.vitals.lcp")).toEqual([{
      value: 1234,
      attributes: { "hexclave.web.vitals.navigation": "soft" },
    }]);
    expect(meter.values.get("hexclave.web.vitals.cls")).toEqual([{
      value: 0.04,
      attributes: { "hexclave.web.vitals.navigation": "soft" },
    }]);
    expect(meter.values.has("hexclave.web.vitals.fps")).toBe(false);
  });

  it("keeps every page-view sample instead of collapsing to the latest value", () => {
    const meter = new FakeMeter();
    const recorder = new OtlpWebVitalsMetricRecorder(meter);

    recorder.record({ lcp_ms: 900 });
    recorder.record({ lcp_ms: 4200 });

    expect(meter.values.get("hexclave.web.vitals.lcp")?.map((entry) => entry.value)).toEqual([900, 4200]);
  });

  it("advises bucket boundaries that include the Google field thresholds", () => {
    const meter = new FakeMeter();
    void new OtlpWebVitalsMetricRecorder(meter);

    const thresholdsByMetric = new Map<string, [number, number]>([
      ["hexclave.web.vitals.lcp", [2500, 4000]],
      ["hexclave.web.vitals.fcp", [1800, 3000]],
      ["hexclave.web.vitals.cls", [0.1, 0.25]],
      ["hexclave.web.vitals.inp", [200, 500]],
      ["hexclave.web.vitals.ttfb", [800, 1800]],
      ["hexclave.web.vitals.fps", [30, 55]],
    ]);
    for (const [name, thresholds] of thresholdsByMetric) {
      const boundaries = meter.options.get(name)?.advice?.explicitBucketBoundaries ?? [];
      for (const threshold of thresholds) {
        expect(boundaries, `${name} should have a bucket boundary at ${threshold}`).toContain(threshold);
      }
      // Ascending order is an OTLP requirement for explicit bucket boundaries.
      expect(boundaries).toEqual([...boundaries].sort((a, b) => a - b));
    }
  });
});

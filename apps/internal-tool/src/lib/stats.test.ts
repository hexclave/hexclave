import { describe, expect, it } from "vitest";
import { canReportP95, extent, formatMilliseconds, MIN_P95_SAMPLE_COUNT, nearestRankPercentile, percentage } from "./stats";

describe("overview statistics", () => {
  it("uses the nearest-rank definition for percentiles", () => {
    expect(nearestRankPercentile([], 0.95)).toBeNull();
    expect(nearestRankPercentile([12], 0.95)).toBe(12);
    expect(nearestRankPercentile(Array.from({ length: 20 }, (_, index) => index + 1), 0.95)).toBe(19);
  });

  it("does not let floating-point noise push an exact rank up by one", () => {
    // 0.28 * 25 is 7.000000000000001 in IEEE 754; the nearest rank is still the 7th value.
    expect(nearestRankPercentile(Array.from({ length: 25 }, (_, index) => index + 1), 0.28)).toBe(7);
    expect(nearestRankPercentile(Array.from({ length: 10 }, (_, index) => index + 1), 0.7)).toBe(7);
  });

  it("finds the extent of a series in one pass", () => {
    expect(extent([])).toBeNull();
    expect(extent([4])).toEqual({ min: 4, max: 4 });
    expect(extent([3, -1, 7, 2])).toEqual({ min: -1, max: 7 });
  });

  it("does not present an empty denominator as zero percent", () => {
    expect(percentage(0, 0)).toBeNull();
    expect(percentage(3, 4)).toBe(75);
  });

  it("distinguishes missing duration data from a real zero-millisecond duration", () => {
    expect(formatMilliseconds(null)).toBe("—");
    expect(formatMilliseconds(0)).toBe("0ms");
  });

  it("only reports p95 once the nearest-rank tail has enough samples", () => {
    expect(canReportP95(MIN_P95_SAMPLE_COUNT - 1)).toBe(false);
    expect(canReportP95(MIN_P95_SAMPLE_COUNT)).toBe(true);
    expect(() => canReportP95(-1)).toThrowErrorMatchingInlineSnapshot(`[Error: Sample count must be a non-negative integer; received -1]`);
  });
});

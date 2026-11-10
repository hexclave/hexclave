import { describe, expect, it } from "vitest";
import { bucketize, MAX_BUCKETS, seriesWindow, trendPercent } from "./series";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 15, 12, 30, 0);

describe("bucketize", () => {
  it("uses hourly buckets for windows up to two days", () => {
    const buckets = bucketize([[]], NOW - 24 * HOUR, NOW);
    expect(buckets[1].start - buckets[0].start).toBe(HOUR);
    // Aligned to the hour, so a 24h window spans 25 partial-or-whole hours.
    expect(buckets.length).toBe(25);
  });

  it("uses daily buckets for longer windows", () => {
    const buckets = bucketize([[]], NOW - 7 * DAY, NOW);
    expect(buckets[1].start - buckets[0].start).toBe(DAY);
    expect(buckets.length).toBe(8);
  });

  it("widens buckets so long windows never exceed the bucket cap", () => {
    const buckets = bucketize([[]], NOW - 400 * DAY, NOW);
    expect(buckets.length).toBeLessThanOrEqual(MAX_BUCKETS);
    expect((buckets[1].start - buckets[0].start) % DAY).toBe(0);
  });

  it("counts each series separately and keeps an event at exactly `end`", () => {
    const start = NOW - 3 * HOUR;
    const buckets = bucketize([[start, NOW - HOUR, NOW], [NOW]], start, NOW);
    const totals = buckets.reduce((sum, bucket) => [sum[0] + bucket.values[0], sum[1] + bucket.values[1]], [0, 0]);
    expect(totals).toEqual([3, 1]);
    expect(buckets.at(-1)?.values).toEqual([1, 1]);
  });

  it("ignores timestamps outside the window", () => {
    const buckets = bucketize([[NOW - 10 * DAY, NOW + HOUR]], NOW - HOUR, NOW);
    expect(buckets.every(bucket => bucket.values[0] === 0)).toBe(true);
  });

  it("rejects an inverted window", () => {
    expect(() => bucketize([[]], NOW, NOW - HOUR)).toThrowErrorMatchingInlineSnapshot(`[Error: bucketize: end (1768476600000) must not be before start (1768480200000)]`);
  });
});

describe("seriesWindow", () => {
  it("uses the range start when the range is bounded", () => {
    expect(seriesWindow(NOW - DAY, NOW - 30 * DAY, NOW)).toEqual({ start: NOW - DAY, end: NOW });
  });

  it("spans the observed data for an unbounded range, defaulting to a day when empty", () => {
    expect(seriesWindow(null, NOW - 5 * DAY, NOW)).toEqual({ start: NOW - 5 * DAY, end: NOW });
    expect(seriesWindow(null, null, NOW)).toEqual({ start: NOW - DAY, end: NOW });
  });
});

describe("trendPercent", () => {
  it("compares the second half of the series with the first", () => {
    expect(trendPercent([1, 1, 2, 2])).toBe(100);
    expect(trendPercent([4, 4, 1, 1])).toBe(-75);
  });

  it("is undefined for short series or an empty baseline", () => {
    expect(trendPercent([1, 2, 3])).toBeNull();
    expect(trendPercent([0, 0, 5, 5])).toBeNull();
  });
});

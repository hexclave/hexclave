import { describe, expect, it } from "vitest";
import {
  formatAbsoluteTimeFromMillis,
  formatCount,
  formatDateFromMillis,
  formatDuration,
  formatRelativeTimeFromMillis,
  tryParseJson,
} from "./format";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");

describe("formatRelativeTimeFromMillis", () => {
  it("collapses the recent past into 'just now'", () => {
    expect(formatRelativeTimeFromMillis(NOW, NOW)).toBe("just now");
    expect(formatRelativeTimeFromMillis(NOW - 30_000, NOW)).toBe("just now");
  });

  it("reads a future timestamp as 'just now' rather than 'in 3 minutes'", () => {
    expect(formatRelativeTimeFromMillis(NOW + 180_000, NOW)).toBe("just now");
  });

  it("steps up through the units", () => {
    expect(formatRelativeTimeFromMillis(NOW - 5 * 60_000, NOW)).toContain("5");
    expect(formatRelativeTimeFromMillis(NOW - 3 * 3_600_000, NOW)).toContain("3");
    expect(formatRelativeTimeFromMillis(NOW - 4 * 86_400_000, NOW)).toContain("4");
  });

  it("throws rather than rendering NaN", () => {
    expect(() => formatRelativeTimeFromMillis(Number.NaN, NOW)).toThrow();
  });
});

describe("formatAbsoluteTimeFromMillis / formatDateFromMillis", () => {
  it("renders something non-empty and deterministic for a valid instant", () => {
    expect(formatAbsoluteTimeFromMillis(NOW).length).toBeGreaterThan(0);
    expect(formatDateFromMillis(NOW).length).toBeGreaterThan(0);
    expect(formatDateFromMillis(NOW)).not.toBe(formatAbsoluteTimeFromMillis(NOW));
  });

  it("throws on a non-finite instant", () => {
    expect(() => formatAbsoluteTimeFromMillis(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => formatDateFromMillis(Number.NaN)).toThrow();
  });
});

describe("formatDuration", () => {
  it("still renders the magnitudes the Observability pages agreed on", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0.4)).toBe("400µs");
    expect(formatDuration(90_000)).toBe("1m 30s");
  });
});

describe("formatCount", () => {
  it("keeps small counts exact and compacts large ones", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1_203)).toBe("1,203");
    expect(formatCount(9_999)).toBe("9,999");
    expect(formatCount(10_000)).toBe("10.0k");
    expect(formatCount(125_000)).toBe("125k");
    expect(formatCount(1_500_000)).toBe("1.5M");
    expect(formatCount(15_000_000)).toBe("15M");
  });

  it("drops the decimal exactly at the 100k / 10M readability boundaries", () => {
    expect(formatCount(99_999)).toBe("100.0k");
    expect(formatCount(100_000)).toBe("100k");
    expect(formatCount(9_999_999)).toBe("10.0M");
    expect(formatCount(10_000_000)).toBe("10M");
  });

  it("throws on non-finite and negative input rather than rendering nonsense", () => {
    expect(() => formatCount(Number.NaN)).toThrow();
    expect(() => formatCount(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => formatCount(-4)).toThrow();
  });
});

describe("tryParseJson", () => {
  it("returns the original value when it isn't JSON", () => {
    expect(tryParseJson("{oops")).toBe("{oops");
    expect(tryParseJson({ already: "parsed" })).toEqual({ already: "parsed" });
  });
});

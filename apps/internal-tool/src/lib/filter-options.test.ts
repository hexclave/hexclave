import { describe, expect, it } from "vitest";
import { AUTH_OPTIONS, hasErrorFilter, isAuthenticatedFilter, onlySelected, parseTimeRange, QA_STATE_OPTIONS } from "./filter-options";

describe("parseTimeRange", () => {
  it("accepts every listed range and fails loudly on anything else", () => {
    expect(parseTimeRange("30d")).toBe("30d");
    // A select rendering a range the filter cannot honour would silently show unfiltered data.
    expect(() => parseTimeRange("90d")).toThrow(/Unexpected time range/);
  });
});

describe("two-valued multi-selects", () => {
  it("filter only when exactly one value is selected", () => {
    expect(hasErrorFilter(new Set())).toBeUndefined();
    expect(hasErrorFilter(new Set(["error"]))).toBe(true);
    expect(hasErrorFilter(new Set(["ok"]))).toBe(false);
    expect(hasErrorFilter(new Set(["ok", "error"]))).toBeUndefined();
    expect(isAuthenticatedFilter(new Set(["anon"]))).toBe(false);
    expect(onlySelected(new Set(["authed", "anon"]), AUTH_OPTIONS)).toBeUndefined();
  });
  it("refuse domains that are not two-valued", () => {
    expect(() => onlySelected(new Set(["pass"]), QA_STATE_OPTIONS)).toThrow(/two-valued/);
  });
});

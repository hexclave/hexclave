import { describe, expect, it } from "vitest";
import { chiSquareUpperTail, detectSampleRatioMismatch } from "./srm";

describe("chiSquareUpperTail", () => {
  // Reference values from standard chi-square tables.
  it("matches textbook critical values", () => {
    expect(chiSquareUpperTail(3.841, 1)).toBeCloseTo(0.05, 3);
    expect(chiSquareUpperTail(6.635, 1)).toBeCloseTo(0.01, 3);
    expect(chiSquareUpperTail(5.991, 2)).toBeCloseTo(0.05, 3);
    expect(chiSquareUpperTail(7.815, 3)).toBeCloseTo(0.05, 3);
    expect(chiSquareUpperTail(11.345, 3)).toBeCloseTo(0.01, 3);
  });

  it("handles the boundaries", () => {
    expect(chiSquareUpperTail(0, 1)).toBe(1);
    expect(chiSquareUpperTail(1000, 1)).toBeCloseTo(0, 10);
  });

  it("rejects invalid inputs", () => {
    expect(() => chiSquareUpperTail(-1, 1)).toThrow();
    expect(() => chiSquareUpperTail(1, 0)).toThrow();
  });
});

describe("detectSampleRatioMismatch", () => {
  it("does not flag perfectly balanced counts", () => {
    const result = detectSampleRatioMismatch({
      variants: [
        { variantId: "a", weightBasisPoints: 5000, exposedSubjects: 5000 },
        { variantId: "b", weightBasisPoints: 5000, exposedSubjects: 5000 },
      ],
    });
    expect(result.detected).toBe(false);
    expect(result.statistic).toBeCloseTo(0, 10);
    expect(result.pValue).toBeCloseTo(1, 10);
  });

  it("does not flag ordinary sampling noise (chi2 = 4, p ~ 0.0455 > 0.01)", () => {
    // 5100 vs 4900 out of 10000 at 50/50: chi2 = 100^2/5000 * 2 = 4
    const result = detectSampleRatioMismatch({
      variants: [
        { variantId: "a", weightBasisPoints: 5000, exposedSubjects: 5100 },
        { variantId: "b", weightBasisPoints: 5000, exposedSubjects: 4900 },
      ],
    });
    expect(result.detected).toBe(false);
    expect(result.statistic).toBeCloseTo(4, 6);
    expect(result.pValue).toBeCloseTo(0.0455, 3);
  });

  it("flags a genuine mismatch (chi2 = 36, p ~ 2e-9)", () => {
    const result = detectSampleRatioMismatch({
      variants: [
        { variantId: "a", weightBasisPoints: 5000, exposedSubjects: 5300 },
        { variantId: "b", weightBasisPoints: 5000, exposedSubjects: 4700 },
      ],
    });
    expect(result.detected).toBe(true);
    expect(result.statistic).toBeCloseTo(36, 6);
    expect(result.pValue).toBeLessThan(1e-8);
  });

  it("respects unequal expected weights", () => {
    // 90/10 split observed exactly as configured: no mismatch.
    const balanced = detectSampleRatioMismatch({
      variants: [
        { variantId: "a", weightBasisPoints: 9000, exposedSubjects: 9000 },
        { variantId: "b", weightBasisPoints: 1000, exposedSubjects: 1000 },
      ],
    });
    expect(balanced.detected).toBe(false);

    // 90/10 configured but 50/50 observed: massive mismatch.
    const skewed = detectSampleRatioMismatch({
      variants: [
        { variantId: "a", weightBasisPoints: 9000, exposedSubjects: 5000 },
        { variantId: "b", weightBasisPoints: 1000, exposedSubjects: 5000 },
      ],
    });
    expect(skewed.detected).toBe(true);
  });

  it("is not applicable with zero exposures", () => {
    const result = detectSampleRatioMismatch({
      variants: [
        { variantId: "a", weightBasisPoints: 5000, exposedSubjects: 0 },
        { variantId: "b", weightBasisPoints: 5000, exposedSubjects: 0 },
      ],
    });
    expect(result).toEqual({ detected: false, statistic: null, pValue: null });
  });

  it("flags any exposure on a zero-weight variant", () => {
    const result = detectSampleRatioMismatch({
      variants: [
        { variantId: "a", weightBasisPoints: 10000, exposedSubjects: 1000 },
        { variantId: "b", weightBasisPoints: 0, exposedSubjects: 3 },
      ],
    });
    expect(result.detected).toBe(true);
    expect(result.pValue).toBe(0);
  });

  it("does not run a zero-degree-of-freedom test when only one variant has weight", () => {
    const result = detectSampleRatioMismatch({
      variants: [
        { variantId: "a", weightBasisPoints: 10000, exposedSubjects: 1000 },
        { variantId: "b", weightBasisPoints: 0, exposedSubjects: 0 },
      ],
    });
    expect(result).toEqual({ detected: false, statistic: 0, pValue: 1 });
  });

  it("works with more than two variants", () => {
    const result = detectSampleRatioMismatch({
      variants: [
        { variantId: "a", weightBasisPoints: 3334, exposedSubjects: 3300 },
        { variantId: "b", weightBasisPoints: 3333, exposedSubjects: 3400 },
        { variantId: "c", weightBasisPoints: 3333, exposedSubjects: 3300 },
      ],
    });
    expect(result.detected).toBe(false);
    expect(result.pValue).toBeGreaterThan(0.01);
  });

  it("rejects invalid inputs", () => {
    expect(() => detectSampleRatioMismatch({ variants: [{ variantId: "a", weightBasisPoints: 10000, exposedSubjects: 10 }] })).toThrow();
    expect(() => detectSampleRatioMismatch({
      variants: [
        { variantId: "a", weightBasisPoints: 5000, exposedSubjects: 1.5 },
        { variantId: "b", weightBasisPoints: 5000, exposedSubjects: 1 },
      ],
    })).toThrow();
  });
});

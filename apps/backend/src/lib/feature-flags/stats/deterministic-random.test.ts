import { describe, expect, it } from "vitest";
import { DeterministicRandom, sortedQuantile } from "./deterministic-random";

describe("DeterministicRandom", () => {
  it("is deterministic: same seed produces the same stream", () => {
    const a = new DeterministicRandom("seed-1");
    const b = new DeterministicRandom("seed-1");
    for (let i = 0; i < 100; i++) {
      expect(a.uniform()).toBe(b.uniform());
    }
  });

  it("different seeds produce different streams", () => {
    const a = new DeterministicRandom("seed-1");
    const b = new DeterministicRandom("seed-2");
    const streamA = Array.from({ length: 10 }, () => a.uniform());
    const streamB = Array.from({ length: 10 }, () => b.uniform());
    expect(streamA).not.toEqual(streamB);
  });

  it("uniform() stays strictly inside (0, 1) and has mean ~0.5", () => {
    const rng = new DeterministicRandom("uniform-test");
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const u = rng.uniform();
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
      sum += u;
    }
    expect(sum / n).toBeCloseTo(0.5, 2);
  });

  it("normal() has mean ~0 and variance ~1", () => {
    const rng = new DeterministicRandom("normal-test");
    const n = 50_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const x = rng.normal();
      sum += x;
      sumSq += x * x;
    }
    const mean = sum / n;
    expect(mean).toBeCloseTo(0, 1);
    expect(sumSq / n - mean * mean).toBeCloseTo(1, 1);
  });

  it("gamma(shape) has mean ~shape and variance ~shape, including shape < 1", () => {
    for (const shape of [0.5, 1, 2.5, 9]) {
      const rng = new DeterministicRandom(`gamma-test-${shape}`);
      const n = 50_000;
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < n; i++) {
        const x = rng.gamma(shape);
        expect(x).toBeGreaterThan(0);
        sum += x;
        sumSq += x * x;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      // MC error at n=50k is ~sqrt(shape/50000) for the mean; tolerances are ~6 sigma.
      expect(Math.abs(mean - shape)).toBeLessThan(0.15 * Math.max(1, shape));
      expect(Math.abs(variance - shape)).toBeLessThan(0.3 * Math.max(1, shape));
    }
  });

  it("gamma() rejects non-positive shapes", () => {
    const rng = new DeterministicRandom("gamma-invalid");
    expect(() => rng.gamma(0)).toThrow();
    expect(() => rng.gamma(-1)).toThrow();
  });

  it("beta(a, b) has mean ~a/(a+b) and stays in (0, 1)", () => {
    const rng = new DeterministicRandom("beta-test");
    const n = 50_000;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = rng.beta(3, 7);
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / n).toBeCloseTo(0.3, 2);
  });
});

describe("sortedQuantile", () => {
  it("interpolates linearly", () => {
    const values = [0, 10, 20, 30, 40];
    expect(sortedQuantile(values, 0)).toBe(0);
    expect(sortedQuantile(values, 1)).toBe(40);
    expect(sortedQuantile(values, 0.5)).toBe(20);
    expect(sortedQuantile(values, 0.25)).toBe(10);
    expect(sortedQuantile(values, 0.125)).toBe(5);
  });

  it("handles a single-element array", () => {
    expect(sortedQuantile([7], 0.5)).toBe(7);
  });

  it("rejects empty arrays and out-of-range quantiles", () => {
    expect(() => sortedQuantile([], 0.5)).toThrow();
    expect(() => sortedQuantile([1], -0.1)).toThrow();
    expect(() => sortedQuantile([1], 1.1)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  POSTERIOR_SAMPLE_COUNT,
  computeBinaryPosteriors,
  computeNumericPosteriors,
  decideWinner,
  drawPosteriorSamplesForGuardrail,
  isGuardrailRegression,
} from "./bayesian";

// Reference vectors: analytic results for conjugate Beta/NIG models, asserted
// with tolerances sized to the Monte Carlo error of POSTERIOR_SAMPLE_COUNT
// deterministic samples (~0.5% for probabilities). Because sampling is seeded,
// these tests are fully reproducible — a tolerance failure means the sampler
// or the posterior update actually changed, not test flake.

describe("computeBinaryPosteriors", () => {
  it("matches the analytic P(best) for Beta(2,1) vs Beta(1,1): P(X > Y) = 2/3", () => {
    // A: 1 conversion / 1 exposure -> posterior Beta(2, 1); B: 0/0 -> Beta(1, 1) (uniform)
    const posteriors = computeBinaryPosteriors({
      variants: [
        { variantId: "a", exposedSubjects: 1, convertedSubjects: 1 },
        { variantId: "b", exposedSubjects: 0, convertedSubjects: 0 },
      ],
      direction: "increase",
      seed: "test-analytic-beta",
    });
    const a = posteriors.find((p) => p.variantId === "a");
    expect(a?.probabilityBest).toBeGreaterThan(2 / 3 - 0.02);
    expect(a?.probabilityBest).toBeLessThan(2 / 3 + 0.02);
  });

  it("matches the analytic posterior mean and 95% CI for a flat posterior", () => {
    // 0 exposures -> Beta(1, 1): mean 0.5, equal-tailed 95% CI [0.025, 0.975]
    const [only] = computeBinaryPosteriors({
      variants: [{ variantId: "only", exposedSubjects: 0, convertedSubjects: 0 }],
      direction: "increase",
      seed: "test-flat",
    });
    expect(only.posteriorMean).toBeCloseTo(0.5, 1);
    expect(only.credibleInterval95.lower).toBeCloseTo(0.025, 1);
    expect(only.credibleInterval95.upper).toBeCloseTo(0.975, 1);
    expect(only.probabilityBest).toBe(1);
  });

  it("gives a clearly better variant a high P(best), in the goal direction", () => {
    const variants = [
      { variantId: "control", exposedSubjects: 1000, convertedSubjects: 400 },
      { variantId: "treatment", exposedSubjects: 1000, convertedSubjects: 600 },
    ];
    const increase = computeBinaryPosteriors({ variants, direction: "increase", seed: "test-direction" });
    expect(increase.find((p) => p.variantId === "treatment")?.probabilityBest).toBeGreaterThan(0.99);

    // For a "decrease" metric the same data favors control.
    const decrease = computeBinaryPosteriors({ variants, direction: "decrease", seed: "test-direction" });
    expect(decrease.find((p) => p.variantId === "control")?.probabilityBest).toBeGreaterThan(0.99);
  });

  it("probabilities sum to 1 across variants and CI brackets the true rate", () => {
    const posteriors = computeBinaryPosteriors({
      variants: [
        { variantId: "a", exposedSubjects: 500, convertedSubjects: 100 },
        { variantId: "b", exposedSubjects: 500, convertedSubjects: 105 },
        { variantId: "c", exposedSubjects: 500, convertedSubjects: 95 },
      ],
      direction: "increase",
      seed: "test-multivariant",
    });
    const total = posteriors.reduce((acc, p) => acc + p.probabilityBest, 0);
    expect(total).toBeCloseTo(1, 6);
    const a = posteriors.find((p) => p.variantId === "a");
    expect(a?.posteriorMean).toBeCloseTo(0.2, 1);
    expect(a?.credibleInterval95.lower).toBeLessThan(0.2);
    expect(a?.credibleInterval95.upper).toBeGreaterThan(0.2);
  });

  it("is deterministic for the same seed and stable per-variant when variants are added", () => {
    const base = computeBinaryPosteriors({
      variants: [
        { variantId: "a", exposedSubjects: 100, convertedSubjects: 30 },
        { variantId: "b", exposedSubjects: 100, convertedSubjects: 35 },
      ],
      direction: "increase",
      seed: "stability",
    });
    const again = computeBinaryPosteriors({
      variants: [
        { variantId: "a", exposedSubjects: 100, convertedSubjects: 30 },
        { variantId: "b", exposedSubjects: 100, convertedSubjects: 35 },
      ],
      direction: "increase",
      seed: "stability",
    });
    expect(again).toEqual(base);

    // Adding a third variant must not change a/b's means or CIs (per-variant RNG streams).
    const withThird = computeBinaryPosteriors({
      variants: [
        { variantId: "a", exposedSubjects: 100, convertedSubjects: 30 },
        { variantId: "b", exposedSubjects: 100, convertedSubjects: 35 },
        { variantId: "c", exposedSubjects: 100, convertedSubjects: 20 },
      ],
      direction: "increase",
      seed: "stability",
    });
    expect(withThird.find((p) => p.variantId === "a")?.posteriorMean).toBe(base[0].posteriorMean);
    expect(withThird.find((p) => p.variantId === "a")?.credibleInterval95).toEqual(base[0].credibleInterval95);
  });

  it("rejects impossible observations", () => {
    expect(() => computeBinaryPosteriors({
      variants: [{ variantId: "a", exposedSubjects: 10, convertedSubjects: 11 }],
      direction: "increase",
      seed: "invalid",
    })).toThrow();
    expect(() => computeBinaryPosteriors({
      variants: [{ variantId: "a", exposedSubjects: 10, convertedSubjects: -1 }],
      direction: "increase",
      seed: "invalid",
    })).toThrow();
  });
});

describe("computeNumericPosteriors", () => {
  it("recovers the sample mean for a large, tight sample", () => {
    // 1000 subjects, each with value exactly 10: sum = 10000, sumSq = 100000
    const [only] = computeNumericPosteriors({
      variants: [{ variantId: "only", exposedSubjects: 1000, sumValues: 10_000, sumSquaredValues: 100_000 }],
      direction: "increase",
      seed: "numeric-tight",
    });
    expect(only.posteriorMean).toBeCloseTo(10, 1);
    expect(only.credibleInterval95.upper - only.credibleInterval95.lower).toBeLessThan(0.5);
  });

  it("separates two clearly different numeric variants", () => {
    // A ~ mean 10, B ~ mean 12, both with sd ~1 over 500 subjects.
    // sumSq = n * (mean^2 + sd^2)
    const posteriors = computeNumericPosteriors({
      variants: [
        { variantId: "a", exposedSubjects: 500, sumValues: 5000, sumSquaredValues: 500 * (100 + 1) },
        { variantId: "b", exposedSubjects: 500, sumValues: 6000, sumSquaredValues: 500 * (144 + 1) },
      ],
      direction: "increase",
      seed: "numeric-separated",
    });
    expect(posteriors.find((p) => p.variantId === "b")?.probabilityBest).toBeGreaterThan(0.99);
    expect(posteriors.find((p) => p.variantId === "a")?.posteriorMean).toBeCloseTo(10, 0);
    expect(posteriors.find((p) => p.variantId === "b")?.posteriorMean).toBeCloseTo(12, 0);
  });

  it("handles the no-data case with a proper (wide) posterior", () => {
    const [only] = computeNumericPosteriors({
      variants: [{ variantId: "only", exposedSubjects: 0, sumValues: 0, sumSquaredValues: 0 }],
      direction: "increase",
      seed: "numeric-empty",
    });
    // NIG(0, 1, 1, 1) prior: finite mean near 0, wide interval — but crucially, no NaN/crash.
    expect(Number.isFinite(only.posteriorMean)).toBe(true);
    expect(only.credibleInterval95.lower).toBeLessThan(only.credibleInterval95.upper);
  });

  it("rejects non-finite observations", () => {
    expect(() => computeNumericPosteriors({
      variants: [{ variantId: "a", exposedSubjects: 10, sumValues: Infinity, sumSquaredValues: 0 }],
      direction: "increase",
      seed: "invalid",
    })).toThrow();
  });
});

describe("decideWinner", () => {
  const posterior = (variantId: string, probabilityBest: number) => ({
    variantId,
    posteriorMean: 0.5,
    credibleInterval95: { lower: 0.4, upper: 0.6 },
    probabilityBest,
  });

  it("declares a winner only when all four conditions hold", () => {
    const decision = decideWinner({
      exposedSubjectsByVariant: new Map([["a", 150], ["b", 150]]),
      primaryPosteriors: [posterior("a", 0.97), posterior("b", 0.03)],
      guardrailRegressionVariantIds: new Set(),
      srmDetected: false,
    });
    expect(decision).toEqual({ status: "winner", variantId: "a", probabilityBest: 0.97 });
  });

  it("blocks on SRM before anything else", () => {
    const decision = decideWinner({
      exposedSubjectsByVariant: new Map([["a", 150], ["b", 150]]),
      primaryPosteriors: [posterior("a", 0.99), posterior("b", 0.01)],
      guardrailRegressionVariantIds: new Set(["a"]),
      srmDetected: true,
    });
    expect(decision).toEqual({ status: "no_winner", reason: "srm_detected" });
  });

  it("requires >= 100 exposed subjects in EVERY variant", () => {
    const decision = decideWinner({
      exposedSubjectsByVariant: new Map([["a", 1000], ["b", 99]]),
      primaryPosteriors: [posterior("a", 0.99), posterior("b", 0.01)],
      guardrailRegressionVariantIds: new Set(),
      srmDetected: false,
    });
    expect(decision).toEqual({ status: "no_winner", reason: "insufficient_data" });
  });

  it("requires P(best) >= 0.95", () => {
    const decision = decideWinner({
      exposedSubjectsByVariant: new Map([["a", 150], ["b", 150]]),
      primaryPosteriors: [posterior("a", 0.94), posterior("b", 0.06)],
      guardrailRegressionVariantIds: new Set(),
      srmDetected: false,
    });
    expect(decision).toEqual({ status: "no_winner", reason: "no_variant_confident" });
  });

  it("blocks a confident variant that regresses a guardrail", () => {
    const decision = decideWinner({
      exposedSubjectsByVariant: new Map([["a", 150], ["b", 150]]),
      primaryPosteriors: [posterior("a", 0.99), posterior("b", 0.01)],
      guardrailRegressionVariantIds: new Set(["a"]),
      srmDetected: false,
    });
    expect(decision).toEqual({ status: "no_winner", reason: "guardrail_regression" });
  });
});

describe("guardrail regression detection", () => {
  it("flags a variant that is clearly worse than control on an increase-metric", () => {
    const samples = drawPosteriorSamplesForGuardrail({
      kind: "binary",
      variants: [
        { variantId: "control", exposedSubjects: 1000, convertedSubjects: 500 },
        { variantId: "worse", exposedSubjects: 1000, convertedSubjects: 300 },
        { variantId: "same", exposedSubjects: 1000, convertedSubjects: 495 },
      ],
      seed: "guardrail-test",
    });
    const controlSamples = samples.get("control");
    const worseSamples = samples.get("worse");
    const sameSamples = samples.get("same");
    if (controlSamples == null || worseSamples == null || sameSamples == null) throw new Error("missing samples");

    expect(controlSamples).toHaveLength(POSTERIOR_SAMPLE_COUNT);
    expect(isGuardrailRegression({ controlSamples, variantSamples: worseSamples, direction: "increase" })).toBe(true);
    expect(isGuardrailRegression({ controlSamples, variantSamples: sameSamples, direction: "increase" })).toBe(false);
    // On a decrease-metric (lower is better), the "worse" variant is actually an improvement.
    expect(isGuardrailRegression({ controlSamples, variantSamples: worseSamples, direction: "decrease" })).toBe(false);
  });
});

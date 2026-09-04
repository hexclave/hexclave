import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { DeterministicRandom, sortedQuantile } from "./deterministic-random";

/**
 * Bayesian posterior inference for experiment metrics.
 *
 * - Binary metrics (including each step of a funnel): Beta-Binomial with a flat
 *   Beta(1, 1) prior. Posterior is Beta(1 + conversions, 1 + nonConversions).
 * - Numeric metrics: Normal-Inverse-Gamma conjugate model with a weakly
 *   informative prior NIG(mu0=0, kappa0=1, alpha0=1, beta0=1). With the >=100
 *   subjects required before declaring a winner, the prior's pull towards 0 is
 *   negligible, and a proper prior keeps the posterior well-defined even with
 *   0 or 1 observations (an improper reference prior would not be).
 *
 * Probability-to-be-best and credible intervals are both computed from the same
 * deterministic posterior samples (seeded by the caller) so that repeated result
 * computations are bit-for-bit reproducible. Sample count is fixed rather than
 * configurable so all consumers get the same precision (~0.5% MC error on
 * probabilities), which matters because the 0.95 winner threshold is a product
 * contract, not a tunable.
 */

export const POSTERIOR_SAMPLE_COUNT = 10_000;

export type BinaryMetricObservation = {
  /** Number of distinct exposed subjects for this variant. */
  exposedSubjects: number,
  /** Number of distinct exposed subjects that converted. Must be <= exposedSubjects. */
  convertedSubjects: number,
};

export type NumericMetricObservation = {
  /** Number of distinct exposed subjects for this variant (also the count of per-subject values; subjects without an attributed event count as 0). */
  exposedSubjects: number,
  /** Sum of the per-subject metric values. */
  sumValues: number,
  /** Sum of squares of the per-subject metric values. */
  sumSquaredValues: number,
};

export type VariantPosteriorSummary = {
  variantId: string,
  /** Posterior mean of the metric (conversion rate for binary, mean value for numeric). */
  posteriorMean: number,
  /** Equal-tailed 95% credible interval for the metric. */
  credibleInterval95: { lower: number, upper: number },
  /** Probability that this variant has the best metric value among all variants (in the metric's goal direction). */
  probabilityBest: number,
};

export type MetricDirection = "increase" | "decrease";

function samplePosteriors(
  variants: { variantId: string, sample: (rng: DeterministicRandom) => number }[],
  direction: MetricDirection,
  seed: string,
): VariantPosteriorSummary[] {
  if (variants.length === 0) {
    throw new HexclaveAssertionError("samplePosteriors() requires at least one variant");
  }
  // One RNG per variant (seeded by variant id) so adding/removing a variant
  // doesn't shift the sample streams of the others — results for unchanged
  // variants stay identical, which makes snapshots and comparisons stable.
  const rngs = variants.map((v) => new DeterministicRandom(`${seed} :: ${v.variantId}`));
  const samples = variants.map(() => new Array<number>(POSTERIOR_SAMPLE_COUNT));
  const bestCounts = variants.map(() => 0);

  for (let i = 0; i < POSTERIOR_SAMPLE_COUNT; i++) {
    let bestIndex = 0;
    for (let vi = 0; vi < variants.length; vi++) {
      const value = variants[vi].sample(rngs[vi]);
      samples[vi][i] = value;
      if (vi > 0) {
        const better = direction === "increase" ? value > samples[bestIndex][i] : value < samples[bestIndex][i];
        if (better) bestIndex = vi;
      }
    }
    bestCounts[bestIndex]++;
  }

  return variants.map((v, vi) => {
    const sorted = [...samples[vi]].sort((a, b) => a - b);
    const mean = samples[vi].reduce((acc, x) => acc + x, 0) / POSTERIOR_SAMPLE_COUNT;
    return {
      variantId: v.variantId,
      posteriorMean: mean,
      credibleInterval95: {
        lower: sortedQuantile(sorted, 0.025),
        upper: sortedQuantile(sorted, 0.975),
      },
      probabilityBest: bestCounts[vi] / POSTERIOR_SAMPLE_COUNT,
    };
  });
}

export function computeBinaryPosteriors(options: {
  variants: (BinaryMetricObservation & { variantId: string })[],
  direction: MetricDirection,
  seed: string,
}): VariantPosteriorSummary[] {
  for (const v of options.variants) {
    if (!Number.isInteger(v.exposedSubjects) || !Number.isInteger(v.convertedSubjects) || v.convertedSubjects < 0 || v.exposedSubjects < v.convertedSubjects) {
      throw new HexclaveAssertionError(`Invalid binary observation for variant ${v.variantId}: exposed=${v.exposedSubjects}, converted=${v.convertedSubjects}; the attribution query must guarantee 0 <= converted <= exposed`);
    }
  }
  return samplePosteriors(
    options.variants.map((v) => ({
      variantId: v.variantId,
      sample: (rng: DeterministicRandom) => rng.beta(1 + v.convertedSubjects, 1 + v.exposedSubjects - v.convertedSubjects),
    })),
    options.direction,
    options.seed,
  );
}

/**
 * NIG(mu0=0, kappa0=1, alpha0=1, beta0=1) conjugate update for a numeric
 * observation. Shared by summary computation and guardrail sampling so the two
 * always agree on the posterior (a drift here would make guardrail verdicts
 * inconsistent with the displayed intervals).
 */
function numericPosteriorParams(v: NumericMetricObservation & { variantId: string }): { muN: number, kappaN: number, alphaN: number, betaN: number } {
  if (!Number.isInteger(v.exposedSubjects) || v.exposedSubjects < 0 || !Number.isFinite(v.sumValues) || !Number.isFinite(v.sumSquaredValues)) {
    throw new HexclaveAssertionError(`Invalid numeric observation for variant ${v.variantId}: n=${v.exposedSubjects}, sum=${v.sumValues}, sumSq=${v.sumSquaredValues}`);
  }
  const mu0 = 0, kappa0 = 1, alpha0 = 1, beta0 = 1;
  const n = v.exposedSubjects;
  const mean = n > 0 ? v.sumValues / n : 0;
  // Sum of squared deviations; clamp tiny negative values from floating-point cancellation.
  const sse = Math.max(0, v.sumSquaredValues - n * mean * mean);
  const kappaN = kappa0 + n;
  const muN = (kappa0 * mu0 + n * mean) / kappaN;
  const alphaN = alpha0 + n / 2;
  const betaN = beta0 + sse / 2 + (kappa0 * n * (mean - mu0) * (mean - mu0)) / (2 * kappaN);
  return { muN, kappaN, alphaN, betaN };
}

function sampleNumericPosterior(rng: DeterministicRandom, params: { muN: number, kappaN: number, alphaN: number, betaN: number }): number {
  // sigma^2 ~ InvGamma(alphaN, betaN), then mu | sigma^2 ~ N(muN, sigma^2 / kappaN)
  const sigma2 = params.betaN / rng.gamma(params.alphaN);
  return params.muN + rng.normal() * Math.sqrt(sigma2 / params.kappaN);
}

export function computeNumericPosteriors(options: {
  variants: (NumericMetricObservation & { variantId: string })[],
  direction: MetricDirection,
  seed: string,
}): VariantPosteriorSummary[] {
  return samplePosteriors(
    options.variants.map((v) => {
      const params = numericPosteriorParams(v);
      return {
        variantId: v.variantId,
        sample: (rng: DeterministicRandom) => sampleNumericPosterior(rng, params),
      };
    }),
    options.direction,
    options.seed,
  );
}

export const WINNER_MIN_EXPOSED_SUBJECTS_PER_VARIANT = 100;
export const WINNER_MIN_PROBABILITY_BEST = 0.95;

export type WinnerDecision =
  | { status: "winner", variantId: string, probabilityBest: number }
  | { status: "no_winner", reason: "insufficient_data" | "no_variant_confident" | "guardrail_regression" | "srm_detected" };

/**
 * Decides whether the experiment has a winner on its primary metric. All four
 * conditions must hold: every variant has >=100 exposed subjects, one variant
 * has P(best) >= 0.95, no guardrail metric shows a likely regression for that
 * variant, and no sample-ratio mismatch was detected. The order of checks below
 * is also the order of "severity" reported to the user: data quality problems
 * (SRM) mask statistical conclusions, so SRM is checked first.
 */
export function decideWinner(options: {
  exposedSubjectsByVariant: Map<string, number>,
  primaryPosteriors: VariantPosteriorSummary[],
  /** For the candidate winner: does any guardrail metric show a likely regression? (see hasGuardrailRegression) */
  guardrailRegressionVariantIds: Set<string>,
  srmDetected: boolean,
}): WinnerDecision {
  if (options.srmDetected) {
    return { status: "no_winner", reason: "srm_detected" };
  }
  const exposedCounts = [...options.exposedSubjectsByVariant.values()];
  if (exposedCounts.length < 2 || exposedCounts.some((n) => n < WINNER_MIN_EXPOSED_SUBJECTS_PER_VARIANT)) {
    return { status: "no_winner", reason: "insufficient_data" };
  }
  const best = options.primaryPosteriors.reduce((a, b) => (b.probabilityBest > a.probabilityBest ? b : a));
  if (best.probabilityBest < WINNER_MIN_PROBABILITY_BEST) {
    return { status: "no_winner", reason: "no_variant_confident" };
  }
  if (options.guardrailRegressionVariantIds.has(best.variantId)) {
    return { status: "no_winner", reason: "guardrail_regression" };
  }
  return { status: "winner", variantId: best.variantId, probabilityBest: best.probabilityBest };
}

export const GUARDRAIL_REGRESSION_PROBABILITY_THRESHOLD = 0.95;

/**
 * A guardrail metric "regresses" for a variant if, compared against the control
 * variant, the probability that the variant is worse (in the guardrail metric's
 * goal direction) is >= 0.95. Computed from the same deterministic posterior
 * samples used everywhere else: we approximate P(variant worse than control) by
 * pairing samples. Both posteriors must come from the same computation batch
 * (same seed) so the pairing is meaningful yet deterministic.
 */
export function isGuardrailRegression(options: {
  controlSamples: readonly number[],
  variantSamples: readonly number[],
  direction: MetricDirection,
}): boolean {
  if (options.controlSamples.length !== options.variantSamples.length || options.controlSamples.length === 0) {
    throw new HexclaveAssertionError("isGuardrailRegression() requires equally-sized non-empty sample arrays from the same batch");
  }
  let worseCount = 0;
  for (let i = 0; i < options.controlSamples.length; i++) {
    const worse = options.direction === "increase"
      ? options.variantSamples[i] < options.controlSamples[i]
      : options.variantSamples[i] > options.controlSamples[i];
    if (worse) worseCount++;
  }
  return worseCount / options.controlSamples.length >= GUARDRAIL_REGRESSION_PROBABILITY_THRESHOLD;
}

/**
 * Raw posterior samples for a set of variants — used by guardrail comparisons,
 * which need paired samples rather than summaries. Deterministic like the
 * summaries above (same seed => same samples).
 */
export function drawPosteriorSamplesForGuardrail(options: {
  kind: "binary",
  variants: (BinaryMetricObservation & { variantId: string })[],
  seed: string,
} | {
  kind: "numeric",
  variants: (NumericMetricObservation & { variantId: string })[],
  seed: string,
}): Map<string, number[]> {
  const result = new Map<string, number[]>();
  // Branch on kind before iterating so `options.variants` is narrowed to the
  // matching observation type (branching per-variant would leave each element
  // as the union and require casts).
  if (options.kind === "binary") {
    for (const v of options.variants) {
      if (v.convertedSubjects < 0 || v.exposedSubjects < v.convertedSubjects) {
        throw new HexclaveAssertionError(`Invalid binary observation for variant ${v.variantId}`);
      }
      const rng = new DeterministicRandom(`${options.seed} :: ${v.variantId}`);
      const samples = new Array<number>(POSTERIOR_SAMPLE_COUNT);
      for (let i = 0; i < POSTERIOR_SAMPLE_COUNT; i++) {
        samples[i] = rng.beta(1 + v.convertedSubjects, 1 + v.exposedSubjects - v.convertedSubjects);
      }
      result.set(v.variantId, samples);
    }
  } else {
    for (const v of options.variants) {
      const params = numericPosteriorParams(v);
      const rng = new DeterministicRandom(`${options.seed} :: ${v.variantId}`);
      const samples = new Array<number>(POSTERIOR_SAMPLE_COUNT);
      for (let i = 0; i < POSTERIOR_SAMPLE_COUNT; i++) {
        samples[i] = sampleNumericPosterior(rng, params);
      }
      result.set(v.variantId, samples);
    }
  }
  return result;
}

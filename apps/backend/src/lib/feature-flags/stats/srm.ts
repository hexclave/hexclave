import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

/**
 * Sample-ratio mismatch (SRM) detection: a chi-square goodness-of-fit test of
 * observed exposed-subject counts against the configured variant weights. An
 * SRM means the assignment mechanism itself is broken (biased bucketing, lost
 * exposures for one variant, ...), so any statistical conclusion drawn from
 * the data would be untrustworthy — results are flagged and winner declaration
 * is blocked.
 */

export const SRM_P_VALUE_THRESHOLD = 0.01;

/** Natural log of the gamma function via the Lanczos approximation (g=7, n=9). */
function logGamma(x: number): number {
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const xm1 = x - 1;
  let acc = coefficients[0];
  for (let i = 1; i < 9; i++) {
    acc += coefficients[i] / (xm1 + i);
  }
  const t = xm1 + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (xm1 + 0.5) * Math.log(t) - t + Math.log(acc);
}

/**
 * Regularized lower incomplete gamma function P(a, x), via the standard series
 * expansion for x < a + 1 and the continued fraction for x >= a + 1
 * (Numerical Recipes gammp/gammq).
 */
function regularizedLowerIncompleteGamma(a: number, x: number): number {
  if (!(a > 0) || x < 0 || !Number.isFinite(a) || !Number.isFinite(x)) {
    throw new HexclaveAssertionError(`regularizedLowerIncompleteGamma requires a > 0 and x >= 0, got a=${a}, x=${x}`);
  }
  if (x === 0) return 0;
  const maxIterations = 500;
  const epsilon = 1e-14;
  if (x < a + 1) {
    // Series representation
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < maxIterations; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * epsilon) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  // Continued fraction representation (modified Lentz's method) computes Q(a, x)
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < maxIterations; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  return 1 - q;
}

/** Upper tail probability P(X >= statistic) for X ~ chi-square with the given degrees of freedom. */
export function chiSquareUpperTail(statistic: number, degreesOfFreedom: number): number {
  if (!(degreesOfFreedom >= 1)) {
    throw new HexclaveAssertionError(`chiSquareUpperTail requires degreesOfFreedom >= 1, got ${degreesOfFreedom}`);
  }
  if (!(statistic >= 0)) {
    throw new HexclaveAssertionError(`chiSquareUpperTail requires statistic >= 0, got ${statistic}`);
  }
  return 1 - regularizedLowerIncompleteGamma(degreesOfFreedom / 2, statistic / 2);
}

export type SrmResult = {
  detected: boolean,
  /** Chi-square statistic; null when the test is not applicable (no exposures yet). */
  statistic: number | null,
  pValue: number | null,
};

/**
 * Tests observed exposed-subject counts against expected weights (basis
 * points). SRM is declared when p < 0.01 — deliberately stricter than the
 * usual 0.05 because the test runs on every results refresh and a false SRM
 * alarm blocks winner declaration entirely.
 */
export function detectSampleRatioMismatch(options: {
  variants: { variantId: string, weightBasisPoints: number, exposedSubjects: number }[],
}): SrmResult {
  const { variants } = options;
  if (variants.length < 2) {
    throw new HexclaveAssertionError("SRM detection requires at least two variants; experiment config validation should have enforced this");
  }
  const totalWeight = variants.reduce((acc, v) => acc + v.weightBasisPoints, 0);
  if (totalWeight <= 0) {
    throw new HexclaveAssertionError("SRM detection requires positive total variant weight");
  }
  const totalExposed = variants.reduce((acc, v) => {
    if (!Number.isInteger(v.exposedSubjects) || v.exposedSubjects < 0) {
      throw new HexclaveAssertionError(`Invalid exposed-subject count for variant ${v.variantId}: ${v.exposedSubjects}`);
    }
    return acc + v.exposedSubjects;
  }, 0);
  if (totalExposed === 0) {
    return { detected: false, statistic: null, pValue: null };
  }

  // Zero-weight variants should receive zero traffic; any exposure at all for
  // them is by definition a sample-ratio mismatch (and would divide by zero in
  // the chi-square term), so handle them before the main loop.
  for (const v of variants) {
    if (v.weightBasisPoints === 0 && v.exposedSubjects > 0) {
      return { detected: true, statistic: null, pValue: 0 };
    }
  }

  const contributing = variants.filter((v) => v.weightBasisPoints > 0);
  // With one positive-weight variant there is no distribution to compare.
  // Zero-weight variants were handled above, so the observed allocation is
  // necessarily consistent and a chi-square test (zero degrees of freedom)
  // is not applicable.
  if (contributing.length === 1) {
    return { detected: false, statistic: 0, pValue: 1 };
  }
  let statistic = 0;
  for (const v of contributing) {
    const expected = (totalExposed * v.weightBasisPoints) / totalWeight;
    statistic += ((v.exposedSubjects - expected) * (v.exposedSubjects - expected)) / expected;
  }
  const pValue = chiSquareUpperTail(statistic, contributing.length - 1);
  return { detected: pValue < SRM_P_VALUE_THRESHOLD, statistic, pValue };
}

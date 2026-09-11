export function nearestRankPercentile(sortedValues: readonly number[], percentile: number): number | null {
  if (sortedValues.length === 0) return null;
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new Error(`Percentile must be greater than 0 and at most 1; received ${percentile}`);
  }
  // `percentile * length` can land a hair above an exact integer in floating point (0.28 * 25 is
  // 7.000000000000001), and `ceil` would then pick the next rank. The epsilon absorbs that without
  // being large enough to move a genuinely fractional product across an integer.
  const index = Math.ceil(percentile * sortedValues.length - 1e-9) - 1;
  return sortedValues[index];
}

/** Smallest and largest of `values` in one pass; null for no values. Safe for arrays too large to spread. */
export function extent(values: Iterable<number>): { min: number, max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (const value of values) {
    seen = true;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return seen ? { min, max } : null;
}

export function percentage(part: number, total: number): number | null {
  if (total === 0) return null;
  return Math.round((part / total) * 100);
}

export const MIN_P95_SAMPLE_COUNT = 20;

export function canReportP95(sampleCount: number): boolean {
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new Error(`Sample count must be a non-negative integer; received ${sampleCount}`);
  }
  return sampleCount >= MIN_P95_SAMPLE_COUNT;
}

export function formatMilliseconds(value: number | null): string {
  return value == null ? "—" : `${value.toLocaleString()}ms`;
}

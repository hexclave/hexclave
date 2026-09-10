export function nearestRankPercentile(sortedValues: readonly number[], percentile: number): number | null {
  if (sortedValues.length === 0) return null;
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new Error(`Percentile must be greater than 0 and at most 1; received ${percentile}`);
  }
  const index = Math.ceil(percentile * sortedValues.length) - 1;
  return sortedValues[index];
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

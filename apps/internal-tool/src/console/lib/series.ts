const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** More buckets than this and individual bars become too thin to hover on a laptop screen. */
export const MAX_BUCKETS = 60;

export type TimeBucket = {
  start: number,
  end: number,
  /** Short axis label ("3 PM", "Oct 4"). */
  label: string,
  /** Longer label for tooltips ("Oct 4, 3 PM"). */
  fullLabel: string,
  /** One value per series, in the order the series were passed in. */
  values: number[],
};

function startOfLocalDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfLocalHour(time: number): number {
  const date = new Date(time);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/**
 * Buckets each series' timestamps into calendar-aligned hours (spans up to ~2 days) or days, so
 * bars line up with midnight/the hour rather than with whatever "now" happened to be. Spans too
 * long for daily buckets under MAX_BUCKETS are widened to whole multiples of a day.
 *
 * Timestamps outside [start, end] are ignored; a timestamp exactly at `end` lands in the last
 * bucket (otherwise the newest event would vanish from the chart).
 */
export function bucketize(series: ReadonlyArray<readonly number[]>, start: number, end: number): TimeBucket[] {
  if (!(end >= start)) throw new Error(`bucketize: end (${end}) must not be before start (${start})`);
  const span = end - start;
  const hourly = span <= 2 * DAY_MS;
  const unit = hourly ? HOUR_MS : DAY_MS;
  const alignedStart = hourly ? startOfLocalHour(start) : startOfLocalDay(start);
  const unitsNeeded = Math.max(1, Math.ceil((end - alignedStart + 1) / unit));
  const unitsPerBucket = Math.max(1, Math.ceil(unitsNeeded / MAX_BUCKETS));
  const bucketMs = unit * unitsPerBucket;
  const bucketCount = Math.max(1, Math.ceil((end - alignedStart + 1) / bucketMs));

  const labelFormat: Intl.DateTimeFormatOptions = hourly ? { hour: "numeric" } : { month: "short", day: "numeric" };
  const fullFormat: Intl.DateTimeFormatOptions = hourly
    ? { month: "short", day: "numeric", hour: "numeric" }
    : { weekday: "short", month: "short", day: "numeric" };

  const buckets: TimeBucket[] = [];
  for (let index = 0; index < bucketCount; index++) {
    const bucketStart = alignedStart + index * bucketMs;
    buckets.push({
      start: bucketStart,
      end: bucketStart + bucketMs,
      label: new Date(bucketStart).toLocaleString("en-US", labelFormat),
      fullLabel: new Date(bucketStart).toLocaleString("en-US", fullFormat),
      values: series.map(() => 0),
    });
  }
  series.forEach((times, seriesIndex) => {
    for (const time of times) {
      if (time < start || time > end) continue;
      const index = Math.min(Math.floor((time - alignedStart) / bucketMs), bucketCount - 1);
      if (index >= 0) buckets[index].values[seriesIndex]++;
    }
  });
  return buckets;
}

/** Window for a relative range ending now, or for "all" the span of the observed data. */
export function seriesWindow(rangeStart: number | null, observedMin: number | null, now: number): { start: number, end: number } {
  if (rangeStart != null) return { start: rangeStart, end: now };
  return { start: observedMin ?? now - DAY_MS, end: now };
}

/** Change between the two halves of a series, as a percentage of the first half; null when undefined. */
export function trendPercent(values: readonly number[]): number | null {
  if (values.length < 4) return null;
  const middle = Math.floor(values.length / 2);
  const before = values.slice(0, middle).reduce((sum, value) => sum + value, 0);
  const after = values.slice(values.length - middle).reduce((sum, value) => sum + value, 0);
  if (before === 0) return null;
  return Math.round(((after - before) / before) * 100);
}

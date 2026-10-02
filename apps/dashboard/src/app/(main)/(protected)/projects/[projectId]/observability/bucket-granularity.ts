import type { ObservabilityTimeRangeHours } from "./filters";

export type BucketGranularity = {
  label: string,
  bucketNoun: string,
  bucketCount: number,
  stepMs: number,
  stepSql: string,
  historySql: string,
};

const HOUR_MS = 3_600_000;

export function getBucketGranularity(hours: ObservabilityTimeRangeHours): BucketGranularity {
  switch (hours) {
    case 1: {
      return {
        label: "per minute",
        bucketNoun: "minute",
        bucketCount: 60,
        stepMs: 60_000,
        stepSql: "INTERVAL 1 MINUTE",
        historySql: "INTERVAL 59 MINUTE",
      };
    }
    case 24: {
      return {
        label: "per hour",
        bucketNoun: "hour",
        bucketCount: 24,
        stepMs: HOUR_MS,
        stepSql: "INTERVAL 1 HOUR",
        historySql: "INTERVAL 23 HOUR",
      };
    }
    case 168: {
      return {
        label: "per 6 hours",
        bucketNoun: "6 hours",
        bucketCount: 28,
        stepMs: 6 * HOUR_MS,
        stepSql: "INTERVAL 6 HOUR",
        historySql: "INTERVAL 162 HOUR",
      };
    }
    case 720: {
      return {
        label: "per day",
        bucketNoun: "day",
        bucketCount: 30,
        stepMs: 24 * HOUR_MS,
        stepSql: "INTERVAL 1 DAY",
        historySql: "INTERVAL 29 DAY",
      };
    }
  }
}

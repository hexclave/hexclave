import type { McpCallLogRow } from "./types";
export const QA_REVIEW_FAILED_THRESHOLD_MS = 2 * 60 * 1000;
export function qaReviewStartedAt(row: McpCallLogRow): Date {
  const requested = toDate(row.qaReviewRequestedAt);
  const created = toDate(row.createdAt);
  return requested > created ? requested : created;
}

/**
 * SpacetimeDB timestamps are { __timestamp_micros_since_unix_epoch__: bigint }.
 * Convert to a JS Date.
 */
export function toDate(ts: unknown): Date {
  if (ts instanceof Date) return ts;
  if (typeof ts === "object" && ts !== null && "__timestamp_micros_since_unix_epoch__" in ts) {
    const micros = (ts as Record<string, unknown>).__timestamp_micros_since_unix_epoch__;
    if (typeof micros !== "bigint") {
      throw new TypeError(`Expected __timestamp_micros_since_unix_epoch__ to be bigint, got ${typeof micros}`);
    }
    return new Date(Number(micros / 1000n));
  }
  if (typeof ts === "bigint") {
    return new Date(Number(ts / 1000n));
  }
  if (typeof ts === "number") {
    return new Date(ts);
  }
  throw new TypeError(`Cannot convert ${typeof ts} to Date`);
}

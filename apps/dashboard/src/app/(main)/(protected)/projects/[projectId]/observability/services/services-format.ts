import {
  formatAbsoluteTimeFromMillis,
  formatCount,
  formatDuration,
  formatRelativeTimeFromMillis,
} from "../format";
import { parseServiceTimestamp, type ServiceAttentionReason } from "./services-data";

export { formatCount, formatDuration };

export function formatPercent(ratio: number, fractionDigits = 1): string {
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

export function formatSignedPercent(ratio: number): string {
  const percent = ratio * 100;
  const rounded = Math.abs(percent) >= 100 ? Math.round(percent) : Number(percent.toFixed(1));
  if (rounded === 0) return "0%";
  return rounded > 0 ? `+${rounded}%` : `−${Math.abs(rounded)}%`;
}

export function formatRelativeTime(value: string, nowMs: number): string {
  return formatRelativeTimeFromMillis(parseServiceTimestamp(value).getTime(), nowMs);
}

export function formatAbsoluteTime(value: string): string {
  return formatAbsoluteTimeFromMillis(parseServiceTimestamp(value).getTime());
}

export const ATTENTION_REASON_LABELS = new Map<ServiceAttentionReason, string>([
  ["error-burst", "Error burst"],
  ["new-errors", "New errors"],
  ["error-spike", "Errors up"],
  ["latency-regression", "Slower"],
  ["went-silent", "Went silent"],
]);

export function attentionReasonLabel(reason: ServiceAttentionReason): string {
  const label = ATTENTION_REASON_LABELS.get(reason);
  if (label == null) throw new Error(`Missing label for attention reason: ${reason}`);
  return label;
}

export function attentionReasonDescription(
  reason: ServiceAttentionReason,
  context: {
    errorCount: number,
    baselineErrorCount: number,
    latestBucketErrorCount: number | null,
    bucketNoun: string,
    p95DurationMs: number | null,
    baselineP95DurationMs: number | null,
    baselineRequestCount: number,
  },
): string {
  switch (reason) {
    case "error-burst": {
      if (context.latestBucketErrorCount == null) {
        throw new Error("An error burst can only be detected from a timeline, so its bucket count must be known");
      }
      const count = context.latestBucketErrorCount;
      return `${formatCount(count)} ${count === 1 ? "error" : "errors"} in the last ${context.bucketNoun}, well above this service's usual rate`;
    }
    case "new-errors": {
      return `${formatCount(context.errorCount)} ${context.errorCount === 1 ? "error" : "errors"} after none in the previous window`;
    }
    case "error-spike": {
      return `${formatCount(context.errorCount)} errors, up from ${formatCount(context.baselineErrorCount)} in the previous window`;
    }
    case "latency-regression": {
      return `p95 ${formatDuration(context.p95DurationMs)}, up from ${formatDuration(context.baselineP95DurationMs)}`;
    }
    case "went-silent": {
      return `No requests this window, after ${formatCount(context.baselineRequestCount)} in the previous one`;
    }
  }
}

export const MAX_JAVASCRIPT_TIMESTAMP_MILLIS = 8_640_000_000_000_000;

export const MAX_TELEMETRY_METERING_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const RFC3339_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

function parseClientTimestamp(clientTimestamp: number | string | null): number | null {
  if (clientTimestamp === null) return null;
  if (typeof clientTimestamp === "number") return clientTimestamp;
  return RFC3339_TIMESTAMP_PATTERN.test(clientTimestamp) ? Date.parse(clientTimestamp) : null;
}

/**
 * Client clocks are useful for assigning usage to the right period, but they
 * are not trusted to move a debit into a future period, more than
 * MAX_TELEMETRY_METERING_LOOKBACK_MS into the past, or construct an invalid
 * Date. Malformed protocol timestamps fall back to the earliest accepted item.
 */
export function telemetryMeteredAt(
  clientTimestamp: number | string | null,
  fallbackTimestampMs: number,
  receivedAt: Date,
): Date {
  const parsed = parseClientTimestamp(clientTimestamp);
  const timestampMs = parsed !== null && Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_JAVASCRIPT_TIMESTAMP_MILLIS
    ? parsed
    : fallbackTimestampMs;
  const receivedAtMs = receivedAt.getTime();
  const earliestAllowedMs = receivedAtMs - MAX_TELEMETRY_METERING_LOOKBACK_MS;
  const boundedMs = Number.isFinite(timestampMs) ? timestampMs : receivedAtMs;
  return new Date(Math.max(earliestAllowedMs, Math.min(boundedMs, receivedAtMs)));
}

import { parseJson, type Json } from "@hexclave/shared/dist/utils/json";

export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms === 0) return "0s";
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) {
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  if (ms < 86_400_000) {
    const totalMinutes = Math.round(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const totalHours = Math.round(ms / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Cannot format a non-finite count: ${value}`);
  if (value < 0) throw new Error(`Cannot format a negative count: ${value}`);
  if (value < 10_000) return value.toLocaleString();
  if (value < 1_000_000) {
    const thousands = (value / 1_000).toFixed(value < 100_000 ? 1 : 0);
    return thousands === "1000" ? "1.0M" : `${thousands}k`;
  }
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

const RELATIVE_TIME_UNITS: readonly { limitMs: number, divisorMs: number, unit: Intl.RelativeTimeFormatUnit }[] = [
  { limitMs: 60_000, divisorMs: 1_000, unit: "second" },
  { limitMs: 3_600_000, divisorMs: 60_000, unit: "minute" },
  { limitMs: 86_400_000, divisorMs: 3_600_000, unit: "hour" },
  { limitMs: 2_592_000_000, divisorMs: 86_400_000, unit: "day" },
];

export function formatRelativeTimeFromMillis(millis: number, nowMs: number): string {
  if (!Number.isFinite(millis)) throw new Error(`Cannot format a non-finite timestamp: ${millis}`);
  const elapsedMs = nowMs - millis;
  if (elapsedMs < 45_000) return "just now";

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });
  for (const { limitMs, divisorMs, unit } of RELATIVE_TIME_UNITS) {
    if (elapsedMs < limitMs) {
      return formatter.format(-Math.round(elapsedMs / divisorMs), unit);
    }
  }
  return formatter.format(-Math.round(elapsedMs / 2_592_000_000), "month");
}

export function formatAbsoluteTimeFromMillis(millis: number): string {
  if (!Number.isFinite(millis)) throw new Error(`Cannot format a non-finite timestamp: ${millis}`);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(millis));
}

export function formatDateFromMillis(millis: number): string {
  if (!Number.isFinite(millis)) throw new Error(`Cannot format a non-finite timestamp: ${millis}`);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(millis));
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Some telemetry columns hold JSON serialized into a string column; this
 * unwraps one level of that, leaving every non-string (and every string that
 * isn't valid JSON) untouched.
 */
export function tryParseJson(value: Json): Json;
export function tryParseJson(value: Json | undefined): Json | undefined;
export function tryParseJson(value: Json | undefined): Json | undefined {
  if (typeof value !== "string") return value;
  const parsed = parseJson(value);
  return parsed.status === "ok" ? parsed.data : value;
}

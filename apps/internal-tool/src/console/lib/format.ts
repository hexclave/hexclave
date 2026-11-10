import { formatDistanceToNowStrict } from "date-fns";

/** "1,240ms" below 10s, "12.4s" up to a minute, "2m 05s" beyond — readable at a glance in tables. */
export function formatDuration(ms: number | bigint | null | undefined): string {
  if (ms == null) return "—";
  const value = Number(ms);
  if (!Number.isFinite(value)) return "—";
  if (value < 10_000) return `${Math.round(value).toLocaleString()}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatCompact(value: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: value >= 1000 ? 1 : 0 }).format(value);
}

/** "3m ago" style, short enough for table cells. */
export function formatAgo(date: Date): string {
  return `${formatDistanceToNowStrict(date)} ago`;
}

export function formatPercent(value: number | null): string {
  return value == null ? "—" : `${value}%`;
}

/** Cost read-out for totals: cents precision above a dollar, sub-cent precision below. */
export function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

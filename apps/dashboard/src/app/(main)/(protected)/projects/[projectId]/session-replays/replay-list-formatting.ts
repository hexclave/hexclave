export function formatReplayDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${totalSeconds % 60}s`;
  return `${totalSeconds}s`;
}

const compactCountFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
});

export function formatReplayCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "—";
  return compactCountFormatter.format(count).toLocaleLowerCase("en-US");
}

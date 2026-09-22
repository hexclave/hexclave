// TV snapshot contracts are negotiated numerically so a newer client header
// never silently drops fields that an older contract already included.
// Empty, whitespace-only, non-decimal, zero, and negative values are not a
// contract version; they fall back to 1.
export function readTvSnapshotContractVersion(headers: Record<string, string[] | undefined>): number {
  const raw = headers["x-hexclave-tv-snapshot-contract"]?.at(0)
    ?? headers["x-stack-tv-snapshot-contract"]?.at(0);
  if (raw == null) return 1;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return 1;
  return Number(trimmed);
}

// TV snapshot contracts are negotiated numerically so a newer client header
// never silently drops fields that an older contract already included.
export function readTvSnapshotContractVersion(headers: Record<string, string[] | undefined>): number {
  const raw = headers["x-hexclave-tv-snapshot-contract"]?.at(0)
    ?? headers["x-stack-tv-snapshot-contract"]?.at(0);
  const version = Number(raw ?? "1");
  return Number.isInteger(version) ? version : 1;
}

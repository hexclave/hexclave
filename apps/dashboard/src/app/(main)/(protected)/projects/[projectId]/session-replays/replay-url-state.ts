
export const REPLAY_SEEK_EPOCH_SPLIT_MS = 100_000_000_000;

export type ReplaySeekAt =
  | { kind: "epoch", value: number }
  | { kind: "offset", value: number };

export function parseReplaySeekAt(raw: string | null): ReplaySeekAt | null {
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return null;
  if (value >= REPLAY_SEEK_EPOCH_SPLIT_MS) return { kind: "epoch", value };
  return { kind: "offset", value };
}

export function replaySeekOffsetMs(seek: ReplaySeekAt, globalStartTs: number, globalTotalMs: number): number {
  const offset = seek.kind === "epoch" ? seek.value - globalStartTs : seek.value;
  return Math.min(Math.max(offset, 0), Math.max(globalTotalMs, 0));
}

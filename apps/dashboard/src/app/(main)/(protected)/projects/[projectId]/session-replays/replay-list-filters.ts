export type ReplayUserKind = "anonymous" | "verified";

export type ReplayFilters = {
  userId: string,
  userLabel: string,
  teamId: string,
  teamLabel: string,
  durationMinSeconds: string,
  durationMaxSeconds: string,
  lastActivePreset: "" | "24h" | "7d" | "30d",
  clickCountMin: string,
  userKind: "" | ReplayUserKind,
};

export const EMPTY_REPLAY_FILTERS: ReplayFilters = {
  userId: "",
  userLabel: "",
  teamId: "",
  teamLabel: "",
  durationMinSeconds: "",
  durationMaxSeconds: "",
  lastActivePreset: "",
  clickCountMin: "",
  userKind: "",
};

export function replayUserKindLabel(kind: ReplayUserKind): string {
  switch (kind) {
    case "anonymous": {
      return "Anonymous";
    }
    case "verified": {
      return "Verified";
    }
    default: {
      kind satisfies never;
      throw new Error(`Unexpected session replay user kind: ${kind}`);
    }
  }
}

export function replayFiltersActiveCount(filters: ReplayFilters): number {
  let count = 0;
  if (filters.userId) count += 1;
  if (filters.teamId) count += 1;
  if (filters.durationMinSeconds || filters.durationMaxSeconds) count += 1;
  if (filters.lastActivePreset) count += 1;
  if (filters.clickCountMin) count += 1;
  if (filters.userKind) count += 1;
  return count;
}

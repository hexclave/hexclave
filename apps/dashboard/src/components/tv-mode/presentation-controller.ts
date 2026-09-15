import type { TvPresentedTakeover, TvSnapshot } from "@/lib/tv-mode/types";

export type TvPresentationView =
  | { type: "fatal-error", message: string }
  | { type: "takeover", presentedTakeover: TvPresentedTakeover }
  | { type: "empty" }
  | { type: "screen", screenIndex: number };

export function getNextTvScreenIndex(currentIndex: number, screenCount: number): number {
  if (screenCount <= 0) return 0;
  return (currentIndex + 1) % screenCount;
}

export function selectTvPresentationView(
  snapshot: TvSnapshot,
  screenIndex: number,
  boundedTakeoverCompleted: boolean,
): TvPresentationView {
  if (snapshot.fatalErrorMessage != null) {
    return { type: "fatal-error", message: snapshot.fatalErrorMessage };
  }

  const takeover = snapshot.presentation.takeover;
  if (
    takeover != null
    && !boundedTakeoverCompleted
  ) {
    return { type: "takeover", presentedTakeover: takeover };
  }

  const playlistScreens = snapshot.profile.playlist
    .map((screenId) => snapshot.screens.find((screen) => screen.id === screenId))
    .filter((screen) => screen != null);

  if (
    snapshot.profile.playlist.length === 0
    || (playlistScreens.length > 0 && playlistScreens.every((screen) => screen.sourceStatus === "empty"))
  ) {
    return { type: "empty" };
  }

  return {
    type: "screen",
    screenIndex: Math.min(screenIndex, snapshot.profile.playlist.length - 1),
  };
}

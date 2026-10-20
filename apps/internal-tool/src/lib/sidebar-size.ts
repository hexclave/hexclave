export const DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 208;
export const MAX_SIDEBAR_WIDTH = 480;

// The detail sidebar used to be a fixed `min(34rem, 42vw)`; 544px is that 34rem, kept as the default
// so existing users see no jump. The bounds are wide because detail panes hold transcripts and JSON
// payloads that some reviewers want nearly half the screen for.
export const DEFAULT_DETAIL_SIDEBAR_WIDTH = 544;
export const MIN_DETAIL_SIDEBAR_WIDTH = 360;
export const MAX_DETAIL_SIDEBAR_WIDTH = 960;

function clampWidth(width: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(width)) return fallback;
  return Math.min(max, Math.max(min, Math.round(width)));
}

export function normalizeSidebarWidth(width: number): number {
  return clampWidth(width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH);
}

export function normalizeDetailSidebarWidth(width: number): number {
  return clampWidth(width, MIN_DETAIL_SIDEBAR_WIDTH, MAX_DETAIL_SIDEBAR_WIDTH, DEFAULT_DETAIL_SIDEBAR_WIDTH);
}

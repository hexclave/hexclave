// Multi-tab session replay timeline: how a replay's tabs (segments) are laid
// out in time, labelled, and which tab is "active" — i.e. shown — at any moment.
//
// This is the single source of truth for both the dashboard replay player and
// the server-side video renderer (apps/backend/scripts/replay-render/render.mjs),
// so a rendered video always cuts between tabs exactly where the player does.
// The renderer runs this file as-is with Node's built-in TypeScript type
// stripping, so it must stay dependency-free and use only erasable TypeScript
// syntax (no enums, namespaces, parameter properties or imports).

/** How much faster than playback the dead time between two tabs is skipped. */
export const INTER_TAB_GAP_FAST_FORWARD_MULTIPLIER = 12;

export type ReplayTimeRange = { startTs: number, endTs: number };

export type ReplayTimelineTab = {
  tabKey: string,
  /** The 1-based N of "Tab N". Lower labels win when several tabs are active at once. */
  labelIndex: number,
  /** When this tab was recording, sorted and non-overlapping (see mergeReplayChunkRanges). */
  ranges: ReplayTimeRange[],
  /** A tab without a full snapshot cannot be shown, so it is never active. */
  hasFullSnapshot: boolean,
};

/** Merges a tab's chunk time spans into sorted, non-overlapping ranges. */
export function mergeReplayChunkRanges(chunks: Array<{ firstEventAtMs: number, lastEventAtMs: number }>): ReplayTimeRange[] {
  const ranges = chunks
    .map((c) => ({ startTs: c.firstEventAtMs, endTs: c.lastEventAtMs }))
    .filter((r) => Number.isFinite(r.startTs) && Number.isFinite(r.endTs) && r.endTs >= r.startTs)
    .sort((a, b) => a.startTs - b.startTs);

  const merged: ReplayTimeRange[] = [];
  for (const r of ranges) {
    const last = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (last != null && r.startTs <= last.endTs) {
      last.endTs = Math.max(last.endTs, r.endTs);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Same ordering as stringCompare in ./strings (case-insensitive first, then
 * case-sensitive), duplicated because this file may not import anything.
 */
export function compareReplayTabKeys(a: string, b: string): number {
  const cmp = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
  return cmp(a.toUpperCase(), b.toUpperCase()) || cmp(b, a);
}

/** "Tab N" numbering: tabs in order of their first event, 1-based. */
export function computeReplayTabLabelIndex(tabs: Array<{ tabKey: string, firstEventAtMs: number }>): Map<string, number> {
  const ordered = tabs.slice().sort((a, b) => {
    const first = a.firstEventAtMs - b.firstEventAtMs;
    if (first !== 0) return first;
    return compareReplayTabKeys(a.tabKey, b.tabKey);
  });
  return new Map(ordered.map((t, i) => [t.tabKey, i + 1]));
}

/** Start and end of the whole replay across all tabs. */
export function computeReplayGlobalTimeline(tabs: Array<{ firstEventAtMs: number, lastEventAtMs: number }>) {
  let globalStartTs = Infinity;
  let globalEndTs = -Infinity;
  for (const t of tabs) {
    globalStartTs = Math.min(globalStartTs, t.firstEventAtMs);
    globalEndTs = Math.max(globalEndTs, t.lastEventAtMs);
  }
  if (!Number.isFinite(globalStartTs) || !Number.isFinite(globalEndTs) || globalEndTs < globalStartTs) {
    return { globalStartTs: 0, globalEndTs: 0, globalTotalMs: 0 };
  }
  return { globalStartTs, globalEndTs, globalTotalMs: globalEndTs - globalStartTs };
}

/** Whether the tab was recording at `ts` (and can be shown). */
export function isReplayTabInRangeAt(tab: ReplayTimelineTab, ts: number): boolean {
  if (!tab.hasFullSnapshot) return false;
  let lo = 0;
  let hi = tab.ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = tab.ranges[mid]!;
    if (ts < r.startTs) {
      hi = mid - 1;
    } else if (ts > r.endTs) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/** The tab to show at `ts` when the current one has nothing: the lowest-labelled tab that was recording. */
export function findBestReplayTabAt(tabs: ReplayTimelineTab[], ts: number, excludeTabKey?: string): string | null {
  let best: ReplayTimelineTab | null = null;
  for (const tab of tabs) {
    if (excludeTabKey != null && tab.tabKey === excludeTabKey) continue;
    if (!isReplayTabInRangeAt(tab, ts)) continue;
    if (
      best == null
      || tab.labelIndex < best.labelIndex
      || (tab.labelIndex === best.labelIndex && compareReplayTabKeys(tab.tabKey, best.tabKey) < 0)
    ) {
      best = tab;
    }
  }
  return best?.tabKey ?? null;
}

/** The earliest moment after `ts` at which some tab starts recording again. */
export function findNextReplayTabStartAfter(tabs: ReplayTimelineTab[], ts: number): { tabKey: string, startTs: number } | null {
  let bestStartTs = Infinity;
  let bestKey: string | null = null;
  for (const tab of tabs) {
    if (!tab.hasFullSnapshot) continue;
    for (const r of tab.ranges) {
      if (r.startTs <= ts) continue;
      if (r.startTs < bestStartTs) {
        bestStartTs = r.startTs;
        bestKey = tab.tabKey;
      }
      break; // ranges are sorted by start
    }
  }
  if (bestKey == null || !Number.isFinite(bestStartTs)) return null;
  return { tabKey: bestKey, startTs: bestStartTs };
}

export type ReplayActiveTabDecision =
  | { type: "stay" }
  | { type: "switch", tabKey: string }
  | { type: "gap", tabKey: string, startTs: number }
  | { type: "end" };

/**
 * The follow-active-tab rule. Keep showing the active tab while it was
 * recording at `ts`; otherwise switch to the best tab that was; otherwise
 * fast-forward (see INTER_TAB_GAP_FAST_FORWARD_MULTIPLIER) to whichever tab
 * starts next; otherwise the replay is over.
 */
export function decideReplayActiveTab(tabs: ReplayTimelineTab[], activeTabKey: string | null, ts: number): ReplayActiveTabDecision {
  const active = activeTabKey == null ? undefined : tabs.find((t) => t.tabKey === activeTabKey);
  if (active != null && isReplayTabInRangeAt(active, ts)) return { type: "stay" };
  const best = findBestReplayTabAt(tabs, ts);
  if (best != null) return best === activeTabKey ? { type: "stay" } : { type: "switch", tabKey: best };
  const next = findNextReplayTabStartAfter(tabs, ts);
  if (next != null) return { type: "gap", tabKey: next.tabKey, startTs: next.startTs };
  return { type: "end" };
}

import.meta.vitest?.test("decideReplayActiveTab follows the active tab across overlaps and gaps", ({ expect }) => {
  const tabs: ReplayTimelineTab[] = [
    { tabKey: "a", labelIndex: 1, hasFullSnapshot: true, ranges: [{ startTs: 0, endTs: 100 }, { startTs: 400, endTs: 500 }] },
    { tabKey: "b", labelIndex: 2, hasFullSnapshot: true, ranges: [{ startTs: 50, endTs: 300 }] },
    { tabKey: "c", labelIndex: 3, hasFullSnapshot: false, ranges: [{ startTs: 0, endTs: 1000 }] },
  ];
  expect(decideReplayActiveTab(tabs, null, 10)).toEqual({ type: "switch", tabKey: "a" });
  // b is recording too, but a still is, so a stays.
  expect(decideReplayActiveTab(tabs, "a", 60)).toEqual({ type: "stay" });
  // a stopped: b takes over, even though a has a lower label.
  expect(decideReplayActiveTab(tabs, "a", 150)).toEqual({ type: "switch", tabKey: "b" });
  // Nothing recording (c has no snapshot): fast-forward to a's next range.
  expect(decideReplayActiveTab(tabs, "b", 350)).toEqual({ type: "gap", tabKey: "a", startTs: 400 });
  expect(decideReplayActiveTab(tabs, "a", 600)).toEqual({ type: "end" });
});

import.meta.vitest?.test("mergeReplayChunkRanges merges overlapping chunks and drops invalid ones", ({ expect }) => {
  expect(mergeReplayChunkRanges([
    { firstEventAtMs: 50, lastEventAtMs: 80 },
    { firstEventAtMs: 0, lastEventAtMs: 60 },
    { firstEventAtMs: 100, lastEventAtMs: 90 },
    { firstEventAtMs: 200, lastEventAtMs: 250 },
  ])).toEqual([{ startTs: 0, endTs: 80 }, { startTs: 200, endTs: 250 }]);
});

import.meta.vitest?.test("computeReplayTabLabelIndex orders by first event, then tab key", ({ expect }) => {
  expect([...computeReplayTabLabelIndex([
    { tabKey: "b", firstEventAtMs: 10 },
    { tabKey: "a", firstEventAtMs: 10 },
    { tabKey: "c", firstEventAtMs: 5 },
  ])]).toEqual([["c", 1], ["a", 2], ["b", 3]]);
});

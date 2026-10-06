import type { TabKey, TabStream } from "@/lib/session-replay-streams";
import {
  getDesiredGlobalOffsetFromPlaybackState,
  getReplayFinishAction,
  INTER_TAB_GAP_FAST_FORWARD_MULTIPLIER,
  applySeekState,
} from "@/lib/session-replay-playback";
import {
  globalOffsetToLocalOffset,
  localOffsetToGlobalOffset,
} from "@/lib/session-replay-streams";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

// ---------------------------------------------------------------------------
// Shared constants (also used by the component shell)
// ---------------------------------------------------------------------------

export const ALLOWED_PLAYER_SPEEDS = new Set([0.5, 1, 2, 4]);

/** How long (wall-clock ms) the player can be in "playing" mode without the
 *  replayer reporting progress before we attempt automatic recovery. */
export const STALL_THRESHOLD_MS = 3000;

/** Minimum wall-clock interval between `sync_mini_tabs` effects while playing.
 *  Syncing a mini tab is a full rrweb seek (rebuild from the last FullSnapshot
 *  plus synchronous fast-forward of every event up to the offset), which can
 *  block the main thread for hundreds of milliseconds on large recordings —
 *  doing it on every tick froze the page. Mini tabs are small background
 *  thumbnails, so a coarse sync cadence is enough. */
export const MINI_TAB_SYNC_INTERVAL_MS = 2000;

export const DEFAULT_REPLAY_SETTINGS: ReplaySettings = {
  playerSpeed: 1,
  skipInactivity: true,
  followActiveTab: false,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReplaySettings = {
  playerSpeed: number,
  skipInactivity: boolean,
  followActiveTab: boolean,
};

export type ChunkRange = { startTs: number, endTs: number };

export type GapFastForward = {
  fromGlobalMs: number,
  toGlobalMs: number,
  wallMs: number,
  nextTabKey: TabKey,
  gen: number,
};

export type PlaybackMode =
  | "paused"
  | "playing"
  | "buffering"
  | "gap_fast_forward"
  | "finished";

export type Phase = "idle" | "downloading" | "ready";

/** Minimal stream info the machine needs (no DOM / rrweb refs). */
export type StreamInfo = {
  tabKey: TabKey,
  firstEventAtMs: number,
  lastEventAtMs: number,
};

export type ReplayState = {
  generation: number,
  phase: Phase,

  playbackMode: PlaybackMode,
  activeTabKey: TabKey | null,
  pausedAtGlobalMs: number,
  currentGlobalTimeMsForUi: number,

  streams: StreamInfo[],
  globalStartTs: number,
  globalTotalMs: number,

  chunkRangesByTab: Map<TabKey, ChunkRange[]>,
  tabLabelIndex: Map<TabKey, number>,
  hasFullSnapshotByTab: Set<TabKey>,
  loadedDurationByTabMs: Map<TabKey, number>,
  tabsWithEvents: Set<TabKey>,

  replayerReady: Set<TabKey>,

  settings: ReplaySettings,
  autoPlayTriggered: boolean,
  suppressAutoFollowUntilWallMs: number,
  autoResumeAfterBuffering: boolean,
  bufferingAtGlobalMs: number | null,

  gapFastForward: GapFastForward | null,

  /** Tracks the localTimeMs of the last premature-finish retry so we can
   *  detect an infinite loop where rrweb keeps firing "finish" at the same
   *  position because `addEvent` didn't extend the playable range. */
  prematureFinishRetryLocalMs: number | null,

  /** Wall-clock time when we first noticed "playing" mode but the replayer
   *  hadn't reported any progress.  Used for stall detection. */
  playingWithoutProgressSinceMs: number | null,

  /** Wall-clock time of the last `sync_mini_tabs` effect, used to throttle
   *  mini-tab seeks (see MINI_TAB_SYNC_INTERVAL_MS). */
  lastMiniTabSyncWallMs: number,

  downloadError: string | null,
  playerError: string | null,
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ReplayAction =
  | { type: "SELECT_RECORDING", generation: number }
  | {
    type: "STREAMS_COMPUTED",
    generation: number,
    streams: StreamInfo[],
    globalStartTs: number,
    globalTotalMs: number,
    chunkRangesByTab: Map<TabKey, ChunkRange[]>,
    tabLabelIndex: Map<TabKey, number>,
  }
  | { type: "DOWNLOAD_COMPLETE", generation: number }
  | { type: "DOWNLOAD_ERROR", generation: number, message: string }
  | {
    type: "CHUNK_LOADED",
    generation: number,
    tabKey: TabKey,
    hasFullSnapshot: boolean,
    loadedDurationMs: number,
    hadEventsBeforeThisChunk: boolean,
  }
  | { type: "REPLAYER_READY", generation: number, tabKey: TabKey }
  | { type: "REPLAYER_INIT_ERROR", generation: number, message: string }
  | {
    type: "REPLAYER_FINISH",
    generation: number,
    tabKey: TabKey,
    localTimeMs: number,
    nowMs: number,
  }
  | { type: "TOGGLE_PLAY_PAUSE", nowMs: number }
  | { type: "SEEK", globalOffsetMs: number, nowMs: number }
  | { type: "SELECT_TAB", tabKey: TabKey, nowMs: number }
  | { type: "UPDATE_SPEED", speed: number }
  | { type: "UPDATE_SETTINGS", updates: Partial<ReplaySettings> }
  | {
    type: "TICK",
    nowMs: number,
    activeReplayerLocalTimeMs: number | null,
  }
  | { type: "BUFFER_CHECK", generation: number, tabKey: TabKey }
  | { type: "RESET" };

// ---------------------------------------------------------------------------
// Effects (data, not imperative)
// ---------------------------------------------------------------------------

export type ReplayEffect =
  | { type: "play_replayer", tabKey: TabKey, localOffsetMs: number }
  | { type: "pause_replayer_at", tabKey: TabKey, localOffsetMs: number }
  | { type: "pause_all" }
  | { type: "ensure_replayer", tabKey: TabKey, generation: number }
  | { type: "destroy_all_replayers" }
  | { type: "set_replayer_speed", speed: number }
  | { type: "set_replayer_skip_inactive", skipInactive: boolean }
  | { type: "sync_mini_tabs", globalOffsetMs: number }
  | { type: "schedule_buffer_poll", generation: number, tabKey: TabKey, localTimeMs: number, delayMs: number }
  | { type: "save_settings", settings: ReplaySettings }
  | { type: "recreate_replayer", tabKey: TabKey, generation: number };

export type ReducerResult = {
  state: ReplayState,
  effects: ReplayEffect[],
};

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function createInitialState(settings?: ReplaySettings): ReplayState {
  return {
    generation: 0,
    phase: "idle",
    playbackMode: "paused",
    activeTabKey: null,
    pausedAtGlobalMs: 0,
    currentGlobalTimeMsForUi: 0,
    streams: [],
    globalStartTs: 0,
    globalTotalMs: 0,
    chunkRangesByTab: new Map(),
    tabLabelIndex: new Map(),
    hasFullSnapshotByTab: new Set(),
    loadedDurationByTabMs: new Map(),
    tabsWithEvents: new Set(),
    replayerReady: new Set(),
    settings: settings ?? { ...DEFAULT_REPLAY_SETTINGS },
    autoPlayTriggered: false,
    suppressAutoFollowUntilWallMs: 0,
    autoResumeAfterBuffering: false,
    bufferingAtGlobalMs: null,
    gapFastForward: null,
    prematureFinishRetryLocalMs: null,
    playingWithoutProgressSinceMs: null,
    lastMiniTabSyncWallMs: 0,
    downloadError: null,
    playerError: null,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function findBestTabAtGlobalOffset(
  state: ReplayState,
  globalOffsetMs: number,
  excludeTabKey?: TabKey,
): TabKey | null {
  const ts = state.globalStartTs + globalOffsetMs;
  const candidates = state.streams.filter((s) => {
    if (excludeTabKey && s.tabKey === excludeTabKey) return false;
    if (!state.hasFullSnapshotByTab.has(s.tabKey)) return false;
    const ranges = state.chunkRangesByTab.get(s.tabKey) ?? [];
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid]!;
      if (ts < r.startTs) {
        hi = mid - 1;
      } else if (ts > r.endTs) {
        lo = mid + 1;
      } else {
        return true;
      }
    }
    return false;
  });
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const aLabel = state.tabLabelIndex.get(a.tabKey) ?? Number.POSITIVE_INFINITY;
    const bLabel = state.tabLabelIndex.get(b.tabKey) ?? Number.POSITIVE_INFINITY;
    if (aLabel !== bLabel) return aLabel - bLabel;
    return stringCompare(a.tabKey, b.tabKey);
  });

  return candidates[0]!.tabKey;
}

export function isTabInRangeAtGlobalOffset(
  state: ReplayState,
  tabKey: TabKey,
  globalOffsetMs: number,
): boolean {
  if (!state.hasFullSnapshotByTab.has(tabKey)) return false;
  const ts = state.globalStartTs + globalOffsetMs;
  const ranges = state.chunkRangesByTab.get(tabKey) ?? [];
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
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

export function findNextTabStartAfterGlobalOffset(
  state: ReplayState,
  globalOffsetMs: number,
): { tabKey: TabKey, globalOffsetMs: number } | null {
  const ts = state.globalStartTs + globalOffsetMs;
  let bestStartTs = Infinity;
  let bestKey: TabKey | null = null;

  for (const s of state.streams) {
    if (!state.hasFullSnapshotByTab.has(s.tabKey)) continue;
    const ranges = state.chunkRangesByTab.get(s.tabKey) ?? [];
    for (const r of ranges) {
      if (r.startTs <= ts) continue;
      if (r.startTs < bestStartTs) {
        bestStartTs = r.startTs;
        bestKey = s.tabKey;
      }
      break; // ranges sorted by start
    }
  }

  if (!bestKey || !Number.isFinite(bestStartTs)) return null;
  return {
    tabKey: bestKey,
    globalOffsetMs: bestStartTs - state.globalStartTs,
  };
}

function getStreamInfo(state: ReplayState, tabKey: TabKey): StreamInfo | null {
  return state.streams.find(s => s.tabKey === tabKey) ?? null;
}

function computeDesiredGlobalOffset(
  state: ReplayState,
  nowMs: number,
  activeReplayerLocalTimeMs: number | null,
): number {
  const activeStream = state.activeTabKey ? getStreamInfo(state, state.activeTabKey) : null;
  return getDesiredGlobalOffsetFromPlaybackState({
    gapFastForward: state.gapFastForward,
    playerIsPlaying: state.playbackMode === "playing" || state.playbackMode === "gap_fast_forward",
    nowMs,
    playerSpeed: state.settings.playerSpeed,
    pausedAtGlobalMs: state.pausedAtGlobalMs,
    activeLocalOffsetMs: activeReplayerLocalTimeMs,
    activeStreamStartTs: activeStream?.firstEventAtMs ?? null,
    globalStartTs: state.globalStartTs,
    gapFastForwardMultiplier: INTER_TAB_GAP_FAST_FORWARD_MULTIPLIER,
  });
}

function playEffectsForAllTabs(state: ReplayState, globalOffsetMs: number): ReplayEffect[] {
  const effects: ReplayEffect[] = [];
  for (const s of state.streams) {
    const localOffset = globalOffsetToLocalOffset(state.globalStartTs, s.firstEventAtMs, globalOffsetMs);
    if (s.tabKey === state.activeTabKey) {
      effects.push({ type: "play_replayer", tabKey: s.tabKey, localOffsetMs: localOffset });
    } else if (state.replayerReady.has(s.tabKey)) {
      effects.push({ type: "pause_replayer_at", tabKey: s.tabKey, localOffsetMs: localOffset });
    }
  }
  return effects;
}

function isStaleGeneration(state: ReplayState, generation: number): boolean {
  return generation !== state.generation;
}

/** Fields that only matter for imperative playback bookkeeping — the UI reads
 *  the current time via `getCurrentTimeMs()` / refs, never from React state.
 *  Dispatches that change nothing else can skip the React re-render. This is
 *  what keeps the 200ms TICK loop from re-rendering the whole page. */
const RENDER_IRRELEVANT_STATE_KEYS: ReadonlySet<keyof ReplayState> = new Set([
  "currentGlobalTimeMsForUi",
  "pausedAtGlobalMs",
  "playingWithoutProgressSinceMs",
  "suppressAutoFollowUntilWallMs",
  "prematureFinishRetryLocalMs",
  "lastMiniTabSyncWallMs",
] satisfies (keyof ReplayState)[]);

export function areStatesRenderEquivalent(a: ReplayState, b: ReplayState): boolean {
  if (a === b) return true;
  for (const key of Object.keys(a) as (keyof ReplayState)[]) {
    if (RENDER_IRRELEVANT_STATE_KEYS.has(key)) continue;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function replayReducer(state: ReplayState, action: ReplayAction): ReducerResult {
  switch (action.type) {
    case "SELECT_RECORDING": {
      const newState: ReplayState = {
        ...createInitialState(state.settings),
        generation: action.generation,
        phase: "downloading",
      };
      return {
        state: newState,
        effects: [{ type: "destroy_all_replayers" }],
      };
    }

    case "STREAMS_COMPUTED": {
      if (isStaleGeneration(state, action.generation)) return { state, effects: [] };
      const firstStream = action.streams[0] as StreamInfo | undefined;
      const initialActive = (
        action.streams.find(s => s.firstEventAtMs === action.globalStartTs)?.tabKey
        ?? firstStream?.tabKey
        ?? null
      );
      return {
        state: {
          ...state,
          streams: action.streams,
          globalStartTs: action.globalStartTs,
          globalTotalMs: action.globalTotalMs,
          chunkRangesByTab: action.chunkRangesByTab,
          tabLabelIndex: action.tabLabelIndex,
          activeTabKey: initialActive,
          pausedAtGlobalMs: 0,
          currentGlobalTimeMsForUi: 0,
        },
        effects: [],
      };
    }

    case "DOWNLOAD_COMPLETE": {
      if (isStaleGeneration(state, action.generation)) return { state, effects: [] };

      const effects: ReplayEffect[] = [];
      let newPlaybackMode: PlaybackMode = state.playbackMode === "buffering" ? "paused" : state.playbackMode;
      let newActiveTabKey = state.activeTabKey;

      // Safety net: if buffering when download finishes, try to resume
      if (state.bufferingAtGlobalMs !== null && state.autoResumeAfterBuffering) {
        const seekTo = state.bufferingAtGlobalMs;
        let resumeTabKey = state.activeTabKey;

        // Verify the active tab can actually play
        if (resumeTabKey && !state.replayerReady.has(resumeTabKey) && !state.hasFullSnapshotByTab.has(resumeTabKey)) {
          resumeTabKey = findBestTabAtGlobalOffset(state, seekTo);
        }

        if (resumeTabKey && (state.replayerReady.has(resumeTabKey) || state.hasFullSnapshotByTab.has(resumeTabKey))) {
          newPlaybackMode = "playing";
          newActiveTabKey = resumeTabKey;
          if (resumeTabKey !== state.activeTabKey) {
            effects.push({ type: "ensure_replayer", tabKey: resumeTabKey, generation: state.generation });
          }
          effects.push(...playEffectsForAllTabs({ ...state, playbackMode: "playing", activeTabKey: resumeTabKey }, seekTo));
        }
        // else: newPlaybackMode stays "paused" — no tab can play
      }

      return {
        state: {
          ...state,
          phase: "ready",
          activeTabKey: newActiveTabKey,
          playbackMode: newPlaybackMode,
          bufferingAtGlobalMs: null,
          autoResumeAfterBuffering: false,
        },
        effects,
      };
    }

    case "DOWNLOAD_ERROR": {
      if (isStaleGeneration(state, action.generation)) return { state, effects: [] };
      return {
        state: {
          ...state,
          phase: "ready",
          downloadError: action.message,
        },
        effects: [],
      };
    }

    case "CHUNK_LOADED": {
      if (isStaleGeneration(state, action.generation)) return { state, effects: [] };

      const newHasFullSnapshot = new Set(state.hasFullSnapshotByTab);
      if (action.hasFullSnapshot) {
        newHasFullSnapshot.add(action.tabKey);
      }

      const newLoadedDuration = new Map(state.loadedDurationByTabMs);
      newLoadedDuration.set(action.tabKey, action.loadedDurationMs);

      const newTabsWithEvents = new Set(state.tabsWithEvents);
      newTabsWithEvents.add(action.tabKey);

      const effects: ReplayEffect[] = [];

      // Ensure replayer for any tab that has a full snapshot but no ready replayer.
      // This covers first-chunk init, tabs that got a FullSnapshot in a later chunk,
      // and retry after a failed/pending init.  ensureReplayerForTab is idempotent.
      if (newHasFullSnapshot.has(action.tabKey) && !state.replayerReady.has(action.tabKey)) {
        effects.push({ type: "ensure_replayer", tabKey: action.tabKey, generation: action.generation });
      }

      // If the active tab has no FullSnapshot but this tab just got one, switch.
      // This ensures the component renders a container for the playable tab.
      let newActiveTabKey = state.activeTabKey;
      if (
        action.hasFullSnapshot
        && !state.hasFullSnapshotByTab.has(action.tabKey)
        && state.activeTabKey !== null
        && state.activeTabKey !== action.tabKey
        && !newHasFullSnapshot.has(state.activeTabKey)
      ) {
        newActiveTabKey = action.tabKey;
      }

      // Check if buffering can be resolved by new data
      let newPlaybackMode = state.playbackMode;
      let newBufferingAtGlobalMs = state.bufferingAtGlobalMs;
      let newAutoResumeAfterBuffering = state.autoResumeAfterBuffering;
      let newPausedAtGlobalMs = state.pausedAtGlobalMs;

      if (
        newActiveTabKey === action.tabKey
        && state.bufferingAtGlobalMs !== null
      ) {
        const stream = getStreamInfo(state, action.tabKey);
        if (stream) {
          const targetLocal = globalOffsetToLocalOffset(
            state.globalStartTs,
            stream.firstEventAtMs,
            state.bufferingAtGlobalMs,
          );
          const bufferAhead = state.phase === "downloading" ? 2000 : 0;
          if (action.loadedDurationMs >= targetLocal + bufferAhead) {
            const seekTo = state.bufferingAtGlobalMs;
            newBufferingAtGlobalMs = null;

            if (state.autoResumeAfterBuffering) {
              newAutoResumeAfterBuffering = false;
              newPlaybackMode = "playing";
              newPausedAtGlobalMs = seekTo;
              effects.push(...playEffectsForAllTabs(
                { ...state, playbackMode: "playing", activeTabKey: newActiveTabKey },
                seekTo,
              ));
            } else {
              newPlaybackMode = "paused";
            }
          }
        }
      }

      // Clear playerError when the active tab receives a FullSnapshot
      const clearPlayerError = action.hasFullSnapshot && action.tabKey === newActiveTabKey;

      return {
        state: {
          ...state,
          activeTabKey: newActiveTabKey,
          hasFullSnapshotByTab: newHasFullSnapshot,
          loadedDurationByTabMs: newLoadedDuration,
          tabsWithEvents: newTabsWithEvents,
          playbackMode: newPlaybackMode,
          bufferingAtGlobalMs: newBufferingAtGlobalMs,
          autoResumeAfterBuffering: newAutoResumeAfterBuffering,
          pausedAtGlobalMs: newPausedAtGlobalMs,
          ...(clearPlayerError ? { playerError: null } : {}),
        },
        effects,
      };
    }

    case "REPLAYER_READY": {
      if (isStaleGeneration(state, action.generation)) return { state, effects: [] };

      const newReplayerReady = new Set(state.replayerReady);
      newReplayerReady.add(action.tabKey);

      const isActiveTab = state.activeTabKey === action.tabKey;

      // Auto-play fallback: if auto-play hasn't triggered yet and the active
      // tab is stuck (no full snapshot → replayer can never be created), switch
      // the active tab to this newly-ready tab so auto-play can proceed.
      const activeTabStuck = !isActiveTab
        && !state.autoPlayTriggered
        && state.activeTabKey !== null
        && !state.hasFullSnapshotByTab.has(state.activeTabKey);
      const effectiveIsActiveTab = isActiveTab || activeTabStuck;

      const shouldAutoPlay = !state.autoPlayTriggered && effectiveIsActiveTab;
      const shouldPlay = effectiveIsActiveTab && (shouldAutoPlay || (state.playbackMode === "playing"));

      const newActiveTabKey = activeTabStuck ? action.tabKey : state.activeTabKey;

      const effects: ReplayEffect[] = [];
      const stream = getStreamInfo(state, action.tabKey);
      const streamStartTs = stream?.firstEventAtMs ?? state.globalStartTs;
      const targetGlobalMs = activeTabStuck
        ? localOffsetToGlobalOffset(state.globalStartTs, streamStartTs, 0)
        : state.pausedAtGlobalMs;
      const desiredLocal = globalOffsetToLocalOffset(state.globalStartTs, streamStartTs, targetGlobalMs);

      if (shouldPlay) {
        effects.push({ type: "play_replayer", tabKey: action.tabKey, localOffsetMs: desiredLocal });
      } else {
        effects.push({ type: "pause_replayer_at", tabKey: action.tabKey, localOffsetMs: desiredLocal });
      }

      return {
        state: {
          ...state,
          activeTabKey: newActiveTabKey,
          replayerReady: newReplayerReady,
          autoPlayTriggered: state.autoPlayTriggered || shouldAutoPlay,
          playbackMode: shouldAutoPlay && state.playbackMode !== "buffering"
            ? "playing"
            : state.playbackMode,
          pausedAtGlobalMs: activeTabStuck ? targetGlobalMs : state.pausedAtGlobalMs,
          playingWithoutProgressSinceMs: null,
        },
        effects,
      };
    }

    case "REPLAYER_INIT_ERROR": {
      if (isStaleGeneration(state, action.generation)) return { state, effects: [] };
      return {
        state: { ...state, playerError: action.message },
        effects: [],
      };
    }

    case "REPLAYER_FINISH": {
      if (isStaleGeneration(state, action.generation)) return { state, effects: [] };
      if (state.activeTabKey !== action.tabKey) return { state, effects: [] };

      const localTime = action.localTimeMs;
      const loadedDurationMs = state.loadedDurationByTabMs.get(action.tabKey) ?? 0;

      // Premature finish: rrweb fires "finish" but more data was added via addEvent.
      // Guard: if we already retried at this same position, rrweb's addEvent didn't
      // extend the playable range.  Recreate the replayer with all loaded events
      // instead of looping infinitely.
      if (loadedDurationMs > localTime + 100) {
        const isRepeatedAtSamePosition =
          state.prematureFinishRetryLocalMs !== null
          && Math.abs(state.prematureFinishRetryLocalMs - localTime) < 200;

        if (isRepeatedAtSamePosition) {
          // Loop detected — recreate the rrweb Replayer with all loaded events.
          const newReplayerReady = new Set(state.replayerReady);
          newReplayerReady.delete(action.tabKey);
          return {
            state: {
              ...state,
              replayerReady: newReplayerReady,
              prematureFinishRetryLocalMs: null,
              playingWithoutProgressSinceMs: null,
            },
            effects: [{ type: "recreate_replayer", tabKey: action.tabKey, generation: action.generation }],
          };
        }

        return {
          state: { ...state, prematureFinishRetryLocalMs: localTime, playingWithoutProgressSinceMs: null },
          effects: [{ type: "play_replayer", tabKey: action.tabKey, localOffsetMs: localTime }],
        };
      }

      const stream = getStreamInfo(state, action.tabKey);
      const streamStartTs = stream?.firstEventAtMs ?? state.globalStartTs;
      const tabExpectedDurationMs = stream
        ? stream.lastEventAtMs - stream.firstEventAtMs
        : null;

      // Buffer if still downloading and tab expects more events
      if (
        state.phase === "downloading"
        && tabExpectedDurationMs !== null
        && tabExpectedDurationMs > localTime + 500
      ) {
        const globalOffset = localOffsetToGlobalOffset(state.globalStartTs, streamStartTs, localTime);
        return {
          state: {
            ...state,
            playbackMode: "buffering",
            pausedAtGlobalMs: globalOffset,
            bufferingAtGlobalMs: globalOffset,
            autoResumeAfterBuffering: true,
            playingWithoutProgressSinceMs: null,
          },
          effects: [
            { type: "schedule_buffer_poll", generation: action.generation, tabKey: action.tabKey, localTimeMs: localTime, delayMs: 500 },
          ],
        };
      }

      let globalOffset = localOffsetToGlobalOffset(state.globalStartTs, streamStartTs, localTime);

      // Find the best OTHER tab at this offset
      let bestKey = findBestTabAtGlobalOffset(state, globalOffset, action.tabKey);

      // Retry with authoritative time if stale
      if (!bestKey && globalOffset + 500 < state.currentGlobalTimeMsForUi) {
        globalOffset = state.currentGlobalTimeMsForUi;
        bestKey = findBestTabAtGlobalOffset(state, globalOffset, action.tabKey);
      }

      // Another tab has events — switch
      if (bestKey) {
        const effects: ReplayEffect[] = [
          { type: "ensure_replayer", tabKey: bestKey, generation: action.generation },
          ...playEffectsForAllTabs(
            { ...state, activeTabKey: bestKey },
            globalOffset,
          ),
        ];
        return {
          state: {
            ...state,
            activeTabKey: bestKey,
            playbackMode: "playing",
            pausedAtGlobalMs: globalOffset,
            bufferingAtGlobalMs: null,
            autoResumeAfterBuffering: false,
            suppressAutoFollowUntilWallMs: action.nowMs + 400,
            playingWithoutProgressSinceMs: null,
          },
          effects,
        };
      }

      // No alternative tab — gap, buffer, or true finish
      const currentTabHasMoreExpectedEvents = tabExpectedDurationMs !== null
        && tabExpectedDurationMs > localTime + 500;

      const nextStart = findNextTabStartAfterGlobalOffset(state, globalOffset);
      const finishAction = getReplayFinishAction({
        hasBestTabAtCurrentTime: false,
        isDownloading: state.phase === "downloading",
        nextStartGlobalOffsetMs: nextStart?.globalOffsetMs ?? null,
        currentGlobalOffsetMs: Math.max(globalOffset, state.currentGlobalTimeMsForUi),
        currentTabHasMoreExpectedEvents,
      });

      if (finishAction.type === "gap_fast_forward" && nextStart) {
        const gff: GapFastForward = {
          fromGlobalMs: globalOffset,
          toGlobalMs: finishAction.toGlobalMs,
          wallMs: action.nowMs,
          nextTabKey: nextStart.tabKey,
          gen: action.generation,
        };
        return {
          state: {
            ...state,
            playbackMode: "gap_fast_forward",
            gapFastForward: gff,
            pausedAtGlobalMs: globalOffset,
            playingWithoutProgressSinceMs: null,
          },
          effects: [],
        };
      }

      if (finishAction.type === "buffer_at_current") {
        return {
          state: {
            ...state,
            playbackMode: "buffering",
            pausedAtGlobalMs: globalOffset,
            bufferingAtGlobalMs: globalOffset,
            autoResumeAfterBuffering: true,
            playingWithoutProgressSinceMs: null,
          },
          effects: [],
        };
      }

      // True finish
      return {
        state: {
          ...state,
          playbackMode: "finished",
          pausedAtGlobalMs: state.globalTotalMs,
          currentGlobalTimeMsForUi: state.globalTotalMs,
          gapFastForward: null,
          bufferingAtGlobalMs: null,
          playingWithoutProgressSinceMs: null,
        },
        effects: [{ type: "pause_all" }],
      };
    }

    case "TOGGLE_PLAY_PAUSE": {
      const isPlaying = state.playbackMode === "playing" || state.playbackMode === "gap_fast_forward";
      const isBuffering = state.playbackMode === "buffering";

      if (isPlaying || isBuffering) {
        // Pause
        return {
          state: {
            ...state,
            playbackMode: "paused",
            pausedAtGlobalMs: state.currentGlobalTimeMsForUi,
            gapFastForward: null,
            bufferingAtGlobalMs: null,
            autoResumeAfterBuffering: false,
            playingWithoutProgressSinceMs: null,
            playerError: null,
          },
          effects: [{ type: "pause_all" }],
        };
      }

      // Play
      let target = state.pausedAtGlobalMs;
      let playActiveTabKey = state.activeTabKey;

      // If active tab has no replayer and can't get one, switch to a tab that can play
      if (playActiveTabKey && !state.replayerReady.has(playActiveTabKey) && !state.hasFullSnapshotByTab.has(playActiveTabKey)) {
        const altTab = findBestTabAtGlobalOffset(state, target);
        if (altTab) {
          playActiveTabKey = altTab;
        } else {
          // Find any ready tab at its start time
          for (const s of state.streams) {
            if (state.replayerReady.has(s.tabKey)) {
              playActiveTabKey = s.tabKey;
              target = localOffsetToGlobalOffset(state.globalStartTs, s.firstEventAtMs, 0);
              break;
            }
          }
        }
      }

      // Guard: if no tab can play, either buffer (still downloading) or error
      if (
        !playActiveTabKey
        || (!state.replayerReady.has(playActiveTabKey) && !state.hasFullSnapshotByTab.has(playActiveTabKey))
      ) {
        if (state.phase === "downloading" && playActiveTabKey) {
          // Data may still arrive — enter buffering mode
          const bufferStream = getStreamInfo(state, playActiveTabKey);
          const bufferLocalMs = bufferStream ? globalOffsetToLocalOffset(state.globalStartTs, bufferStream.firstEventAtMs, target) : 0;
          return {
            state: {
              ...state,
              activeTabKey: playActiveTabKey,
              pausedAtGlobalMs: target,
              playbackMode: "buffering",
              bufferingAtGlobalMs: target,
              autoResumeAfterBuffering: true,
              playingWithoutProgressSinceMs: null,
              playerError: null,
            },
            effects: [
              { type: "schedule_buffer_poll", generation: state.generation, tabKey: playActiveTabKey, localTimeMs: bufferLocalMs, delayMs: 500 },
            ],
          };
        }
        return {
          state: {
            ...state,
            playbackMode: "paused",
            playerError: state.streams.some((stream) => state.hasFullSnapshotByTab.has(stream.tabKey))
              ? "Unable to play: recording data may be incomplete. Try reloading."
              : "Unable to play: this recording contains no full page snapshot, so its incremental updates cannot be reconstructed.",
            playingWithoutProgressSinceMs: null,
          },
          effects: [],
        };
      }

      // Check if active tab needs buffering
      if (state.phase === "downloading" && playActiveTabKey) {
        const stream = getStreamInfo(state, playActiveTabKey);
        if (stream) {
          const localTarget = globalOffsetToLocalOffset(state.globalStartTs, stream.firstEventAtMs, target);
          const loaded = state.loadedDurationByTabMs.get(playActiveTabKey) ?? 0;
          if (localTarget > loaded) {
            return {
              state: {
                ...state,
                activeTabKey: playActiveTabKey,
                pausedAtGlobalMs: target,
                playbackMode: "buffering",
                bufferingAtGlobalMs: target,
                autoResumeAfterBuffering: true,
                playingWithoutProgressSinceMs: null,
                playerError: null,
              },
              effects: [
                { type: "schedule_buffer_poll", generation: state.generation, tabKey: playActiveTabKey, localTimeMs: localTarget, delayMs: 500 },
              ],
            };
          }
        }
      }

      const stateForPlay = { ...state, activeTabKey: playActiveTabKey };
      return {
        state: {
          ...stateForPlay,
          playbackMode: "playing",
          pausedAtGlobalMs: target,
          bufferingAtGlobalMs: null,
          gapFastForward: null,
          suppressAutoFollowUntilWallMs: action.nowMs + 400,
          playingWithoutProgressSinceMs: null,
          playerError: null,
        },
        effects: playEffectsForAllTabs(stateForPlay, target),
      };
    }

    case "SEEK": {
      const seekState = applySeekState({ seekToGlobalMs: action.globalOffsetMs });
      let newActiveTabKey = state.activeTabKey;
      const effects: ReplayEffect[] = [];

      // Switch tab if seek target is outside active tab's range
      const desiredKey = findBestTabAtGlobalOffset(state, action.globalOffsetMs);
      if (desiredKey && desiredKey !== state.activeTabKey) {
        newActiveTabKey = desiredKey;
        effects.push({ type: "ensure_replayer", tabKey: desiredKey, generation: state.generation });
      }

      const stateWithNewTab = { ...state, activeTabKey: newActiveTabKey };

      // Check if buffering needed
      if (state.phase === "downloading" && newActiveTabKey) {
        const stream = getStreamInfo(state, newActiveTabKey);
        if (stream) {
          const localTarget = globalOffsetToLocalOffset(state.globalStartTs, stream.firstEventAtMs, action.globalOffsetMs);
          const loaded = state.loadedDurationByTabMs.get(newActiveTabKey) ?? 0;
          if (localTarget > loaded) {
            effects.push({ type: "pause_all" });
            return {
              state: {
                ...stateWithNewTab,
                playbackMode: "buffering",
                pausedAtGlobalMs: seekState.pausedAtGlobalMs,
                gapFastForward: null,
                bufferingAtGlobalMs: action.globalOffsetMs,
                autoResumeAfterBuffering: true,
                prematureFinishRetryLocalMs: null,
                playingWithoutProgressSinceMs: null,
                // Reset the throttle here too so mini tabs re-sync on the first
                // TICK after buffering resumes rather than waiting out the interval.
                lastMiniTabSyncWallMs: action.nowMs - MINI_TAB_SYNC_INTERVAL_MS,
                playerError: null,
              },
              effects,
            };
          }
        }
      }

      effects.push(...playEffectsForAllTabs(stateWithNewTab, action.globalOffsetMs));

      return {
        state: {
          ...stateWithNewTab,
          playbackMode: "playing",
          pausedAtGlobalMs: seekState.pausedAtGlobalMs,
          gapFastForward: null,
          bufferingAtGlobalMs: null,
          autoResumeAfterBuffering: false,
          currentGlobalTimeMsForUi: action.globalOffsetMs,
          suppressAutoFollowUntilWallMs: action.nowMs + 400,
          prematureFinishRetryLocalMs: null,
          playingWithoutProgressSinceMs: null,
          // Reset the throttle so the next TICK re-syncs mini tabs to the new
          // position regardless of page age (0 would still throttle during the
          // first MINI_TAB_SYNC_INTERVAL_MS after page load).
          lastMiniTabSyncWallMs: action.nowMs - MINI_TAB_SYNC_INTERVAL_MS,
          playerError: null,
        },
        effects,
      };
    }

    case "SELECT_TAB": {
      const effects: ReplayEffect[] = [{ type: "pause_all" }];
      const wasPlaying = state.playbackMode === "playing" || state.playbackMode === "gap_fast_forward";

      // Check if buffering needed for the new tab
      if (state.phase === "downloading") {
        const stream = getStreamInfo(state, action.tabKey);
        if (stream) {
          const localTarget = globalOffsetToLocalOffset(state.globalStartTs, stream.firstEventAtMs, state.pausedAtGlobalMs);
          const loaded = state.loadedDurationByTabMs.get(action.tabKey) ?? 0;
          if (localTarget > loaded) {
            effects.push({ type: "ensure_replayer", tabKey: action.tabKey, generation: state.generation });
            return {
              state: {
                ...state,
                activeTabKey: action.tabKey,
                playbackMode: "buffering",
                gapFastForward: null,
                bufferingAtGlobalMs: state.pausedAtGlobalMs,
                autoResumeAfterBuffering: true,
                suppressAutoFollowUntilWallMs: action.nowMs + 5000,
                prematureFinishRetryLocalMs: null,
                playingWithoutProgressSinceMs: null,
                playerError: null,
              },
              effects,
            };
          }
        }
      }

      effects.push({ type: "ensure_replayer", tabKey: action.tabKey, generation: state.generation });

      if (wasPlaying) {
        effects.push(...playEffectsForAllTabs({ ...state, activeTabKey: action.tabKey }, state.pausedAtGlobalMs));
      }

      return {
        state: {
          ...state,
          activeTabKey: action.tabKey,
          playbackMode: wasPlaying ? "playing" : "paused",
          gapFastForward: null,
          bufferingAtGlobalMs: null,
          autoResumeAfterBuffering: false,
          suppressAutoFollowUntilWallMs: action.nowMs + 5000,
          prematureFinishRetryLocalMs: null,
          playingWithoutProgressSinceMs: null,
          playerError: null,
        },
        effects,
      };
    }

    case "UPDATE_SPEED": {
      if (!ALLOWED_PLAYER_SPEEDS.has(action.speed)) return { state, effects: [] };
      const newSettings = { ...state.settings, playerSpeed: action.speed };
      return {
        state: { ...state, settings: newSettings },
        effects: [
          { type: "set_replayer_speed", speed: action.speed },
          { type: "save_settings", settings: newSettings },
        ],
      };
    }

    case "UPDATE_SETTINGS": {
      const newSettings = { ...state.settings, ...action.updates };
      const effects: ReplayEffect[] = [
        { type: "save_settings", settings: newSettings },
      ];

      if (action.updates.skipInactivity !== undefined) {
        effects.push({ type: "set_replayer_skip_inactive", skipInactive: action.updates.skipInactivity });
      }

      return {
        state: { ...state, settings: newSettings },
        effects,
      };
    }

    case "TICK": {
      let globalOffset = computeDesiredGlobalOffset(state, action.nowMs, action.activeReplayerLocalTimeMs);
      const previousGlobalOffset = state.currentGlobalTimeMsForUi;
      const effects: ReplayEffect[] = [];

      // Monotonicity guard: during playing, don't let stale rrweb readings jump back
      if (
        state.playbackMode === "playing"
        && !state.gapFastForward
        && action.nowMs >= state.suppressAutoFollowUntilWallMs
        && globalOffset + 500 < previousGlobalOffset
      ) {
        globalOffset = previousGlobalOffset;
      }

      let newState = { ...state, currentGlobalTimeMsForUi: globalOffset };

      // Sync mini tabs (throttled — a mini-tab sync is a full rrweb seek)
      if (
        state.playbackMode === "playing"
        && action.nowMs - state.lastMiniTabSyncWallMs >= MINI_TAB_SYNC_INTERVAL_MS
      ) {
        newState = { ...newState, lastMiniTabSyncWallMs: action.nowMs };
        effects.push({ type: "sync_mini_tabs", globalOffsetMs: globalOffset });
      }

      // Gap fast-forward completion
      const gff = state.gapFastForward;
      if (gff && globalOffset >= gff.toGlobalMs) {
        newState = {
          ...newState,
          gapFastForward: null,
          activeTabKey: gff.nextTabKey,
          playbackMode: "playing",
          pausedAtGlobalMs: gff.toGlobalMs,
          currentGlobalTimeMsForUi: gff.toGlobalMs,
          bufferingAtGlobalMs: null,
          autoResumeAfterBuffering: false,
          suppressAutoFollowUntilWallMs: action.nowMs + 200,
        };
        effects.push(
          { type: "ensure_replayer", tabKey: gff.nextTabKey, generation: gff.gen },
          ...playEffectsForAllTabs(newState, gff.toGlobalMs),
        );
        return { state: newState, effects };
      }

      // Auto-follow active tab
      if (
        state.settings.followActiveTab
        && state.playbackMode === "playing"
        && state.streams.length > 1
      ) {
        if (action.nowMs >= state.suppressAutoFollowUntilWallMs) {
          const activeInRange = state.activeTabKey
            ? isTabInRangeAtGlobalOffset(state, state.activeTabKey, globalOffset)
            : false;
          if (!activeInRange) {
            const bestKey = findBestTabAtGlobalOffset(state, globalOffset);
            if (bestKey && bestKey !== state.activeTabKey) {
              newState = {
                ...newState,
                activeTabKey: bestKey,
                pausedAtGlobalMs: globalOffset,
                suppressAutoFollowUntilWallMs: action.nowMs + 200,
              };
              effects.push(
                { type: "ensure_replayer", tabKey: bestKey, generation: state.generation },
                ...playEffectsForAllTabs(newState, globalOffset),
              );
            }
          }
        }
      }

      // ----- Stall detection -----
      // Track when the player is in "playing" mode but the replayer hasn't
      // reported any progress (activeReplayerLocalTimeMs is null).
      if (newState.playbackMode === "playing" && action.activeReplayerLocalTimeMs !== null) {
        // Replayer is responding — clear tracker
        newState = { ...newState, playingWithoutProgressSinceMs: null };
      } else if (newState.playbackMode !== "playing") {
        // Not playing — clear tracker
        newState = { ...newState, playingWithoutProgressSinceMs: null };
      } else if (action.activeReplayerLocalTimeMs === null) {
        if (newState.playingWithoutProgressSinceMs === null) {
          // Start timing the stall
          newState = { ...newState, playingWithoutProgressSinceMs: action.nowMs };
        } else if (action.nowMs - newState.playingWithoutProgressSinceMs >= STALL_THRESHOLD_MS) {
          // Stall detected — attempt recovery
          const stallGlobalOffset = newState.pausedAtGlobalMs;

          // Strategy A: Switch to another tab that IS ready
          const altTab = findBestTabAtGlobalOffset(newState, stallGlobalOffset, newState.activeTabKey ?? undefined);
          if (altTab && newState.replayerReady.has(altTab)) {
            newState = {
              ...newState,
              activeTabKey: altTab,
              playingWithoutProgressSinceMs: null,
              suppressAutoFollowUntilWallMs: action.nowMs + 400,
            };
            effects.push(
              ...playEffectsForAllTabs(newState, stallGlobalOffset),
            );
            return { state: newState, effects };
          }

          // Strategy B: Active tab IS in replayerReady (but broken) — recreate
          const activeKeyB = newState.activeTabKey;
          if (activeKeyB && newState.replayerReady.has(activeKeyB)) {
            const newReplayerReady = new Set(newState.replayerReady);
            newReplayerReady.delete(activeKeyB);
            newState = {
              ...newState,
              replayerReady: newReplayerReady,
              playingWithoutProgressSinceMs: null,
            };
            effects.push({ type: "recreate_replayer", tabKey: activeKeyB, generation: newState.generation });
            return { state: newState, effects };
          }

          // Strategy C: Tab has full snapshot but no replayer — ensure it
          const activeKeyC = newState.activeTabKey;
          if (activeKeyC && newState.hasFullSnapshotByTab.has(activeKeyC)) {
            newState = { ...newState, playingWithoutProgressSinceMs: null };
            effects.push({ type: "ensure_replayer", tabKey: activeKeyC, generation: newState.generation });
            return { state: newState, effects };
          }

          // Strategy D: Switch to ANY ready tab (even at a different offset)
          for (const s of newState.streams) {
            if (s.tabKey === newState.activeTabKey) continue;
            if (!newState.replayerReady.has(s.tabKey)) continue;
            const altGlobalMs = localOffsetToGlobalOffset(newState.globalStartTs, s.firstEventAtMs, 0);
            newState = {
              ...newState,
              activeTabKey: s.tabKey,
              pausedAtGlobalMs: altGlobalMs,
              currentGlobalTimeMsForUi: altGlobalMs,
              playingWithoutProgressSinceMs: null,
              suppressAutoFollowUntilWallMs: action.nowMs + 400,
            };
            effects.push(...playEffectsForAllTabs(newState, altGlobalMs));
            return { state: newState, effects };
          }

          // Strategy E: Nothing works
          if (state.phase === "downloading") {
            // Still downloading — enter buffering, FullSnapshot may arrive
            newState = {
              ...newState,
              playbackMode: "buffering",
              bufferingAtGlobalMs: stallGlobalOffset,
              autoResumeAfterBuffering: true,
              playingWithoutProgressSinceMs: null,
            };
            effects.push({ type: "pause_all" });
            return { state: newState, effects };
          }
          newState = {
            ...newState,
            playbackMode: "paused",
            playingWithoutProgressSinceMs: null,
            playerError: "Playback stalled: unable to recover. Try seeking or switching tabs.",
          };
          effects.push({ type: "pause_all" });
          return { state: newState, effects };
        }
      }

      return { state: newState, effects };
    }

    case "BUFFER_CHECK": {
      if (isStaleGeneration(state, action.generation)) return { state, effects: [] };
      if (state.activeTabKey !== action.tabKey) return { state, effects: [] };
      if (state.playbackMode !== "buffering") return { state, effects: [] };
      if (state.bufferingAtGlobalMs === null) return { state, effects: [] };

      const stream = getStreamInfo(state, action.tabKey);
      if (!stream) return { state, effects: [] };

      const localTarget = globalOffsetToLocalOffset(state.globalStartTs, stream.firstEventAtMs, state.bufferingAtGlobalMs);
      const loaded = state.loadedDurationByTabMs.get(action.tabKey) ?? 0;

      if (loaded > localTarget + 2000 || state.phase !== "downloading") {
        const seekTo = state.bufferingAtGlobalMs;

        // Verify the active tab can actually play before resuming
        if (!state.replayerReady.has(action.tabKey) && !state.hasFullSnapshotByTab.has(action.tabKey)) {
          const altTab = findBestTabAtGlobalOffset(state, seekTo);
          if (altTab) {
            return {
              state: {
                ...state,
                activeTabKey: altTab,
                playbackMode: "playing",
                bufferingAtGlobalMs: null,
                autoResumeAfterBuffering: false,
              },
              effects: [
                { type: "ensure_replayer", tabKey: altTab, generation: action.generation },
                ...playEffectsForAllTabs({ ...state, activeTabKey: altTab }, seekTo),
              ],
            };
          }
          // No tab can play — fall back to paused
          return {
            state: {
              ...state,
              playbackMode: "paused",
              bufferingAtGlobalMs: null,
              autoResumeAfterBuffering: false,
            },
            effects: [{ type: "pause_all" }],
          };
        }

        return {
          state: {
            ...state,
            playbackMode: "playing",
            bufferingAtGlobalMs: null,
            autoResumeAfterBuffering: false,
          },
          effects: playEffectsForAllTabs(state, seekTo),
        };
      }

      // Still buffering — schedule another poll
      return {
        state,
        effects: [
          { type: "schedule_buffer_poll", generation: action.generation, tabKey: action.tabKey, localTimeMs: localTarget, delayMs: 500 },
        ],
      };
    }

    case "RESET": {
      return {
        state: createInitialState(state.settings),
        effects: [{ type: "destroy_all_replayers" }],
      };
    }

    default: {
      return { state, effects: [] };
    }
  }
}

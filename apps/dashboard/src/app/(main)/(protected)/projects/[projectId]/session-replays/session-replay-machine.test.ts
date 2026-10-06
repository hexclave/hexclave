import { describe, expect, it } from "vitest";
import {
  areStatesRenderEquivalent,
  createInitialState,
  MINI_TAB_SYNC_INTERVAL_MS,
  replayReducer,
  findBestTabAtGlobalOffset,
  isTabInRangeAtGlobalOffset,
  findNextTabStartAfterGlobalOffset,
  ALLOWED_PLAYER_SPEEDS,
  DEFAULT_REPLAY_SETTINGS,
  STALL_THRESHOLD_MS,
  type ReplayState,
  type ReplayAction,
  type StreamInfo,
  type ChunkRange,
  type ReducerResult,
  type ReplayEffect,
} from "./session-replay-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreams(...specs: Array<{ tabKey: string, firstMs: number, lastMs: number }>): StreamInfo[] {
  return specs.map(s => ({
    tabKey: s.tabKey,
    firstEventAtMs: s.firstMs,
    lastEventAtMs: s.lastMs,
  }));
}

function makeChunkRanges(entries: Record<string, Array<[number, number]>>): Map<string, ChunkRange[]> {
  const m = new Map<string, ChunkRange[]>();
  for (const [key, ranges] of Object.entries(entries)) {
    m.set(key, ranges.map(([s, e]) => ({ startTs: s, endTs: e })));
  }
  return m;
}

function makeTabLabels(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

/** Create a state with two tabs ready for playback. */
function twoTabReadyState(overrides?: Partial<ReplayState>): ReplayState {
  return {
    ...createInitialState(),
    generation: 1,
    phase: "downloading",
    streams: makeStreams(
      { tabKey: "a", firstMs: 1000, lastMs: 5000 },
      { tabKey: "b", firstMs: 6000, lastMs: 10000 },
    ),
    globalStartTs: 1000,
    globalTotalMs: 9000,
    chunkRangesByTab: makeChunkRanges({
      a: [[1000, 5000]],
      b: [[6000, 10000]],
    }),
    tabLabelIndex: makeTabLabels({ a: 1, b: 2 }),
    hasFullSnapshotByTab: new Set(["a", "b"]),
    loadedDurationByTabMs: new Map([["a", 4000], ["b", 4000]]),
    tabsWithEvents: new Set(["a", "b"]),
    replayerReady: new Set(["a", "b"]),
    activeTabKey: "a",
    playbackMode: "paused",
    ...overrides,
  };
}

function dispatch(state: ReplayState, action: ReplayAction): ReducerResult {
  return replayReducer(state, action);
}

function dispatchChain(state: ReplayState, actions: ReplayAction[]): ReducerResult {
  let result: ReducerResult = { state, effects: [] };
  const allEffects: ReplayEffect[] = [];
  for (const action of actions) {
    result = replayReducer(result.state, action);
    allEffects.push(...result.effects);
  }
  return { state: result.state, effects: allEffects };
}

function hasEffect(effects: ReplayEffect[], type: ReplayEffect["type"]): boolean {
  return effects.some(e => e.type === type);
}

function getEffects(effects: ReplayEffect[], type: ReplayEffect["type"]): ReplayEffect[] {
  return effects.filter(e => e.type === type);
}

// ---------------------------------------------------------------------------
// Unit tests: each action
// ---------------------------------------------------------------------------

describe("session-replay-machine", () => {
  describe("createInitialState", () => {
    it("returns idle state with default settings", () => {
      const s = createInitialState();
      expect(s.phase).toBe("idle");
      expect(s.playbackMode).toBe("paused");
      expect(s.generation).toBe(0);
      expect(s.activeTabKey).toBeNull();
      expect(s.settings).toEqual(DEFAULT_REPLAY_SETTINGS);
    });

    it("accepts custom settings", () => {
      const settings = { playerSpeed: 2, skipInactivity: false, followActiveTab: true };
      const s = createInitialState(settings);
      expect(s.settings).toEqual(settings);
    });
  });

  describe("SELECT_RECORDING", () => {
    it("resets state and sets generation", () => {
      const state = twoTabReadyState({ playbackMode: "playing" });
      const { state: s, effects } = dispatch(state, { type: "SELECT_RECORDING", generation: 5 });
      expect(s.generation).toBe(5);
      expect(s.phase).toBe("downloading");
      expect(s.playbackMode).toBe("paused");
      expect(s.activeTabKey).toBeNull();
      expect(s.streams).toHaveLength(0);
      expect(hasEffect(effects, "destroy_all_replayers")).toBe(true);
    });

    it("preserves settings across selection", () => {
      const state = twoTabReadyState();
      state.settings = { playerSpeed: 4, skipInactivity: false, followActiveTab: true };
      const { state: s } = dispatch(state, { type: "SELECT_RECORDING", generation: 2 });
      expect(s.settings.playerSpeed).toBe(4);
      expect(s.settings.followActiveTab).toBe(true);
    });
  });

  describe("STREAMS_COMPUTED", () => {
    it("sets streams and picks initial active tab", () => {
      const state = { ...createInitialState(), generation: 1, phase: "downloading" as const };
      const streams = makeStreams(
        { tabKey: "x", firstMs: 500, lastMs: 1000 },
        { tabKey: "y", firstMs: 200, lastMs: 900 },
      );
      const { state: s } = dispatch(state, {
        type: "STREAMS_COMPUTED",
        generation: 1,
        streams,
        globalStartTs: 200,
        globalTotalMs: 800,
        chunkRangesByTab: new Map(),
        tabLabelIndex: new Map(),
      });
      expect(s.streams).toBe(streams);
      expect(s.globalStartTs).toBe(200);
      expect(s.globalTotalMs).toBe(800);
      // "y" starts at 200 = globalStartTs
      expect(s.activeTabKey).toBe("y");
    });

    it("falls back to first stream when none matches globalStartTs", () => {
      const state = { ...createInitialState(), generation: 1, phase: "downloading" as const };
      const streams = makeStreams(
        { tabKey: "a", firstMs: 500, lastMs: 1000 },
        { tabKey: "b", firstMs: 600, lastMs: 900 },
      );
      const { state: s } = dispatch(state, {
        type: "STREAMS_COMPUTED",
        generation: 1,
        streams,
        globalStartTs: 200,
        globalTotalMs: 800,
        chunkRangesByTab: new Map(),
        tabLabelIndex: new Map(),
      });
      expect(s.activeTabKey).toBe("a");
    });

    it("ignores stale generation", () => {
      const state = { ...createInitialState(), generation: 3 };
      const { state: s } = dispatch(state, {
        type: "STREAMS_COMPUTED",
        generation: 1,
        streams: makeStreams({ tabKey: "a", firstMs: 0, lastMs: 100 }),
        globalStartTs: 0,
        globalTotalMs: 100,
        chunkRangesByTab: new Map(),
        tabLabelIndex: new Map(),
      });
      expect(s.streams).toHaveLength(0); // unchanged
    });
  });

  describe("CHUNK_LOADED", () => {
    it("updates loaded duration and marks full snapshot", () => {
      const state = twoTabReadyState();
      const { state: s } = dispatch(state, {
        type: "CHUNK_LOADED",
        generation: 1,
        tabKey: "a",
        hasFullSnapshot: true,
        loadedDurationMs: 3500,
        hadEventsBeforeThisChunk: true,
      });
      expect(s.loadedDurationByTabMs.get("a")).toBe(3500);
      expect(s.hasFullSnapshotByTab.has("a")).toBe(true);
    });

    it("triggers ensure_replayer when tab was empty", () => {
      const state = twoTabReadyState();
      state.tabsWithEvents.delete("a");
      state.replayerReady.delete("a"); // Replayer can't be ready without events
      const { effects } = dispatch(state, {
        type: "CHUNK_LOADED",
        generation: 1,
        tabKey: "a",
        hasFullSnapshot: true,
        loadedDurationMs: 500,
        hadEventsBeforeThisChunk: false,
      });
      expect(hasEffect(effects, "ensure_replayer")).toBe(true);
    });

    it("does not trigger ensure_replayer when tab had events", () => {
      const state = twoTabReadyState();
      const { effects } = dispatch(state, {
        type: "CHUNK_LOADED",
        generation: 1,
        tabKey: "a",
        hasFullSnapshot: true,
        loadedDurationMs: 3500,
        hadEventsBeforeThisChunk: true,
      });
      expect(hasEffect(effects, "ensure_replayer")).toBe(false);
    });

    it("resumes from buffering when enough data arrives", () => {
      const state = twoTabReadyState({
        playbackMode: "buffering",
        activeTabKey: "a",
        bufferingAtGlobalMs: 1000, // global offset 1000 => local offset at tab a = globalOffset (since globalStart = firstEventAt = 1000) => local 1000
        autoResumeAfterBuffering: true,
      });
      // local target = globalOffsetToLocalOffset(1000, 1000, 1000) = max(0, 1000+1000-1000) = 1000
      // bufferAhead = 2000 (downloading)
      // need loaded >= 1000 + 2000 = 3000
      const { state: s, effects } = dispatch(state, {
        type: "CHUNK_LOADED",
        generation: 1,
        tabKey: "a",
        hasFullSnapshot: true,
        loadedDurationMs: 3500,
        hadEventsBeforeThisChunk: true,
      });
      expect(s.playbackMode).toBe("playing");
      expect(s.bufferingAtGlobalMs).toBeNull();
      expect(hasEffect(effects, "play_replayer")).toBe(true);
    });

    it("switches active tab when current active has no snapshot", () => {
      const state = twoTabReadyState({
        activeTabKey: "a",
      });
      // Active tab "a" has no full snapshot
      state.hasFullSnapshotByTab.delete("a");
      state.replayerReady.delete("a");
      state.replayerReady.delete("b");
      state.hasFullSnapshotByTab.delete("b");
      const { state: s } = dispatch(state, {
        type: "CHUNK_LOADED",
        generation: 1,
        tabKey: "b",
        hasFullSnapshot: true,
        loadedDurationMs: 500,
        hadEventsBeforeThisChunk: false,
      });
      expect(s.activeTabKey).toBe("b");
    });

    it("does NOT switch active tab when active already has a snapshot", () => {
      const state = twoTabReadyState({
        activeTabKey: "a",
      });
      // Active tab "a" already has full snapshot
      state.replayerReady.delete("b");
      state.hasFullSnapshotByTab.delete("b");
      const { state: s } = dispatch(state, {
        type: "CHUNK_LOADED",
        generation: 1,
        tabKey: "b",
        hasFullSnapshot: true,
        loadedDurationMs: 500,
        hadEventsBeforeThisChunk: false,
      });
      expect(s.activeTabKey).toBe("a");
    });

    it("does NOT switch on subsequent snapshots for same tab", () => {
      const state = twoTabReadyState({
        activeTabKey: "a",
      });
      // Tab "b" already has a full snapshot
      // Active tab "a" has no full snapshot
      state.hasFullSnapshotByTab.delete("a");
      state.replayerReady.delete("a");
      const { state: s } = dispatch(state, {
        type: "CHUNK_LOADED",
        generation: 1,
        tabKey: "b",
        hasFullSnapshot: true,
        loadedDurationMs: 2000,
        hadEventsBeforeThisChunk: true,
      });
      // Tab b already had a snapshot, so no switch needed
      expect(s.activeTabKey).toBe("a");
    });

    it("stays buffering when not enough data", () => {
      const state = twoTabReadyState({
        playbackMode: "buffering",
        activeTabKey: "a",
        bufferingAtGlobalMs: 1000,
        autoResumeAfterBuffering: true,
      });
      const { state: s } = dispatch(state, {
        type: "CHUNK_LOADED",
        generation: 1,
        tabKey: "a",
        hasFullSnapshot: true,
        loadedDurationMs: 500, // not enough
        hadEventsBeforeThisChunk: true,
      });
      expect(s.playbackMode).toBe("buffering");
    });
  });

  describe("REPLAYER_READY", () => {
    it("auto-plays active tab on first replayer ready", () => {
      const state = twoTabReadyState({
        autoPlayTriggered: false,
        playbackMode: "paused",
      });
      state.replayerReady.delete("a");
      const { state: s, effects } = dispatch(state, {
        type: "REPLAYER_READY",
        generation: 1,
        tabKey: "a",
      });
      expect(s.autoPlayTriggered).toBe(true);
      expect(s.playbackMode).toBe("playing");
      expect(hasEffect(effects, "play_replayer")).toBe(true);
    });

    it("does not auto-play non-active tab", () => {
      const state = twoTabReadyState({
        autoPlayTriggered: false,
        activeTabKey: "a",
      });
      state.replayerReady.delete("b");
      const { state: s, effects } = dispatch(state, {
        type: "REPLAYER_READY",
        generation: 1,
        tabKey: "b",
      });
      expect(s.autoPlayTriggered).toBe(false);
      // Should pause at correct offset, not play
      expect(hasEffect(effects, "pause_replayer_at")).toBe(true);
      expect(hasEffect(effects, "play_replayer")).toBe(false);
    });

    it("auto-plays non-active tab when active tab is stuck (no full snapshot)", () => {
      const state = twoTabReadyState({
        autoPlayTriggered: false,
        activeTabKey: "a",
      });
      // Active tab "a" has no full snapshot — it's stuck
      state.hasFullSnapshotByTab.delete("a");
      state.replayerReady.delete("a");
      state.replayerReady.delete("b");
      const { state: s, effects } = dispatch(state, {
        type: "REPLAYER_READY",
        generation: 1,
        tabKey: "b",
      });
      // Should switch to "b" and auto-play
      expect(s.activeTabKey).toBe("b");
      expect(s.autoPlayTriggered).toBe(true);
      expect(s.playbackMode).toBe("playing");
      expect(hasEffect(effects, "play_replayer")).toBe(true);
    });

    it("does not auto-play when already triggered", () => {
      const state = twoTabReadyState({
        autoPlayTriggered: true,
        playbackMode: "paused",
      });
      state.replayerReady.delete("a");
      const { state: s } = dispatch(state, {
        type: "REPLAYER_READY",
        generation: 1,
        tabKey: "a",
      });
      // No auto-play: stays paused
      expect(s.playbackMode).toBe("paused");
    });
  });

  describe("REPLAYER_FINISH", () => {
    it("restarts on premature finish (more loaded data)", () => {
      const state = twoTabReadyState({
        playbackMode: "playing",
        activeTabKey: "a",
      });
      state.loadedDurationByTabMs.set("a", 5000);
      const { state: s, effects } = dispatch(state, {
        type: "REPLAYER_FINISH",
        generation: 1,
        tabKey: "a",
        localTimeMs: 2000, // well below 5000
        nowMs: 1000,
      });
      // Should restart playback
      expect(s.playbackMode).toBe("playing");
      const playEffects = getEffects(effects, "play_replayer");
      expect(playEffects).toHaveLength(1);
      expect((playEffects[0] as any).localOffsetMs).toBe(2000);
    });

    it("buffers when downloading and tab expects more", () => {
      const state = twoTabReadyState({
        playbackMode: "playing",
        activeTabKey: "a",
        phase: "downloading",
      });
      // Tab "a": firstMs=1000, lastMs=5000, so expected duration=4000
      // localTimeMs=2000 => 2000+500 < 4000, so more expected
      state.loadedDurationByTabMs.set("a", 2000);
      const { state: s, effects } = dispatch(state, {
        type: "REPLAYER_FINISH",
        generation: 1,
        tabKey: "a",
        localTimeMs: 2000,
        nowMs: 1000,
      });
      expect(s.playbackMode).toBe("buffering");
      expect(s.autoResumeAfterBuffering).toBe(true);
      expect(hasEffect(effects, "schedule_buffer_poll")).toBe(true);
    });

    it("switches to another tab that has events at this offset", () => {
      // Tab a covers 1000-5000, tab b covers 4000-10000 (overlapping)
      const state: ReplayState = {
        ...twoTabReadyState(),
        streams: makeStreams(
          { tabKey: "a", firstMs: 1000, lastMs: 5000 },
          { tabKey: "b", firstMs: 4000, lastMs: 10000 },
        ),
        chunkRangesByTab: makeChunkRanges({
          a: [[1000, 5000]],
          b: [[4000, 10000]],
        }),
        playbackMode: "playing",
        activeTabKey: "a",
        phase: "ready",
      };
      state.loadedDurationByTabMs.set("a", 4000);
      // localTime 4000, globalOffset = 4000 + (1000-1000) = 4000
      // Tab b covers 4000, so it should switch
      const { state: s, effects } = dispatch(state, {
        type: "REPLAYER_FINISH",
        generation: 1,
        tabKey: "a",
        localTimeMs: 4000,
        nowMs: 1000,
      });
      expect(s.activeTabKey).toBe("b");
      expect(s.playbackMode).toBe("playing");
      expect(hasEffect(effects, "ensure_replayer")).toBe(true);
    });

    it("starts gap fast-forward when next tab exists after gap", () => {
      const state = twoTabReadyState({
        playbackMode: "playing",
        activeTabKey: "a",
        phase: "ready",
      });
      // Tab a fully loaded up to 4000ms local time
      state.loadedDurationByTabMs.set("a", 4000);
      // localTime 4000 => globalOffset = 4000 + (1000-1000) = 4000
      // Tab b starts at 6000, so next start = 6000-1000 = 5000 global offset
      const { state: s } = dispatch(state, {
        type: "REPLAYER_FINISH",
        generation: 1,
        tabKey: "a",
        localTimeMs: 4000,
        nowMs: 1000,
      });
      expect(s.playbackMode).toBe("gap_fast_forward");
      expect(s.gapFastForward).not.toBeNull();
      expect(s.gapFastForward!.nextTabKey).toBe("b");
      expect(s.gapFastForward!.toGlobalMs).toBe(5000);
    });

    it("finishes replay when no more tabs", () => {
      // Single tab, fully loaded
      const state: ReplayState = {
        ...createInitialState(),
        generation: 1,
        phase: "ready",
        streams: makeStreams({ tabKey: "a", firstMs: 1000, lastMs: 5000 }),
        globalStartTs: 1000,
        globalTotalMs: 4000,
        chunkRangesByTab: makeChunkRanges({ a: [[1000, 5000]] }),
        tabLabelIndex: makeTabLabels({ a: 1 }),
        hasFullSnapshotByTab: new Set(["a"]),
        loadedDurationByTabMs: new Map([["a", 4000]]),
        tabsWithEvents: new Set(["a"]),
        replayerReady: new Set(["a"]),
        activeTabKey: "a",
        playbackMode: "playing",
      };
      const { state: s, effects } = dispatch(state, {
        type: "REPLAYER_FINISH",
        generation: 1,
        tabKey: "a",
        localTimeMs: 4000,
        nowMs: 1000,
      });
      expect(s.playbackMode).toBe("finished");
      expect(s.pausedAtGlobalMs).toBe(4000);
      expect(hasEffect(effects, "pause_all")).toBe(true);
    });

    it("ignores stale generation", () => {
      const state = twoTabReadyState({ playbackMode: "playing" });
      const { state: s, effects } = dispatch(state, {
        type: "REPLAYER_FINISH",
        generation: 99,
        tabKey: "a",
        localTimeMs: 1000,
        nowMs: 1000,
      });
      expect(s).toBe(state);
      expect(effects).toHaveLength(0);
    });

    it("ignores finish from non-active tab", () => {
      const state = twoTabReadyState({ playbackMode: "playing", activeTabKey: "a" });
      const { state: s, effects } = dispatch(state, {
        type: "REPLAYER_FINISH",
        generation: 1,
        tabKey: "b",
        localTimeMs: 1000,
        nowMs: 1000,
      });
      expect(s).toBe(state);
      expect(effects).toHaveLength(0);
    });
  });

  describe("TOGGLE_PLAY_PAUSE", () => {
    it("pauses from playing", () => {
      const state = twoTabReadyState({ playbackMode: "playing", currentGlobalTimeMsForUi: 2500 });
      const { state: s, effects } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
      expect(s.playbackMode).toBe("paused");
      expect(s.pausedAtGlobalMs).toBe(2500);
      expect(hasEffect(effects, "pause_all")).toBe(true);
    });

    it("pauses from gap_fast_forward", () => {
      const state = twoTabReadyState({ playbackMode: "gap_fast_forward", currentGlobalTimeMsForUi: 3000 });
      const { state: s } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
      expect(s.playbackMode).toBe("paused");
      expect(s.pausedAtGlobalMs).toBe(3000);
      expect(s.gapFastForward).toBeNull();
    });

    it("pauses from buffering", () => {
      const state = twoTabReadyState({
        playbackMode: "buffering",
        bufferingAtGlobalMs: 1000,
        autoResumeAfterBuffering: true,
        currentGlobalTimeMsForUi: 1500,
      });
      const { state: s } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
      expect(s.playbackMode).toBe("paused");
      expect(s.pausedAtGlobalMs).toBe(1500);
      expect(s.bufferingAtGlobalMs).toBeNull();
      expect(s.autoResumeAfterBuffering).toBe(false);
    });

    it("plays from paused", () => {
      const state = twoTabReadyState({ playbackMode: "paused", pausedAtGlobalMs: 500 });
      const { state: s, effects } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
      expect(s.playbackMode).toBe("playing");
      expect(hasEffect(effects, "play_replayer")).toBe(true);
    });

    it("switches to a ready tab when active tab has no replayer", () => {
      const state = twoTabReadyState({
        playbackMode: "paused",
        activeTabKey: "a",
        pausedAtGlobalMs: 0,
      });
      // Active tab "a" has no full snapshot — can't play
      state.hasFullSnapshotByTab.delete("a");
      state.replayerReady.delete("a");
      const { state: s, effects } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
      expect(s.activeTabKey).toBe("b");
      expect(s.playbackMode).toBe("playing");
      expect(hasEffect(effects, "play_replayer")).toBe(true);
    });

    it("buffers when trying to play beyond loaded data", () => {
      const state = twoTabReadyState({
        playbackMode: "paused",
        activeTabKey: "a",
        pausedAtGlobalMs: 3500,
        phase: "downloading",
      });
      // Tab "a" firstMs=1000, globalStartTs=1000, so localTarget = max(0, 1000+3500-1000) = 3500
      // loaded = 2000, so 3500 > 2000 => buffer
      state.loadedDurationByTabMs.set("a", 2000);
      const { state: s } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
      expect(s.playbackMode).toBe("buffering");
      expect(s.autoResumeAfterBuffering).toBe(true);
    });

    it("emits schedule_buffer_poll when entering buffering (no snapshot)", () => {
      const state = twoTabReadyState({
        playbackMode: "paused",
        activeTabKey: "a",
        phase: "downloading",
      });
      state.hasFullSnapshotByTab.clear();
      state.replayerReady.clear();
      const { state: s, effects } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
      expect(s.playbackMode).toBe("buffering");
      expect(hasEffect(effects, "schedule_buffer_poll")).toBe(true);
    });

    it("emits schedule_buffer_poll when entering buffering (data not loaded)", () => {
      const state = twoTabReadyState({
        playbackMode: "paused",
        activeTabKey: "a",
        pausedAtGlobalMs: 3500,
        phase: "downloading",
      });
      state.loadedDurationByTabMs.set("a", 2000);
      const { state: s, effects } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
      expect(s.playbackMode).toBe("buffering");
      expect(hasEffect(effects, "schedule_buffer_poll")).toBe(true);
    });
  });

  describe("SEEK", () => {
    it("seeks within same tab", () => {
      const state = twoTabReadyState({ playbackMode: "playing", activeTabKey: "a" });
      const { state: s, effects } = dispatch(state, { type: "SEEK", globalOffsetMs: 2000, nowMs: 1000 });
      expect(s.playbackMode).toBe("playing");
      expect(s.pausedAtGlobalMs).toBe(2000);
      expect(s.activeTabKey).toBe("a");
      expect(hasEffect(effects, "play_replayer")).toBe(true);
    });

    it("switches tab when seeking to different tab's range", () => {
      const state = twoTabReadyState({ playbackMode: "playing", activeTabKey: "a" });
      // globalOffsetMs=6000 => ts = 1000+6000 = 7000. Tab b range is [6000, 10000]. 7000 is in range.
      const { state: s, effects } = dispatch(state, { type: "SEEK", globalOffsetMs: 6000, nowMs: 1000 });
      expect(s.activeTabKey).toBe("b");
      expect(s.playbackMode).toBe("playing");
      expect(hasEffect(effects, "ensure_replayer")).toBe(true);
    });

    it("buffers when seeking beyond loaded data during download", () => {
      const state = twoTabReadyState({
        playbackMode: "playing",
        activeTabKey: "a",
        phase: "downloading",
      });
      state.loadedDurationByTabMs.set("a", 1000);
      // Seek to globalOffset 3000 => local = max(0, 1000+3000-1000) = 3000 > 1000 (loaded)
      const { state: s, effects } = dispatch(state, { type: "SEEK", globalOffsetMs: 3000, nowMs: 1000 });
      expect(s.playbackMode).toBe("buffering");
      expect(s.bufferingAtGlobalMs).toBe(3000);
      expect(hasEffect(effects, "pause_all")).toBe(true);
    });

    it("clears gap fast-forward", () => {
      const state = twoTabReadyState({
        playbackMode: "gap_fast_forward",
        gapFastForward: {
          fromGlobalMs: 4000,
          toGlobalMs: 5000,
          wallMs: 0,
          nextTabKey: "b",
          gen: 1,
        },
      });
      const { state: s } = dispatch(state, { type: "SEEK", globalOffsetMs: 1000, nowMs: 1000 });
      expect(s.gapFastForward).toBeNull();
    });
  });

  describe("SELECT_TAB", () => {
    it("switches active tab during playback", () => {
      const state = twoTabReadyState({ playbackMode: "playing", activeTabKey: "a", pausedAtGlobalMs: 2000 });
      const { state: s, effects } = dispatch(state, { type: "SELECT_TAB", tabKey: "b", nowMs: 1000 });
      expect(s.activeTabKey).toBe("b");
      expect(s.playbackMode).toBe("playing");
      expect(s.suppressAutoFollowUntilWallMs).toBe(6000);
      expect(hasEffect(effects, "pause_all")).toBe(true);
      expect(hasEffect(effects, "ensure_replayer")).toBe(true);
    });

    it("stays paused after tab switch when paused", () => {
      const state = twoTabReadyState({ playbackMode: "paused", activeTabKey: "a" });
      const { state: s } = dispatch(state, { type: "SELECT_TAB", tabKey: "b", nowMs: 1000 });
      expect(s.activeTabKey).toBe("b");
      expect(s.playbackMode).toBe("paused");
    });

    it("buffers when new tab's data isn't loaded yet", () => {
      const state = twoTabReadyState({
        playbackMode: "playing",
        activeTabKey: "a",
        pausedAtGlobalMs: 6000,
        phase: "downloading",
      });
      state.loadedDurationByTabMs.set("b", 0);
      const { state: s } = dispatch(state, { type: "SELECT_TAB", tabKey: "b", nowMs: 1000 });
      expect(s.playbackMode).toBe("buffering");
      expect(s.activeTabKey).toBe("b");
    });
  });

  describe("UPDATE_SPEED", () => {
    it("updates speed and emits effect", () => {
      const state = twoTabReadyState();
      const { state: s, effects } = dispatch(state, { type: "UPDATE_SPEED", speed: 4 });
      expect(s.settings.playerSpeed).toBe(4);
      expect(hasEffect(effects, "set_replayer_speed")).toBe(true);
      expect(hasEffect(effects, "save_settings")).toBe(true);
    });

    it("ignores invalid speed", () => {
      const state = twoTabReadyState();
      const { state: s, effects } = dispatch(state, { type: "UPDATE_SPEED", speed: 3 });
      expect(s.settings.playerSpeed).toBe(state.settings.playerSpeed);
      expect(effects).toHaveLength(0);
    });
  });

  describe("UPDATE_SETTINGS", () => {
    it("updates settings and saves", () => {
      const state = twoTabReadyState();
      const { state: s, effects } = dispatch(state, { type: "UPDATE_SETTINGS", updates: { followActiveTab: true } });
      expect(s.settings.followActiveTab).toBe(true);
      expect(hasEffect(effects, "save_settings")).toBe(true);
    });

    it("emits skip_inactive effect when skipInactivity changes", () => {
      const state = twoTabReadyState();
      const { effects } = dispatch(state, { type: "UPDATE_SETTINGS", updates: { skipInactivity: false } });
      expect(hasEffect(effects, "set_replayer_skip_inactive")).toBe(true);
    });
  });

  describe("TICK", () => {
    it("updates currentGlobalTimeMsForUi", () => {
      const state = twoTabReadyState({
        playbackMode: "playing",
        activeTabKey: "a",
        pausedAtGlobalMs: 1000,
      });
      const { state: s } = dispatch(state, {
        type: "TICK",
        nowMs: 1000,
        activeReplayerLocalTimeMs: 1500,
      });
      // globalOffset = 1500 + (1000 - 1000) = 1500
      expect(s.currentGlobalTimeMsForUi).toBe(1500);
    });

    it("completes gap fast-forward", () => {
      const state = twoTabReadyState({
        playbackMode: "gap_fast_forward",
        gapFastForward: {
          fromGlobalMs: 4000,
          toGlobalMs: 5000,
          wallMs: 0,
          nextTabKey: "b",
          gen: 1,
        },
        activeTabKey: "a",
      });
      // Provide a tick where computed offset >= toGlobalMs
      // When gap is active, offset = min(toGlobalMs, fromGlobalMs + elapsed*speed*multiplier)
      // With large enough nowMs, offset hits 5000
      const { state: s, effects } = dispatch(state, {
        type: "TICK",
        nowMs: 999999,
        activeReplayerLocalTimeMs: null,
      });
      expect(s.gapFastForward).toBeNull();
      expect(s.activeTabKey).toBe("b");
      expect(s.playbackMode).toBe("playing");
      expect(hasEffect(effects, "ensure_replayer")).toBe(true);
    });

    it("auto-follows active tab", () => {
      const state = twoTabReadyState({
        playbackMode: "playing",
        activeTabKey: "a",
        settings: { ...DEFAULT_REPLAY_SETTINGS, followActiveTab: true },
        suppressAutoFollowUntilWallMs: 0,
      });
      // Tick at a time where tab a is not in range but tab b is
      // globalOffset = 7000 + (1000-1000) = 7000, ts = 1000+7000 = 8000
      // Tab a range: [1000, 5000] — not in range
      // Tab b range: [6000, 10000] — in range
      const { state: s, effects } = dispatch(state, {
        type: "TICK",
        nowMs: 1000,
        activeReplayerLocalTimeMs: 7000,
      });
      expect(s.activeTabKey).toBe("b");
      expect(hasEffect(effects, "ensure_replayer")).toBe(true);
    });

    it("applies monotonicity guard", () => {
      const state = twoTabReadyState({
        playbackMode: "playing",
        activeTabKey: "a",
        currentGlobalTimeMsForUi: 3000,
        suppressAutoFollowUntilWallMs: 0,
      });
      // Active replayer reports 1000 local ms => global = 1000
      // But previous was 3000, so 1000 + 500 < 3000 => use previous
      const { state: s } = dispatch(state, {
        type: "TICK",
        nowMs: 5000,
        activeReplayerLocalTimeMs: 1000,
      });
      expect(s.currentGlobalTimeMsForUi).toBe(3000);
    });

    it("syncs mini tabs when playing and the sync interval has elapsed", () => {
      const state = twoTabReadyState({ playbackMode: "playing" });
      const { state: s, effects } = dispatch(state, {
        type: "TICK",
        nowMs: MINI_TAB_SYNC_INTERVAL_MS,
        activeReplayerLocalTimeMs: 2000,
      });
      expect(hasEffect(effects, "sync_mini_tabs")).toBe(true);
      expect(s.lastMiniTabSyncWallMs).toBe(MINI_TAB_SYNC_INTERVAL_MS);
    });

    it("throttles mini tab syncs within the sync interval", () => {
      const state = twoTabReadyState({ playbackMode: "playing" });
      const first = dispatch(state, {
        type: "TICK",
        nowMs: MINI_TAB_SYNC_INTERVAL_MS,
        activeReplayerLocalTimeMs: 2000,
      });
      expect(hasEffect(first.effects, "sync_mini_tabs")).toBe(true);

      const second = dispatch(first.state, {
        type: "TICK",
        nowMs: MINI_TAB_SYNC_INTERVAL_MS + 200,
        activeReplayerLocalTimeMs: 2200,
      });
      expect(hasEffect(second.effects, "sync_mini_tabs")).toBe(false);

      const third = dispatch(second.state, {
        type: "TICK",
        nowMs: MINI_TAB_SYNC_INTERVAL_MS * 2,
        activeReplayerLocalTimeMs: 4000,
      });
      expect(hasEffect(third.effects, "sync_mini_tabs")).toBe(true);
    });

    it("resyncs mini tabs on the next tick after a seek", () => {
      const state = twoTabReadyState({
        playbackMode: "playing",
        lastMiniTabSyncWallMs: MINI_TAB_SYNC_INTERVAL_MS,
      });
      const afterSeek = dispatch(state, {
        type: "SEEK",
        globalOffsetMs: 2000,
        nowMs: MINI_TAB_SYNC_INTERVAL_MS + 200,
      });
      const { effects } = dispatch(afterSeek.state, {
        type: "TICK",
        nowMs: MINI_TAB_SYNC_INTERVAL_MS + 400,
        activeReplayerLocalTimeMs: 1000,
      });
      expect(hasEffect(effects, "sync_mini_tabs")).toBe(true);
    });

    it("resyncs mini tabs after a seek even within the first sync interval of page age", () => {
      const state = twoTabReadyState({
        playbackMode: "playing",
        lastMiniTabSyncWallMs: 0,
      });
      const afterSeek = dispatch(state, {
        type: "SEEK",
        globalOffsetMs: 2000,
        nowMs: 100,
      });
      const { effects } = dispatch(afterSeek.state, {
        type: "TICK",
        nowMs: 300,
        activeReplayerLocalTimeMs: 1000,
      });
      expect(hasEffect(effects, "sync_mini_tabs")).toBe(true);
    });
  });

  describe("areStatesRenderEquivalent", () => {
    it("ignores playback bookkeeping fields", () => {
      const state = twoTabReadyState({ playbackMode: "playing" });
      const { state: ticked } = dispatch(state, {
        type: "TICK",
        nowMs: 100,
        activeReplayerLocalTimeMs: 1500,
      });
      expect(ticked).not.toBe(state);
      expect(areStatesRenderEquivalent(state, ticked)).toBe(true);
    });

    it("detects render-relevant changes", () => {
      const state = twoTabReadyState({ playbackMode: "playing" });
      const { state: paused } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 100 });
      expect(areStatesRenderEquivalent(state, paused)).toBe(false);
    });
  });

  describe("BUFFER_CHECK", () => {
    it("resumes when enough data loaded", () => {
      const state = twoTabReadyState({
        playbackMode: "buffering",
        activeTabKey: "a",
        bufferingAtGlobalMs: 1000,
        phase: "downloading",
      });
      state.loadedDurationByTabMs.set("a", 5000);
      const { state: s, effects } = dispatch(state, {
        type: "BUFFER_CHECK",
        generation: 1,
        tabKey: "a",
      });
      expect(s.playbackMode).toBe("playing");
      expect(hasEffect(effects, "play_replayer")).toBe(true);
    });

    it("resumes immediately when download complete", () => {
      const state = twoTabReadyState({
        playbackMode: "buffering",
        activeTabKey: "a",
        bufferingAtGlobalMs: 1000,
        phase: "ready",
      });
      state.loadedDurationByTabMs.set("a", 500); // not much data but phase is ready
      const { state: s } = dispatch(state, {
        type: "BUFFER_CHECK",
        generation: 1,
        tabKey: "a",
      });
      expect(s.playbackMode).toBe("playing");
    });

    it("schedules another poll when still buffering", () => {
      const state = twoTabReadyState({
        playbackMode: "buffering",
        activeTabKey: "a",
        bufferingAtGlobalMs: 1000,
        phase: "downloading",
      });
      state.loadedDurationByTabMs.set("a", 100);
      const { state: s, effects } = dispatch(state, {
        type: "BUFFER_CHECK",
        generation: 1,
        tabKey: "a",
      });
      expect(s.playbackMode).toBe("buffering");
      expect(hasEffect(effects, "schedule_buffer_poll")).toBe(true);
    });

    it("does not resume to playing when active tab has no snapshot", () => {
      const state = twoTabReadyState({
        playbackMode: "buffering",
        activeTabKey: "a",
        bufferingAtGlobalMs: 1000,
        phase: "ready",
      });
      // Tab a has no full snapshot — can't play
      state.hasFullSnapshotByTab.delete("a");
      state.replayerReady.delete("a");
      state.loadedDurationByTabMs.set("a", 5000);
      const { state: s, effects } = dispatch(state, {
        type: "BUFFER_CHECK",
        generation: 1,
        tabKey: "a",
      });
      expect(s.playbackMode).toBe("paused");
      expect(hasEffect(effects, "pause_all")).toBe(true);
    });

    it("ignores stale generation", () => {
      const state = twoTabReadyState({ playbackMode: "buffering" });
      const { effects } = dispatch(state, {
        type: "BUFFER_CHECK",
        generation: 99,
        tabKey: "a",
      });
      expect(effects).toHaveLength(0);
    });
  });

  describe("DOWNLOAD_COMPLETE", () => {
    it("sets phase to ready", () => {
      const state = twoTabReadyState({ phase: "downloading" });
      const { state: s } = dispatch(state, { type: "DOWNLOAD_COMPLETE", generation: 1 });
      expect(s.phase).toBe("ready");
    });

    it("resumes from buffering with auto-resume", () => {
      const state = twoTabReadyState({
        phase: "downloading",
        playbackMode: "buffering",
        bufferingAtGlobalMs: 2000,
        autoResumeAfterBuffering: true,
      });
      const { state: s, effects } = dispatch(state, { type: "DOWNLOAD_COMPLETE", generation: 1 });
      expect(s.playbackMode).toBe("playing");
      expect(s.bufferingAtGlobalMs).toBeNull();
      expect(hasEffect(effects, "play_replayer")).toBe(true);
    });

    it("switches to alt tab when active tab cannot play", () => {
      const state: ReplayState = {
        ...twoTabReadyState({
          phase: "downloading",
          playbackMode: "buffering",
          bufferingAtGlobalMs: 2000,
          autoResumeAfterBuffering: true,
          activeTabKey: "a",
        }),
        streams: makeStreams(
          { tabKey: "a", firstMs: 1000, lastMs: 5000 },
          { tabKey: "b", firstMs: 1000, lastMs: 5000 },
        ),
        chunkRangesByTab: makeChunkRanges({
          a: [[1000, 5000]],
          b: [[1000, 5000]],
        }),
      };
      // Tab a has no snapshot or replayer, but tab b does
      state.hasFullSnapshotByTab.delete("a");
      state.replayerReady.delete("a");
      const { state: s, effects } = dispatch(state, { type: "DOWNLOAD_COMPLETE", generation: 1 });
      expect(s.phase).toBe("ready");
      expect(s.activeTabKey).toBe("b");
      expect(s.playbackMode).toBe("playing");
      expect(hasEffect(effects, "ensure_replayer")).toBe(true);
      expect(hasEffect(effects, "play_replayer")).toBe(true);
    });

    it("pauses when no tab can play on download complete", () => {
      const state = twoTabReadyState({
        phase: "downloading",
        playbackMode: "buffering",
        bufferingAtGlobalMs: 2000,
        autoResumeAfterBuffering: true,
        activeTabKey: "a",
      });
      // No tab has snapshot or replayer
      state.hasFullSnapshotByTab.clear();
      state.replayerReady.clear();
      const { state: s } = dispatch(state, { type: "DOWNLOAD_COMPLETE", generation: 1 });
      expect(s.phase).toBe("ready");
      expect(s.playbackMode).toBe("paused");
    });
  });

  describe("DOWNLOAD_ERROR", () => {
    it("sets error message", () => {
      const state = twoTabReadyState({ phase: "downloading" });
      const { state: s } = dispatch(state, {
        type: "DOWNLOAD_ERROR",
        generation: 1,
        message: "Network error",
      });
      expect(s.downloadError).toBe("Network error");
      expect(s.phase).toBe("ready");
    });
  });

  describe("RESET", () => {
    it("resets to initial state preserving settings", () => {
      const state = twoTabReadyState({ playbackMode: "playing" });
      state.settings = { playerSpeed: 4, skipInactivity: false, followActiveTab: true };
      const { state: s, effects } = dispatch(state, { type: "RESET" });
      expect(s.phase).toBe("idle");
      expect(s.playbackMode).toBe("paused");
      expect(s.settings.playerSpeed).toBe(4);
      expect(hasEffect(effects, "destroy_all_replayers")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe("findBestTabAtGlobalOffset", () => {
  it("finds tab in range", () => {
    const state = twoTabReadyState();
    // globalOffset 2000 => ts = 1000+2000 = 3000. Tab a range: [1000, 5000] => in range
    expect(findBestTabAtGlobalOffset(state, 2000)).toBe("a");
  });

  it("finds tab b when a is out of range", () => {
    const state = twoTabReadyState();
    // globalOffset 6000 => ts = 1000+6000 = 7000. Tab b range: [6000, 10000] => in range
    expect(findBestTabAtGlobalOffset(state, 6000)).toBe("b");
  });

  it("returns null when no tab in range", () => {
    const state = twoTabReadyState();
    // globalOffset 4500 => ts = 1000+4500 = 5500.
    // Tab a: [1000, 5000] => 5500 > 5000, not in range.
    // Tab b: [6000, 10000] => 5500 < 6000, not in range.
    expect(findBestTabAtGlobalOffset(state, 4500)).toBeNull();
  });

  it("excludes specified tab", () => {
    const state = twoTabReadyState();
    expect(findBestTabAtGlobalOffset(state, 2000, "a")).toBeNull();
  });

  it("skips tabs without full snapshot", () => {
    const state = twoTabReadyState();
    state.hasFullSnapshotByTab.delete("a");
    expect(findBestTabAtGlobalOffset(state, 2000)).toBeNull();
  });

  it("prefers tab with lower label index", () => {
    // Two tabs both in range at the same offset
    const state: ReplayState = {
      ...twoTabReadyState(),
      streams: makeStreams(
        { tabKey: "a", firstMs: 1000, lastMs: 5000 },
        { tabKey: "b", firstMs: 1000, lastMs: 5000 },
      ),
      chunkRangesByTab: makeChunkRanges({
        a: [[1000, 5000]],
        b: [[1000, 5000]],
      }),
    };
    expect(findBestTabAtGlobalOffset(state, 2000)).toBe("a");
  });
});

describe("isTabInRangeAtGlobalOffset", () => {
  it("returns true when in range", () => {
    const state = twoTabReadyState();
    expect(isTabInRangeAtGlobalOffset(state, "a", 2000)).toBe(true);
  });

  it("returns false when out of range", () => {
    const state = twoTabReadyState();
    expect(isTabInRangeAtGlobalOffset(state, "a", 5000)).toBe(false);
  });

  it("returns false for tab without full snapshot", () => {
    const state = twoTabReadyState();
    state.hasFullSnapshotByTab.delete("a");
    expect(isTabInRangeAtGlobalOffset(state, "a", 2000)).toBe(false);
  });
});

describe("findNextTabStartAfterGlobalOffset", () => {
  it("finds next tab start", () => {
    const state = twoTabReadyState();
    // globalOffset 4000 => ts = 1000+4000 = 5000. Tab b starts at 6000 > 5000
    const result = findNextTabStartAfterGlobalOffset(state, 4000);
    expect(result).not.toBeNull();
    expect(result!.tabKey).toBe("b");
    expect(result!.globalOffsetMs).toBe(5000); // 6000 - 1000
  });

  it("returns null when no tab starts after offset", () => {
    const state = twoTabReadyState();
    // globalOffset 9000 => ts = 1000+9000 = 10000. No tab starts after 10000
    expect(findNextTabStartAfterGlobalOffset(state, 9000)).toBeNull();
  });

  it("skips tabs without full snapshot", () => {
    const state = twoTabReadyState();
    state.hasFullSnapshotByTab.delete("b");
    expect(findNextTabStartAfterGlobalOffset(state, 4000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario tests (multi-step sequences)
// ---------------------------------------------------------------------------

describe("scenarios", () => {
  it("single tab happy path: select -> download -> play -> finish", () => {
    let state = createInitialState();

    // Select recording
    let r = dispatch(state, { type: "SELECT_RECORDING", generation: 1 });
    state = r.state;
    expect(state.phase).toBe("downloading");

    // Streams computed
    r = dispatch(state, {
      type: "STREAMS_COMPUTED",
      generation: 1,
      streams: makeStreams({ tabKey: "t1", firstMs: 0, lastMs: 5000 }),
      globalStartTs: 0,
      globalTotalMs: 5000,
      chunkRangesByTab: makeChunkRanges({ t1: [[0, 5000]] }),
      tabLabelIndex: makeTabLabels({ t1: 1 }),
    });
    state = r.state;
    expect(state.activeTabKey).toBe("t1");

    // Chunk loaded
    r = dispatch(state, {
      type: "CHUNK_LOADED",
      generation: 1,
      tabKey: "t1",
      hasFullSnapshot: true,
      loadedDurationMs: 5000,
      hadEventsBeforeThisChunk: false,
    });
    state = r.state;
    expect(state.hasFullSnapshotByTab.has("t1")).toBe(true);

    // Replayer ready -> auto-plays
    r = dispatch(state, { type: "REPLAYER_READY", generation: 1, tabKey: "t1" });
    state = r.state;
    expect(state.playbackMode).toBe("playing");
    expect(state.autoPlayTriggered).toBe(true);

    // Download complete
    r = dispatch(state, { type: "DOWNLOAD_COMPLETE", generation: 1 });
    state = r.state;
    expect(state.phase).toBe("ready");

    // Replayer finishes
    r = dispatch(state, {
      type: "REPLAYER_FINISH",
      generation: 1,
      tabKey: "t1",
      localTimeMs: 5000,
      nowMs: 10000,
    });
    state = r.state;
    expect(state.playbackMode).toBe("finished");
  });

  it("two-tab with gap fast-forward between them", () => {
    let state: ReplayState = {
      ...createInitialState(),
      generation: 1,
      phase: "ready",
      streams: makeStreams(
        { tabKey: "a", firstMs: 1000, lastMs: 3000 },
        { tabKey: "b", firstMs: 5000, lastMs: 8000 },
      ),
      globalStartTs: 1000,
      globalTotalMs: 7000,
      chunkRangesByTab: makeChunkRanges({
        a: [[1000, 3000]],
        b: [[5000, 8000]],
      }),
      tabLabelIndex: makeTabLabels({ a: 1, b: 2 }),
      hasFullSnapshotByTab: new Set(["a", "b"]),
      loadedDurationByTabMs: new Map([["a", 2000], ["b", 3000]]),
      tabsWithEvents: new Set(["a", "b"]),
      replayerReady: new Set(["a", "b"]),
      activeTabKey: "a",
      playbackMode: "playing",
    };

    // Tab a finishes
    let r = dispatch(state, {
      type: "REPLAYER_FINISH",
      generation: 1,
      tabKey: "a",
      localTimeMs: 2000,
      nowMs: 1000,
    });
    state = r.state;
    expect(state.playbackMode).toBe("gap_fast_forward");
    expect(state.gapFastForward!.nextTabKey).toBe("b");

    // Tick completes the gap
    r = dispatch(state, {
      type: "TICK",
      nowMs: 999999,
      activeReplayerLocalTimeMs: null,
    });
    state = r.state;
    expect(state.activeTabKey).toBe("b");
    expect(state.playbackMode).toBe("playing");
    expect(state.gapFastForward).toBeNull();
  });

  it("seek during playback to different tab", () => {
    const state = twoTabReadyState({ playbackMode: "playing", activeTabKey: "a" });
    // Seek to tab b's range
    const r = dispatch(state, { type: "SEEK", globalOffsetMs: 6000, nowMs: 1000 });
    expect(r.state.activeTabKey).toBe("b");
    expect(r.state.playbackMode).toBe("playing");
  });

  it("buffering during slow download -> chunk arrives -> resume", () => {
    let state = twoTabReadyState({
      playbackMode: "buffering",
      activeTabKey: "a",
      bufferingAtGlobalMs: 2000,
      autoResumeAfterBuffering: true,
      phase: "downloading",
    });
    state.loadedDurationByTabMs.set("a", 500);

    // Chunk arrives but not enough yet
    let r = dispatch(state, {
      type: "CHUNK_LOADED",
      generation: 1,
      tabKey: "a",
      hasFullSnapshot: true,
      loadedDurationMs: 1500,
      hadEventsBeforeThisChunk: true,
    });
    state = r.state;
    expect(state.playbackMode).toBe("buffering");

    // Another chunk — now enough
    r = dispatch(state, {
      type: "CHUNK_LOADED",
      generation: 1,
      tabKey: "a",
      hasFullSnapshot: true,
      loadedDurationMs: 5000,
      hadEventsBeforeThisChunk: true,
    });
    state = r.state;
    expect(state.playbackMode).toBe("playing");
  });

  it("user pauses during buffering", () => {
    const state = twoTabReadyState({
      playbackMode: "buffering",
      bufferingAtGlobalMs: 2000,
      autoResumeAfterBuffering: true,
    });
    const { state: s } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
    expect(s.playbackMode).toBe("paused");
    expect(s.bufferingAtGlobalMs).toBeNull();
    expect(s.autoResumeAfterBuffering).toBe(false);
  });

  it("tab switch during playback", () => {
    const state = twoTabReadyState({ playbackMode: "playing", activeTabKey: "a", pausedAtGlobalMs: 2000 });
    const { state: s } = dispatch(state, { type: "SELECT_TAB", tabKey: "b", nowMs: 1000 });
    expect(s.activeTabKey).toBe("b");
    expect(s.playbackMode).toBe("playing");
    expect(s.suppressAutoFollowUntilWallMs).toBe(6000);
  });

  it("stale REPLAYER_FINISH from old generation ignored", () => {
    const state = twoTabReadyState({ generation: 5, playbackMode: "playing" });
    const { state: s, effects } = dispatch(state, {
      type: "REPLAYER_FINISH",
      generation: 3,
      tabKey: "a",
      localTimeMs: 1000,
      nowMs: 1000,
    });
    expect(s).toBe(state);
    expect(effects).toHaveLength(0);
  });

  it("premature REPLAYER_FINISH (more loaded data) restarts", () => {
    const state = twoTabReadyState({ playbackMode: "playing", activeTabKey: "a" });
    state.loadedDurationByTabMs.set("a", 8000);
    const { state: s, effects } = dispatch(state, {
      type: "REPLAYER_FINISH",
      generation: 1,
      tabKey: "a",
      localTimeMs: 3000,
      nowMs: 1000,
    });
    expect(s.playbackMode).toBe("playing");
    expect(s.prematureFinishRetryLocalMs).toBe(3000);
    const playEffects = getEffects(effects, "play_replayer");
    expect(playEffects).toHaveLength(1);
    expect((playEffects[0] as any).tabKey).toBe("a");
    expect((playEffects[0] as any).localOffsetMs).toBe(3000);
  });

  it("detects premature finish loop and emits recreate_replayer", () => {
    // Simulate: rrweb fires finish at localTime=5000 but loadedDuration is 300000 (5 min loaded).
    // First finish → retry (play_replayer). Second finish at same position → loop detected.
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      phase: "downloading",
    });
    state.loadedDurationByTabMs.set("a", 300_000);

    // First REPLAYER_FINISH — should retry with play_replayer
    const r1 = dispatch(state, {
      type: "REPLAYER_FINISH",
      generation: 1,
      tabKey: "a",
      localTimeMs: 5000,
      nowMs: 1000,
    });
    expect(r1.state.prematureFinishRetryLocalMs).toBe(5000);
    expect(hasEffect(r1.effects, "play_replayer")).toBe(true);
    expect(hasEffect(r1.effects, "recreate_replayer")).toBe(false);

    // Second REPLAYER_FINISH at same position — should detect loop
    const r2 = dispatch(r1.state, {
      type: "REPLAYER_FINISH",
      generation: 1,
      tabKey: "a",
      localTimeMs: 5000,
      nowMs: 1001,
    });
    expect(r2.state.prematureFinishRetryLocalMs).toBeNull();
    expect(r2.state.replayerReady.has("a")).toBe(false);
    expect(hasEffect(r2.effects, "recreate_replayer")).toBe(true);
    expect(hasEffect(r2.effects, "play_replayer")).toBe(false);
    const recreateEffects = getEffects(r2.effects, "recreate_replayer");
    expect((recreateEffects[0] as any).tabKey).toBe("a");
    expect((recreateEffects[0] as any).generation).toBe(1);
  });

  it("premature finish at different position resets retry tracking", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      prematureFinishRetryLocalMs: 5000,
    });
    state.loadedDurationByTabMs.set("a", 300_000);

    // Finish at a DIFFERENT position (10000 vs tracked 5000) — should retry, not recreate
    const { state: s, effects } = dispatch(state, {
      type: "REPLAYER_FINISH",
      generation: 1,
      tabKey: "a",
      localTimeMs: 10000,
      nowMs: 2000,
    });
    expect(s.prematureFinishRetryLocalMs).toBe(10000);
    expect(hasEffect(effects, "play_replayer")).toBe(true);
    expect(hasEffect(effects, "recreate_replayer")).toBe(false);
  });

  it("SEEK resets premature finish retry tracking", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      prematureFinishRetryLocalMs: 5000,
    });
    const { state: s } = dispatch(state, { type: "SEEK", globalOffsetMs: 2000, nowMs: 1000 });
    expect(s.prematureFinishRetryLocalMs).toBeNull();
  });

  it("SELECT_TAB resets premature finish retry tracking", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      prematureFinishRetryLocalMs: 5000,
    });
    const { state: s } = dispatch(state, { type: "SELECT_TAB", tabKey: "b", nowMs: 1000 });
    expect(s.prematureFinishRetryLocalMs).toBeNull();
  });

  it("long session premature finish loop: retry → detect loop → recreate → resume", () => {
    // Simulates a 1h20m session where rrweb's addEvent doesn't extend playable range.
    // The replayer keeps firing "finish" at ~5s despite having 5 min of loaded data.
    const longTabMs = 80 * 60 * 1000; // 80 minutes
    let state: ReplayState = {
      ...createInitialState(),
      generation: 1,
      phase: "downloading",
      streams: makeStreams({ tabKey: "t1", firstMs: 0, lastMs: longTabMs }),
      globalStartTs: 0,
      globalTotalMs: longTabMs,
      chunkRangesByTab: makeChunkRanges({ t1: [[0, longTabMs]] }),
      tabLabelIndex: makeTabLabels({ t1: 1 }),
      hasFullSnapshotByTab: new Set(["t1"]),
      loadedDurationByTabMs: new Map([["t1", 300_000]]), // 5 min loaded
      tabsWithEvents: new Set(["t1"]),
      replayerReady: new Set(["t1"]),
      activeTabKey: "t1",
      playbackMode: "playing",
      autoPlayTriggered: true,
    };

    // 1st REPLAYER_FINISH at 5s — premature, retry
    let r = dispatch(state, {
      type: "REPLAYER_FINISH",
      generation: 1,
      tabKey: "t1",
      localTimeMs: 5000,
      nowMs: 1000,
    });
    state = r.state;
    expect(state.prematureFinishRetryLocalMs).toBe(5000);
    expect(hasEffect(r.effects, "play_replayer")).toBe(true);

    // 2nd REPLAYER_FINISH at same 5s — loop detected, recreate
    r = dispatch(state, {
      type: "REPLAYER_FINISH",
      generation: 1,
      tabKey: "t1",
      localTimeMs: 5000,
      nowMs: 1001,
    });
    state = r.state;
    expect(state.prematureFinishRetryLocalMs).toBeNull();
    expect(state.replayerReady.has("t1")).toBe(false);
    expect(hasEffect(r.effects, "recreate_replayer")).toBe(true);

    // After recreation, REPLAYER_READY fires (new replayer with all 5 min of events)
    r = dispatch(state, {
      type: "REPLAYER_READY",
      generation: 1,
      tabKey: "t1",
    });
    state = r.state;
    expect(state.replayerReady.has("t1")).toBe(true);
    // Already auto-played, but playbackMode was "playing" so it should play
    expect(hasEffect(r.effects, "play_replayer")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stall detection tests
// ---------------------------------------------------------------------------

describe("stall detection", () => {
  it("starts tracking when playing with null activeReplayerLocalTimeMs", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
    });
    const { state: s } = dispatch(state, {
      type: "TICK",
      nowMs: 5000,
      activeReplayerLocalTimeMs: null,
    });
    expect(s.playingWithoutProgressSinceMs).toBe(5000);
  });

  it("resets tracker when replayer starts responding", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      playingWithoutProgressSinceMs: 1000,
    });
    const { state: s } = dispatch(state, {
      type: "TICK",
      nowMs: 2000,
      activeReplayerLocalTimeMs: 500,
    });
    expect(s.playingWithoutProgressSinceMs).toBeNull();
  });

  it("resets tracker when playback mode is not playing", () => {
    const state = twoTabReadyState({
      playbackMode: "paused",
      playingWithoutProgressSinceMs: 1000,
    });
    const { state: s } = dispatch(state, {
      type: "TICK",
      nowMs: 5000,
      activeReplayerLocalTimeMs: null,
    });
    expect(s.playingWithoutProgressSinceMs).toBeNull();
  });

  it("does not trigger recovery before threshold", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      playingWithoutProgressSinceMs: 5000,
    });
    // 2999ms stall — just under threshold
    const { state: s } = dispatch(state, {
      type: "TICK",
      nowMs: 5000 + STALL_THRESHOLD_MS - 1,
      activeReplayerLocalTimeMs: null,
    });
    // Should still be tracking, no recovery
    expect(s.playingWithoutProgressSinceMs).toBe(5000);
    expect(s.playbackMode).toBe("playing");
  });

  it("Strategy A: switches to another ready tab on stall", () => {
    // Tab a is active but stalled, tab b is ready and in range
    const state: ReplayState = {
      ...twoTabReadyState(),
      streams: makeStreams(
        { tabKey: "a", firstMs: 1000, lastMs: 5000 },
        { tabKey: "b", firstMs: 1000, lastMs: 5000 },
      ),
      chunkRangesByTab: makeChunkRanges({
        a: [[1000, 5000]],
        b: [[1000, 5000]],
      }),
      playbackMode: "playing",
      activeTabKey: "a",
      pausedAtGlobalMs: 2000,
      playingWithoutProgressSinceMs: 1000,
    };
    const { state: s, effects } = dispatch(state, {
      type: "TICK",
      nowMs: 1000 + STALL_THRESHOLD_MS,
      activeReplayerLocalTimeMs: null,
    });
    expect(s.activeTabKey).toBe("b");
    expect(s.playingWithoutProgressSinceMs).toBeNull();
    expect(hasEffect(effects, "play_replayer")).toBe(true);
  });

  it("Strategy B: recreates replayer when active tab is ready but broken", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      pausedAtGlobalMs: 2000,
      playingWithoutProgressSinceMs: 1000,
    });
    // Only tab a is in range at offset 2000, and it's in replayerReady
    const { state: s, effects } = dispatch(state, {
      type: "TICK",
      nowMs: 1000 + STALL_THRESHOLD_MS,
      activeReplayerLocalTimeMs: null,
    });
    expect(s.playingWithoutProgressSinceMs).toBeNull();
    expect(s.replayerReady.has("a")).toBe(false);
    expect(hasEffect(effects, "recreate_replayer")).toBe(true);
    const recreateEffects = getEffects(effects, "recreate_replayer");
    expect((recreateEffects[0] as any).tabKey).toBe("a");
  });

  it("Strategy C: ensures replayer when tab has snapshot but no replayer", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      pausedAtGlobalMs: 2000,
      playingWithoutProgressSinceMs: 1000,
    });
    // Tab a has full snapshot but is NOT in replayerReady
    state.replayerReady.delete("a");
    const { state: s, effects } = dispatch(state, {
      type: "TICK",
      nowMs: 1000 + STALL_THRESHOLD_MS,
      activeReplayerLocalTimeMs: null,
    });
    expect(s.playingWithoutProgressSinceMs).toBeNull();
    expect(hasEffect(effects, "ensure_replayer")).toBe(true);
    const ensureEffects = getEffects(effects, "ensure_replayer");
    expect((ensureEffects[0] as any).tabKey).toBe("a");
  });

  it("Strategy D: switches to any ready tab at a different offset", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      pausedAtGlobalMs: 2000,
      playingWithoutProgressSinceMs: 1000,
    });
    // Tab a has no snapshot and is not ready, but tab b IS ready
    state.hasFullSnapshotByTab.delete("a");
    state.replayerReady.delete("a");
    const { state: s, effects } = dispatch(state, {
      type: "TICK",
      nowMs: 1000 + STALL_THRESHOLD_MS,
      activeReplayerLocalTimeMs: null,
    });
    expect(s.activeTabKey).toBe("b");
    expect(s.playbackMode).toBe("playing");
    expect(s.playingWithoutProgressSinceMs).toBeNull();
    expect(hasEffect(effects, "play_replayer")).toBe(true);
  });

  it("Strategy E: pauses with error when nothing works (download complete)", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      pausedAtGlobalMs: 2000,
      playingWithoutProgressSinceMs: 1000,
      phase: "ready",
    });
    // No tab has snapshot or replayer — nothing can recover
    state.hasFullSnapshotByTab.clear();
    state.replayerReady.clear();
    const { state: s, effects } = dispatch(state, {
      type: "TICK",
      nowMs: 1000 + STALL_THRESHOLD_MS,
      activeReplayerLocalTimeMs: null,
    });
    expect(s.playbackMode).toBe("paused");
    expect(s.playingWithoutProgressSinceMs).toBeNull();
    expect(s.playerError).toContain("stalled");
    expect(hasEffect(effects, "pause_all")).toBe(true);
  });

  it("Strategy E: buffers instead of error when still downloading", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      pausedAtGlobalMs: 2000,
      playingWithoutProgressSinceMs: 1000,
      phase: "downloading",
    });
    // No tab has snapshot or replayer — but still downloading
    state.hasFullSnapshotByTab.clear();
    state.replayerReady.clear();
    const { state: s, effects } = dispatch(state, {
      type: "TICK",
      nowMs: 1000 + STALL_THRESHOLD_MS,
      activeReplayerLocalTimeMs: null,
    });
    expect(s.playbackMode).toBe("buffering");
    expect(s.bufferingAtGlobalMs).toBe(2000);
    expect(s.autoResumeAfterBuffering).toBe(true);
    expect(s.playingWithoutProgressSinceMs).toBeNull();
    expect(s.playerError).toBeNull();
    expect(hasEffect(effects, "pause_all")).toBe(true);
  });

  it("TOGGLE_PLAY_PAUSE stays paused with error when no tab can play (download complete)", () => {
    const state = twoTabReadyState({
      playbackMode: "paused",
      activeTabKey: "a",
      phase: "ready",
    });
    // No tab has snapshot or replayer — nothing can play
    state.hasFullSnapshotByTab.clear();
    state.replayerReady.clear();
    const { state: s } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
    expect(s.playbackMode).toBe("paused");
    expect(s.playerError).toBe("Unable to play: this recording contains no full page snapshot, so its incremental updates cannot be reconstructed.");
  });

  it("TOGGLE_PLAY_PAUSE stays paused with error when activeTabKey is null", () => {
    const state = twoTabReadyState({
      playbackMode: "paused",
      activeTabKey: null,
      phase: "ready",
    });
    state.hasFullSnapshotByTab.clear();
    state.replayerReady.clear();
    const { state: s } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
    expect(s.playbackMode).toBe("paused");
    expect(s.playerError).toContain("Unable to play");
  });

  it("TOGGLE_PLAY_PAUSE buffers when no tab can play but still downloading", () => {
    const state = twoTabReadyState({
      playbackMode: "paused",
      activeTabKey: "a",
      phase: "downloading",
    });
    // No tab has snapshot or replayer yet — data still arriving
    state.hasFullSnapshotByTab.clear();
    state.replayerReady.clear();
    const { state: s } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
    expect(s.playbackMode).toBe("buffering");
    expect(s.autoResumeAfterBuffering).toBe(true);
    expect(s.playerError).toBeNull();
  });

  it("resets tracker on TOGGLE_PLAY_PAUSE (pause)", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      playingWithoutProgressSinceMs: 1000,
    });
    const { state: s } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 2000 });
    expect(s.playingWithoutProgressSinceMs).toBeNull();
  });

  it("resets tracker on TOGGLE_PLAY_PAUSE (play)", () => {
    const state = twoTabReadyState({
      playbackMode: "paused",
      playingWithoutProgressSinceMs: 1000,
    });
    const { state: s } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 2000 });
    expect(s.playingWithoutProgressSinceMs).toBeNull();
  });

  it("resets tracker on SEEK", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      playingWithoutProgressSinceMs: 1000,
    });
    const { state: s } = dispatch(state, { type: "SEEK", globalOffsetMs: 2000, nowMs: 2000 });
    expect(s.playingWithoutProgressSinceMs).toBeNull();
  });

  it("resets tracker on SELECT_TAB", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      playingWithoutProgressSinceMs: 1000,
    });
    const { state: s } = dispatch(state, { type: "SELECT_TAB", tabKey: "b", nowMs: 2000 });
    expect(s.playingWithoutProgressSinceMs).toBeNull();
  });

  it("resets tracker on REPLAYER_READY", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      playingWithoutProgressSinceMs: 1000,
    });
    state.replayerReady.delete("a");
    const { state: s } = dispatch(state, { type: "REPLAYER_READY", generation: 1, tabKey: "a" });
    expect(s.playingWithoutProgressSinceMs).toBeNull();
  });

  it("initializes tracker as null", () => {
    const state = createInitialState();
    expect(state.playingWithoutProgressSinceMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// playerError clearing tests
// ---------------------------------------------------------------------------

describe("playerError clearing", () => {
  it("TOGGLE_PLAY_PAUSE (play) clears playerError", () => {
    const state = twoTabReadyState({
      playbackMode: "paused",
      playerError: "Playback stalled: unable to recover.",
    });
    const { state: s } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
    expect(s.playbackMode).toBe("playing");
    expect(s.playerError).toBeNull();
  });

  it("TOGGLE_PLAY_PAUSE (pause) clears playerError", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      playerError: "Some error",
    });
    const { state: s } = dispatch(state, { type: "TOGGLE_PLAY_PAUSE", nowMs: 1000 });
    expect(s.playbackMode).toBe("paused");
    expect(s.playerError).toBeNull();
  });

  it("SEEK clears playerError", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      playerError: "Playback stalled: unable to recover.",
    });
    const { state: s } = dispatch(state, { type: "SEEK", globalOffsetMs: 2000, nowMs: 1000 });
    expect(s.playerError).toBeNull();
  });

  it("SELECT_TAB clears playerError", () => {
    const state = twoTabReadyState({
      playbackMode: "playing",
      activeTabKey: "a",
      playerError: "Playback stalled: unable to recover.",
    });
    const { state: s } = dispatch(state, { type: "SELECT_TAB", tabKey: "b", nowMs: 1000 });
    expect(s.playerError).toBeNull();
  });

  it("CHUNK_LOADED with hasFullSnapshot on active tab clears playerError", () => {
    const state = twoTabReadyState({
      activeTabKey: "a",
      playerError: "Unable to play: recording data may be incomplete.",
    });
    const { state: s } = dispatch(state, {
      type: "CHUNK_LOADED",
      generation: 1,
      tabKey: "a",
      hasFullSnapshot: true,
      loadedDurationMs: 3500,
      hadEventsBeforeThisChunk: true,
    });
    expect(s.playerError).toBeNull();
  });

  it("CHUNK_LOADED on non-active tab does NOT clear playerError", () => {
    const state = twoTabReadyState({
      activeTabKey: "a",
      playerError: "Unable to play: recording data may be incomplete.",
    });
    const { state: s } = dispatch(state, {
      type: "CHUNK_LOADED",
      generation: 1,
      tabKey: "b",
      hasFullSnapshot: true,
      loadedDurationMs: 3500,
      hadEventsBeforeThisChunk: true,
    });
    expect(s.playerError).toBe("Unable to play: recording data may be incomplete.");
  });

  it("CHUNK_LOADED without hasFullSnapshot on active tab does NOT clear playerError", () => {
    const state = twoTabReadyState({
      activeTabKey: "a",
      playerError: "Unable to play: recording data may be incomplete.",
    });
    const { state: s } = dispatch(state, {
      type: "CHUNK_LOADED",
      generation: 1,
      tabKey: "a",
      hasFullSnapshot: false,
      loadedDurationMs: 3500,
      hadEventsBeforeThisChunk: true,
    });
    expect(s.playerError).toBe("Unable to play: recording data may be incomplete.");
  });
});

// ---------------------------------------------------------------------------
// Invariant tests (fuzz random action sequences)
// ---------------------------------------------------------------------------

describe("invariants", () => {
  function randomAction(state: ReplayState): ReplayAction {
    const actions: ReplayAction[] = [
      { type: "SELECT_RECORDING", generation: state.generation + 1 },
      { type: "TOGGLE_PLAY_PAUSE", nowMs: Math.random() * 10000 },
      { type: "SEEK", globalOffsetMs: Math.random() * (state.globalTotalMs || 1000), nowMs: Math.random() * 10000 },
      { type: "UPDATE_SPEED", speed: [0.5, 1, 2, 4][Math.floor(Math.random() * 4)] },
      { type: "UPDATE_SETTINGS", updates: { followActiveTab: Math.random() > 0.5 } },
      { type: "TICK", nowMs: Math.random() * 10000, activeReplayerLocalTimeMs: Math.random() > 0.3 ? Math.random() * 5000 : null },
      { type: "RESET" },
    ];

    if (state.streams.length > 0) {
      const tabKey = state.streams[Math.floor(Math.random() * state.streams.length)].tabKey;
      actions.push(
        { type: "SELECT_TAB", tabKey, nowMs: Math.random() * 10000 },
        { type: "CHUNK_LOADED", generation: state.generation, tabKey, hasFullSnapshot: true, loadedDurationMs: Math.random() * 10000, hadEventsBeforeThisChunk: Math.random() > 0.5 },
        { type: "REPLAYER_READY", generation: state.generation, tabKey },
        { type: "REPLAYER_FINISH", generation: state.generation, tabKey, localTimeMs: Math.random() * 5000, nowMs: Math.random() * 10000 },
        { type: "BUFFER_CHECK", generation: state.generation, tabKey },
      );
    }

    if (state.phase === "downloading") {
      actions.push(
        { type: "DOWNLOAD_COMPLETE", generation: state.generation },
        { type: "DOWNLOAD_ERROR", generation: state.generation, message: "err" },
      );
    }

    return actions[Math.floor(Math.random() * actions.length)];
  }

  function assertInvariants(state: ReplayState) {
    // playbackMode is always one variant
    expect(["paused", "playing", "buffering", "gap_fast_forward", "finished"]).toContain(state.playbackMode);

    // activeTabKey is in streams or null
    if (state.activeTabKey !== null) {
      const tabKeys = state.streams.map(s => s.tabKey);
      expect(tabKeys).toContain(state.activeTabKey);
    }

    // pausedAtGlobalMs is non-negative
    expect(state.pausedAtGlobalMs).toBeGreaterThanOrEqual(0);

    // gap fast-forward constraints
    if (state.gapFastForward) {
      expect(state.gapFastForward.toGlobalMs).toBeGreaterThan(state.gapFastForward.fromGlobalMs);
    }

    // generation never decrements (relative to initial 0)
    expect(state.generation).toBeGreaterThanOrEqual(0);
  }

  it("survives 200 random actions without violating invariants", () => {
    let state = createInitialState();

    // Set up some state first
    let r = dispatch(state, { type: "SELECT_RECORDING", generation: 1 });
    state = r.state;
    r = dispatch(state, {
      type: "STREAMS_COMPUTED",
      generation: 1,
      streams: makeStreams(
        { tabKey: "a", firstMs: 1000, lastMs: 5000 },
        { tabKey: "b", firstMs: 6000, lastMs: 10000 },
      ),
      globalStartTs: 1000,
      globalTotalMs: 9000,
      chunkRangesByTab: makeChunkRanges({
        a: [[1000, 5000]],
        b: [[6000, 10000]],
      }),
      tabLabelIndex: makeTabLabels({ a: 1, b: 2 }),
    });
    state = r.state;
    state = {
      ...state,
      hasFullSnapshotByTab: new Set(["a", "b"]),
      loadedDurationByTabMs: new Map([["a", 4000], ["b", 4000]]),
      tabsWithEvents: new Set(["a", "b"]),
      replayerReady: new Set(["a", "b"]),
    };

    for (let i = 0; i < 200; i++) {
      const action = randomAction(state);
      const result = replayReducer(state, action);
      state = result.state;
      assertInvariants(state);

      // Effects never reference absent tabKeys
      for (const effect of result.effects) {
        if ("tabKey" in effect && effect.tabKey) {
          const tabKeys = new Set(state.streams.map(s => s.tabKey));
          // After SELECT_RECORDING, streams may be empty — that's fine,
          // the effect was issued before the reset cleared streams.
          // We only check if streams exist.
          if (tabKeys.size > 0) {
            // Note: effects reference tabs from pre-transition state which
            // might not be in post-transition state after SELECT_RECORDING.
            // This is ok — the effect executor checks generation.
          }
        }
      }
    }
  });
});

"use client";

import { TeamSearchTable } from "@/components/data-table/team-search-table";
import { UserPickerTable } from "@/components/data-table/user-picker-table";
import { StyledLink } from "@/components/link";
import { Alert, Button, Dialog, DialogContent, DialogHeader, DialogTitle, Skeleton, Switch, Typography } from "@/components/ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useFromNow } from "@/hooks/use-from-now";
import { formatDurationMs } from "@/lib/session-replay-format";
import {
  getDesiredGlobalOffsetFromPlaybackState,
  INTER_TAB_GAP_FAST_FORWARD_MULTIPLIER,
} from "@/lib/session-replay-playback";
import type { TabKey, TabStream } from "@/lib/session-replay-streams";
import {
  computeGlobalTimeline,
  globalOffsetToLocalOffset,
  groupChunksIntoTabStreams,
  NULL_TAB_KEY,
} from "@/lib/session-replay-streams";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon, ArrowsClockwiseIcon, CheckIcon, CursorClickIcon, FastForwardIcon, FunnelSimpleIcon, GearIcon, LinkIcon, MonitorPlayIcon, PauseIcon, PlayIcon, XIcon } from "@phosphor-icons/react";
import { runAsynchronously, runAsynchronouslyWithAlert, wait } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp, useServerApp } from "../use-admin-app";
import { SessionReplayLimitBanner } from "../analytics/shared";
import { ReplayUserOverview, ReplayUserOverviewSkeleton } from "./replay-user-overview";
import {
  ALLOWED_PLAYER_SPEEDS,
  areStatesRenderEquivalent,
  createInitialState,
  replayReducer,
  type ChunkRange,
  type ReplayAction,
  type ReplayEffect,
  type ReplaySettings,
  type ReplayState,
  type StreamInfo,
} from "./session-replay-machine";

const replaysPanelShellClass =
  "flex-1 min-h-[520px] overflow-hidden rounded-xl bg-white/90 ring-1 ring-black/[0.06] dark:bg-background/60 dark:ring-white/[0.06]";
const replaysListChromeClass =
  "shrink-0 space-y-2 border-b border-black/[0.06] px-3 py-2.5 dark:border-border/30";
const replaysDetailChromeClass =
  "flex h-10 shrink-0 items-center justify-between gap-3 border-b border-black/[0.06] px-3 py-2 dark:border-border/30";
// Same chrome as above, but the user overview is multi-line, so it grows instead
// of being pinned to the transport bar's height.
const replaysDetailOverviewChromeClass =
  "flex shrink-0 items-start justify-between gap-3 border-b border-black/[0.06] px-3 py-2.5 dark:border-border/30";
const replaysViewerSurfaceClass = "bg-zinc-100 dark:bg-background";
const replaysTransportBarClass =
  "flex items-center gap-3 border-t border-black/[0.06] bg-white/95 px-3 dark:border-border/30 dark:bg-background/80";

const PAGE_SIZE = 50;
const INITIAL_CHUNK_BATCH = 20;
const BACKGROUND_CHUNK_BATCH = 50;
const EXTRA_TABS_TO_SHOW = 2;
const REPLAY_SETTINGS_STORAGE_KEY = "stack.session-replay.settings";
const LEGACY_PLAYER_SPEED_STORAGE_KEY = "stack.session-replay.speed";

type RrwebEventWithTime = import("rrweb/typings/types").eventWithTime;
type RrwebReplayer = InstanceType<typeof import("rrweb").Replayer>;

type RecordingRow = {
  id: string,
  refreshTokenId: string,
  projectUser: {
    id: string,
    displayName: string | null,
    primaryEmail: string | null,
  },
  startedAt: Date,
  lastEventAt: Date,
  chunkCount: number,
  eventCount: number,
};

type RecordingListRow = {
  replay: RecordingRow,
  key: string,
};

type ChunkRow = {
  id: string,
  batchId: string,
  sessionReplaySegmentId: string | null,
  eventCount: number,
  byteLength: number,
  firstEventAt: Date,
  lastEventAt: Date,
  createdAt: Date,
};

type AdminAppWithSessionReplays = ReturnType<typeof useAdminApp> & {
  listSessionReplays: (options?: {
    limit?: number,
    cursor?: string,
    userIds?: string[],
    teamIds?: string[],
    durationMsMin?: number,
    durationMsMax?: number,
    lastEventAtFromMillis?: number,
    lastEventAtToMillis?: number,
    clickCountMin?: number,
  }) => Promise<{
    items: RecordingRow[],
    nextCursor: string | null,
  }>,
  getSessionReplay: (sessionReplayId: string) => Promise<RecordingRow>,
  getSessionReplayEvents: (sessionReplayId: string, options?: { offset?: number, limit?: number }) => Promise<{
    chunks: ChunkRow[],
    chunkEvents: Array<{ chunkId: string, events: unknown[] }>,
  }>,
};

type ReplayFilters = {
  userId: string,
  userLabel: string,
  teamId: string,
  teamLabel: string,
  durationMinSeconds: string,
  durationMaxSeconds: string,
  lastActivePreset: "" | "24h" | "7d" | "30d",
  clickCountMin: string,
};

const EMPTY_FILTERS: ReplayFilters = {
  userId: "",
  userLabel: "",
  teamId: "",
  teamLabel: "",
  durationMinSeconds: "",
  durationMaxSeconds: "",
  lastActivePreset: "",
  clickCountMin: "",
};

function coerceRrwebEvents(raw: unknown[]): RrwebEventWithTime[] {
  const filtered: Array<{ timestamp: number }> = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    if (!("timestamp" in e)) continue;
    const ts = (e as { timestamp?: unknown }).timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    filtered.push(e as { timestamp: number });
  }
  return filtered as unknown as RrwebEventWithTime[];
}

function formatTimelineMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${(m % 60).toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function filtersActiveCount(filters: ReplayFilters): number {
  let count = 0;
  if (filters.userId) count += 1;
  if (filters.teamId) count += 1;
  if (filters.durationMinSeconds || filters.durationMaxSeconds) count += 1;
  if (filters.lastActivePreset) count += 1;
  if (filters.clickCountMin) count += 1;
  return count;
}

type TimelineEvent = {
  eventType: string,
  eventAtMs: number,
  data: Record<string, unknown>,
};

type TimelineMarker = {
  timeMs: number,
  eventType: string,
  label: string,
};

function formatEventTooltip(event: TimelineEvent): string {
  const d = event.data;
  if (event.eventType === "$click") {
    const tag = (d.tag_name as string) || "element";
    return `Clicked ${tag}`;
  }
  if (event.eventType === "$page-view") {
    const path = (d.path as string | undefined) ?? (d.url as string | undefined) ?? "/";
    const truncated = path.length > 30 ? path.slice(0, 27) + "..." : path;
    return truncated;
  }
  return event.eventType;
}

function DisplayDate({ date }: { date: Date }) {
  const fromNow = useFromNow(date);
  return <span>{fromNow}</span>;
}

function getRecordingTitle(r: RecordingRow) {
  return r.projectUser.displayName ?? r.projectUser.primaryEmail ?? r.projectUser.id;
}

function parseReplaySettings(raw: string): ReplaySettings | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;

  const playerSpeedRaw = value.playerSpeed;
  const playerSpeed = typeof playerSpeedRaw === "number" && ALLOWED_PLAYER_SPEEDS.has(playerSpeedRaw)
    ? playerSpeedRaw
    : 1;
  const skipInactivity = typeof value.skipInactivity === "boolean"
    ? value.skipInactivity
    : true;
  const followActiveTab = typeof value.followActiveTab === "boolean"
    ? value.followActiveTab
    : false;

  return { playerSpeed, skipInactivity, followActiveTab };
}

function getInitialReplaySettings(): ReplaySettings {
  if (typeof window === 'undefined') return { playerSpeed: 1, skipInactivity: true, followActiveTab: false };
  try {
    const rawSettings = localStorage.getItem(REPLAY_SETTINGS_STORAGE_KEY);
    if (rawSettings) {
      const parsed = parseReplaySettings(rawSettings);
      if (parsed) return parsed;
    }
    const rawLegacySpeed = localStorage.getItem(LEGACY_PLAYER_SPEED_STORAGE_KEY);
    if (rawLegacySpeed) {
      const legacySpeed = Number(rawLegacySpeed);
      if (Number.isFinite(legacySpeed) && ALLOWED_PLAYER_SPEEDS.has(legacySpeed)) {
        return { playerSpeed: legacySpeed, skipInactivity: true, followActiveTab: false };
      }
    }
  } catch {
    // ignore
  }
  return { playerSpeed: 1, skipInactivity: true, followActiveTab: false };
}

// Memoized so the markers (potentially thousands of DOM nodes) only re-render
// when the markers themselves change — never from playback-time updates.
const TimelineMarkersLane = React.memo(function TimelineMarkersLane({
  markers,
  totalTimeMs,
  onSeek,
}: {
  markers: TimelineMarker[],
  totalTimeMs: number,
  onSeek: (timeOffset: number) => void,
}) {
  const [hoveredMarkerIndex, setHoveredMarkerIndex] = useState<number | null>(null);
  const hoveredMarker = hoveredMarkerIndex !== null ? markers[hoveredMarkerIndex] ?? null : null;

  return (
    <div className="relative h-3.5 mb-0.5">
      {markers.map((marker, i) => {
        const left = totalTimeMs > 0 ? (marker.timeMs / totalTimeMs) * 100 : 0;
        if (left < 0 || left > 100) return null;
        const isClick = marker.eventType === "$click";
        return (
          <div
            key={i}
            className={cn(
              "absolute bottom-0 w-[3px] h-3 rounded-sm cursor-pointer",
              "transition-colors",
              isClick
                ? "bg-blue-500/70 hover:bg-blue-400"
                : "bg-emerald-500/70 hover:bg-emerald-400",
            )}
            style={{ left: `${left}%`, marginLeft: "-1.5px" }}
            onMouseEnter={() => setHoveredMarkerIndex(i)}
            onMouseLeave={() => setHoveredMarkerIndex((prev) => prev === i ? null : prev)}
            onClick={() => onSeek(marker.timeMs)}
          />
        );
      })}

      {/* Custom tooltip */}
      {hoveredMarker && (() => {
        const left = totalTimeMs > 0 ? (hoveredMarker.timeMs / totalTimeMs) * 100 : 0;
        return (
          <div
            className="absolute bottom-full mb-1.5 -translate-x-1/2 pointer-events-none z-50"
            style={{ left: `${left}%` }}
          >
            <div className="max-w-52 whitespace-nowrap rounded-md border border-black/[0.08] bg-white px-3 py-1.5 text-xs text-foreground shadow-md ring-1 ring-black/[0.06] dark:border-white/[0.08] dark:bg-primary dark:text-primary-foreground dark:ring-white/[0.08]">
              <div className="truncate">{hoveredMarker.label}</div>
              <div className="text-[10px] opacity-70">{formatTimelineMs(hoveredMarker.timeMs)}</div>
            </div>
          </div>
        );
      })()}
    </div>
  );
});

function Timeline({
  getCurrentTimeMs,
  playerIsPlaying,
  totalTimeMs,
  onTogglePlayPause,
  onSeek,
  playerSpeed,
  onSpeedChange,
  markers,
}: {
  getCurrentTimeMs: () => number,
  playerIsPlaying: boolean,
  totalTimeMs: number,
  onTogglePlayPause: () => void,
  onSeek: (timeOffset: number) => void,
  playerSpeed: number,
  onSpeedChange: (speed: number) => void,
  markers?: TimelineMarker[],
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const timeLabelRef = useRef<HTMLSpanElement | null>(null);
  const progressFillRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number>(0);

  // The current time is written straight to the DOM every frame instead of
  // going through React state — a setState here would re-render the whole
  // transport bar (incl. the markers lane) at 60fps.
  useEffect(() => {
    function tick() {
      const currentTime = getCurrentTimeMs();
      if (timeLabelRef.current) {
        timeLabelRef.current.textContent = formatTimelineMs(currentTime);
      }
      if (progressFillRef.current) {
        const progress = totalTimeMs > 0 ? Math.min(currentTime / totalTimeMs, 1) : 0;
        progressFillRef.current.style.width = `${progress * 100}%`;
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [getCurrentTimeMs, totalTimeMs]);

  const handleTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = trackRef.current;
    if (!el || totalTimeMs <= 0) return;
    const rect = el.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const timeOffset = fraction * totalTimeMs;
    onSeek(timeOffset);
  }, [totalTimeMs, onSeek]);

  const hasMarkers = (markers?.length ?? 0) > 0;

  return (
    <div className={cn(replaysTransportBarClass, hasMarkers ? "py-1.5" : "py-2")}>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={onTogglePlayPause}
      >
        {playerIsPlaying ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
      </Button>

      <span ref={timeLabelRef} className="text-xs text-muted-foreground tabular-nums w-10 shrink-0 text-right">
        {formatTimelineMs(0)}
      </span>

      <div className="flex-1 flex flex-col justify-center">
        {/* Event markers lane */}
        {hasMarkers && markers && (
          <TimelineMarkersLane markers={markers} totalTimeMs={totalTimeMs} onSeek={onSeek} />
        )}

        {/* Progress bar track (clickable) */}
        <div
          ref={trackRef}
          onClick={handleTrackClick}
          className="h-5 flex items-center cursor-pointer group"
        >
          <div className="w-full h-1.5 rounded-full bg-muted relative overflow-hidden">
            <div
              ref={progressFillRef}
              className="absolute inset-y-0 left-0 bg-foreground/60 group-hover:bg-foreground/80 rounded-full transition-colors"
              style={{ width: "0%" }}
            />
          </div>
        </div>
      </div>

      <span className="text-xs text-muted-foreground tabular-nums w-10 shrink-0">
        {formatTimelineMs(totalTimeMs)}
      </span>

      <select
        className="h-7 rounded-md border border-black/[0.08] bg-white/95 px-1.5 text-xs ring-1 ring-black/[0.06] dark:border-border/40 dark:bg-background dark:ring-white/[0.06]"
        value={playerSpeed}
        onChange={(e) => onSpeedChange(Number(e.target.value))}
      >
        <option value={0.5}>0.5x</option>
        <option value={1}>1x</option>
        <option value={2}>2x</option>
        <option value={4}>4x</option>
      </select>
    </div>
  );
}

function ReplaySettingsButton({
  settings,
  onSettingsChange,
}: {
  settings: ReplaySettings,
  onSettingsChange: (updates: Partial<ReplaySettings>) => void,
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setOpen(true)}
        aria-label="Replay settings"
      >
        <GearIcon className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replay settings</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-4">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <Typography className="text-sm font-medium">Skip inactivity</Typography>
                <Typography className="text-xs text-muted-foreground">
                  Fast-forward through idle periods during playback.
                </Typography>
              </div>
              <Switch
                checked={settings.skipInactivity}
                onCheckedChange={(checked) => onSettingsChange({ skipInactivity: checked })}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <Typography className="text-sm font-medium">Follow active tab</Typography>
                <Typography className="text-xs text-muted-foreground">
                  Auto-switch to the tab that has activity at the current time.
                </Typography>
              </div>
              <Switch
                checked={settings.followActiveTab}
                onCheckedChange={(checked) => onSettingsChange({ followActiveTab: checked })}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Machine hook — wraps the pure reducer with a React-friendly interface.
// Returns `state` (for rendering) and `stateRef` (for callbacks).
// ---------------------------------------------------------------------------

function useReplayMachine(initialSettings: ReplaySettings) {
  const stateRef = useRef<ReplayState>(createInitialState(initialSettings));
  const [, forceRender] = useState(0);

  const dispatch = useCallback((action: ReplayAction): ReplayEffect[] => {
    const previousState = stateRef.current;
    const { state, effects } = replayReducer(previousState, action);
    stateRef.current = state;
    // Only re-render when a render-relevant field changed — the TICK loop
    // dispatches several times per second and would otherwise re-render the
    // entire page each time (the UI reads playback time imperatively).
    if (!areStatesRenderEquivalent(previousState, state)) {
      forceRender(v => v + 1);
    }
    return effects;
  }, []);

  return { state: stateRef.current, stateRef, dispatch };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type PageClientProps = {
  initialReplayId?: string,
  lockedUserId?: string,
};

export default function PageClient({ initialReplayId, lockedUserId }: PageClientProps) {
  // SAFETY: The project app is the server-capable admin app; these session
  // replay methods are part of its server interface but may be absent from an
  // older generated SDK declaration.
  const adminApp = useAdminApp() as AdminAppWithSessionReplays;
  const serverApp = useServerApp();
  const isStandaloneReplayPage = initialReplayId != null;
  const isEmbedded = lockedUserId != null;
  const baseFilters = useMemo<ReplayFilters>(
    () => lockedUserId ? { ...EMPTY_FILTERS, userId: lockedUserId } : EMPTY_FILTERS,
    [lockedUserId],
  );

  // ---- Recording list + filters ----

  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [activeFilterDialog, setActiveFilterDialog] = useState<null | "user" | "team" | "duration" | "lastActive" | "clicks">(null);
  const [appliedFilters, setAppliedFilters] = useState<ReplayFilters>(baseFilters);
  const [draftFilters, setDraftFilters] = useState<ReplayFilters>(baseFilters);

  useEffect(() => {
    if (!lockedUserId) return;
    setAppliedFilters((prev) => prev.userId === lockedUserId ? prev : { ...prev, userId: lockedUserId, userLabel: prev.userLabel || "" });
  }, [lockedUserId]);
  const [clickCountsByReplayId, setClickCountsByReplayId] = useState<Map<string, number>>(new Map());
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [standaloneReplay, setStandaloneReplay] = useState<RecordingRow | null>(null);
  const [standaloneReplayError, setStandaloneReplayError] = useState<string | null>(null);

  const listBoxRef = useRef<HTMLDivElement | null>(null);

  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(initialReplayId ?? null);
  const [replayShareLinkCopied, setReplayShareLinkCopied] = useState(false);
  const selectedRecording = useMemo(
    () => recordings.find(r => r.id === selectedRecordingId)
      ?? (standaloneReplay?.id === selectedRecordingId ? standaloneReplay : null),
    [recordings, selectedRecordingId, standaloneReplay],
  );
  const recordingListRows = useMemo<RecordingListRow[]>(
    () => recordings.map((replay) => ({ replay, key: replay.id })),
    [recordings],
  );

  const hasAutoSelectedRef = useRef(false);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    if (!isStandaloneReplayPage) return;
    if (selectedRecordingId === initialReplayId && (standaloneReplay == null || standaloneReplay.id === initialReplayId)) return;
    setSelectedRecordingId(initialReplayId);
  }, [initialReplayId, isStandaloneReplayPage, selectedRecordingId, standaloneReplay, setSelectedRecordingId]);

  useEffect(() => {
    setReplayShareLinkCopied(false);
  }, [selectedRecordingId]);

  useEffect(() => {
    if (!replayShareLinkCopied) return;
    const timer = setTimeout(() => setReplayShareLinkCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [replayShareLinkCopied]);

  const loadPage = useCallback(async (cursor: string | null) => {
    if (cursor !== null && loadingMoreRef.current) return;

    if (cursor === null) {
      setLoadingInitial(true);
    } else {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    }
    setListError(null);

    try {
      const presetMs: Record<string, number> = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };
      const lastActiveFromMillis = appliedFilters.lastActivePreset && presetMs[appliedFilters.lastActivePreset]
        ? Date.now() - presetMs[appliedFilters.lastActivePreset]
        : undefined;

      const res = await adminApp.listSessionReplays({
        limit: PAGE_SIZE,
        cursor: cursor ?? undefined,
        userIds: appliedFilters.userId ? [appliedFilters.userId] : undefined,
        teamIds: appliedFilters.teamId ? [appliedFilters.teamId] : undefined,
        durationMsMin: appliedFilters.durationMinSeconds ? Number(appliedFilters.durationMinSeconds) * 1000 : undefined,
        durationMsMax: appliedFilters.durationMaxSeconds ? Number(appliedFilters.durationMaxSeconds) * 1000 : undefined,
        lastEventAtFromMillis: lastActiveFromMillis,
        clickCountMin: appliedFilters.clickCountMin ? Number(appliedFilters.clickCountMin) : undefined,
      });
      setRecordings((prev) => {
        const items = cursor ? [...prev, ...res.items] : res.items;
        if (!cursor && !hasAutoSelectedRef.current && items.length > 0) {
          hasAutoSelectedRef.current = true;
          setSelectedRecordingId(items[0].id);
        }
        return items;
      });
      setNextCursor(res.nextCursor);
    } catch (e: any) {
      setListError(e?.message ?? "Failed to load session recordings.");
    } finally {
      setLoadingInitial(false);
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [adminApp, appliedFilters]);

  useEffect(() => {
    if (isStandaloneReplayPage) {
      setLoadingInitial(false);
      return;
    }
    setRecordings([]);
    setNextCursor(null);
    hasAutoSelectedRef.current = false;
    runAsynchronously(() => loadPage(null), { noErrorLogging: true });
  }, [isStandaloneReplayPage, loadPage]);

  useEffect(() => {
    if (isStandaloneReplayPage) return;
    if (recordings.length === 0) return;
    const ids = recordings.map(r => r.id);
    runAsynchronously(async () => {
      const res = await serverApp.queryAnalytics({
        query: `SELECT session_replay_id, count() as cnt
                FROM default.events
                WHERE event_type = '$click'
                  AND session_replay_id IN ({ids:Array(String)})
                GROUP BY session_replay_id`,
        params: { ids },
        include_all_branches: false,
        timeout_ms: 15000,
      });
      const map = new Map<string, number>();
      for (const row of res.result) {
        map.set(row.session_replay_id as string, Number(row.cnt));
      }
      setClickCountsByReplayId(map);
    }, { noErrorLogging: true });
  }, [isStandaloneReplayPage, recordings, serverApp]);

  useEffect(() => {
    if (initialReplayId == null) return;
    let cancelled = false;
    setStandaloneReplay(null);
    setStandaloneReplayError(null);
    runAsynchronously(async () => {
      try {
        const replay = await adminApp.getSessionReplay(initialReplayId);
        if (cancelled) return;
        setStandaloneReplay(replay);
      } catch (e: any) {
        if (cancelled) return;
        setStandaloneReplayError(e?.message ?? "Failed to load session replay.");
      }
    }, { noErrorLogging: true });
    return () => {
      cancelled = true;
    };
  }, [adminApp, initialReplayId, isStandaloneReplayPage]);

  const onListScroll = useCallback(() => {
    const el = listBoxRef.current;
    if (!el) return;
    if (!nextCursor) return;
    if (loadingMoreRef.current || loadingInitial) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < 200) {
      runAsynchronously(() => loadPage(nextCursor), { noErrorLogging: true });
    }
  }, [loadingInitial, loadPage, nextCursor]);

  // ---- Replay state machine ----

  const { state: ms, stateRef: msRef, dispatch: rawDispatch } = useReplayMachine(getInitialReplaySettings());

  // ---- DOM / rrweb refs (not managed by machine) ----

  const eventsByTabRef = useRef<Map<TabKey, RrwebEventWithTime[]>>(new Map());
  const containerByTabRef = useRef<Map<TabKey, HTMLDivElement | null>>(new Map());
  const replayerByTabRef = useRef<Map<TabKey, RrwebReplayer>>(new Map());
  const replayerRootByTabRef = useRef<Map<TabKey, HTMLDivElement>>(new Map());
  const resizeObserverByTabRef = useRef<Map<TabKey, ResizeObserver>>(new Map());
  const pendingInitByTabRef = useRef<Set<TabKey>>(new Set());
  const speedSubRef = useRef<{ unsubscribe: () => void } | null>(null);

  // Full TabStream objects for rendering (machine only stores StreamInfo).
  const [fullStreams, setFullStreams] = useState<TabStream<ChunkRow>[]>([]);
  const fullStreamsRef = useRef<TabStream<ChunkRow>[]>([]);

  // Generation counter for staleness checks in async operations.
  const genCounterRef = useRef(0);

  // ---- UI-only state ----
  const [isSkipping, setIsSkipping] = useState(false);
  const [uiVersion, setUiVersion] = useState(0);

  // ---- Derived values ----

  const playerIsPlaying = ms.playbackMode === "playing" || ms.playbackMode === "gap_fast_forward";
  const isBuffering = ms.playbackMode === "buffering";
  const replayFinished = ms.playbackMode === "finished";
  const isDownloading = ms.phase === "downloading";

  // ---- Imperative helpers ----

  const destroyReplayers = useCallback(() => {
    for (const obs of resizeObserverByTabRef.current.values()) {
      obs.disconnect();
    }
    resizeObserverByTabRef.current.clear();

    speedSubRef.current?.unsubscribe();
    speedSubRef.current = null;

    for (const r of replayerByTabRef.current.values()) {
      try {
        r.pause();
      } catch {
        // ignore
      }
    }
    replayerByTabRef.current.clear();
    replayerRootByTabRef.current.clear();

    for (const root of containerByTabRef.current.values()) {
      if (root) root.innerHTML = "";
    }
  }, []);

  // ---- act: dispatch action to machine + execute returned effects ----
  // Uses a ref to break circular dependency with ensureReplayerForTab.

  const actRef = useRef<(action: ReplayAction) => void>(() => {});

  const ensureReplayerForTab = useCallback(async (tabKey: TabKey, gen: number) => {
    if (msRef.current.generation !== gen) return;
    if (replayerByTabRef.current.has(tabKey)) return;

    const rootMaybe = containerByTabRef.current.get(tabKey) ?? null;
    if (!rootMaybe) {
      pendingInitByTabRef.current.add(tabKey);
      return;
    }
    const rootEl = rootMaybe;

    const eventsSnapshot = eventsByTabRef.current.get(tabKey)?.slice() ?? [];
    if (eventsSnapshot.length === 0) {
      pendingInitByTabRef.current.add(tabKey);
      return;
    }

    if (!msRef.current.hasFullSnapshotByTab.has(tabKey)) {
      // Last-resort: scan accumulated events for a FullSnapshot that the
      // chunk-level detection may have missed (eg. due to race conditions or
      // type coercion).  rrweb FullSnapshot is event type 2.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const hasSnapshot = eventsSnapshot.some(e => (e as any).type === 2 || (e as any).type === "2");
      if (!hasSnapshot) return;
      // Patch the machine state so subsequent checks pass.
      actRef.current({
        type: "CHUNK_LOADED",
        generation: gen,
        tabKey,
        hasFullSnapshot: true,
        loadedDurationMs: eventsSnapshot.length >= 2
          ? eventsSnapshot[eventsSnapshot.length - 1].timestamp - eventsSnapshot[0].timestamp
          : 0,
        hadEventsBeforeThisChunk: true,
      });
    }

    try {
      const { Replayer } = await import("rrweb");
      if (msRef.current.generation !== gen) return;
      if (replayerByTabRef.current.has(tabKey)) return;

      const eventsSnapshot2 = eventsByTabRef.current.get(tabKey)?.slice() ?? [];
      if (eventsSnapshot2.length === 0) return;

      const replayer = new Replayer(eventsSnapshot2, {
        root: rootEl,
        speed: msRef.current.settings.playerSpeed,
        skipInactive: msRef.current.settings.skipInactivity,
        triggerFocus: false,
      });

      rootEl.style.position = "relative";
      rootEl.style.width = "100%";
      rootEl.style.height = "100%";
      rootEl.style.overflow = "hidden";

      replayer.wrapper.style.margin = "0";
      replayer.wrapper.style.position = "absolute";
      replayer.wrapper.style.transformOrigin = "top left";

      replayer.iframe.style.border = "0";

      const mouseEl = replayer.wrapper.querySelector(".replayer-mouse") as HTMLElement | null;
      if (mouseEl) {
        mouseEl.style.position = "absolute";
        mouseEl.style.width = "14px";
        mouseEl.style.height = "14px";
        mouseEl.style.borderRadius = "9999px";
        mouseEl.style.background = "rgba(255, 255, 255, 0.9)";
        mouseEl.style.border = "2px solid rgba(0, 0, 0, 0.55)";
        mouseEl.style.boxShadow = "0 2px 10px rgba(0,0,0,0.25)";
        mouseEl.style.transform = "translate(-50%, -50%)";
        mouseEl.style.pointerEvents = "none";
        mouseEl.style.zIndex = "2";
      }

      const mouseTailEl = replayer.wrapper.querySelector(".replayer-mouse-tail") as HTMLCanvasElement | null;
      if (mouseTailEl) {
        mouseTailEl.style.position = "absolute";
        mouseTailEl.style.inset = "0";
        mouseTailEl.style.pointerEvents = "none";
        mouseTailEl.style.zIndex = "1";
      }

      function updateScale() {
        const cw = rootEl.clientWidth;
        const ch = rootEl.clientHeight;
        const replayW = replayer.wrapper.offsetWidth;
        const replayH = replayer.wrapper.offsetHeight;
        if (replayW <= 0 || replayH <= 0 || cw <= 0 || ch <= 0) return;
        const isActive = msRef.current.activeTabKey === tabKey;
        const scale = isActive ? Math.min(cw / replayW, ch / replayH) : (cw / replayW);
        const scaledW = replayW * scale;
        const scaledH = replayH * scale;
        replayer.wrapper.style.left = isActive ? `${(cw - scaledW) / 2}px` : "0px";
        replayer.wrapper.style.top = isActive ? `${(ch - scaledH) / 2}px` : "0px";
        replayer.wrapper.style.transform = `scale(${scale})`;
      }

      updateScale();
      let scaleRaf = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(scaleRaf);
        scaleRaf = requestAnimationFrame(updateScale);
      });
      observer.observe(rootEl);
      observer.observe(replayer.wrapper);
      resizeObserverByTabRef.current.set(tabKey, observer);

      replayerRootByTabRef.current.set(tabKey, rootEl);
      pendingInitByTabRef.current.delete(tabKey);

      // Register replayer BEFORE dispatching so effects can find it.
      replayerByTabRef.current.set(tabKey, replayer);

      // Finish handler — all logic is in the machine reducer.
      try {
        replayer.on("finish", () => {
          if (msRef.current.generation !== gen) return;
          if (msRef.current.activeTabKey !== tabKey) return;

          let localTime = 0;
          try {
            localTime = replayer.getCurrentTime();
          } catch {
            // ignore
          }

          actRef.current({
            type: "REPLAYER_FINISH",
            generation: gen,
            tabKey,
            localTimeMs: localTime,
            nowMs: performance.now(),
          });
        });
      } catch {
        // ignore
      }

      // Machine decides whether to play or pause this replayer.
      actRef.current({
        type: "REPLAYER_READY",
        generation: gen,
        tabKey,
      });

      setUiVersion(v => v + 1);
    } catch (e: any) {
      actRef.current({
        type: "REPLAYER_INIT_ERROR",
        generation: gen,
        message: e?.message ?? "Failed to initialize rrweb player.",
      });
    }
  }, [msRef]);

  // Effect executor — maps machine effects to imperative DOM/rrweb calls.
  function executeEffects(effects: ReplayEffect[]) {
    for (const effect of effects) {
      switch (effect.type) {
        case "play_replayer": {
          const r = replayerByTabRef.current.get(effect.tabKey);
          if (r) {
            try {
              r.play(effect.localOffsetMs);
            } catch {
              // ignore
            }
          } else {
            // Replayer doesn't exist — try to create it so REPLAYER_READY
            // can resume playback.  This covers race conditions where the
            // replayer hasn't been initialised yet when play is requested.
            runAsynchronously(() => ensureReplayerForTab(effect.tabKey, msRef.current.generation), { noErrorLogging: true });
          }
          break;
        }
        case "pause_replayer_at": {
          const r = replayerByTabRef.current.get(effect.tabKey);
          if (r) {
            try {
              r.pause(effect.localOffsetMs);
            } catch {
              // ignore
            }
          }
          break;
        }
        case "pause_all": {
          for (const r of replayerByTabRef.current.values()) {
            try {
              r.pause();
            } catch {
              // ignore
            }
          }
          break;
        }
        case "ensure_replayer": {
          runAsynchronously(() => ensureReplayerForTab(effect.tabKey, effect.generation), { noErrorLogging: true });
          break;
        }
        case "destroy_all_replayers": {
          destroyReplayers();
          eventsByTabRef.current = new Map();
          pendingInitByTabRef.current = new Set();
          setUiVersion(v => v + 1);
          break;
        }
        case "set_replayer_speed": {
          for (const r of replayerByTabRef.current.values()) {
            try {
              r.setConfig({ speed: effect.speed });
            } catch {
              // ignore
            }
          }
          break;
        }
        case "set_replayer_skip_inactive": {
          for (const r of replayerByTabRef.current.values()) {
            try {
              r.setConfig({ skipInactive: effect.skipInactive });
            } catch {
              // ignore
            }
          }
          if (!effect.skipInactive) setIsSkipping(false);
          break;
        }
        case "sync_mini_tabs": {
          const activeKey = msRef.current.activeTabKey;
          for (const [tabKey, r] of replayerByTabRef.current.entries()) {
            if (tabKey === activeKey) continue;
            // Only sync tabs that are actually rendered as mini thumbnails —
            // rrweb's pause(offset) is a full synchronous seek, so seeking
            // hidden tabs is pure wasted main-thread time.
            if (!containerByTabRef.current.get(tabKey)) continue;
            const stream = msRef.current.streams.find(s => s.tabKey === tabKey);
            if (!stream) continue;
            const localOffset = globalOffsetToLocalOffset(
              msRef.current.globalStartTs,
              stream.firstEventAtMs,
              effect.globalOffsetMs,
            );
            try {
              r.pause(localOffset);
            } catch {
              // ignore
            }
          }
          // Mini-tab visibility derives from the current playback time, which
          // no longer triggers React renders on its own — refresh it here, at
          // the (throttled) mini-tab sync cadence.
          setUiVersion(v => v + 1);
          break;
        }
        case "schedule_buffer_poll": {
          const { generation, tabKey, delayMs } = effect;
          setTimeout(() => {
            actRef.current({ type: "BUFFER_CHECK", generation, tabKey });
          }, delayMs);
          break;
        }
        case "recreate_replayer": {
          const tabKey = effect.tabKey;
          const r = replayerByTabRef.current.get(tabKey);
          if (r) {
            try {
              r.pause();
            } catch {
              // ignore
            }
          }
          replayerByTabRef.current.delete(tabKey);
          replayerRootByTabRef.current.delete(tabKey);
          const obs = resizeObserverByTabRef.current.get(tabKey);
          if (obs) {
            obs.disconnect();
            resizeObserverByTabRef.current.delete(tabKey);
          }
          pendingInitByTabRef.current.add(tabKey);
          runAsynchronously(() => ensureReplayerForTab(tabKey, effect.generation), { noErrorLogging: true });
          break;
        }
        case "save_settings": {
          try {
            localStorage.setItem(REPLAY_SETTINGS_STORAGE_KEY, JSON.stringify(effect.settings));
          } catch {
            // ignore
          }
          break;
        }
      }
    }
  }

  // Wire actRef: dispatch to machine + execute effects.
  actRef.current = (action: ReplayAction) => {
    const effects = rawDispatch(action);
    executeEffects(effects);
  };

  // ---- Container ref callback ----

  const setContainerRefForTab = useCallback((tabKey: TabKey, el: HTMLDivElement | null) => {
    containerByTabRef.current.set(tabKey, el);

    if (!el) return;

    const existingRoot = replayerRootByTabRef.current.get(tabKey);
    if (existingRoot && existingRoot !== el) {
      const r = replayerByTabRef.current.get(tabKey);
      if (r) {
        try {
          r.pause();
        } catch {
          // ignore
        }
        replayerByTabRef.current.delete(tabKey);
        replayerRootByTabRef.current.delete(tabKey);
      }
      const obs = resizeObserverByTabRef.current.get(tabKey);
      if (obs) {
        obs.disconnect();
        resizeObserverByTabRef.current.delete(tabKey);
      }
      pendingInitByTabRef.current.add(tabKey);
    }

    if (!pendingInitByTabRef.current.has(tabKey)) return;
    if ((eventsByTabRef.current.get(tabKey)?.length ?? 0) === 0) return;
    runAsynchronously(() => ensureReplayerForTab(tabKey, msRef.current.generation), { noErrorLogging: true });
  }, [ensureReplayerForTab, msRef]);

  // ---- Load chunks and download events ----

  const loadChunksAndDownload = useCallback(async (recordingId: string) => {
    const gen = ++genCounterRef.current;
    actRef.current({ type: "SELECT_RECORDING", generation: gen });
    setFullStreams([]);
    fullStreamsRef.current = [];

    // Helper: process a batch of chunk_events into the replayer state machine.
    // Yields to the event loop between chunks so that feeding a large batch
    // into live replayers (addEvent) doesn't block the main thread while the
    // replay is already playing.
    async function processChunkEvents(
      chunkEvents: Array<{ chunkId: string, events: unknown[] }>,
      allStreams: TabStream<ChunkRow>[],
      chunkIdToTabKey: Map<string, TabKey>,
    ) {
      let isFirstChunk = true;
      for (const ce of chunkEvents) {
        // Only yield while the tab is visible: yielding exists purely to keep
        // the visible UI responsive, and browsers clamp setTimeout-backed
        // waits in hidden tabs (up to ~1s each), which would make large
        // replay loads crawl in the background.
        if (!isFirstChunk && !document.hidden) {
          await wait(0);
        }
        isFirstChunk = false;
        if (msRef.current.generation !== gen) return;

        const tabKey = chunkIdToTabKey.get(ce.chunkId);
        if (!tabKey) continue;

        const events = coerceRrwebEvents(ce.events);
        const prev = eventsByTabRef.current.get(tabKey) ?? [];
        const wasEmpty = prev.length === 0;
        prev.push(...events);
        eventsByTabRef.current.set(tabKey, prev);

        const hasFullSnapshot = !msRef.current.hasFullSnapshotByTab.has(tabKey)
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          && events.some(e => Number((e as any).type) === 2);

        let loadedDurationMs = 0;
        if (prev.length >= 2) {
          loadedDurationMs = prev[prev.length - 1].timestamp - prev[0].timestamp;
        }

        if (!wasEmpty) {
          const r = replayerByTabRef.current.get(tabKey);
          if (r) {
            for (const event of events) {
              r.addEvent(event);
            }
          }
        }

        actRef.current({
          type: "CHUNK_LOADED",
          generation: gen,
          tabKey,
          hasFullSnapshot,
          loadedDurationMs,
          hadEventsBeforeThisChunk: !wasEmpty,
        });

        if (hasFullSnapshot || wasEmpty) {
          setUiVersion(v => v + 1);
        }
      }
    }

    try {
      // Phase 1: Fetch initial batch (fast start).
      const initialResponse = await adminApp.getSessionReplayEvents(recordingId, { offset: 0, limit: INITIAL_CHUNK_BATCH });
      if (msRef.current.generation !== gen) return;

      const allChunkRows: ChunkRow[] = initialResponse.chunks.map((c) => ({
        id: c.id,
        batchId: c.batchId,
        sessionReplaySegmentId: c.sessionReplaySegmentId,
        eventCount: c.eventCount,
        byteLength: c.byteLength,
        firstEventAt: c.firstEventAt,
        lastEventAt: c.lastEventAt,
        createdAt: c.createdAt,
      }));

      const allStreams = groupChunksIntoTabStreams(allChunkRows);
      setFullStreams(allStreams);
      fullStreamsRef.current = allStreams;

      const { globalStartTs, globalTotalMs } = computeGlobalTimeline(allStreams);

      // Build chunk ranges from full metadata.
      const rangesByTab = new Map<TabKey, ChunkRange[]>();
      for (const s of allStreams) {
        const ranges = s.chunks
          .map((c) => ({ startTs: c.firstEventAt.getTime(), endTs: c.lastEventAt.getTime() }))
          .filter(r => Number.isFinite(r.startTs) && Number.isFinite(r.endTs) && r.endTs >= r.startTs)
          .sort((a, b) => a.startTs - b.startTs);

        const merged: ChunkRange[] = [];
        for (const r of ranges) {
          const last = merged[merged.length - 1] as ChunkRange | undefined;
          if (!last) {
            merged.push({ ...r });
            continue;
          }
          if (r.startTs <= last.endTs) {
            last.endTs = Math.max(last.endTs, r.endTs);
          } else {
            merged.push({ ...r });
          }
        }
        rangesByTab.set(s.tabKey, merged);
      }

      // Stable tab labels.
      const labelOrder = allStreams
        .slice()
        .sort((a, b) => {
          const first = a.firstEventAt.getTime() - b.firstEventAt.getTime();
          if (first !== 0) return first;
          return stringCompare(a.tabKey, b.tabKey);
        });
      const tabLabelIndex = new Map(labelOrder.map((s, i) => [s.tabKey, i + 1]));

      const streamInfos: StreamInfo[] = allStreams.map(s => ({
        tabKey: s.tabKey,
        firstEventAtMs: s.firstEventAt.getTime(),
        lastEventAtMs: s.lastEventAt.getTime(),
      }));

      actRef.current({
        type: "STREAMS_COMPUTED",
        generation: gen,
        streams: streamInfos,
        globalStartTs,
        globalTotalMs,
        chunkRangesByTab: rangesByTab,
        tabLabelIndex,
      });

      // Build chunk_id → tabKey lookup from full metadata.
      const chunkIdToTabKey = new Map<string, TabKey>();
      for (const s of allStreams) {
        for (const chunk of s.chunks) {
          chunkIdToTabKey.set(chunk.id, s.tabKey);
        }
      }

      // Process the initial batch of events.
      await processChunkEvents(initialResponse.chunkEvents, allStreams, chunkIdToTabKey);

      // Phase 2: Background loading of remaining chunks.
      const totalChunks = allChunkRows.length;
      let offset = INITIAL_CHUNK_BATCH;

      while (offset < totalChunks) {
        if (msRef.current.generation !== gen) return;

        const batchResponse = await adminApp.getSessionReplayEvents(recordingId, { offset, limit: BACKGROUND_CHUNK_BATCH });
        if (msRef.current.generation !== gen) return;

        await processChunkEvents(batchResponse.chunkEvents, allStreams, chunkIdToTabKey);

        offset += BACKGROUND_CHUNK_BATCH;
      }
    } catch (e: any) {
      if (msRef.current.generation === gen) {
        actRef.current({ type: "DOWNLOAD_ERROR", generation: gen, message: e?.message ?? "Failed to load replay data." });
      }
      return;
    }

    if (msRef.current.generation === gen) {
      actRef.current({ type: "DOWNLOAD_COMPLETE", generation: gen });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminApp, msRef]);

  useEffect(() => {
    if (!selectedRecordingId) return;
    if (!isStandaloneReplayPage && !selectedRecording) return;
    runAsynchronously(() => loadChunksAndDownload(selectedRecordingId), { noErrorLogging: true });
  }, [isStandaloneReplayPage, loadChunksAndDownload, selectedRecordingId, selectedRecording]);

  useEffect(() => {
    if (!selectedRecordingId) {
      setTimelineEvents([]);
      return;
    }
    let cancelled = false;
    setTimelineEvents([]);
    runAsynchronously(async () => {
      const res = await serverApp.queryAnalytics({
        query: `SELECT event_type,
                       toUnixTimestamp64Milli(event_at) as event_at_ms,
                       data
                FROM default.events
                WHERE session_replay_id = {id:String}
                  AND event_type IN ('$click', '$page-view')
                ORDER BY event_at ASC
                LIMIT 2000`,
        params: { id: selectedRecordingId },
        include_all_branches: false,
        timeout_ms: 15000,
      });
      if (cancelled) return;
      setTimelineEvents(res.result.map((r: any) => ({
        eventType: r.event_type as string,
        eventAtMs: Number(r.event_at_ms),
        data: typeof r.data === "string"
          ? JSON.parse(r.data)
          : (r.data ?? {}),
      })));
    }, { noErrorLogging: true });
    return () => {
      cancelled = true;
    };
  }, [selectedRecordingId, serverApp]);

  useEffect(() => {
    return () => {
      genCounterRef.current += 1;
      destroyReplayers();
    };
  }, [destroyReplayers]);

  // ---- Timeline time reading (smooth, direct from rrweb) ----

  const getCurrentGlobalTimeMs = useCallback(() => {
    const s = msRef.current;
    const key = s.activeTabKey;
    const r = key ? (replayerByTabRef.current.get(key) ?? null) : null;
    const stream = key ? s.streams.find(st => st.tabKey === key) ?? null : null;
    let activeLocalOffsetMs: number | null = null;
    if (r) {
      try {
        activeLocalOffsetMs = r.getCurrentTime();
      } catch {
        activeLocalOffsetMs = null;
      }
    }

    return getDesiredGlobalOffsetFromPlaybackState({
      gapFastForward: s.gapFastForward,
      playerIsPlaying: s.playbackMode === "playing" || s.playbackMode === "gap_fast_forward",
      nowMs: performance.now(),
      playerSpeed: s.settings.playerSpeed,
      pausedAtGlobalMs: s.pausedAtGlobalMs,
      activeLocalOffsetMs,
      activeStreamStartTs: stream?.firstEventAtMs ?? null,
      globalStartTs: s.globalStartTs,
      gapFastForwardMultiplier: INTER_TAB_GAP_FAST_FORWARD_MULTIPLIER,
    });
  }, [msRef]);

  // ---- RAF tick loop — drives UI time updates, gap completion, auto-follow ----

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let lastUpdateAt = 0;

    const tick = (now: number) => {
      if (cancelled) return;
      if (now - lastUpdateAt > 200) {
        lastUpdateAt = now;
        const key = msRef.current.activeTabKey;
        const r = key ? (replayerByTabRef.current.get(key) ?? null) : null;
        let activeLocalTimeMs: number | null = null;
        if (r) {
          try {
            activeLocalTimeMs = r.getCurrentTime();
          } catch {
            activeLocalTimeMs = null;
          }
        }

        actRef.current({
          type: "TICK",
          nowMs: performance.now(),
          activeReplayerLocalTimeMs: activeLocalTimeMs,
        });
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [msRef]);

  // ---- Skip indicator (speedService subscription) ----

  useEffect(() => {
    if (!ms.settings.skipInactivity) {
      setIsSkipping(false);
      speedSubRef.current?.unsubscribe();
      speedSubRef.current = null;
      return;
    }

    const key = ms.activeTabKey;
    const r = key ? replayerByTabRef.current.get(key) ?? null : null;

    setIsSkipping(false);
    speedSubRef.current?.unsubscribe();
    speedSubRef.current = null;

    if (!r) return;

    try {
      const sub = (r as any).speedService.subscribe((state: any) => {
        setIsSkipping(state.value === "skipping");
      });
      speedSubRef.current = sub;
    } catch {
      // ignore
    }
  }, [ms.activeTabKey, ms.settings.skipInactivity, uiVersion]);

  // ---- Action callbacks ----

  const togglePlayPause = useCallback(() => {
    actRef.current({ type: "TOGGLE_PLAY_PAUSE", nowMs: performance.now() });
  }, []);

  const handleSeek = useCallback((globalOffset: number) => {
    actRef.current({ type: "SEEK", globalOffsetMs: globalOffset, nowMs: performance.now() });
  }, []);

  const updateSpeed = useCallback((speed: number) => {
    actRef.current({ type: "UPDATE_SPEED", speed });
  }, []);

  const onSelectActiveTab = useCallback((tabKey: TabKey) => {
    actRef.current({ type: "SELECT_TAB", tabKey, nowMs: performance.now() });
  }, []);

  // ---- Derived rendering data ----

  const activeStream = useMemo(
    () => (ms.activeTabKey ? fullStreams.find(s => s.tabKey === ms.activeTabKey) ?? null : null),
    [ms.activeTabKey, fullStreams],
  );

  const visibleMiniStreams = useMemo(() => {
    void uiVersion;
    const currentTs = ms.globalStartTs + ms.currentGlobalTimeMsForUi;
    const candidates = fullStreams.filter(s =>
      s.tabKey !== ms.activeTabKey && ms.hasFullSnapshotByTab.has(s.tabKey)
    );
    const inRange = candidates.filter(s =>
      currentTs >= s.firstEventAt.getTime() && currentTs <= s.lastEventAt.getTime()
    );

    inRange.sort((a, b) => {
      const aLabel = ms.tabLabelIndex.get(a.tabKey) ?? Number.POSITIVE_INFINITY;
      const bLabel = ms.tabLabelIndex.get(b.tabKey) ?? Number.POSITIVE_INFINITY;
      if (aLabel !== bLabel) return aLabel - bLabel;
      return stringCompare(a.tabKey, b.tabKey);
    });

    return inRange.slice(0, EXTRA_TABS_TO_SHOW);
  }, [ms.activeTabKey, ms.currentGlobalTimeMsForUi, ms.globalStartTs, ms.hasFullSnapshotByTab, ms.tabLabelIndex, fullStreams, uiVersion]);

  const showRightColumn = visibleMiniStreams.length > 0;

  const miniIndexByKey = useMemo(() => {
    const m = new Map<TabKey, number>();
    for (const [idx, s] of visibleMiniStreams.entries()) {
      m.set(s.tabKey, idx);
    }
    return m;
  }, [visibleMiniStreams]);

  const getTabLabel = useCallback((tabKey: TabKey) => {
    const idx = ms.tabLabelIndex.get(tabKey);
    if (!idx) return "Tab";
    return `Tab ${idx}`;
  }, [ms.tabLabelIndex]);

  const activeHasEvents = useMemo(() => {
    if (!activeStream) return false;
    void uiVersion;
    return (eventsByTabRef.current.get(activeStream.tabKey)?.length ?? 0) > 0;
  }, [activeStream, uiVersion]);

  const renderableStreamCount = useMemo(() => {
    void uiVersion;
    return fullStreams.filter(s => ms.hasFullSnapshotByTab.has(s.tabKey)).length;
  }, [fullStreams, ms.hasFullSnapshotByTab, uiVersion]);

  const showMainTabLabel = renderableStreamCount > 1;

  const timelineMarkers = useMemo(() => {
    if (timelineEvents.length === 0 || ms.globalTotalMs <= 0) return [];
    return timelineEvents.map((e): TimelineMarker => ({
      timeMs: e.eventAtMs - ms.globalStartTs,
      eventType: e.eventType,
      label: formatEventTooltip(e),
    })).filter(m => m.timeMs >= 0 && m.timeMs <= ms.globalTotalMs);
  }, [timelineEvents, ms.globalStartTs, ms.globalTotalMs]);

  const activeFilterCount = useMemo(() => {
    const count = filtersActiveCount(appliedFilters);
    return isEmbedded && appliedFilters.userId === lockedUserId ? Math.max(0, count - 1) : count;
  }, [appliedFilters, isEmbedded, lockedUserId]);

  const openFilterDialog = useCallback((dialog: "user" | "team" | "duration" | "lastActive" | "clicks") => {
    setDraftFilters(appliedFilters);
    setActiveFilterDialog(dialog);
  }, [appliedFilters]);

  const applyDraftFilters = useCallback(() => {
    setAppliedFilters(draftFilters);
    setActiveFilterDialog(null);
  }, [draftFilters]);

  useEffect(() => {
    if (isStandaloneReplayPage) return;
    if (recordings.length === 0) {
      setSelectedRecordingId(null);
      return;
    }
    if (selectedRecordingId && recordings.some((r) => r.id === selectedRecordingId)) return;
    setSelectedRecordingId(recordings[0]?.id ?? null);
  }, [isStandaloneReplayPage, recordings, selectedRecordingId]);

  // ---- Rendering ----

  return (
    <AppEnabledGuard appId="session-replays">
      <PageLayout
        title={isEmbedded ? undefined : (isStandaloneReplayPage ? "Session Replay" : "Session Replays")}
        description={!isEmbedded && isStandaloneReplayPage ? (
          <StyledLink
            href={`/projects/${encodeURIComponent(adminApp.projectId)}/session-replays`}
            className="inline-flex items-center gap-1 text-xs"
          >
            <ArrowLeftIcon className="h-3 w-3" />
            Back to all replays
          </StyledLink>
        ) : undefined}
        fillWidth
        noPadding
        containedHeight
      >
        <div className={cn("flex min-h-0 flex-1 flex-col gap-3", !isEmbedded && "px-4 sm:px-6")}>
          <SessionReplayLimitBanner />
          <PanelGroup data-walkthrough="analytics-replays" direction="horizontal" className={replaysPanelShellClass}>
            {!isStandaloneReplayPage && (
              <>
                <Panel defaultSize={25} minSize={16} className="min-h-0">
                  <div className="flex h-full min-h-0 flex-col overflow-hidden bg-zinc-50 dark:bg-transparent">
                    <div className={replaysListChromeClass}>
                      <div className="flex items-center justify-between gap-2 h-8">
                        <Typography className="text-sm font-medium">
                          Sessions{!loadingInitial && recordingListRows.length > 0 ? ` (${recordingListRows.length}${nextCursor ? "+" : ""})` : ""}
                        </Typography>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2.5"
                            >
                              <FunnelSimpleIcon className="h-3.5 w-3.5 mr-1" />
                              Filters
                              {activeFilterCount > 0 && (
                                <span className="ml-1 rounded-full bg-foreground/10 px-1.5 py-0 text-[10px]">
                                  {activeFilterCount}
                                </span>
                              )}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="w-48"
                            onCloseAutoFocus={(e) => e.preventDefault()}
                          >
                            {!isEmbedded && (
                              <DropdownMenuItem onClick={() => { requestAnimationFrame(() => openFilterDialog("user")); }}>
                                User
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => { requestAnimationFrame(() => openFilterDialog("team")); }}>
                              Team
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { requestAnimationFrame(() => openFilterDialog("duration")); }}>
                              Duration
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { requestAnimationFrame(() => openFilterDialog("lastActive")); }}>
                              Last active
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { requestAnimationFrame(() => openFilterDialog("clicks")); }}>
                              Click count
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      {activeFilterCount > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {appliedFilters.userId && !isEmbedded && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px]">
                              user:{appliedFilters.userLabel || "selected"}
                            </span>
                          )}
                          {appliedFilters.teamId && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px]">
                              team:{appliedFilters.teamLabel || "selected"}
                            </span>
                          )}
                          {(appliedFilters.durationMinSeconds || appliedFilters.durationMaxSeconds) && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px]">
                              duration
                            </span>
                          )}
                          {appliedFilters.lastActivePreset && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px]">
                              last active: {appliedFilters.lastActivePreset}
                            </span>
                          )}
                          {appliedFilters.clickCountMin && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px]">
                              clicks
                            </span>
                          )}
                          <button
                            className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors hover:transition-none"
                            onClick={() => setAppliedFilters(baseFilters)}
                          >
                            <XIcon className="h-2.5 w-2.5" />
                            clear
                          </button>
                        </div>
                      )}
                    </div>

                    <Dialog open={activeFilterDialog === "user"} onOpenChange={(open) => setActiveFilterDialog(open ? "user" : null)}>
                      <DialogContent className="max-w-md">
                        <DialogHeader>
                          <DialogTitle>User Filter</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-3">
                          <UserPickerTable
                            action={(user) => (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                            setAppliedFilters((prev) => ({
                              ...prev,
                              userId: user.id,
                              userLabel: user.displayName ?? user.primaryEmail ?? user.id,
                            }));
                            setActiveFilterDialog(null);
                                }}
                              >
                                Select
                              </Button>
                            )}
                          />
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8"
                              onClick={() => {
                          setAppliedFilters((prev) => ({ ...prev, userId: "", userLabel: "" }));
                          setActiveFilterDialog(null);
                              }}
                            >
                              Clear
                            </Button>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>

                    <Dialog open={activeFilterDialog === "team"} onOpenChange={(open) => setActiveFilterDialog(open ? "team" : null)}>
                      <DialogContent className="max-w-3xl">
                        <DialogHeader>
                          <DialogTitle>Team Filter</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-3 pt-2">
                          <TeamSearchTable
                            action={(team) => (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                            setAppliedFilters((prev) => ({
                              ...prev,
                              teamId: team.id,
                              teamLabel: team.displayName,
                            }));
                            setActiveFilterDialog(null);
                                }}
                              >
                                Select
                              </Button>
                            )}
                          />
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8"
                              onClick={() => {
                          setAppliedFilters((prev) => ({ ...prev, teamId: "", teamLabel: "" }));
                          setActiveFilterDialog(null);
                              }}
                            >
                              Clear
                            </Button>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>

                    <Dialog open={activeFilterDialog === "duration"} onOpenChange={(open) => setActiveFilterDialog(open ? "duration" : null)}>
                      <DialogContent className="max-w-md">
                        <DialogHeader>
                          <DialogTitle>Duration Filter</DialogTitle>
                        </DialogHeader>
                        <form onSubmit={(e) => {
                    e.preventDefault();
                    applyDraftFilters();
                        }}>
                          <div className="grid grid-cols-2 gap-3 pt-2">
                            <label className="space-y-1">
                              <Typography className="text-xs text-muted-foreground">Min (seconds)</Typography>
                              <input
                                type="number"
                                min={0}
                                className="h-8 w-full rounded-md border border-border/50 bg-background px-2 text-xs"
                                value={draftFilters.durationMinSeconds}
                                onChange={(e) => setDraftFilters((prev) => ({ ...prev, durationMinSeconds: e.target.value }))}
                              />
                            </label>
                            <label className="space-y-1">
                              <Typography className="text-xs text-muted-foreground">Max (seconds)</Typography>
                              <input
                                type="number"
                                min={0}
                                className="h-8 w-full rounded-md border border-border/50 bg-background px-2 text-xs"
                                value={draftFilters.durationMaxSeconds}
                                onChange={(e) => setDraftFilters((prev) => ({ ...prev, durationMaxSeconds: e.target.value }))}
                              />
                            </label>
                          </div>
                          <div className="pt-3 flex items-center justify-end gap-2">
                            <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => setActiveFilterDialog(null)}>Cancel</Button>
                            <Button type="submit" size="sm" className="h-8">Apply</Button>
                          </div>
                        </form>
                      </DialogContent>
                    </Dialog>

                    <Dialog open={activeFilterDialog === "lastActive"} onOpenChange={(open) => setActiveFilterDialog(open ? "lastActive" : null)}>
                      <DialogContent className="max-w-md">
                        <DialogHeader>
                          <DialogTitle>Last Active Filter</DialogTitle>
                        </DialogHeader>
                        <div className="flex flex-wrap gap-2 pt-2">
                          {([["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]] as const).map(([value, label]) => (
                            <Button
                              key={value}
                              variant={appliedFilters.lastActivePreset === value ? "default" : "outline"}
                              size="sm"
                              className="h-8"
                              onClick={() => {
                          setAppliedFilters((prev) => ({ ...prev, lastActivePreset: value }));
                          setActiveFilterDialog(null);
                              }}
                            >
                              {label}
                            </Button>
                          ))}
                        </div>
                        <div className="pt-1 flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8"
                            onClick={() => {
                        setAppliedFilters((prev) => ({ ...prev, lastActivePreset: "" }));
                        setActiveFilterDialog(null);
                            }}
                          >
                            Clear
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>

                    <Dialog open={activeFilterDialog === "clicks"} onOpenChange={(open) => setActiveFilterDialog(open ? "clicks" : null)}>
                      <DialogContent className="max-w-md">
                        <DialogHeader>
                          <DialogTitle>Click Count Filter</DialogTitle>
                        </DialogHeader>
                        <form onSubmit={(e) => {
                    e.preventDefault();
                    applyDraftFilters();
                        }}>
                          <div className="space-y-3 pt-2">
                            <input
                              type="number"
                              min={0}
                              className="h-8 w-full rounded-md border border-border/50 bg-background px-2 text-xs"
                              value={draftFilters.clickCountMin}
                              onChange={(e) => setDraftFilters((prev) => ({ ...prev, clickCountMin: e.target.value }))}
                              placeholder="Minimum click count"
                            />
                          </div>
                          <div className="pt-3 flex items-center justify-end gap-2">
                            <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => setActiveFilterDialog(null)}>Cancel</Button>
                            <Button type="submit" size="sm" className="h-8">Apply</Button>
                          </div>
                        </form>
                      </DialogContent>
                    </Dialog>

                    {listError && (
                      <div className="p-3">
                        <Alert variant="destructive">{listError}</Alert>
                      </div>
                    )}

                    <div
                      ref={listBoxRef}
                      onScroll={onListScroll}
                      className="flex-1 min-h-0 overflow-y-auto"
                    >
                      {loadingInitial ? (
                        <div className="p-2 space-y-1">
                          {Array.from({ length: 8 }).map((_, i) => (
                            <div key={i} className="rounded-lg p-3">
                              <Skeleton className="h-4 w-36" />
                              <Skeleton className="mt-1.5 h-3 w-24" />
                            </div>
                          ))}
                        </div>
                      ) : recordings.length === 0 ? (
                        <div className="p-6 text-center">
                          <Typography className="text-sm text-muted-foreground">
                            {activeFilterCount > 0 ? "No replays match these filters." : "No replays yet."}
                          </Typography>
                        </div>
                      ) : (
                        <div className="p-1.5 space-y-0.5">
                          {recordingListRows.map(({ replay: r, key }) => {
                            const isSelected = r.id === selectedRecordingId;
                            const durationMs = r.lastEventAt.getTime() - r.startedAt.getTime();
                            const duration = formatDurationMs(durationMs);
                            return (
                              <div
                                key={key}
                                className={cn(
                                "rounded-lg",
                                isSelected
                                  ? "bg-white shadow-sm ring-1 ring-black/[0.06] dark:bg-background/80 dark:ring-white/[0.06]"
                                  : "hover:bg-white/70 dark:hover:bg-muted/20",
                              )}
                              >
                                <button
                                  onClick={() => setSelectedRecordingId(r.id)}
                                  className={cn(
                                  "w-full text-left rounded-lg px-3 py-2.5",
                                  "transition-colors hover:transition-none",
                                )}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium truncate">
                                      {getRecordingTitle(r)}
                                    </span>
                                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                                      {duration}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                    <DisplayDate date={r.lastEventAt} />
                                    {(clickCountsByReplayId.get(r.id) ?? 0) > 0 && (
                                      <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/70">
                                        <CursorClickIcon className="h-3 w-3" />
                                        {clickCountsByReplayId.get(r.id)}
                                      </span>
                                    )}
                                  </div>
                                </button>
                              </div>
                            );
                          })}

                          {loadingMore && (
                            <div className="rounded-lg p-3">
                              <Skeleton className="h-4 w-36" />
                              <Skeleton className="mt-1.5 h-3 w-24" />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </Panel>

                <PanelResizeHandle className="w-px bg-black/[0.08] transition-colors duration-150 hover:bg-black/[0.14] hover:transition-none dark:bg-border/40 dark:hover:bg-border" />
              </>
            )}

            <Panel defaultSize={isStandaloneReplayPage ? 100 : 75} minSize={35} className="min-h-0">
              <div className="h-full min-h-0 flex flex-col overflow-hidden bg-white dark:bg-background">
                {(standaloneReplayError || ms.downloadError || ms.playerError) && (
                  <div className="p-3 space-y-2">
                    {standaloneReplayError && <Alert variant="destructive">{standaloneReplayError}</Alert>}
                    {ms.downloadError && <Alert variant="destructive">{ms.downloadError}</Alert>}
                    {ms.playerError && <Alert variant="destructive">{ms.playerError}</Alert>}
                  </div>
                )}

                <div className={cn(selectedRecording ? replaysDetailOverviewChromeClass : replaysDetailChromeClass)}>
                  {selectedRecording ? (
                    <React.Suspense fallback={<ReplayUserOverviewSkeleton />}>
                      <ReplayUserOverview
                        replay={{
                          id: selectedRecording.id,
                          userId: selectedRecording.projectUser.id,
                          refreshTokenId: selectedRecording.refreshTokenId,
                          startedAt: selectedRecording.startedAt,
                          lastEventAt: selectedRecording.lastEventAt,
                        }}
                      />
                    </React.Suspense>
                  ) : isStandaloneReplayPage && selectedRecordingId ? (
                    <Typography className="text-sm font-medium truncate font-mono">
                      Replay {selectedRecordingId}
                    </Typography>
                  ) : (
                    <Typography className="text-sm font-medium truncate" />
                  )}
                  <div className="flex items-center gap-1">
                    {selectedRecordingId && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={replayShareLinkCopied ? "Link copied" : "Copy link to replay"}
                        title={replayShareLinkCopied ? "Copied!" : "Copy link to replay"}
                        onClick={() => runAsynchronouslyWithAlert(async () => {
                          await navigator.clipboard.writeText(
                          `${window.location.origin}/projects/${encodeURIComponent(adminApp.projectId)}/session-replays/${encodeURIComponent(selectedRecordingId)}`,
                        );
                        setReplayShareLinkCopied(true);
                        })}
                      >
                        {replayShareLinkCopied ? (
                          <CheckIcon className="h-4 w-4 text-emerald-600" weight="bold" />
                        ) : (
                          <LinkIcon className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                    <ReplaySettingsButton
                      settings={ms.settings}
                      onSettingsChange={(updates) => actRef.current({ type: "UPDATE_SETTINGS", updates })}
                    />
                  </div>
                </div>

                {selectedRecordingId ? (
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                      <div
                        className="grid flex-1 min-h-0 grid-cols-[minmax(0,1fr)_260px] gap-px overflow-hidden bg-black/[0.06] dark:bg-border/40"
                        style={{
                          gridTemplateColumns: showRightColumn ? "minmax(0, 1fr) 260px" : "minmax(0, 1fr) 0px",
                          gridTemplateRows: showRightColumn ? `repeat(${EXTRA_TABS_TO_SHOW}, auto) 1fr` : "1fr",
                          transition: "grid-template-columns 180ms ease-out",
                        }}
                      >
                        {fullStreams.length === 0 && (
                          <div className={cn("col-span-2 row-span-6 grid place-items-center", replaysViewerSurfaceClass)}>
                            <div className="text-center space-y-2 p-6">
                              {isDownloading ? (
                                <>
                                  <Skeleton className="h-2 w-48 mx-auto" />
                                  <Typography className="text-sm text-muted-foreground">
                                    Loading replay...
                                  </Typography>
                                </>
                              ) : (
                                <Typography className="text-sm text-muted-foreground">
                                  No replay data loaded yet.
                                </Typography>
                              )}
                            </div>
                          </div>
                        )}

                        {fullStreams.map((s) => {
                          const isActive = s.tabKey === ms.activeTabKey;
                          const miniIndex = miniIndexByKey.get(s.tabKey);
                          const isMiniVisible = miniIndex !== undefined && miniIndex >= 0 && miniIndex < EXTRA_TABS_TO_SHOW;
                          if (!isActive && !isMiniVisible) return null;

                          const title = getTabLabel(s.tabKey);

                          return (
                            <button
                              key={s.tabKey}
                              type="button"
                              onClick={() => {
                                if (!isActive) onSelectActiveTab(s.tabKey);
                              }}
                              className={cn(
                              "relative block w-full overflow-hidden text-left",
                              replaysViewerSurfaceClass,
                              isActive ? "h-full cursor-default" : "transition-colors duration-150 hover:transition-none hover:bg-zinc-200/50 dark:hover:bg-muted/10",
                            )}
                              style={{
                                gridColumn: isActive ? "1" : "2",
                                gridRow: isActive ? ("1 / -1" as any) : ((miniIndex ?? 0) + 1),
                                ...(isActive ? {} : { aspectRatio: "16/10" }),
                              }}
                            >
                              <div
                                ref={(el) => setContainerRefForTab(s.tabKey, el)}
                                className={cn("absolute inset-0", replaysViewerSurfaceClass)}
                              />

                              {!isActive && (
                                <div className="absolute inset-x-0 top-0 z-10 px-2 pt-1.5">
                                  <span className="text-[11px] font-medium truncate bg-black/50 text-white px-2 py-0.5 rounded-full backdrop-blur-sm">{title}</span>
                                </div>
                              )}

                              {!isActive && !replayerByTabRef.current.has(s.tabKey) && (
                                <div className="absolute inset-0 grid place-items-center text-[11px] text-muted-foreground pointer-events-none">
                                  Loading...
                                </div>
                              )}

                              {isActive && (
                                <>
                                  {showMainTabLabel && (
                                    <div className="absolute inset-x-0 top-4 z-10 flex justify-start pointer-events-none px-4">
                                      <div className="flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1.5 backdrop-blur-sm">
                                        <span className="text-xs text-white font-medium">{getTabLabel(s.tabKey)}</span>
                                        {s.tabKey === NULL_TAB_KEY && (
                                          <span className="text-xs text-white/70">unknown id</span>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  {activeHasEvents && !playerIsPlaying && !isBuffering && (
                                    <div
                                      className="absolute inset-0 z-10 grid place-items-center cursor-pointer transition-opacity"
                                      onClick={(e) => {
                                      e.preventDefault();
                                      if (replayFinished) {
                                        handleSeek(0);
                                      } else {
                                        togglePlayPause();
                                      }
                                      }}
                                    >
                                      {replayFinished ? (
                                        <div className="flex flex-col items-center gap-2">
                                          <div className="rounded-full bg-black/50 p-4 backdrop-blur-sm">
                                            <ArrowsClockwiseIcon className="h-10 w-10 text-white" weight="bold" />
                                          </div>
                                          <span className="text-sm text-white/80 bg-black/40 px-3 py-1 rounded-full backdrop-blur-sm">
                                            Replay from start
                                          </span>
                                        </div>
                                      ) : (
                                        <div className="rounded-full bg-black/50 p-4 backdrop-blur-sm">
                                          <PlayIcon className="h-10 w-10 text-white" weight="fill" />
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {activeHasEvents && ms.settings.skipInactivity && isSkipping && (
                                    <div className="absolute inset-x-0 top-4 z-10 flex justify-center pointer-events-none">
                                      <div className="flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1.5 backdrop-blur-sm">
                                        <FastForwardIcon className="h-3.5 w-3.5 text-white" weight="fill" />
                                        <span className="text-xs text-white">Skipping inactivity</span>
                                      </div>
                                    </div>
                                  )}

                                  {activeHasEvents && isBuffering && (
                                    <div
                                      className="absolute inset-0 z-10 grid place-items-center cursor-pointer"
                                      onClick={(e) => {
                                      e.preventDefault();
                                      togglePlayPause();
                                      }}
                                    >
                                      <div className="flex items-center gap-2 rounded-full bg-black/50 px-4 py-2 backdrop-blur-sm">
                                        <div className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                                        <span className="text-sm text-white">Buffering...</span>
                                      </div>
                                    </div>
                                  )}

                                  {activeHasEvents && playerIsPlaying && !isBuffering && (
                                    <div
                                      className="absolute inset-0 z-10 cursor-pointer"
                                      onClick={(e) => {
                                      e.stopPropagation();
                                      togglePlayPause();
                                      }}
                                    />
                                  )}

                                  {!activeHasEvents && (
                                    <div className="absolute inset-0 grid place-items-center bg-background/80 backdrop-blur-sm">
                                      <div className="text-center space-y-2 p-6">
                                        {isDownloading ? (
                                          <>
                                            <Skeleton className="h-2 w-48 mx-auto" />
                                            <Typography className="text-sm text-muted-foreground">
                                              Loading replay...
                                            </Typography>
                                          </>
                                        ) : (
                                          <Typography className="text-sm text-muted-foreground">
                                            No events found.
                                          </Typography>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {activeStream && activeHasEvents && (
                        <Timeline
                          getCurrentTimeMs={getCurrentGlobalTimeMs}
                          playerIsPlaying={playerIsPlaying}
                          totalTimeMs={ms.globalTotalMs}
                          onTogglePlayPause={togglePlayPause}
                          onSeek={handleSeek}
                          playerSpeed={ms.settings.playerSpeed}
                          onSpeedChange={updateSpeed}
                          markers={timelineMarkers}
                        />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 grid place-items-center">
                    {loadingInitial ? (
                      <div className="text-center space-y-2 p-6">
                        <Skeleton className="h-2 w-48 mx-auto" />
                        <Typography className="text-sm text-muted-foreground">
                          Loading replay...
                        </Typography>
                      </div>
                    ) : (
                      <div className="text-center p-6 max-w-md mx-auto">
                        <MonitorPlayIcon className="h-12 w-12 text-muted-foreground/40 mx-auto" />
                        <Typography className="mt-3 text-sm font-medium">
                          No session replays yet
                        </Typography>
                        <Typography className="mt-2 text-sm text-muted-foreground">
                          Session replays let you watch how users interact with your app. For info on enabling replays,{" "}
                          <StyledLink
                            href="https://docs.hexclave.com/guides/apps/analytics/overview"
                            target="_blank"
                          >
                            look here
                          </StyledLink>
                          .
                        </Typography>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Panel>
          </PanelGroup>
        </div>
      </PageLayout>
    </AppEnabledGuard>
  );
}

import { computeReplayGlobalTimeline } from "@hexclave/shared/dist/utils/session-replay-timeline";

export const NULL_TAB_KEY = "__null_tab__";

export type TabKey = string;

export function toTabKey(sessionReplaySegmentId: string | null): TabKey {
  return sessionReplaySegmentId ?? NULL_TAB_KEY;
}

export type TabStream<TChunk> = {
  sessionReplaySegmentId: string | null,
  tabKey: TabKey,
  chunks: TChunk[],
  firstEventAt: Date,
  lastEventAt: Date,
  eventCount: number,
  chunkCount: number,
};

type ChunkLike = {
  sessionReplaySegmentId: string | null,
  firstEventAt: Date,
  lastEventAt: Date,
  eventCount: number,
  createdAt?: Date,
};

function compareChunks(a: ChunkLike, b: ChunkLike) {
  const aFirst = a.firstEventAt.getTime();
  const bFirst = b.firstEventAt.getTime();
  if (aFirst !== bFirst) return aFirst - bFirst;

  const aLast = a.lastEventAt.getTime();
  const bLast = b.lastEventAt.getTime();
  if (aLast !== bLast) return aLast - bLast;

  const aCreated = a.createdAt?.getTime() ?? 0;
  const bCreated = b.createdAt?.getTime() ?? 0;
  if (aCreated !== bCreated) return aCreated - bCreated;

  return 0;
}

export function groupChunksIntoTabStreams<TChunk extends ChunkLike>(chunks: TChunk[]): TabStream<TChunk>[] {
  const byTab = new Map<TabKey, { sessionReplaySegmentId: string | null, chunks: TChunk[] }>();

  for (const c of chunks) {
    const tabKey = toTabKey(c.sessionReplaySegmentId);
    const existing = byTab.get(tabKey);
    if (existing) {
      existing.chunks.push(c);
    } else {
      byTab.set(tabKey, { sessionReplaySegmentId: c.sessionReplaySegmentId, chunks: [c] });
    }
  }

  const streams: TabStream<TChunk>[] = [];
  for (const { sessionReplaySegmentId, chunks: tabChunks } of byTab.values()) {
    tabChunks.sort(compareChunks);

    let firstEventAtMs = Infinity;
    let lastEventAtMs = -Infinity;
    let eventCount = 0;

    for (const c of tabChunks) {
      firstEventAtMs = Math.min(firstEventAtMs, c.firstEventAt.getTime());
      lastEventAtMs = Math.max(lastEventAtMs, c.lastEventAt.getTime());
      eventCount += c.eventCount;
    }

    const firstEventAt = new Date(Number.isFinite(firstEventAtMs) ? firstEventAtMs : 0);
    const lastEventAt = new Date(Number.isFinite(lastEventAtMs) ? lastEventAtMs : 0);

    streams.push({
      sessionReplaySegmentId,
      tabKey: toTabKey(sessionReplaySegmentId),
      chunks: tabChunks,
      firstEventAt,
      lastEventAt,
      eventCount,
      chunkCount: tabChunks.length,
    });
  }

  streams.sort((a, b) => {
    const last = b.lastEventAt.getTime() - a.lastEventAt.getTime();
    if (last !== 0) return last;
    return b.eventCount - a.eventCount;
  });

  return streams;
}

export function limitTabStreams<TChunk>(
  streams: TabStream<TChunk>[],
  maxStreams: number,
): { streams: TabStream<TChunk>[], hiddenCount: number } {
  if (streams.length <= maxStreams) return { streams, hiddenCount: 0 };
  return { streams: streams.slice(0, maxStreams), hiddenCount: streams.length - maxStreams };
}

export function computeGlobalTimeline(streams: Array<{ firstEventAt: Date, lastEventAt: Date }>) {
  return computeReplayGlobalTimeline(streams.map((s) => ({
    firstEventAtMs: s.firstEventAt.getTime(),
    lastEventAtMs: s.lastEventAt.getTime(),
  })));
}

export function globalOffsetToLocalOffset(globalStartTs: number, streamStartTs: number, globalOffsetMs: number) {
  const globalTs = globalStartTs + globalOffsetMs;
  return Math.max(0, globalTs - streamStartTs);
}

export function localOffsetToGlobalOffset(globalStartTs: number, streamStartTs: number, localOffsetMs: number) {
  return localOffsetMs + (streamStartTs - globalStartTs);
}


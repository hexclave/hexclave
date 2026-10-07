export type AdminSessionReplay = {
  id: string,
  /** The session the replay was recorded in; analytics events of the same session carry it too. */
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

export type AdminSessionReplayChunk = {
  id: string,
  batchId: string,
  sessionReplaySegmentId: string | null,
  browserSessionId: string | null,
  eventCount: number,
  byteLength: number,
  firstEventAt: Date,
  lastEventAt: Date,
  createdAt: Date,
};

export type ListSessionReplaysOptions = {
  limit?: number,
  cursor?: string,
  userIds?: string[],
  teamIds?: string[],
  durationMsMin?: number,
  durationMsMax?: number,
  lastEventAtFromMillis?: number,
  lastEventAtToMillis?: number,
  clickCountMin?: number,
};

export type ListSessionReplaysResult = {
  items: AdminSessionReplay[],
  nextCursor: string | null,
};

export type ListSessionReplayChunksOptions = {
  limit?: number,
  cursor?: string,
};

export type ListSessionReplayChunksResult = {
  items: AdminSessionReplayChunk[],
  nextCursor: string | null,
};

export type SessionReplayAllEventsResult = {
  chunks: Array<{
    id: string,
    batchId: string,
    sessionReplaySegmentId: string | null,
    eventCount: number,
    byteLength: number,
    firstEventAt: Date,
    lastEventAt: Date,
    createdAt: Date,
  }>,
  chunkEvents: Array<{
    chunkId: string,
    events: unknown[],
  }>,
};

export type AdminSessionReplayRender = {
  id: string,
  sessionReplayId: string,
  /** The tab (segment) of the replay that is rendered. */
  sessionReplaySegmentId: string,
  status: "queued" | "rendering" | "succeeded" | "failed",
  /** Fraction of frames rendered so far (0 to 1), or null before rendering starts. */
  progress: number | null,
  options: {
    fps: number,
    speed: number,
    skipInactivity: boolean,
  },
  errorMessage: string | null,
  createdAt: Date,
  startedAt: Date | null,
  finishedAt: Date | null,
  /** Set once `status` is `"succeeded"`. */
  video: {
    /** Short-lived download URL for the MP4; fetch the render again for a fresh one. */
    url: string,
    urlExpiresAt: Date,
    byteLength: number,
    width: number,
    height: number,
    durationMs: number,
  } | null,
};

export type RenderSessionReplayOptions = {
  /** Which tab of the replay to render. Defaults to the tab with the most activity. */
  sessionReplaySegmentId?: string,
  /** Frames per second, 1–30. Defaults to 15. */
  fps?: number,
  /** Playback speed multiplier, 0.25–8. Defaults to 1. */
  speed?: number,
  /** Cut idle stretches longer than two seconds down to about one second. Defaults to true. */
  skipInactivity?: boolean,
};

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

export type SessionReplayUserKind = "anonymous" | "verified";

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
  userKind?: SessionReplayUserKind,
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

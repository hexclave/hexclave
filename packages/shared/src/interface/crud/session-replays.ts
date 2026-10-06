export type AdminSessionReplayUserKind = "anonymous" | "verified";

export type AdminListSessionReplaysOptions = {
  limit?: number,
  cursor?: string,
  user_ids?: string[],
  team_ids?: string[],
  duration_ms_min?: number,
  duration_ms_max?: number,
  last_event_at_from_millis?: number,
  last_event_at_to_millis?: number,
  click_count_min?: number,
  /**
   * Restrict to anonymous users (`isAnonymous`) or verified users (non-anonymous).
   * Omitted means both. "verified" here is identified / signed-up, not email-verified.
   */
  user_kind?: AdminSessionReplayUserKind,
};

export type AdminListSessionReplaysResponse = {
  items: Array<{
    id: string,
    refresh_token_id: string,
    project_user: {
      id: string,
      display_name: string | null,
      primary_email: string | null,
    },
    started_at_millis: number,
    last_event_at_millis: number,
    chunk_count: number,
    event_count: number,
  }>,
  pagination: {
    next_cursor: string | null,
  },
};

export type AdminGetSessionReplayResponse = {
  id: string,
  refresh_token_id: string,
  project_user: {
    id: string,
    display_name: string | null,
    primary_email: string | null,
  },
  started_at_millis: number,
  last_event_at_millis: number,
  chunk_count: number,
  event_count: number,
};

export type AdminListSessionReplayChunksOptions = {
  limit?: number,
  cursor?: string,
};

export type AdminListSessionReplayChunksResponse = {
  items: Array<{
    id: string,
    batch_id: string,
    session_replay_segment_id: string | null,
    browser_session_id: string | null,
    event_count: number,
    byte_length: number,
    first_event_at_millis: number,
    last_event_at_millis: number,
    created_at_millis: number,
  }>,
  pagination: {
    next_cursor: string | null,
  },
};

export type AdminGetSessionReplayChunkEventsResponse = {
  events: unknown[],
};

export type AdminGetSessionReplayAllEventsResponse = {
  chunks: Array<{
    id: string,
    batch_id: string,
    session_replay_segment_id: string | null,
    event_count: number,
    byte_length: number,
    first_event_at_millis: number,
    last_event_at_millis: number,
    created_at_millis: number,
  }>,
  chunk_events: Array<{
    chunk_id: string,
    events: unknown[],
  }>,
};

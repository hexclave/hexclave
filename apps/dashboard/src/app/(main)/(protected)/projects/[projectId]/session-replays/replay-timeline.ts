export type ReplayTimelineEvent = {
  eventType: string,
  eventAtMs: number,
  data: Record<string, unknown>,
};

export type ReplayTimelineMarker = {
  timeMs: number,
  eventType: string,
  label: string,
};

export const TIMELINE_EVENT_LABELS = new Map([
  ["$copy", "Copy"],
  ["$cut", "Cut"],
  ["$paste", "Paste"],
  ["$context-menu", "Context menu"],
  ["$print", "Print"],
  ["$fullscreen-exit", "Fullscreen exit"],
]);

export const TIMELINE_MARKER_CLASS_NAMES = new Map([
  ["$click", "bg-blue-500/70 hover:bg-blue-400"],
  ["$page-view", "bg-emerald-500/70 hover:bg-emerald-400"],
  ["$form-submit", "bg-amber-500/70 hover:bg-amber-400"],
  ["$window-resize", "bg-sky-500/70 hover:bg-sky-400"],
  ["$copy", "bg-violet-500/70 hover:bg-violet-400"],
  ["$cut", "bg-violet-500/70 hover:bg-violet-400"],
  ["$paste", "bg-violet-500/70 hover:bg-violet-400"],
  ["$context-menu", "bg-violet-500/70 hover:bg-violet-400"],
  ["$print", "bg-violet-500/70 hover:bg-violet-400"],
  ["$fullscreen-exit", "bg-violet-500/70 hover:bg-violet-400"],
  ["$error", "bg-red-500/80 hover:bg-red-400"],
]);

export function formatReplayTimelineEventTooltip(event: ReplayTimelineEvent): string {
  const data = event.data;
  switch (event.eventType) {
    case "$click": {
      const tag = typeof data.tag_name === "string" && data.tag_name !== "" ? data.tag_name : "element";
      return `Clicked ${tag}`;
    }
    case "$page-view": {
      const path = typeof data.path === "string" && data.path !== ""
        ? data.path
        : typeof data.url === "string" && data.url !== "" ? data.url : "/";
      return path.length > 30 ? path.slice(0, 27) + "..." : path;
    }
    case "$form-submit": {
      const formId = typeof data.form_id === "string" && data.form_id !== "" ? data.form_id : null;
      const formName = typeof data.form_name === "string" && data.form_name !== "" ? data.form_name : null;
      return `Form submit${formId != null ? ` #${formId}` : formName != null ? ` ${formName}` : ""}`;
    }
    case "$window-resize": {
      const width = data.viewport_width;
      const height = data.viewport_height;
      if (typeof width === "number" && typeof height === "number") return `Resize ${width}×${height}`;
      return "Window resize";
    }
    case "$error": {
      const name = typeof data.name === "string" && data.name !== "" ? data.name : "Error";
      const message = typeof data.message === "string" && data.message !== "" ? data.message : null;
      return message == null ? name : `${name}: ${message}`;
    }
    default: {
      return TIMELINE_EVENT_LABELS.get(event.eventType) ?? event.eventType;
    }
  }
}

export function replayTimelineMarkerClassName(eventType: string): string {
  return TIMELINE_MARKER_CLASS_NAMES.get(eventType) ?? "bg-zinc-500/70 hover:bg-zinc-400";
}

/**
 * `$error` rows are exposed through `default.errors`, not `default.events`.
 * Keep the sources explicit so the replay timeline includes observability
 * errors without depending on the product-events view changing its contract.
 */
export function getReplayTimelineQuery(): string {
  return `SELECT event_type,
                       toUnixTimestamp64Milli(event_at) AS event_at_ms,
                       toString(data) AS data
                FROM (
                  SELECT event_type, event_at, toString(data) AS data
                  FROM default.events
                  WHERE session_replay_id = {id:String}
                    AND event_type NOT IN ('$page-view', '$error')
                  UNION ALL
                  SELECT event_type, event_at, toString(data) AS data
                  FROM default.errors
                  WHERE session_replay_id = {id:String}
                  UNION ALL
                  SELECT CAST('$page-view', 'LowCardinality(String)') AS event_type, started_at AS event_at, toString(data) AS data
                  FROM default.page_views
                  WHERE session_replay_id = {id:String}
                )
                ORDER BY event_at ASC
                LIMIT 2000`;
}

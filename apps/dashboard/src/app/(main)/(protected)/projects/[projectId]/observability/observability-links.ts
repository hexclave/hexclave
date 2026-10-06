import { urlString } from "@hexclave/shared/dist/utils/urls";


export type TraceHighlight = {
  traceId: string,
  spanId?: string | null,
  eventType?: string | null,
  eventAtMs?: number | null,
};


export function tracesHref(projectId: string): string {
  return urlString`/projects/${projectId}/observability/traces`;
}

export function logsHref(projectId: string): string {
  return urlString`/projects/${projectId}/observability/logs`;
}

export function eventsHref(projectId: string): string {
  return urlString`/projects/${projectId}/analytics/events`;
}

export function sessionReplayHref(projectId: string, replayId: string, options?: { atMs?: number }): string {
  const path = urlString`/projects/${projectId}/session-replays/${replayId}`;
  if (options?.atMs == null) return path;
  return `${path}?at=${encodeURIComponent(String(options.atMs))}`;
}

export function traceDetailHref(projectId: string, traceIdOrHighlight: string | TraceHighlight): string {
  const highlight = typeof traceIdOrHighlight === "string"
    ? { traceId: traceIdOrHighlight }
    : traceIdOrHighlight;
  const params = new URLSearchParams();
  params.set("trace", highlight.traceId);
  if (highlight.spanId != null && highlight.spanId !== "") params.set("span", highlight.spanId);
  if (highlight.eventType != null && highlight.eventType !== "") params.set("event", highlight.eventType);
  if (highlight.eventAtMs != null) params.set("at", String(highlight.eventAtMs));
  return `${tracesHref(projectId)}?${params.toString()}`;
}

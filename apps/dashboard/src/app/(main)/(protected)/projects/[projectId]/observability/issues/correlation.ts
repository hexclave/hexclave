import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { RowData } from "../../analytics/shared";
import { parseClickHouseUtc, type IssueOccurrence } from "./issues-data";


export const LEADING_UP_TO_WINDOW_MS = 5 * 60_000;
export const LEADING_UP_TO_LIMIT = 50;

export type CorrelationAnchorKind = "trace" | "page_view_span" | "session_replay";

export type CorrelationAnchor = { kind: CorrelationAnchorKind, value: string };

const ANCHOR_COLUMNS = new Map<CorrelationAnchorKind, string>([
  ["trace", "trace_id"],
  ["page_view_span", "page_view_span_id"],
  ["session_replay", "session_replay_id"],
]);

export const CORRELATION_ANCHOR_LABELS = new Map<CorrelationAnchorKind, string>([
  ["trace", "same trace"],
  ["page_view_span", "same page view"],
  ["session_replay", "same session"],
]);

function nonEmpty(value: string | null): string | null {
  return value != null && value.trim() !== "" ? value : null;
}

export function resolveCorrelationAnchor(
  occurrence: Pick<IssueOccurrence, "trace_id" | "page_view_span_id" | "session_replay_id">,
): CorrelationAnchor | null {
  const traceId = nonEmpty(occurrence.trace_id);
  if (traceId != null) return { kind: "trace", value: traceId };
  const pageViewSpanId = nonEmpty(occurrence.page_view_span_id);
  if (pageViewSpanId != null) return { kind: "page_view_span", value: pageViewSpanId };
  const sessionReplayId = nonEmpty(occurrence.session_replay_id);
  if (sessionReplayId != null) return { kind: "session_replay", value: sessionReplayId };
  return null;
}

export function getLeadingUpToLogsQuery(
  anchor: CorrelationAnchor,
  occurrenceAtMillis: number,
): { query: string, params: Record<string, string | number> } {
  const column = ANCHOR_COLUMNS.get(anchor.kind);
  if (column == null) {
    throw new HexclaveAssertionError(`Unknown correlation anchor kind: ${anchor.kind}`);
  }
  if (!Number.isFinite(occurrenceAtMillis)) {
    throw new HexclaveAssertionError(`Occurrence timestamp must be finite, got ${occurrenceAtMillis}`);
  }
  return {
    query: `
SELECT
  event_at,
  level,
  body AS message,
  service_name
FROM default.logs
WHERE ${column} = {anchorValue:String}
  AND event_at >= fromUnixTimestamp64Milli({fromMillis:Int64}, 'UTC')
  AND event_at <= fromUnixTimestamp64Milli({toMillis:Int64}, 'UTC')
ORDER BY event_at DESC
LIMIT ${LEADING_UP_TO_LIMIT}
`,
    params: {
      anchorValue: anchor.value,
      fromMillis: occurrenceAtMillis - LEADING_UP_TO_WINDOW_MS,
      toMillis: occurrenceAtMillis,
    },
  };
}

export type LeadingUpToLogLine = {
  eventAtMillis: number,
  level: string,
  message: string,
  serviceName: string | null,
};

export function parseLeadingUpToLogRows(
  rows: readonly RowData[],
): LeadingUpToLogLine[] {
  return rows.map((row) => {
    return {
      eventAtMillis: parseClickHouseUtc(row.event_at, "log row event_at"),
      level: typeof row.level === "string" ? row.level : "",
      message: typeof row.message === "string" ? row.message : "",
      serviceName: typeof row.service_name === "string" && row.service_name !== "" ? row.service_name : null,
    };
  });
}

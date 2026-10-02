"use client";

import { Button } from "@/components/ui";
import { Link } from "@/components/link";
import { parseClickHouseDate } from "../analytics/shared";
import type { RowData } from "../analytics/shared";
import { sessionReplayHref, traceDetailHref } from "./observability-links";

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function eventAtMsFromRow(row: RowData): number | null {
  const eventAt = row.event_at;
  if (typeof eventAt === "number" && Number.isFinite(eventAt)) return Math.trunc(eventAt);
  if (typeof eventAt !== "string" || eventAt === "") return null;
  try {
    return parseClickHouseDate(eventAt).getTime();
  } catch {
    return null;
  }
}

export function TelemetryRowLinks({
  row,
  projectId,
  showTrace = true,
}: {
  row: RowData,
  projectId: string,
  showTrace?: boolean,
}) {
  const traceId = stringOrNull(row.trace_id);
  const spanId = stringOrNull(row.span_id);
  const eventType = stringOrNull(row.event_type);
  const eventAtMs = eventAtMsFromRow(row);
  const replayId = stringOrNull(row.session_replay_id);

  if ((traceId == null || !showTrace) && replayId == null) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showTrace && traceId != null && (
        <Button size="sm" variant="outline" asChild>
          <Link href={traceDetailHref(projectId, {
            traceId,
            spanId,
            eventType,
            eventAtMs,
          })}>
            View in trace
          </Link>
        </Button>
      )}
      {replayId != null && (
        <Button size="sm" variant="outline" asChild>
          <Link href={sessionReplayHref(projectId, replayId, eventAtMs == null ? undefined : { atMs: eventAtMs })}>
            View session replay
          </Link>
        </Button>
      )}
    </div>
  );
}

import { utf8ByteLength } from "@/lib/utf8";
import type {
  IssueGroupingHashProvenance,
  PublicIssueErrorEnvelope,
  PublicIssueFrame,
  PublicIssueFrameSymbolication,
  PublicIssueOccurrence,
} from "@/app/api/latest/issues/contract";
import type { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import type { IssueAttachment } from "@hexclave/shared/dist/interface/admin-issues";
import { isJsonSerializable, type Json } from "@hexclave/shared/dist/utils/json";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import {
  emptyFrameSymbolication,
  symbolicatePublicFrames,
  type PublicIssueSymbolicator,
  type StoredIssueFrame,
} from "./occurrence-symbolication";
import { scrubPublicRecord, scrubPublicText, scrubPublicValue } from "./public-scrub";

export type PublicOccurrenceRow = {
  occurrence_id: string,
  event_at: string,
  message: string,
  level: string,
  data: Record<string, Json>,
  error_envelope: string | null,
  issue_grouping_provenance: string,
  error_frames: string,
  trace_id: string | null,
  span_id: string | null,
  page_view_span_id: string | null,
  session_replay_id: string | null,
  session_replay_segment_id: string | null,
  user_id: string | null,
  service_name: string | null,
  deployment_environment_name: string | null,
};

const PUBLIC_ERROR_ENVELOPE_MAX_BYTES = 256 * 1024;
const PUBLIC_GROUPING_PROVENANCE_MAX_BYTES = 64 * 1024;
const PUBLIC_GROUPING_PROVENANCE_MAX_ENTRIES = 16;

function parsePublicStringArray(value: unknown, maximumLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maximumLength) return null;
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    values.push(scrubPublicText(item));
  }
  return values;
}

function parsePublicGroupingProvenance(raw: string): IssueGroupingHashProvenance[] {
  if (raw === "" || utf8ByteLength(raw) > PUBLIC_GROUPING_PROVENANCE_MAX_BYTES) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  if (!Array.isArray(parsed) || parsed.length > PUBLIC_GROUPING_PROVENANCE_MAX_ENTRIES) return [];

  const result: IssueGroupingHashProvenance[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) return [];
    const role = item.role;
    if (role !== "primary" && role !== "secondary") return [];
    if (
      typeof item.hash !== "string"
      || typeof item.config_id !== "string"
      || typeof item.variant !== "string"
      || !isRecord(item.fingerprint)
      || typeof item.fingerprint.type !== "string"
      || typeof item.fingerprint.source !== "string"
    ) return [];
    const tokens = parsePublicStringArray(item.fingerprint.tokens, 32);
    const resolvedTokens = parsePublicStringArray(item.fingerprint.resolved_tokens, 32);
    if (tokens === null || resolvedTokens === null) return [];
    result.push({
      hash: scrubPublicText(item.hash),
      role,
      config_id: scrubPublicText(item.config_id),
      variant: scrubPublicText(item.variant),
      fingerprint: {
        type: scrubPublicText(item.fingerprint.type),
        source: scrubPublicText(item.fingerprint.source),
        tokens,
        resolved_tokens: resolvedTokens,
      },
    });
  }
  return result;
}

function isPublicErrorEnvelope(value: unknown): value is PublicIssueErrorEnvelope {
  return isRecord(value) && Object.values(value).every(isJsonSerializable);
}

export function parsePublicErrorEnvelope(raw: string | null): PublicIssueErrorEnvelope | null {
  if (raw === null || raw === "") return null;
  if (utf8ByteLength(raw) > PUBLIC_ERROR_ENVELOPE_MAX_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const scrubbed = scrubPublicValue(parsed);
  return isPublicErrorEnvelope(scrubbed) ? scrubbed : null;
}

export function occurrenceTimestamp(eventAt: string): number {
  const timestamp = Date.parse(eventAt.endsWith("Z") ? eventAt : `${eventAt}Z`);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`ClickHouse returned an invalid issue occurrence timestamp: ${eventAt}`);
  }
  return timestamp;
}

function parseStoredFrames(raw: string): StoredIssueFrame[] {
  if (raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((value) => {
    if (!isRecord(value)) return [];
    const frame: StoredIssueFrame = {
      filename: typeof value.filename === "string" ? value.filename : null,
      function: typeof value.function === "string" ? value.function : null,
      module: typeof value.module === "string" ? value.module : null,
      absPath: typeof value.absPath === "string" ? value.absPath : null,
      lineno: typeof value.lineno === "number" ? value.lineno : null,
      colno: typeof value.colno === "number" ? value.colno : null,
      inApp: value.inApp === true,
      debugId: typeof value.debugId === "string" ? value.debugId : null,
    };
    return [frame];
  });
}

function toPublicFrame(frame: StoredIssueFrame, symbolication: PublicIssueFrameSymbolication): PublicIssueFrame {
  const publicFrame: PublicIssueFrame = {
    filename: frame.filename === null ? null : scrubPublicText(frame.filename),
    function: frame.function === null ? null : scrubPublicText(frame.function),
    module: frame.module === null ? null : scrubPublicText(frame.module),
    abs_path: frame.absPath === null ? null : scrubPublicText(frame.absPath),
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.inApp,
    symbolication,
  };
  if (frame.debugId !== null) publicFrame.debug_id = scrubPublicText(frame.debugId);
  return publicFrame;
}

function occurrenceRelease(envelope: PublicIssueErrorEnvelope | null): string | null {
  const envelopeRelease = envelope?.release;
  if (typeof envelopeRelease === "string" && envelopeRelease !== "") return envelopeRelease;
  return null;
}

export async function projectPublicIssueOccurrence(
  row: PublicOccurrenceRow,
  options: {
    scope: { tenantId: string, projectId: string, branchId: string },
    symbolicator?: PublicIssueSymbolicator,
    attachments?: readonly IssueAttachment[],
    errorEnvelope?: PublicIssueErrorEnvelope | null,
  },
): Promise<PublicIssueOccurrence> {
  const storedFrames = parseStoredFrames(row.error_frames);
  const errorEnvelope = options.errorEnvelope === undefined
    ? parsePublicErrorEnvelope(row.error_envelope)
    : options.errorEnvelope;
  const release = occurrenceRelease(errorEnvelope);
  const groupingProvenance = parsePublicGroupingProvenance(row.issue_grouping_provenance);
  const symbolication = await symbolicatePublicFrames({
    frames: storedFrames,
    data: row.data,
    envelope: errorEnvelope,
    scope: options.scope,
    symbolicator: options.symbolicator,
  });
  return {
    occurrence_id: row.occurrence_id,
    event_at_millis: occurrenceTimestamp(row.event_at),
    message: scrubPublicText(row.message),
    level: scrubPublicText(row.level),
    data: scrubPublicRecord(row.data),
    error_envelope: errorEnvelope,
    grouping_provenance: groupingProvenance,
    frames: storedFrames.map((frame, index) => toPublicFrame(
      frame,
      symbolication.frames[index] ?? emptyFrameSymbolication("not_attempted", []),
    )),
    attachments: [...options.attachments ?? []],
    raw_stack: typeof row.data.stack === "string" ? scrubPublicText(row.data.stack) : null,
    trace_id: row.trace_id,
    span_id: row.span_id,
    page_view_span_id: row.page_view_span_id,
    session_replay_id: row.session_replay_id,
    user_id: row.user_id,
    service_name: row.service_name === null ? null : scrubPublicText(row.service_name),
    environment: row.deployment_environment_name === null ? null : scrubPublicText(row.deployment_environment_name),
    release: release === null ? null : scrubPublicText(release),
    symbolication_diagnostics: symbolication.diagnostics,
  };
}

export function projectResolvedOccurrenceReplayIds(
  rows: readonly PublicOccurrenceRow[],
  segments: readonly { id: string, sessionReplayId: string }[],
): PublicOccurrenceRow[] {
  const replayIdsBySegment = new Map<string, string | null>();
  for (const segment of segments) {
    const existing = replayIdsBySegment.get(segment.id);
    replayIdsBySegment.set(
      segment.id,
      existing === undefined || existing === segment.sessionReplayId ? segment.sessionReplayId : null,
    );
  }
  return rows.map((row) => ({
    ...row,
    session_replay_id: row.session_replay_id
      ?? (row.session_replay_segment_id === null
        ? null
        : replayIdsBySegment.get(row.session_replay_segment_id) ?? null),
  }));
}

export async function resolveOccurrenceReplayIds(
  tenancy: Tenancy,
  rows: readonly PublicOccurrenceRow[],
): Promise<PublicOccurrenceRow[]> {
  const missingSegmentIds = [...new Set(rows.flatMap((row) =>
    row.session_replay_id === null && row.session_replay_segment_id !== null
      ? [row.session_replay_segment_id]
      : [],
  ))];
  if (missingSegmentIds.length === 0) return [...rows];

  const prisma = await getPrismaClientForTenancy(tenancy);
  const chunks = await prisma.$replica().sessionReplayChunk.findMany({
    where: {
      tenancyId: tenancy.id,
      sessionReplaySegmentId: { in: missingSegmentIds },
    },
    select: { sessionReplaySegmentId: true, sessionReplayId: true },
  });
  return projectResolvedOccurrenceReplayIds(
    rows,
    chunks.map((chunk) => ({
      id: chunk.sessionReplaySegmentId,
      sessionReplayId: chunk.sessionReplayId,
    })),
  );
}

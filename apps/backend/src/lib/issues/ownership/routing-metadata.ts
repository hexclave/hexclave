import { utf8ByteLength } from "@/lib/utf8";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import type {
  OwnershipDecisionTrace,
  OwnershipOwnerSource,
  OwnershipRecipient,
  OwnershipResolution,
  OwnershipTraceCode,
  OwnershipTraceDecision,
  OwnershipTraceParticipantType,
  OwnershipTraceStage,
  OwnershipTraceTargetType,
} from "./types";

export const OWNERSHIP_ROUTING_METADATA_SCHEMA_VERSION: 1 = 1;
export const OWNERSHIP_ROUTING_METADATA_MAX_TRACE_ENTRIES = 64;
export const OWNERSHIP_ROUTING_METADATA_MAX_IDENTIFIER_BYTES = 256;
export const OWNERSHIP_ROUTING_METADATA_MAX_RECIPIENTS = 64;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export type OwnershipRoutingTargetMetadata =
  | { type: "team", team_id: string }
  | { type: "issue_owners", fallthrough: "active_members" | "all_members" | "none" };

export type OwnershipRoutingTraceEntry = {
  stage: OwnershipTraceStage,
  decision: OwnershipTraceDecision,
  code: OwnershipTraceCode,
  participant_type?: OwnershipTraceParticipantType,
  participant_id?: string,
  target_type?: OwnershipTraceTargetType,
  owner_source?: OwnershipOwnerSource,
  count?: number,
};

export type OwnershipRoutingMetadata = {
  schema_version: typeof OWNERSHIP_ROUTING_METADATA_SCHEMA_VERSION,
  target: OwnershipRoutingTargetMetadata,
  status: OwnershipResolution["status"],
  reason: OwnershipResolution["reason"],
  recipient_count: number,
  output_truncated: boolean,
  trace_truncated: boolean,
  trace: readonly OwnershipRoutingTraceEntry[],
};

export type OwnershipRoutingResolution = {
  recipients: readonly OwnershipRecipient[],
  metadata: OwnershipRoutingMetadata,
};

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && !CONTROL_CHARACTER_PATTERN.test(value)
    && utf8ByteLength(value) <= OWNERSHIP_ROUTING_METADATA_MAX_IDENTIFIER_BYTES;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

function isRecipientCount(value: unknown): value is number {
  return isCount(value) && value <= OWNERSHIP_ROUTING_METADATA_MAX_RECIPIENTS;
}

function isStage(value: unknown): value is OwnershipTraceStage {
  return value === "scope" || value === "input" || value === "target" || value === "candidate"
    || value === "fallthrough" || value === "output";
}

function isDecision(value: unknown): value is OwnershipTraceDecision {
  return value === "accepted" || value === "selected" || value === "skipped"
    || value === "rejected" || value === "limited";
}

function isParticipantType(value: unknown): value is OwnershipTraceParticipantType {
  return value === "user" || value === "team";
}

function isTargetType(value: unknown): value is OwnershipTraceTargetType {
  return value === "member" || value === "team" || value === "issue_owners";
}

function isOwnerSource(value: unknown): value is OwnershipOwnerSource {
  return value === "manual" || value === "ownership_rule" || value === "codeowners"
    || value === "suspect_commit" || value === "seer_suggested";
}

function isTraceCode(value: unknown): value is OwnershipTraceCode {
  return value === "scope_accepted" || value === "scope_mismatch" || value === "invalid_input"
    || value === "invalid_timestamp" || value === "duplicate_member" || value === "duplicate_team"
    || value === "input_limit" || value === "input_accepted" || value === "target_member"
    || value === "target_team" || value === "target_issue_owners" || value === "member_selected"
    || value === "team_selected" || value === "owner_selected" || value === "member_unresolved"
    || value === "team_unresolved" || value === "owner_unresolved" || value === "duplicate_suppressed"
    || value === "fallthrough_considered" || value === "fallthrough_selected" || value === "fallthrough_none"
    || value === "recipient_limit" || value === "resolution_complete" || value === "resolution_rejected"
    || value === "trace_truncated";
}

function isFallthrough(value: unknown): value is "active_members" | "all_members" | "none" {
  return value === "active_members" || value === "all_members" || value === "none";
}

function parseTarget(value: unknown): OwnershipRoutingTargetMetadata | null {
  if (!isRecord(value) || !isString(value.type)) return null;
  if (value.type === "team") {
    return isString(value.team_id) ? { type: "team", team_id: value.team_id } : null;
  }
  return value.type === "issue_owners" && isFallthrough(value.fallthrough)
    ? { type: "issue_owners", fallthrough: value.fallthrough }
    : null;
}

function parseTraceEntry(value: unknown): OwnershipRoutingTraceEntry | null {
  if (!isRecord(value)
    || !isStage(value.stage)
    || !isDecision(value.decision)
    || !isTraceCode(value.code)) return null;
  const participantType = value.participant_type;
  const participantId = value.participant_id;
  const targetType = value.target_type;
  const ownerSource = value.owner_source;
  const count = value.count;
  if (participantType !== undefined && !isParticipantType(participantType)) return null;
  if (participantId !== undefined && !isString(participantId)) return null;
  if (targetType !== undefined && !isTargetType(targetType)) return null;
  if (ownerSource !== undefined && !isOwnerSource(ownerSource)) return null;
  if (count !== undefined && !isCount(count)) return null;
  const entry: OwnershipRoutingTraceEntry = {
    stage: value.stage,
    decision: value.decision,
    code: value.code,
  };
  if (participantType !== undefined) entry.participant_type = participantType;
  if (participantId !== undefined) entry.participant_id = participantId;
  if (targetType !== undefined) entry.target_type = targetType;
  if (ownerSource !== undefined) entry.owner_source = ownerSource;
  if (count !== undefined) entry.count = count;
  return entry;
}

function toTraceEntry(value: OwnershipDecisionTrace): OwnershipRoutingTraceEntry {
  const entry: OwnershipRoutingTraceEntry = {
    stage: value.stage,
    decision: value.decision,
    code: value.code,
  };
  if (value.participantType !== undefined) entry.participant_type = value.participantType;
  if (value.participantId !== undefined) entry.participant_id = value.participantId;
  if (value.targetType !== undefined) entry.target_type = value.targetType;
  if (value.ownerSource !== undefined) entry.owner_source = value.ownerSource;
  if (value.count !== undefined) entry.count = value.count;
  return entry;
}

export function buildOwnershipRoutingMetadata(
  target: OwnershipRoutingTargetMetadata,
  resolution: OwnershipResolution,
): OwnershipRoutingMetadata {
  const trace = resolution.trace.slice(0, OWNERSHIP_ROUTING_METADATA_MAX_TRACE_ENTRIES).map(toTraceEntry);
  return {
    schema_version: OWNERSHIP_ROUTING_METADATA_SCHEMA_VERSION,
    target,
    status: resolution.status,
    reason: resolution.reason,
    recipient_count: resolution.recipients.length,
    output_truncated: resolution.outputTruncated,
    trace_truncated: resolution.traceTruncated || resolution.trace.length > trace.length,
    trace,
  };
}

export function parseOwnershipRoutingMetadata(value: unknown): OwnershipRoutingMetadata | null {
  if (!isRecord(value)
    || value.schema_version !== OWNERSHIP_ROUTING_METADATA_SCHEMA_VERSION
    || !isString(value.status)
    || !isString(value.reason)
    || !isRecipientCount(value.recipient_count)
    || !isBoolean(value.output_truncated)
    || !isBoolean(value.trace_truncated)
    || !Array.isArray(value.trace)
    || value.trace.length > OWNERSHIP_ROUTING_METADATA_MAX_TRACE_ENTRIES) return null;
  const target = parseTarget(value.target);
  if (target === null) return null;
  if (value.status !== "resolved" && value.status !== "empty" && value.status !== "rejected") return null;
  if (value.reason !== "target_resolved"
    && value.reason !== "fallthrough_resolved"
    && value.reason !== "no_recipient"
    && value.reason !== "invalid_input"
    && value.reason !== "invalid_timestamp"
    && value.reason !== "duplicate_member"
    && value.reason !== "duplicate_team"
    && value.reason !== "input_limit"
    && value.reason !== "scope_mismatch") return null;
  const trace: OwnershipRoutingTraceEntry[] = [];
  for (const entry of value.trace) {
    const parsed = parseTraceEntry(entry);
    if (parsed === null) return null;
    trace.push(parsed);
  }
  return {
    schema_version: OWNERSHIP_ROUTING_METADATA_SCHEMA_VERSION,
    target,
    status: value.status,
    reason: value.reason,
    recipient_count: value.recipient_count,
    output_truncated: value.output_truncated,
    trace_truncated: value.trace_truncated,
    trace,
  };
}

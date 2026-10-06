import { isRecord } from "@hexclave/shared/dist/utils/objects";
import {
  OWNERSHIP_RESOLVER_MAX_IDENTIFIER_BYTES,
  OWNERSHIP_RESOLVER_MAX_ISSUE_OWNERS,
  OWNERSHIP_RESOLVER_MAX_MEMBERS,
  OWNERSHIP_RESOLVER_MAX_RECIPIENTS,
  OWNERSHIP_RESOLVER_MAX_TEAM_MEMBER_REFERENCES,
  OWNERSHIP_RESOLVER_MAX_TEAMS,
  OWNERSHIP_RESOLVER_MAX_TRACE_ENTRIES,
  OWNERSHIP_RESOLVER_SCHEMA_VERSION,
  type OwnershipDecisionTrace,
  type OwnershipFallthrough,
  type OwnershipIssueOwnerInput,
  type OwnershipMemberInput,
  type OwnershipOwnerSource,
  type OwnershipRecipient,
  type OwnershipResolution,
  type OwnershipResolutionReason,
  type OwnershipResolverInput,
  type OwnershipScope,
  type OwnershipTarget,
  type OwnershipTeamInput,
  type OwnershipTraceCode,
  type OwnershipTraceDecision,
  type OwnershipTraceParticipantType,
  type OwnershipTraceStage,
} from "./types";

const TEXT_ENCODER = new TextEncoder();
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const OWNER_SOURCES: readonly OwnershipOwnerSource[] = [
  "manual",
  "ownership_rule",
  "codeowners",
  "suspect_commit",
  "seer_suggested",
];
const FALLTHROUGHS: readonly OwnershipFallthrough[] = ["active_members", "all_members", "none"];

type InputValidationFailure = Exclude<
  OwnershipResolutionReason,
  "target_resolved" | "fallthrough_resolved" | "no_recipient"
>;

type ValidatedInput = {
  scope: OwnershipScope,
  target: OwnershipTarget,
  members: readonly OwnershipMemberInput[],
  teams: readonly OwnershipTeamInput[],
  issueOwners: readonly OwnershipIssueOwnerInput[],
};

type InputValidation =
  | { status: "ok", value: ValidatedInput }
  | { status: "error", reason: InputValidationFailure };

type TraceOptions = {
  participantType?: OwnershipTraceParticipantType,
  participantId?: string,
  targetType?: "member" | "team" | "issue_owners",
  ownerSource?: OwnershipOwnerSource,
  count?: number,
};

class TraceBuilder {
  private readonly entries: OwnershipDecisionTrace[] = [];
  private truncated = false;

  add(
    stage: OwnershipTraceStage,
    decision: OwnershipTraceDecision,
    code: OwnershipTraceCode,
    options: TraceOptions = {},
  ): void {
    if (this.entries.length >= OWNERSHIP_RESOLVER_MAX_TRACE_ENTRIES - 1) {
      this.truncated = true;
      return;
    }
    this.entries.push({ stage, decision, code, ...options });
  }

  finish(): { trace: readonly OwnershipDecisionTrace[], traceTruncated: boolean } {
    if (this.truncated) {
      this.entries.push({ stage: "output", decision: "limited", code: "trace_truncated" });
    }
    return { trace: [...this.entries], traceTruncated: this.truncated };
  }
}

function parseIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return null;
  if (CONTROL_CHARACTER_PATTERN.test(value)) return null;
  if (TEXT_ENCODER.encode(value).byteLength > OWNERSHIP_RESOLVER_MAX_IDENTIFIER_BYTES) return null;
  return value;
}

function parseScope(value: unknown): OwnershipScope | null {
  if (!isRecord(value)) return null;
  const tenancyId = parseIdentifier(value.tenancyId);
  const projectId = parseIdentifier(value.projectId);
  const branchId = parseIdentifier(value.branchId);
  if (tenancyId === null || projectId === null || branchId === null) return null;
  return { tenancyId, projectId, branchId };
}

function sameScope(left: OwnershipScope, right: OwnershipScope): boolean {
  return left.tenancyId === right.tenancyId
    && left.projectId === right.projectId
    && left.branchId === right.branchId;
}

function parseTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTER_PATTERN.test(value)) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return undefined;
  return value;
}

function parseFallthrough(value: unknown): OwnershipFallthrough | null {
  if (typeof value !== "string") return null;
  for (const candidate of FALLTHROUGHS) {
    if (candidate === value) return candidate;
  }
  return null;
}

function parseOwnerSource(value: unknown): OwnershipOwnerSource | null {
  if (typeof value !== "string") return null;
  for (const candidate of OWNER_SOURCES) {
    if (candidate === value) return candidate;
  }
  return null;
}

function parseTarget(value: unknown): OwnershipTarget | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "member") {
    const userId = parseIdentifier(value.userId);
    return userId === null ? null : { type: "member", userId };
  }
  if (value.type === "team") {
    const teamId = parseIdentifier(value.teamId);
    return teamId === null ? null : { type: "team", teamId };
  }
  if (value.type === "issue_owners") {
    const fallthrough = parseFallthrough(value.fallthrough);
    return fallthrough === null ? null : { type: "issue_owners", fallthrough };
  }
  return null;
}

function parseMember(value: unknown): OwnershipMemberInput | null {
  if (!isRecord(value)) return null;
  const scope = parseScope(value.scope);
  const userId = parseIdentifier(value.userId);
  const lastActiveAt = parseTimestamp(value.lastActiveAt);
  const eligibleForFallthrough = value.eligibleForFallthrough ?? true;
  if (scope === null || userId === null || typeof value.isActive !== "boolean"
    || typeof eligibleForFallthrough !== "boolean" || lastActiveAt === undefined) return null;
  return { scope, userId, isActive: value.isActive, lastActiveAt, eligibleForFallthrough };
}

function parseTeam(value: unknown): OwnershipTeamInput | null {
  if (!isRecord(value) || !Array.isArray(value.memberUserIds) || value.memberUserIds.length > OWNERSHIP_RESOLVER_MAX_TEAM_MEMBER_REFERENCES) return null;
  const scope = parseScope(value.scope);
  const teamId = parseIdentifier(value.teamId);
  if (scope === null || teamId === null) return null;
  const memberUserIds: string[] = [];
  for (const rawUserId of value.memberUserIds) {
    const userId = parseIdentifier(rawUserId);
    if (userId === null) return null;
    memberUserIds.push(userId);
  }
  return { scope, teamId, memberUserIds };
}

function parseIssueOwner(value: unknown): OwnershipIssueOwnerInput | null {
  if (!isRecord(value)) return null;
  const scope = parseScope(value.scope);
  const source = parseOwnerSource(value.source);
  if (scope === null || source === null || (value.type !== "user" && value.type !== "team")) return null;

  const userId = value.userId === undefined ? null : parseIdentifier(value.userId);
  const teamId = value.teamId === undefined ? null : parseIdentifier(value.teamId);
  if (value.type === "user") {
    return userId !== null && teamId === null ? { scope, type: "user", userId, source } : null;
  }
  return teamId !== null && userId === null ? { scope, type: "team", teamId, source } : null;
}

function validateInput(value: unknown): InputValidation {
  if (!isRecord(value) || value.schemaVersion !== OWNERSHIP_RESOLVER_SCHEMA_VERSION) {
    return { status: "error", reason: "invalid_input" };
  }
  const scope = parseScope(value.scope);
  const target = parseTarget(value.target);
  if (scope === null || target === null) return { status: "error", reason: "invalid_input" };
  if (!Array.isArray(value.members) || !Array.isArray(value.teams) || !Array.isArray(value.issueOwners)) {
    return { status: "error", reason: "invalid_input" };
  }
  if (value.members.length > OWNERSHIP_RESOLVER_MAX_MEMBERS
    || value.teams.length > OWNERSHIP_RESOLVER_MAX_TEAMS
    || value.issueOwners.length > OWNERSHIP_RESOLVER_MAX_ISSUE_OWNERS) {
    return { status: "error", reason: "input_limit" };
  }

  const members: OwnershipMemberInput[] = [];
  const memberIds = new Set<string>();
  for (const rawMember of value.members) {
    const member = parseMember(rawMember);
    if (member === null) {
      return { status: "error", reason: "invalid_input" };
    }
    if (!sameScope(member.scope, scope)) {
      return { status: "error", reason: "scope_mismatch" };
    }
    if (memberIds.has(member.userId)) {
      return { status: "error", reason: "duplicate_member" };
    }
    memberIds.add(member.userId);
    members.push(member);
  }

  const teams: OwnershipTeamInput[] = [];
  const teamIds = new Set<string>();
  for (const rawTeam of value.teams) {
    const team = parseTeam(rawTeam);
    if (team === null) {
      return { status: "error", reason: "invalid_input" };
    }
    if (!sameScope(team.scope, scope)) {
      return { status: "error", reason: "scope_mismatch" };
    }
    if (teamIds.has(team.teamId)) {
      return { status: "error", reason: "duplicate_team" };
    }
    teamIds.add(team.teamId);
    teams.push(team);
  }

  const issueOwners: OwnershipIssueOwnerInput[] = [];
  for (const rawOwner of value.issueOwners) {
    const owner = parseIssueOwner(rawOwner);
    if (owner === null) {
      return { status: "error", reason: "invalid_input" };
    }
    if (!sameScope(owner.scope, scope)) {
      return { status: "error", reason: "scope_mismatch" };
    }
    issueOwners.push(owner);
  }

  return { status: "ok", value: { scope, target, members, teams, issueOwners } };
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareMembersByActivity(left: OwnershipMemberInput, right: OwnershipMemberInput): number {
  const leftTime = left.lastActiveAt === null ? Number.NEGATIVE_INFINITY : new Date(left.lastActiveAt).getTime();
  const rightTime = right.lastActiveAt === null ? Number.NEGATIVE_INFINITY : new Date(right.lastActiveAt).getTime();
  if (leftTime !== rightTime) return rightTime - leftTime;
  return compareStrings(left.userId, right.userId);
}

function compareIssueOwners(left: OwnershipIssueOwnerInput, right: OwnershipIssueOwnerInput): number {
  const leftIdentifier = left.type === "user" ? left.userId : left.teamId;
  const rightIdentifier = right.type === "user" ? right.userId : right.teamId;
  const sourceOrder = compareStrings(left.source, right.source);
  if (sourceOrder !== 0) return sourceOrder;
  const typeOrder = compareStrings(left.type, right.type);
  if (typeOrder !== 0) return typeOrder;
  return compareStrings(leftIdentifier, rightIdentifier);
}

function inputFailureTraceCode(reason: InputValidationFailure): OwnershipTraceCode {
  return reason;
}

function rejectedResolution(reason: InputValidationFailure, traceBuilder: TraceBuilder): OwnershipResolution {
  traceBuilder.add(
    reason === "scope_mismatch" ? "scope" : "input",
    "rejected",
    inputFailureTraceCode(reason),
  );
  const finished = traceBuilder.finish();
  return {
    schemaVersion: OWNERSHIP_RESOLVER_SCHEMA_VERSION,
    status: "rejected",
    reason,
    recipients: [],
    trace: finished.trace,
    outputTruncated: false,
    traceTruncated: finished.traceTruncated,
  };
}

function completeResolution(
  status: "resolved" | "empty",
  reason: "target_resolved" | "fallthrough_resolved" | "no_recipient",
  recipients: readonly OwnershipRecipient[],
  outputTruncated: boolean,
  traceBuilder: TraceBuilder,
): OwnershipResolution {
  traceBuilder.add("output", status === "resolved" ? "accepted" : "skipped", "resolution_complete", { count: recipients.length });
  const finished = traceBuilder.finish();
  return {
    schemaVersion: OWNERSHIP_RESOLVER_SCHEMA_VERSION,
    status,
    reason,
    recipients: [...recipients],
    trace: finished.trace,
    outputTruncated,
    traceTruncated: finished.traceTruncated,
  };
}

export function resolveOwnershipRecipients(value: unknown): OwnershipResolution {
  const traceBuilder = new TraceBuilder();
  const validation = validateInput(value);
  if (validation.status === "error") return rejectedResolution(validation.reason, traceBuilder);

  const input = validation.value;
  traceBuilder.add("scope", "accepted", "scope_accepted");
  traceBuilder.add("input", "accepted", "input_accepted", {
    count: input.members.length + input.teams.length + input.issueOwners.length,
  });

  const membersById = new Map(input.members.map((member) => [member.userId, member]));
  const teamsById = new Map(input.teams.map((team) => [team.teamId, team]));
  const recipients: OwnershipRecipient[] = [];
  const selectedUserIds = new Set<string>();
  let outputTruncated = false;

  const addRecipient = (member: OwnershipMemberInput, ownerSource?: OwnershipOwnerSource): void => {
    if (selectedUserIds.has(member.userId)) {
      traceBuilder.add("candidate", "skipped", "duplicate_suppressed", {
        participantType: "user",
        participantId: member.userId,
        ownerSource,
      });
      return;
    }
    if (recipients.length >= OWNERSHIP_RESOLVER_MAX_RECIPIENTS) {
      outputTruncated = true;
      traceBuilder.add("output", "limited", "recipient_limit", { count: OWNERSHIP_RESOLVER_MAX_RECIPIENTS });
      return;
    }
    selectedUserIds.add(member.userId);
    recipients.push({ userId: member.userId });
    traceBuilder.add("candidate", "selected", "member_selected", {
      participantType: "user",
      participantId: member.userId,
      ownerSource,
    });
  };

  const addMemberById = (userId: string, ownerSource?: OwnershipOwnerSource): void => {
    const member = membersById.get(userId);
    if (member === undefined) {
      traceBuilder.add("candidate", "skipped", "member_unresolved", {
        participantType: "user",
        participantId: userId,
        ownerSource,
      });
      return;
    }
    addRecipient(member, ownerSource);
  };

  const addTeamMembers = (team: OwnershipTeamInput, ownerSource?: OwnershipOwnerSource): void => {
    const memberUserIds = [...new Set(team.memberUserIds)].sort(compareStrings);
    for (const userId of memberUserIds) addMemberById(userId, ownerSource);
  };

  if (input.target.type === "member") {
    traceBuilder.add("target", "selected", "target_member", {
      targetType: "member",
      participantType: "user",
      participantId: input.target.userId,
    });
    addMemberById(input.target.userId);
    return completeResolution(
      recipients.length === 0 ? "empty" : "resolved",
      recipients.length === 0 ? "no_recipient" : "target_resolved",
      recipients,
      outputTruncated,
      traceBuilder,
    );
  }

  if (input.target.type === "team") {
    traceBuilder.add("target", "selected", "target_team", {
      targetType: "team",
      participantType: "team",
      participantId: input.target.teamId,
    });
    const team = teamsById.get(input.target.teamId);
    if (team === undefined) {
      traceBuilder.add("candidate", "skipped", "team_unresolved", {
        participantType: "team",
        participantId: input.target.teamId,
      });
    } else {
      traceBuilder.add("candidate", "selected", "team_selected", {
        participantType: "team",
        participantId: team.teamId,
        count: team.memberUserIds.length,
      });
      addTeamMembers(team);
    }
    return completeResolution(
      recipients.length === 0 ? "empty" : "resolved",
      recipients.length === 0 ? "no_recipient" : "target_resolved",
      recipients,
      outputTruncated,
      traceBuilder,
    );
  }

  traceBuilder.add("target", "selected", "target_issue_owners", { targetType: "issue_owners" });
  for (const owner of [...input.issueOwners].sort(compareIssueOwners)) {
    const ownerId = owner.type === "user" ? owner.userId : owner.teamId;
    traceBuilder.add("candidate", "selected", "owner_selected", {
      participantType: owner.type,
      participantId: ownerId,
      ownerSource: owner.source,
    });
    if (owner.type === "user") {
      if (membersById.has(ownerId)) addMemberById(ownerId, owner.source);
      else traceBuilder.add("candidate", "skipped", "owner_unresolved", { participantType: "user", participantId: ownerId, ownerSource: owner.source });
    } else {
      const team = teamsById.get(ownerId);
      if (team === undefined) {
        traceBuilder.add("candidate", "skipped", "team_unresolved", { participantType: "team", participantId: ownerId, ownerSource: owner.source });
      } else {
        traceBuilder.add("candidate", "selected", "team_selected", { participantType: "team", participantId: ownerId, ownerSource: owner.source, count: team.memberUserIds.length });
        addTeamMembers(team, owner.source);
      }
    }
  }

  if (recipients.length > 0) {
    return completeResolution("resolved", "target_resolved", recipients, outputTruncated, traceBuilder);
  }

  traceBuilder.add("fallthrough", "accepted", "fallthrough_considered", { targetType: "issue_owners" });
  if (input.target.fallthrough === "none") {
    traceBuilder.add("fallthrough", "skipped", "fallthrough_none", { targetType: "issue_owners" });
    return completeResolution("empty", "no_recipient", recipients, outputTruncated, traceBuilder);
  }

  const fallbackMembers = input.target.fallthrough === "active_members"
    ? [...input.members].filter((member) => member.isActive && member.eligibleForFallthrough !== false).sort(compareMembersByActivity)
    : [...input.members].filter((member) => member.eligibleForFallthrough !== false).sort((left, right) => compareStrings(left.userId, right.userId));
  traceBuilder.add("fallthrough", "selected", "fallthrough_selected", {
    targetType: "issue_owners",
    count: fallbackMembers.length,
  });
  for (const member of fallbackMembers) addRecipient(member);

  return completeResolution(
    recipients.length === 0 ? "empty" : "resolved",
    recipients.length === 0 ? "no_recipient" : "fallthrough_resolved",
    recipients,
    outputTruncated,
    traceBuilder,
  );
}

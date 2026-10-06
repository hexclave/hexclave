export const OWNERSHIP_RESOLVER_SCHEMA_VERSION: 1 = 1;
export const OWNERSHIP_RESOLVER_MAX_RECIPIENTS = 64;
export const OWNERSHIP_RESOLVER_MAX_TRACE_ENTRIES = 128;
export const OWNERSHIP_RESOLVER_MAX_MEMBERS = 512;
export const OWNERSHIP_RESOLVER_MAX_TEAMS = 128;
export const OWNERSHIP_RESOLVER_MAX_TEAM_MEMBER_REFERENCES = 512;
export const OWNERSHIP_RESOLVER_MAX_ISSUE_OWNERS = 256;
export const OWNERSHIP_RESOLVER_MAX_IDENTIFIER_BYTES = 256;

export type OwnershipScope = {
  tenancyId: string,
  projectId: string,
  branchId: string,
};

export type OwnershipFallthrough = "active_members" | "all_members" | "none";

export type OwnershipTarget =
  | { type: "member", userId: string }
  | { type: "team", teamId: string }
  | { type: "issue_owners", fallthrough: OwnershipFallthrough };

export type OwnershipMemberInput = {
  scope: OwnershipScope,
  userId: string,
  isActive: boolean,
  lastActiveAt: string | null,
  eligibleForFallthrough?: boolean,
};

export type OwnershipTeamInput = {
  scope: OwnershipScope,
  teamId: string,
  memberUserIds: readonly string[],
};

export type OwnershipOwnerSource =
  | "manual"
  | "ownership_rule"
  | "codeowners"
  | "suspect_commit"
  | "seer_suggested";

export type OwnershipIssueOwnerInput =
  | {
    scope: OwnershipScope,
    type: "user",
    userId: string,
    source: OwnershipOwnerSource,
  }
  | {
    scope: OwnershipScope,
    type: "team",
    teamId: string,
    source: OwnershipOwnerSource,
  };

export type OwnershipResolverInput = {
  schemaVersion: typeof OWNERSHIP_RESOLVER_SCHEMA_VERSION,
  scope: OwnershipScope,
  target: OwnershipTarget,
  members: readonly OwnershipMemberInput[],
  teams: readonly OwnershipTeamInput[],
  issueOwners: readonly OwnershipIssueOwnerInput[],
};

export type OwnershipRecipient = {
  userId: string,
};

export type OwnershipTraceStage = "scope" | "input" | "target" | "candidate" | "fallthrough" | "output";
export type OwnershipTraceDecision = "accepted" | "selected" | "skipped" | "rejected" | "limited";
export type OwnershipTraceParticipantType = "user" | "team";
export type OwnershipTraceTargetType = "member" | "team" | "issue_owners";

export type OwnershipTraceCode =
  | "scope_accepted"
  | "scope_mismatch"
  | "invalid_input"
  | "invalid_timestamp"
  | "duplicate_member"
  | "duplicate_team"
  | "input_limit"
  | "input_accepted"
  | "target_member"
  | "target_team"
  | "target_issue_owners"
  | "member_selected"
  | "team_selected"
  | "owner_selected"
  | "member_unresolved"
  | "team_unresolved"
  | "owner_unresolved"
  | "duplicate_suppressed"
  | "fallthrough_considered"
  | "fallthrough_selected"
  | "fallthrough_none"
  | "recipient_limit"
  | "resolution_complete"
  | "resolution_rejected"
  | "trace_truncated";

export type OwnershipDecisionTrace = {
  stage: OwnershipTraceStage,
  decision: OwnershipTraceDecision,
  code: OwnershipTraceCode,
  participantType?: OwnershipTraceParticipantType,
  participantId?: string,
  targetType?: OwnershipTraceTargetType,
  ownerSource?: OwnershipOwnerSource,
  count?: number,
};

export type OwnershipResolutionReason =
  | "target_resolved"
  | "fallthrough_resolved"
  | "no_recipient"
  | "invalid_input"
  | "invalid_timestamp"
  | "duplicate_member"
  | "duplicate_team"
  | "input_limit"
  | "scope_mismatch";

export type OwnershipResolution = {
  schemaVersion: typeof OWNERSHIP_RESOLVER_SCHEMA_VERSION,
  status: "resolved" | "empty" | "rejected",
  reason: OwnershipResolutionReason,
  recipients: readonly OwnershipRecipient[],
  trace: readonly OwnershipDecisionTrace[],
  outputTruncated: boolean,
  traceTruncated: boolean,
};

import { describe, expect, it } from "vitest";
import {
  OWNERSHIP_RESOLVER_MAX_RECIPIENTS,
  OWNERSHIP_RESOLVER_MAX_TRACE_ENTRIES,
  OWNERSHIP_RESOLVER_SCHEMA_VERSION,
  type OwnershipIssueOwnerInput,
  type OwnershipMemberInput,
  type OwnershipResolverInput,
  type OwnershipScope,
  type OwnershipTeamInput,
} from "./types";
import { resolveOwnershipRecipients } from "./resolver";

const SCOPE: OwnershipScope = {
  tenancyId: "00000000-0000-4000-8000-000000000001",
  projectId: "project-a",
  branchId: "branch-a",
};

const OTHER_SCOPE: OwnershipScope = {
  ...SCOPE,
  branchId: "branch-b",
};

function member(userId: string, overrides: Partial<OwnershipMemberInput> = {}): OwnershipMemberInput {
  return {
    scope: SCOPE,
    userId,
    isActive: true,
    lastActiveAt: "2026-08-06T12:00:00.000Z",
    ...overrides,
  };
}

function team(teamId: string, memberUserIds: readonly string[], scope: OwnershipScope = SCOPE): OwnershipTeamInput {
  return { scope, teamId, memberUserIds };
}

function owner(
  type: OwnershipIssueOwnerInput["type"],
  id: string,
  source: OwnershipIssueOwnerInput["source"],
  scope: OwnershipScope = SCOPE,
): OwnershipIssueOwnerInput {
  return type === "user"
    ? { scope, type, userId: id, source }
    : { scope, type, teamId: id, source };
}

function input(overrides: Partial<OwnershipResolverInput> = {}): OwnershipResolverInput {
  return {
    schemaVersion: OWNERSHIP_RESOLVER_SCHEMA_VERSION,
    scope: SCOPE,
    target: { type: "issue_owners", fallthrough: "none" },
    members: [member("user-a"), member("user-b")],
    teams: [team("team-a", ["user-a", "user-b"])],
    issueOwners: [owner("user", "user-a", "ownership_rule")],
    ...overrides,
  };
}

describe("resolveOwnershipRecipients", () => {
  it("resolves an in-scope team to deterministically ordered member recipients", () => {
    const result = resolveOwnershipRecipients(input({
      target: { type: "team", teamId: "team-a" },
      members: [member("user-b"), member("user-a")],
      teams: [team("team-a", ["user-b", "user-a"])],
      issueOwners: [],
    }));

    expect(result).toMatchObject({
      status: "resolved",
      reason: "target_resolved",
      recipients: [{ userId: "user-a" }, { userId: "user-b" }],
      outputTruncated: false,
    });
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "scope_accepted" }),
      expect.objectContaining({ code: "target_team", participantId: "team-a" }),
      expect.objectContaining({ code: "team_selected", participantId: "team-a" }),
    ]));
  });

  it("rejects every mixed-scope snapshot before emitting a recipient", () => {
    const result = resolveOwnershipRecipients(input({
      members: [member("user-a"), member("user-b", { scope: OTHER_SCOPE })],
      target: { type: "member", userId: "user-a" },
    }));

    expect(result).toMatchObject({
      status: "rejected",
      reason: "scope_mismatch",
      recipients: [],
      outputTruncated: false,
    });
    expect(result.trace).toEqual([{ stage: "scope", decision: "rejected", code: "scope_mismatch" }]);
  });

  it("uses active-member fallthrough only when no issue owner resolves", () => {
    const result = resolveOwnershipRecipients(input({
      target: { type: "issue_owners", fallthrough: "active_members" },
      members: [
        member("user-old", { isActive: true, lastActiveAt: "2026-08-01T00:00:00.000Z" }),
        member("user-new", { isActive: true, lastActiveAt: "2026-08-05T00:00:00.000Z" }),
        member("user-inactive", { isActive: false, lastActiveAt: "2026-08-06T00:00:00.000Z" }),
      ],
      teams: [],
      issueOwners: [owner("user", "missing-user", "ownership_rule")],
    }));

    expect(result).toMatchObject({
      status: "resolved",
      reason: "fallthrough_resolved",
      recipients: [{ userId: "user-new" }, { userId: "user-old" }],
    });
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "owner_unresolved", participantId: "missing-user" }),
      expect.objectContaining({ code: "fallthrough_selected", count: 2 }),
    ]));
  });

  it("does not fall through when an issue owner resolves, and dedupes owner/team overlap", () => {
    const result = resolveOwnershipRecipients(input({
      target: { type: "issue_owners", fallthrough: "all_members" },
      members: [member("user-a"), member("user-b"), member("user-c")],
      teams: [team("team-a", ["user-b", "user-a", "user-b"])],
      issueOwners: [
        owner("team", "team-a", "codeowners"),
        owner("user", "user-a", "manual"),
      ],
    }));

    expect(result.recipients).toEqual([{ userId: "user-a" }, { userId: "user-b" }]);
    expect(result.reason).toBe("target_resolved");
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_suppressed", participantId: "user-a" }),
    ]));
    expect(result.trace.some((entry) => entry.code === "fallthrough_selected")).toBe(false);
  });

  it("selects internal team members without admitting them to customer fallthrough", () => {
    const internalMember = member("internal-collaborator", { eligibleForFallthrough: false });
    expect(resolveOwnershipRecipients(input({
      target: { type: "team", teamId: "owner-team" },
      members: [internalMember],
      teams: [team("owner-team", [internalMember.userId])],
      issueOwners: [],
    })).recipients).toEqual([{ userId: internalMember.userId }]);

    expect(resolveOwnershipRecipients(input({
      target: { type: "issue_owners", fallthrough: "all_members" },
      members: [member("customer-member"), internalMember],
      teams: [],
      issueOwners: [],
    })).recipients).toEqual([{ userId: "customer-member" }]);
  });

  it("supports no-recipient fallthrough as an explicit decision", () => {
    const result = resolveOwnershipRecipients(input({
      target: { type: "issue_owners", fallthrough: "none" },
      issueOwners: [owner("team", "missing-team", "ownership_rule")],
      teams: [],
    }));

    expect(result).toMatchObject({ status: "empty", reason: "no_recipient", recipients: [] });
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "team_unresolved", participantId: "missing-team" }),
      expect.objectContaining({ code: "fallthrough_none" }),
    ]));
  });

  it("rejects malformed, ambiguous, and non-canonical input without throwing", () => {
    expect(resolveOwnershipRecipients(null)).toMatchObject({
      status: "rejected",
      reason: "invalid_input",
      recipients: [],
    });
    expect(resolveOwnershipRecipients(input({
      members: [member("user-a"), member("user-a")],
    })).reason).toBe("duplicate_member");
    expect(resolveOwnershipRecipients(input({
      members: [member("user-a", { lastActiveAt: "yesterday" })],
    })).reason).toBe("invalid_input");
    expect(resolveOwnershipRecipients({
      ...input(),
      target: { type: "issue_owners", fallthrough: "unknown" },
    })).toMatchObject({ status: "rejected", reason: "invalid_input" });
  });

  it("bounds recipients and decision traces for a large valid snapshot", () => {
    const members = Array.from({ length: 200 }, (_, index) => member(`user-${String(index).padStart(3, "0")}`));
    const result = resolveOwnershipRecipients(input({
      target: { type: "team", teamId: "team-large" },
      members,
      teams: [team("team-large", members.map((entry) => entry.userId))],
      issueOwners: [],
    }));

    expect(result.status).toBe("resolved");
    expect(result.recipients).toHaveLength(OWNERSHIP_RESOLVER_MAX_RECIPIENTS);
    expect(result.outputTruncated).toBe(true);
    expect(result.trace.length).toBeLessThanOrEqual(OWNERSHIP_RESOLVER_MAX_TRACE_ENTRIES);
    expect(result.traceTruncated).toBe(true);
    expect(new Set(result.recipients.map((recipient) => recipient.userId)).size).toBe(OWNERSHIP_RESOLVER_MAX_RECIPIENTS);
  });
});

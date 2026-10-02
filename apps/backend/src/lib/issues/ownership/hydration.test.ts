import { describe, expect, it } from "vitest";
import { IssueOwnerSource as PrismaIssueOwnerSource, IssueOwnerType as PrismaIssueOwnerType } from "@/generated/prisma/client";
import { resolveOwnershipRecipients } from "./resolver";
import { buildOwnershipResolverInput } from "./hydration";
import type { OwnershipHydrationRows } from "./hydration";

const scope = {
  tenancyId: "00000000-0000-4000-8000-000000000001",
  projectId: "project-alerts",
  branchId: "branch-main",
};

function member(projectUserId: string, overrides: Partial<OwnershipHydrationRows["members"][number]> = {}): OwnershipHydrationRows["members"][number] {
  return {
    tenancyId: scope.tenancyId,
    mirroredProjectId: scope.projectId,
    mirroredBranchId: scope.branchId,
    projectUserId,
    lastActiveAt: new Date("2026-08-06T12:00:00.000Z"),
    restrictedByAdmin: false,
    isAnonymous: false,
    ...overrides,
  };
}

function team(teamId: string, overrides: Partial<OwnershipHydrationRows["teams"][number]> = {}): OwnershipHydrationRows["teams"][number] {
  return {
    tenancyId: scope.tenancyId,
    mirroredProjectId: scope.projectId,
    mirroredBranchId: scope.branchId,
    teamId,
    ...overrides,
  };
}

describe("ownership hydration for issue alerts", () => {
  it("hydrates a scoped team into bounded user recipients", () => {
    const input = buildOwnershipResolverInput(scope, { type: "team", teamId: "team-1" }, {
      members: [member("user-1"), member("user-2")],
      teams: [team("team-1")],
      teamMembers: [
        { tenancyId: scope.tenancyId, teamId: "team-1", projectUserId: "user-2" },
        { tenancyId: scope.tenancyId, teamId: "team-1", projectUserId: "user-1" },
        { tenancyId: scope.tenancyId, teamId: "team-1", projectUserId: "user-not-in-branch" },
      ],
      issueOwners: [],
    }, "issue-1");

    expect(resolveOwnershipRecipients(input)).toMatchObject({
      status: "resolved",
      reason: "target_resolved",
      recipients: [{ userId: "user-1" }, { userId: "user-2" }],
    });
  });

  it("uses active-member fallthrough when issue owners resolve to no current member", () => {
    const input = buildOwnershipResolverInput(scope, { type: "issue_owners", fallthrough: "active_members" }, {
      members: [
        member("user-active"),
        member("user-restricted", { restrictedByAdmin: true }),
      ],
      teams: [],
      teamMembers: [],
      issueOwners: [{
        tenancyId: scope.tenancyId,
        projectId: scope.projectId,
        branchId: scope.branchId,
        issueId: "issue-1",
        ownerType: PrismaIssueOwnerType.USER,
        ownerUserId: "user-deleted",
        ownerTeamId: null,
        source: PrismaIssueOwnerSource.OWNERSHIP_RULE,
      }],
    }, "issue-1");

    expect(resolveOwnershipRecipients(input)).toMatchObject({
      status: "resolved",
      reason: "fallthrough_resolved",
      recipients: [{ userId: "user-active" }],
    });
  });

  it("rejects a mixed-scope member snapshot before emitting a recipient", () => {
    const input = buildOwnershipResolverInput(scope, { type: "team", teamId: "team-1" }, {
      members: [member("user-cross-scope", { mirroredBranchId: "branch-other" })],
      teams: [team("team-1")],
      teamMembers: [{ tenancyId: scope.tenancyId, teamId: "team-1", projectUserId: "user-cross-scope" }],
      issueOwners: [],
    }, "issue-1");

    expect(resolveOwnershipRecipients(input)).toMatchObject({
      status: "rejected",
      reason: "scope_mismatch",
      recipients: [],
    });
  });

  it("returns an explainable empty result when issue-owner fallthrough is disabled", () => {
    const input = buildOwnershipResolverInput(scope, { type: "issue_owners", fallthrough: "none" }, {
      members: [],
      teams: [],
      teamMembers: [],
      issueOwners: [],
    }, "issue-1");

    expect(resolveOwnershipRecipients(input)).toMatchObject({
      status: "empty",
      reason: "no_recipient",
      recipients: [],
    });
  });

  it("fails closed when a hydration row is returned for another issue", () => {
    expect(() => buildOwnershipResolverInput(scope, { type: "issue_owners", fallthrough: "none" }, {
      members: [],
      teams: [],
      teamMembers: [],
      issueOwners: [{
        tenancyId: scope.tenancyId,
        projectId: scope.projectId,
        branchId: scope.branchId,
        issueId: "issue-other",
        ownerType: PrismaIssueOwnerType.USER,
        ownerUserId: "user-other",
        ownerTeamId: null,
        source: PrismaIssueOwnerSource.MANUAL,
      }],
    }, "issue-1")).toThrow("different issue");
  });
});

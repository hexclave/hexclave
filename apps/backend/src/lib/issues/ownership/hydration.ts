import {
  IssueOwnerSource as PrismaIssueOwnerSource,
  IssueOwnerType as PrismaIssueOwnerType,
} from "@/generated/prisma/client";
import { getPrismaClientForTenancy } from "@/prisma-client";
import type { Tenancy } from "@/lib/tenancies";
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch } from "@/lib/tenancies";
import type { IssueAlertEmailRouting } from "@/lib/issues/issue-alerts/destinations";
import {
  OWNERSHIP_RESOLVER_MAX_ISSUE_OWNERS,
  OWNERSHIP_RESOLVER_MAX_MEMBERS,
  OWNERSHIP_RESOLVER_MAX_TEAM_MEMBER_REFERENCES,
  OWNERSHIP_RESOLVER_MAX_TEAMS,
  OWNERSHIP_RESOLVER_SCHEMA_VERSION,
  type OwnershipIssueOwnerInput,
  type OwnershipMemberInput,
  type OwnershipOwnerSource,
  type OwnershipResolverInput,
  type OwnershipScope,
  type OwnershipTarget,
  type OwnershipTeamInput,
} from "./types";
import { resolveOwnershipRecipients } from "./resolver";
import {
  buildOwnershipRoutingMetadata,
  type OwnershipRoutingResolution,
  type OwnershipRoutingTargetMetadata,
} from "./routing-metadata";

const MAX_MEMBER_ROWS = OWNERSHIP_RESOLVER_MAX_MEMBERS + 1;
const MAX_TEAM_ROWS = OWNERSHIP_RESOLVER_MAX_TEAMS + 1;
const MAX_ISSUE_OWNER_ROWS = OWNERSHIP_RESOLVER_MAX_ISSUE_OWNERS + 1;
const MAX_TEAM_MEMBER_ROWS = OWNERSHIP_RESOLVER_MAX_TEAM_MEMBER_REFERENCES + 1;

export type OwnershipHydrationMemberRow = {
  tenancyId: string,
  mirroredProjectId: string,
  mirroredBranchId: string,
  projectUserId: string,
  lastActiveAt: Date,
  restrictedByAdmin: boolean,
  isAnonymous: boolean,
  eligibleForFallthrough?: boolean,
};

export type OwnershipHydrationTeamRow = {
  tenancyId: string,
  mirroredProjectId: string,
  mirroredBranchId: string,
  teamId: string,
};

export type OwnershipHydrationTeamMemberRow = {
  tenancyId: string,
  teamId: string,
  projectUserId: string,
};

export type OwnershipHydrationIssueOwnerRow = {
  tenancyId: string,
  projectId: string,
  branchId: string,
  issueId: string,
  ownerType: PrismaIssueOwnerType,
  ownerUserId: string | null,
  ownerTeamId: string | null,
  source: PrismaIssueOwnerSource,
};

export type OwnershipHydrationRows = {
  members: readonly OwnershipHydrationMemberRow[],
  teams: readonly OwnershipHydrationTeamRow[],
  teamMembers: readonly OwnershipHydrationTeamMemberRow[],
  issueOwners: readonly OwnershipHydrationIssueOwnerRow[],
};

function scopeFromMember(row: OwnershipHydrationMemberRow): OwnershipScope {
  return {
    tenancyId: row.tenancyId,
    projectId: row.mirroredProjectId,
    branchId: row.mirroredBranchId,
  };
}

function scopeFromTeam(row: OwnershipHydrationTeamRow): OwnershipScope {
  return {
    tenancyId: row.tenancyId,
    projectId: row.mirroredProjectId,
    branchId: row.mirroredBranchId,
  };
}

function isActiveMember(row: OwnershipHydrationMemberRow): boolean {
  return !row.restrictedByAdmin && !row.isAnonymous;
}

function timestampForResolver(value: Date): string {
  return Number.isFinite(value.getTime()) ? value.toISOString() : "invalid-timestamp";
}

function ownerSource(source: PrismaIssueOwnerSource): OwnershipOwnerSource {
  switch (source) {
    case PrismaIssueOwnerSource.MANUAL: { return "manual"; }
    case PrismaIssueOwnerSource.OWNERSHIP_RULE: { return "ownership_rule"; }
    case PrismaIssueOwnerSource.CODEOWNERS: { return "codeowners"; }
    case PrismaIssueOwnerSource.SUSPECT_COMMIT: { return "suspect_commit"; }
    case PrismaIssueOwnerSource.SEER_SUGGESTED: { return "seer_suggested"; }
  }
}

function issueOwnerInput(row: OwnershipHydrationIssueOwnerRow): OwnershipIssueOwnerInput {
  const scope: OwnershipScope = {
    tenancyId: row.tenancyId,
    projectId: row.projectId,
    branchId: row.branchId,
  };
  const source = ownerSource(row.source);
  if (row.ownerType === PrismaIssueOwnerType.USER
    && row.ownerUserId !== null
    && row.ownerTeamId === null) {
    return { scope, type: "user", userId: row.ownerUserId, source };
  }
  if (row.ownerType === PrismaIssueOwnerType.TEAM
    && row.ownerTeamId !== null
    && row.ownerUserId === null) {
    return { scope, type: "team", teamId: row.ownerTeamId, source };
  }
  throw new Error("Issue-owner hydration encountered an invalid owner row");
}

function targetForRouting(routing: IssueAlertEmailRouting): OwnershipTarget {
  if (routing.type === "team") return { type: "team", teamId: routing.teamId };
  return { type: "issue_owners", fallthrough: routing.fallthrough };
}

function metadataTargetForRouting(routing: IssueAlertEmailRouting): OwnershipRoutingTargetMetadata {
  if (routing.type === "team") return { type: "team", team_id: routing.teamId };
  return { type: "issue_owners", fallthrough: routing.fallthrough };
}

export function buildOwnershipResolverInput(
  scope: OwnershipScope,
  target: OwnershipTarget,
  rows: OwnershipHydrationRows,
  issueId: string,
): OwnershipResolverInput {
  if (rows.issueOwners.some((owner) => owner.issueId !== issueId)) {
    throw new Error("Issue-owner hydration encountered a row for a different issue");
  }

  const teams: OwnershipTeamInput[] = [];
  for (const team of rows.teams) {
    const teamScope = scopeFromTeam(team);
    const memberUserIds = rows.teamMembers
      .filter((member) => member.tenancyId === team.tenancyId && member.teamId === team.teamId)
      .map((member) => member.projectUserId);
    teams.push({ scope: teamScope, teamId: team.teamId, memberUserIds });
  }

  const memberRows = rows.members.length > OWNERSHIP_RESOLVER_MAX_MEMBERS
    ? rows.members
    : rows.members.filter(isActiveMember);
  const members: OwnershipMemberInput[] = memberRows.map((member) => ({
    scope: scopeFromMember(member),
    userId: member.projectUserId,
    isActive: true,
    lastActiveAt: timestampForResolver(member.lastActiveAt),
    eligibleForFallthrough: member.eligibleForFallthrough ?? true,
  }));
  const issueOwners = rows.issueOwners.map(issueOwnerInput);
  return {
    schemaVersion: OWNERSHIP_RESOLVER_SCHEMA_VERSION,
    scope,
    target,
    members,
    teams,
    issueOwners,
  };
}

export async function hydrateIssueAlertOwnership(
  tenancy: Tenancy,
  issueId: string,
  routing: IssueAlertEmailRouting,
): Promise<OwnershipRoutingResolution> {
  const scope: OwnershipScope = {
    tenancyId: tenancy.id,
    projectId: tenancy.project.id,
    branchId: tenancy.branchId,
  };
  const target = targetForRouting(routing);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const replica = prisma.$replica();
  const memberRowsPromise = replica.projectUser.findMany({
    where: {
      tenancyId: scope.tenancyId,
      mirroredProjectId: scope.projectId,
      mirroredBranchId: scope.branchId,
    },
    orderBy: { projectUserId: "asc" },
    take: MAX_MEMBER_ROWS,
    select: {
      tenancyId: true,
      mirroredProjectId: true,
      mirroredBranchId: true,
      projectUserId: true,
      lastActiveAt: true,
      restrictedByAdmin: true,
      isAnonymous: true,
    },
  });
  const issueOwnerRowsPromise = routing.type === "issue_owners"
    ? replica.issueOwner.findMany({
      where: {
        tenancyId: scope.tenancyId,
        projectId: scope.projectId,
        branchId: scope.branchId,
        issueId,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: MAX_ISSUE_OWNER_ROWS,
      select: {
        tenancyId: true,
        projectId: true,
        branchId: true,
        issueId: true,
        ownerType: true,
        ownerUserId: true,
        ownerTeamId: true,
        source: true,
      },
    })
    : Promise.resolve([]);
  const [memberRows, issueOwnerRows] = await Promise.all([memberRowsPromise, issueOwnerRowsPromise]);

  const teamIds = new Set<string>();
  if (routing.type === "team") teamIds.add(routing.teamId);
  for (const owner of issueOwnerRows) {
    if (owner.ownerType === PrismaIssueOwnerType.TEAM && owner.ownerTeamId !== null) teamIds.add(owner.ownerTeamId);
  }
  const requestedTeamIds = [...teamIds].sort();
  const internalTenancy = requestedTeamIds.length === 0
    ? null
    : await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID, true);
  const internalReplica = internalTenancy === null
    ? null
    : (await getPrismaClientForTenancy(internalTenancy)).$replica();
  const internalTeamRows = internalReplica === null
    ? []
    : await internalReplica.team.findMany({
      where: {
        tenancyId: internalTenancy?.id,
        teamId: { in: requestedTeamIds },
      },
      orderBy: { teamId: "asc" },
      take: MAX_TEAM_ROWS,
      select: {
        teamId: true,
      },
    });
  const internalTeamMemberRows = internalReplica === null
    ? []
    : (await Promise.all(internalTeamRows.map(async (team) => await internalReplica.teamMember.findMany({
      where: {
        tenancyId: internalTenancy?.id,
        teamId: team.teamId,
      },
      orderBy: { projectUserId: "asc" },
      take: MAX_TEAM_MEMBER_ROWS,
      select: {
        teamId: true,
        projectUser: {
          select: {
            projectUserId: true,
            lastActiveAt: true,
            restrictedByAdmin: true,
            isAnonymous: true,
          },
        },
      },
    })))).flat();

  const teamRows: OwnershipHydrationTeamRow[] = internalTeamRows.map((team) => ({
    tenancyId: scope.tenancyId,
    mirroredProjectId: scope.projectId,
    mirroredBranchId: scope.branchId,
    teamId: team.teamId,
  }));
  const teamMemberRows: OwnershipHydrationTeamMemberRow[] = internalTeamMemberRows.map((member) => ({
    tenancyId: scope.tenancyId,
    teamId: member.teamId,
    projectUserId: member.projectUser.projectUserId,
  }));
  const internalMembersById = new Map<string, OwnershipHydrationMemberRow>();
  for (const member of internalTeamMemberRows) {
    internalMembersById.set(member.projectUser.projectUserId, {
      tenancyId: scope.tenancyId,
      mirroredProjectId: scope.projectId,
      mirroredBranchId: scope.branchId,
      projectUserId: member.projectUser.projectUserId,
      lastActiveAt: member.projectUser.lastActiveAt,
      restrictedByAdmin: member.projectUser.restrictedByAdmin,
      isAnonymous: member.projectUser.isAnonymous,
      eligibleForFallthrough: false,
    });
  }
  const internalMemberRows = [...internalMembersById.values()];

  const input = buildOwnershipResolverInput(scope, target, {
    members: [...memberRows, ...internalMemberRows],
    teams: teamRows,
    teamMembers: teamMemberRows,
    issueOwners: issueOwnerRows,
  }, issueId);
  const resolution = resolveOwnershipRecipients(input);
  return {
    recipients: resolution.recipients,
    metadata: buildOwnershipRoutingMetadata(metadataTargetForRouting(routing), resolution),
  };
}

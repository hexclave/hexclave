import { StandardOAuthProviderType } from "@/generated/prisma/client";
import { logPermissionDeniedInBackground } from "@/lib/compliance-events";
import { KnownErrors } from "@hexclave/shared";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { ProviderType, standardProviders } from "@hexclave/shared/dist/utils/oauth";
import { typedToUppercase } from "@hexclave/shared/dist/utils/strings";
import { listPermissions } from "./permissions";
import { Tenancy } from "./tenancies";
import { PrismaTransaction } from "./types";


async function _getTeamMembership(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    teamId: string, userId: string,
  }
) {
  return await tx.teamMember.findUnique({
    where: {
      tenancyId_projectUserId_teamId: {
        tenancyId: options.tenancyId,
        projectUserId: options.userId,
        teamId: options.teamId,
      },
    },
  });
}

export async function ensureTeamMembershipExists(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    teamId: string,
    userId: string,
  }
) {
  await ensureUserExists(tx, { tenancyId: options.tenancyId, userId: options.userId });

  const member = await _getTeamMembership(tx, options);

  if (!member) {
    throw new KnownErrors.TeamMembershipNotFound(options.teamId, options.userId);
  }
}

export async function ensureTeamMembershipDoesNotExist(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    teamId: string,
    userId: string,
  }
) {
  const member = await _getTeamMembership(tx, options);

  if (member) {
    throw new KnownErrors.TeamMembershipAlreadyExists();
  }
}

export async function ensureTeamExists(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    teamId: string,
  }
) {
  const team = await tx.team.findUnique({
    where: {
      tenancyId_teamId: {
        tenancyId: options.tenancyId,
        teamId: options.teamId,
      },
    },
  });

  if (!team) {
    throw new KnownErrors.TeamNotFound(options.teamId);
  }
}

/**
 * Like `ensureTeamExists`, but also takes a FOR UPDATE row lock on the team for the rest of the transaction.
 *
 * Use this as the first lock in transactions that lock a team's dependent rows (members, permissions,
 * invitations) and then the team itself. The external DB sync sequencer locks the Team row first and then
 * the team's TEAM_INVITATION verification codes (in one statement), so taking the locks in the opposite
 * order can deadlock against it.
 */
export async function lockTeamForUpdate(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    teamId: string,
  }
) {
  const rows = await tx.$queryRaw<{ teamId: string }[]>`
    SELECT "teamId"
    FROM "Team"
    WHERE "tenancyId" = ${options.tenancyId}::uuid
      AND "teamId" = ${options.teamId}::uuid
    FOR UPDATE
  `;

  if (rows.length === 0) {
    throw new KnownErrors.TeamNotFound(options.teamId);
  }
}

export async function ensureUserTeamPermissionExists(
  tx: PrismaTransaction,
  options: {
    tenancy: Tenancy,
    teamId: string,
    userId: string,
    permissionId: string,
    errorType: 'required' | 'not-exist',
    recursive: boolean,
  }
) {
  await ensureTeamMembershipExists(tx, {
    tenancyId: options.tenancy.id,
    teamId: options.teamId,
    userId: options.userId,
  });

  const result = await listPermissions(tx, {
    scope: 'team',
    tenancy: options.tenancy,
    teamId: options.teamId,
    userId: options.userId,
    permissionId: options.permissionId,
    recursive: options.recursive,
  });

  if (result.length === 0) {
    if (options.errorType === 'not-exist') {
      throw new KnownErrors.TeamPermissionNotFound(options.teamId, options.userId, options.permissionId);
    } else {
      logPermissionDeniedInBackground(options.tenancy, {
        userId: options.userId,
        permissionId: options.permissionId,
        teamId: options.teamId,
        scope: "team",
      });
      throw new KnownErrors.TeamPermissionRequired(options.teamId, options.userId, options.permissionId);
    }
  }
}

export async function ensureProjectPermissionExists(
  tx: PrismaTransaction,
  options: {
    tenancy: Tenancy,
    userId: string,
    permissionId: string,
    errorType: 'required' | 'not-exist',
    recursive: boolean,
  }
) {
  await ensureUserExists(tx, {
    tenancyId: options.tenancy.id,
    userId: options.userId,
  });

  const result = await listPermissions(tx, {
    scope: 'project',
    tenancy: options.tenancy,
    userId: options.userId,
    permissionId: options.permissionId,
    recursive: options.recursive,
  });

  if (result.length === 0) {
    if (options.errorType === 'not-exist') {
      throw new KnownErrors.PermissionNotFound(options.permissionId);
    } else {
      logPermissionDeniedInBackground(options.tenancy, {
        userId: options.userId,
        permissionId: options.permissionId,
        scope: "project",
      });
      throw new KnownErrors.ProjectPermissionRequired(options.userId, options.permissionId);
    }
  }
}

export async function ensureUserExists(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    userId: string,
  }
) {
  const user = await tx.projectUser.findUnique({
    where: {
      tenancyId_projectUserId: {
        tenancyId: options.tenancyId,
        projectUserId: options.userId,
      },
    },
  });

  if (!user) {
    throw new KnownErrors.UserNotFound();
  }
}

export function ensureStandardProvider(
  providerId: ProviderType
): Lowercase<StandardOAuthProviderType> {
  if (!standardProviders.includes(providerId as any)) {
    throw new KnownErrors.InvalidStandardOAuthProviderId(providerId);
  }
  return providerId as any;
}

export async function ensureContactChannelDoesNotExists(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    userId: string,
    type: 'email',
    value: string,
  }
) {
  const contactChannel = await tx.contactChannel.findUnique({
    where: {
      tenancyId_projectUserId_type_value: {
        tenancyId: options.tenancyId,
        projectUserId: options.userId,
        type: typedToUppercase(options.type),
        value: options.value,
      },
    },
  });

  if (contactChannel) {
    throw new StatusError(StatusError.BadRequest, 'Contact channel already exists');
  }
}

export async function ensureContactChannelExists(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    userId: string,
    contactChannelId: string,
  }
) {
  const contactChannel = await tx.contactChannel.findUnique({
    where: {
      tenancyId_projectUserId_id: {
        tenancyId: options.tenancyId,
        projectUserId: options.userId,
        id: options.contactChannelId,
      },
    },
  });

  if (!contactChannel) {
    throw new StatusError(StatusError.BadRequest, 'Contact channel not found');
  }

  return contactChannel;
}

import { buildCreatedFieldsAuditMetadata, recordAuditEvent, shouldRecordAdminAudit } from "@/lib/audit-log";
import { recordExternalDbSyncDeletion, recordExternalDbSyncTeamPermissionDeletionsForTeamMember, withExternalDbSyncUpdate } from "@/lib/external-db-sync";
import { grantDefaultTeamPermissions } from "@/lib/permissions";
import { ensureTeamExists, ensureTeamMembershipDoesNotExist, ensureTeamMembershipExists, ensureUserExists, ensureUserTeamPermissionExists } from "@/lib/request-checks";
import { Tenancy } from "@/lib/tenancies";
import { PrismaTransaction } from "@/lib/types";
import { sendTeamMembershipCreatedWebhook, sendTeamMembershipDeletedWebhook, sendTeamPermissionCreatedWebhook } from "@/lib/webhooks";
import { enqueueWorkflowEvent } from "@/lib/workflows/events";
import { getPrismaClientForTenancy, retryTransaction } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { KnownErrors } from "@hexclave/shared";
import { teamMembershipsCrud } from "@hexclave/shared/dist/interface/crud/team-memberships";
import { userIdOrMeSchema, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";


export async function addUserToTeam(tx: PrismaTransaction, options: {
  tenancy: Tenancy,
  teamId: string,
  userId: string,
  type: 'member' | 'creator',
}) {
  await tx.teamMember.create({
    data: withExternalDbSyncUpdate({
      projectUserId: options.userId,
      teamId: options.teamId,
      tenancyId: options.tenancy.id,
    }),
  });

  const result = await grantDefaultTeamPermissions(tx, {
    tenancy: options.tenancy,
    userId: options.userId,
    teamId: options.teamId,
    type: options.type,
  });

  return {
    directPermissionIds: result.grantedPermissionIds,
  };
}


export const teamMembershipsCrudHandlers = createLazyProxy(() => createCrudHandlers(teamMembershipsCrud, {
  paramsSchema: yupObject({
    team_id: yupString().uuid().defined(),
    user_id: userIdOrMeSchema.defined(),
  }),
  onCreate: async ({ auth, params }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const result = await retryTransaction(prisma, async (tx) => {
      await ensureUserExists(tx, {
        tenancyId: auth.tenancy.id,
        userId: params.user_id,
      });

      await ensureTeamExists(tx, {
        tenancyId: auth.tenancy.id,
        teamId: params.team_id,
      });

      await ensureTeamMembershipDoesNotExist(tx, {
        tenancyId: auth.tenancy.id,
        teamId: params.team_id,
        userId: params.user_id
      });

      const user = await tx.projectUser.findUnique({
        where: {
          tenancyId_projectUserId: {
            tenancyId: auth.tenancy.id,
            projectUserId: params.user_id,
          },
        },
      });

      if (!user) {
        throw new KnownErrors.UserNotFound();
      }

      const addResult = await addUserToTeam(tx, {
        tenancy: auth.tenancy,
        teamId: params.team_id,
        userId: params.user_id,
        type: 'member',
      });

      // Workflow platform events ride the entity transaction (transactional
      // outbox); the Svix webhooks below stay fire-and-forget post-commit.
      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "team_membership.created", payload: { team_id: params.team_id, user_id: params.user_id } });
      for (const permissionId of addResult.directPermissionIds) {
        await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "team_permission.created", payload: { id: permissionId, team_id: params.team_id, user_id: params.user_id } });
      }

      return addResult;
    });

    const data = {
      team_id: params.team_id,
      user_id: params.user_id,
    };

    // Membership create is server/admin-only at the CRUD schema layer; still gate
    // so programmatic helpers never write admin audit noise.
    if (shouldRecordAdminAudit(auth)) {
      const metadata = buildCreatedFieldsAuditMetadata({
        source: "team_memberships.create",
        fields: {
          team_id: params.team_id,
          user_id: params.user_id,
          ...(result.directPermissionIds.length > 0
            ? { granted_permission_ids: result.directPermissionIds }
            : {}),
        },
      }) ?? {
          source: "team_memberships.create",
          team_id: params.team_id,
          user_id: params.user_id,
        };
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "team_membership.created",
        targetUserId: params.user_id,
        metadata,
      });
    }

    runAsynchronouslyAndWaitUntil((async () => {
      await sendTeamMembershipCreatedWebhook({
        projectId: auth.project.id,
        data,
      });

      await Promise.all(
        result.directPermissionIds.map((permissionId) =>
          sendTeamPermissionCreatedWebhook({
            projectId: auth.project.id,
            data: {
              id: permissionId,
              team_id: params.team_id,
              user_id: params.user_id,
            }
          })
        )
      );
    })());

    return data;
  },
  onDelete: async ({ auth, params }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    await retryTransaction(prisma, async (tx) => {
      // Users are always allowed to remove themselves from a team
      // Only users with the $remove_members permission can remove other users
      if (auth.type === 'client') {
        const currentUserId = auth.user?.id ?? throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());

        if (params.user_id !== currentUserId) {
          await ensureUserTeamPermissionExists(tx, {
            tenancy: auth.tenancy,
            teamId: params.team_id,
            userId: auth.user?.id ?? throwErr('auth.user is null'),
            permissionId: "$remove_members",
            errorType: 'required',
            recursive: true,
          });
        }
      }

      await ensureTeamMembershipExists(tx, {
        tenancyId: auth.tenancy.id,
        teamId: params.team_id,
        userId: params.user_id,
      });

      await recordExternalDbSyncTeamPermissionDeletionsForTeamMember(tx, {
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
        teamId: params.team_id,
      });

      await recordExternalDbSyncDeletion(tx, {
        tableName: "TeamMember",
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
        teamId: params.team_id,
      });

      await tx.teamMember.delete({
        where: {
          tenancyId_projectUserId_teamId: {
            tenancyId: auth.tenancy.id,
            projectUserId: params.user_id,
            teamId: params.team_id,
          },
        },
      });

      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "team_membership.deleted", payload: { team_id: params.team_id, user_id: params.user_id } });
    });

    // Skip client self-remove / client $remove_members — Compliance covers dashboard/admin.
    if (shouldRecordAdminAudit(auth)) {
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "team_membership.deleted",
        targetUserId: params.user_id,
        metadata: {
          source: "team_memberships.delete",
          team_id: params.team_id,
          user_id: params.user_id,
        },
      });
    }

    runAsynchronouslyAndWaitUntil(sendTeamMembershipDeletedWebhook({
      projectId: auth.project.id,
      data: {
        team_id: params.team_id,
        user_id: params.user_id,
      },
    }));
  },
}));

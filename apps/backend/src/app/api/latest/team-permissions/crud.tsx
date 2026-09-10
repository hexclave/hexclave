import { buildCreatedFieldsAuditMetadata, recordAuditEvent, shouldRecordAdminAudit } from "@/lib/audit-log";
import { grantTeamPermission, listPermissions, revokeTeamPermission } from "@/lib/permissions";
import { ensureTeamMembershipExists, ensureUserTeamPermissionExists } from "@/lib/request-checks";
import { sendTeamPermissionCreatedWebhook, sendTeamPermissionDeletedWebhook } from "@/lib/webhooks";
import { enqueueWorkflowEvent } from "@/lib/workflows/events";
import { getPrismaClientForTenancy, retryTransaction } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { KnownErrors } from "@hexclave/shared";
import { teamPermissionsCrud } from '@hexclave/shared/dist/interface/crud/team-permissions';
import { permissionDefinitionIdSchema, userIdOrMeSchema, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";

export const teamPermissionsCrudHandlers = createLazyProxy(() => createCrudHandlers(teamPermissionsCrud, {
  querySchema: yupObject({
    team_id: yupString().uuid().optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: 'Filter with the team ID. If set, only the permissions of the members in a specific team will be returned.', exampleValue: 'cce084a3-28b7-418e-913e-c8ee6d802ea4' } }),
    user_id: userIdOrMeSchema.optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: 'Filter with the user ID. If set, only the permissions this user has will be returned. Client request must set `user_id=me`', exampleValue: 'me' } }),
    permission_id: permissionDefinitionIdSchema.optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: 'Filter with the permission ID. If set, only the permissions with this specific ID will be returned', exampleValue: '16399452-c4f3-4554-8e44-c2d67bb60360' } }),
    recursive: yupString().oneOf(['true', 'false']).optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: 'Whether to list permissions recursively. If set to `false`, only the permission the users directly have will be listed. If set to `true` all the direct and indirect permissions will be listed.', exampleValue: 'true' } }),
  }),
  paramsSchema: yupObject({
    team_id: yupString().uuid().defined(),
    user_id: userIdOrMeSchema.defined(),
    permission_id: permissionDefinitionIdSchema.defined(),
  }),
  async onCreate({ auth, params }) {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const result = await retryTransaction(prisma, async (tx) => {
      await ensureTeamMembershipExists(tx, { tenancyId: auth.tenancy.id, teamId: params.team_id, userId: params.user_id });

      const existingGrant = await tx.teamMemberDirectPermission.findUnique({
        where: {
          tenancyId_projectUserId_teamId_permissionId: {
            tenancyId: auth.tenancy.id,
            projectUserId: params.user_id,
            teamId: params.team_id,
            permissionId: params.permission_id,
          },
        },
        select: { id: true },
      });

      const granted = await grantTeamPermission(tx, {
        tenancy: auth.tenancy,
        teamId: params.team_id,
        userId: params.user_id,
        permissionId: params.permission_id
      });
      // Workflow platform events ride the entity transaction (transactional
      // outbox); the Svix webhook below stays fire-and-forget post-commit.
      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "team_permission.created", payload: { id: params.permission_id, team_id: params.team_id, user_id: params.user_id } });
      return { granted, created: existingGrant == null };
    });

    if (shouldRecordAdminAudit(auth) && result.created) {
      const metadata = buildCreatedFieldsAuditMetadata({
        source: "team_permissions.create",
        fields: {
          team_id: params.team_id,
          user_id: params.user_id,
          permission_id: params.permission_id,
        },
      }) ?? {
          source: "team_permissions.create",
          team_id: params.team_id,
          user_id: params.user_id,
          permission_id: params.permission_id,
        };
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "team_permission.granted",
        targetUserId: params.user_id,
        metadata,
      });
    }

    runAsynchronouslyAndWaitUntil(sendTeamPermissionCreatedWebhook({
      projectId: auth.project.id,
      data: {
        id: params.permission_id,
        team_id: params.team_id,
        user_id: params.user_id,
      }
    }));

    return result.granted;
  },
  async onDelete({ auth, params }) {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const result = await retryTransaction(prisma, async (tx) => {
      await ensureUserTeamPermissionExists(tx, {
        tenancy: auth.tenancy,
        teamId: params.team_id,
        userId: params.user_id,
        permissionId: params.permission_id,
        errorType: 'not-exist',
        recursive: false,
      });

      const revoked = await revokeTeamPermission(tx, {
        tenancy: auth.tenancy,
        teamId: params.team_id,
        userId: params.user_id,
        permissionId: params.permission_id
      });
      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "team_permission.deleted", payload: { id: params.permission_id, team_id: params.team_id, user_id: params.user_id } });
      return revoked;
    });

    if (shouldRecordAdminAudit(auth)) {
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "team_permission.revoked",
        targetUserId: params.user_id,
        metadata: {
          source: "team_permissions.delete",
          team_id: params.team_id,
          user_id: params.user_id,
          permission_id: params.permission_id,
        },
      });
    }

    runAsynchronouslyAndWaitUntil(sendTeamPermissionDeletedWebhook({
      projectId: auth.project.id,
      data: {
        id: params.permission_id,
        team_id: params.team_id,
        user_id: params.user_id,
      }
    }));

    return result;
  },
  async onList({ auth, query }) {
    if (auth.type === 'client') {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());

      if (query.user_id !== currentUserId) {
        throw new StatusError(StatusError.Forbidden, 'Client can only list permissions for their own user. user_id must be either "me" or the ID of the current user');
      }
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    return await retryTransaction(prisma, async (tx) => {
      return {
        items: await listPermissions(tx, {
          scope: 'team',
          tenancy: auth.tenancy,
          teamId: query.team_id,
          permissionId: query.permission_id,
          userId: query.user_id,
          recursive: query.recursive === 'true',
        }),
        is_paginated: false,
      };
    });
  },
}));

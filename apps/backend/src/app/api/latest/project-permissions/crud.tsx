import { buildCreatedFieldsAuditMetadata, recordAuditEvent, shouldRecordDashboardAudit } from "@/lib/audit-log";
import { grantProjectPermission, listPermissions, revokeProjectPermission } from "@/lib/permissions";
import { ensureProjectPermissionExists, ensureUserExists } from "@/lib/request-checks";
import { sendProjectPermissionCreatedWebhook, sendProjectPermissionDeletedWebhook } from "@/lib/webhooks";
import { enqueueWorkflowEvent } from "@/lib/workflows/events";
import { getPrismaClientForTenancy, retryTransaction } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { KnownErrors } from "@hexclave/shared";
import { projectPermissionsCrud } from '@hexclave/shared/dist/interface/crud/project-permissions';
import { permissionDefinitionIdSchema, userIdOrMeSchema, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";

export const projectPermissionsCrudHandlers = createLazyProxy(() => createCrudHandlers(projectPermissionsCrud, {
  querySchema: yupObject({
    user_id: userIdOrMeSchema.optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: 'Filter with the user ID. If set, only the permissions this user has will be returned. Client request must set `user_id=me`', exampleValue: 'me' } }),
    permission_id: permissionDefinitionIdSchema.optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: 'Filter with the permission ID. If set, only the permissions with this specific ID will be returned', exampleValue: '16399452-c4f3-4554-8e44-c2d67bb60360' } }),
    recursive: yupString().oneOf(['true', 'false']).optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: 'Whether to list permissions recursively. If set to `false`, only the permission the users directly have will be listed. If set to `true` all the direct and indirect permissions will be listed.', exampleValue: 'true' } }),
  }),
  paramsSchema: yupObject({
    user_id: userIdOrMeSchema.defined(),
    permission_id: permissionDefinitionIdSchema.defined(),
  }),
  async onCreate({ auth, params }) {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const result = await retryTransaction(prisma, async (tx) => {
      await ensureUserExists(tx, { tenancyId: auth.tenancy.id, userId: params.user_id });

      const granted = await grantProjectPermission(tx, {
        tenancy: auth.tenancy,
        userId: params.user_id,
        permissionId: params.permission_id
      });
      // Workflow platform events ride the entity transaction (transactional
      // outbox); the Svix webhook below stays fire-and-forget post-commit.
      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "project_permission.created", payload: { id: params.permission_id, user_id: params.user_id } });
      return granted;
    });

    // Dashboard-only: bare admin/server API keys must not write Compliance events.
    if (shouldRecordDashboardAudit(auth)) {
      const metadata = buildCreatedFieldsAuditMetadata({
        source: "project_permissions.create",
        fields: {
          user_id: params.user_id,
          permission_id: params.permission_id,
        },
      }) ?? {
          source: "project_permissions.create",
          user_id: params.user_id,
          permission_id: params.permission_id,
        };
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "project_permission.granted",
        targetUserId: params.user_id,
        metadata,
      });
    }

    runAsynchronouslyAndWaitUntil(sendProjectPermissionCreatedWebhook({
      projectId: auth.project.id,
      data: {
        id: params.permission_id,
        user_id: params.user_id,
      }
    }));

    return result;
  },
  async onDelete({ auth, params }) {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const result = await retryTransaction(prisma, async (tx) => {
      await ensureProjectPermissionExists(tx, {
        tenancy: auth.tenancy,
        userId: params.user_id,
        permissionId: params.permission_id,
        errorType: 'not-exist',
        recursive: false,
      });

      const revoked = await revokeProjectPermission(tx, {
        tenancy: auth.tenancy,
        userId: params.user_id,
        permissionId: params.permission_id
      });
      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "project_permission.deleted", payload: { id: params.permission_id, user_id: params.user_id } });
      return revoked;
    });

    if (shouldRecordDashboardAudit(auth)) {
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "project_permission.revoked",
        targetUserId: params.user_id,
        metadata: {
          source: "project_permissions.delete",
          user_id: params.user_id,
          permission_id: params.permission_id,
        },
      });
    }

    runAsynchronouslyAndWaitUntil(sendProjectPermissionDeletedWebhook({
      projectId: auth.project.id,
      data: {
        id: params.permission_id,
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
          scope: 'project',
          tenancy: auth.tenancy,
          permissionId: query.permission_id,
          userId: query.user_id,
          recursive: query.recursive === 'true',
        }),
        is_paginated: false,
      };
    });
  },
}));

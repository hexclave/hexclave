import { buildUpdatedFieldsAuditMetadata, recordAuditEvent, shouldRecordAdminAudit } from "@/lib/audit-log";
import { globalPrismaClient } from "@/prisma-client";
import { createPrismaCrudHandlers } from "@/route-handlers/prisma-handler";
import { KnownErrors } from "@hexclave/shared";
import { internalApiKeysCrud } from "@hexclave/shared/dist/interface/crud/internal-api-keys";
import { yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";

export const internalApiKeyCrudHandlers = createLazyProxy(() => createPrismaCrudHandlers(internalApiKeysCrud, "apiKeySet", {
  paramsSchema: yupObject({
    api_key_id: yupString().uuid().defined(),
  }),
  baseFields: async () => ({}),
  where: async ({ auth }) => {
    return {
      projectId: auth.project.id,
    };
  },
  whereUnique: async ({ params, auth }) => {
    return {
      projectId_id: {
        projectId: auth.project.id,
        id: params.api_key_id,
      },
    };
  },
  include: async () => ({}),
  notFoundToCrud: () => {
    throw new KnownErrors.ApiKeyNotFound();
  },
  orderBy: async () => {
    return {
      createdAt: 'desc',
    };
  },
  crudToPrisma: async (crud, { auth, params }) => {
    // Need the prior row so re-PATCH with revoked:true does not overwrite the
    // original revoke timestamp (create is handled by a separate route).
    const old = await globalPrismaClient.apiKeySet.findUnique({
      where: {
        projectId_id: {
          projectId: auth.project.id,
          id: params.api_key_id ?? throwErr('params.apiKeyId is required for update'),
        },
      },
    });

    return {
      description: crud.description,
      manuallyRevokedAt: old?.manuallyRevokedAt != null ? undefined : (crud.revoked ? new Date() : undefined),
    };
  },
  prismaToCrud: async (prisma) => {
    return {
      id: prisma.id,
      description: prisma.description,
      publishable_client_key: prisma.publishableClientKey ? {
        last_four: prisma.publishableClientKey.slice(-4),
      } : undefined,
      secret_server_key: prisma.secretServerKey ? {
        last_four: prisma.secretServerKey.slice(-4),
      } : undefined,
      super_secret_admin_key: prisma.superSecretAdminKey ? {
        last_four: prisma.superSecretAdminKey.slice(-4),
      } : undefined,
      created_at_millis: prisma.createdAt.getTime(),
      expires_at_millis: prisma.expiresAt.getTime(),
      manually_revoked_at_millis: prisma.manuallyRevokedAt?.getTime(),
    };
  },
  onUpdate: async (prisma, { auth }, { previous }) => {
    if (!shouldRecordAdminAudit(auth)) {
      return;
    }

    // First revoke wins a dedicated action; description edits are a separate update event.
    if (previous.manuallyRevokedAt == null && prisma.manuallyRevokedAt != null) {
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "project_api_key.revoked",
        metadata: {
          source: "api_keys.update",
          api_key_id: prisma.id,
          description: prisma.description,
        },
      });
    }

    if (previous.description !== prisma.description) {
      const metadata = buildUpdatedFieldsAuditMetadata({
        source: "api_keys.update",
        patch: { description: prisma.description },
        beforeRoot: { description: previous.description },
        afterRoot: { description: prisma.description },
      });
      if (metadata != null) {
        await recordAuditEvent({
          tenancy: auth.tenancy,
          auth,
          action: "project_api_key.updated",
          metadata: {
            ...metadata,
            api_key_id: prisma.id,
          },
        });
      }
    }
  },
}));

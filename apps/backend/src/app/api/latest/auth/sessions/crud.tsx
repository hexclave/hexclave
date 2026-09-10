import { recordAuditEvent } from "@/lib/audit-log";
import { recordExternalDbSyncDeletion } from "@/lib/external-db-sync";
import { globalPrismaClient } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { SmartRequestAuth } from "@/route-handlers/smart-request";
import { KnownErrors } from "@hexclave/shared";
import { sessionsCrud } from "@hexclave/shared/dist/interface/crud/sessions";
import { userIdOrMeSchema, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { geoInfoSchema } from "@hexclave/shared/dist/utils/geo";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";

export const sessionsCrudHandlers = createLazyProxy(() => createCrudHandlers(sessionsCrud, {
  paramsSchema: yupObject({
    id: yupString().uuid().defined(),
  }).defined(),
  querySchema: yupObject({
    user_id: userIdOrMeSchema.defined(),
  }).defined(),
  onList: async ({ auth, query }) => {
    const listImpersonations = auth.type === 'admin';

    if (auth.type === 'client') {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());
      if (currentUserId !== query.user_id) {
        throw new StatusError(StatusError.Forbidden, 'Client can only list sessions for their own user.');
      }
    }

    const refreshTokenObjs = await globalPrismaClient.projectUserRefreshToken.findMany({
      where: {
        tenancyId: auth.tenancy.id,
        projectUserId: query.user_id,
        isImpersonation: listImpersonations ? undefined : false,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const result = {
      items: refreshTokenObjs.map(s => {
        const ipInfo = s.lastActiveAtIpInfo ? geoInfoSchema.validateSync(s.lastActiveAtIpInfo) : undefined;
        return {
          id: s.id,
          user_id: s.projectUserId,
          created_at: s.createdAt.getTime(),
          last_used_at: s.lastActiveAt.getTime(),
          is_impersonation: s.isImpersonation,
          is_current_session: s.id === auth.refreshTokenId,
          last_used_at_end_user_ip_info: ipInfo,
        };
      }),
      is_paginated: false,
    };

    return result;
  },
  onDelete: async ({ auth, params }: { auth: SmartRequestAuth, params: { id: string }, query: { user_id?: string } }) => {
    const session = await globalPrismaClient.projectUserRefreshToken.findFirst({
      where: {
        tenancyId: auth.tenancy.id,
        id: params.id,
      },
    });

    if (!session || (auth.type === 'client' && auth.user?.id !== session.projectUserId)) {
      throw new StatusError(StatusError.NotFound, 'Session not found.');
    }


    if (auth.refreshTokenId === session.id) {
      throw new KnownErrors.CannotDeleteCurrentSession();
    }

    await recordExternalDbSyncDeletion(globalPrismaClient, {
      tableName: "ProjectUserRefreshToken",
      tenancyId: auth.tenancy.id,
      refreshTokenId: params.id,
    });

    const deleted = await globalPrismaClient.projectUserRefreshToken.deleteMany({
      where: {
        tenancyId: auth.tenancy.id,
        id: params.id,
      },
    });

    if (deleted.count === 0) {
      return;
    }

    if (session.isImpersonation) {
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "impersonation.revoked",
        targetUserId: session.projectUserId,
        metadata: {
          refresh_token_id: session.id,
          source: "auth.sessions.delete",
        },
      });
    }
  },
}));

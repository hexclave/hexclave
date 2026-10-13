import { recordExternalDbSyncDeletion } from "@/lib/external-db-sync";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { SmartRequestAuth } from "@/route-handlers/smart-request";
import { KnownErrors } from "@hexclave/shared";
import { sessionsCrud, type SessionsCrud } from "@hexclave/shared/dist/interface/crud/sessions";
import { userIdOrMeSchema, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { geoInfoSchema } from "@hexclave/shared/dist/utils/geo";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";

function sessionRead(options: {
  id: string,
  userId: string,
  createdAt: Date,
  lastUsedAt: Date,
  isImpersonation: boolean,
  currentSessionId: string | null | undefined,
  lastUsedAtEndUserIpInfo?: SessionsCrud["Server"]["Read"]["last_used_at_end_user_ip_info"],
}): SessionsCrud["Server"]["Read"] {
  return {
    id: options.id,
    user_id: options.userId,
    created_at: options.createdAt.getTime(),
    last_used_at: options.lastUsedAt.getTime(),
    is_impersonation: options.isImpersonation,
    is_current_session: options.id === options.currentSessionId,
    last_used_at_end_user_ip_info: options.lastUsedAtEndUserIpInfo,
  };
}

export const sessionsCrudHandlers = createLazyProxy(() => createCrudHandlers(sessionsCrud, {
  paramsSchema: yupObject({
    id: yupString().uuid().defined(),
  }).defined(),
  querySchema: yupObject({
    user_id: userIdOrMeSchema.defined(),
  }).defined(),
  onList: async ({ auth, query }) => {
    const listImpersonations = auth.type === 'admin';
    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    if (auth.type === 'client') {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());
      if (currentUserId !== query.user_id) {
        throw new StatusError(StatusError.Forbidden, 'Client can only list sessions for their own user.');
      }
    }

    const [refreshTokenObjs, externalSessions] = await Promise.all([
      globalPrismaClient.projectUserRefreshToken.findMany({
        where: {
          tenancyId: auth.tenancy.id,
          projectUserId: query.user_id,
          isImpersonation: listImpersonations ? undefined : false,
        },
      }),
      prisma.externalAuthSession.findMany({
        where: {
          tenancyId: auth.tenancy.id,
          externalAuthMethod: {
            projectUserId: query.user_id,
          },
          revokedAt: null,
        },
        include: {
          externalAuthMethod: true,
        },
      }),
    ]);

    return {
      items: [...refreshTokenObjs.map(session => {
        const ipInfo = session.lastActiveAtIpInfo ? geoInfoSchema.validateSync(session.lastActiveAtIpInfo) : undefined;
        return sessionRead({
          id: session.id,
          userId: session.projectUserId,
          createdAt: session.createdAt,
          lastUsedAt: session.lastActiveAt,
          isImpersonation: session.isImpersonation,
          currentSessionId: auth.refreshTokenId,
          lastUsedAtEndUserIpInfo: ipInfo,
        });
      }), ...externalSessions.map(session => sessionRead({
        id: session.id,
        userId: session.externalAuthMethod.projectUserId,
        createdAt: session.createdAt,
        lastUsedAt: session.lastActiveAt,
        isImpersonation: false,
        currentSessionId: auth.refreshTokenId,
      }))].sort((a, b) => b.created_at - a.created_at),
      is_paginated: false,
    };
  },
  onDelete: async ({ auth, params }: { auth: SmartRequestAuth, params: { id: string }, query: { user_id?: string } }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const session = await globalPrismaClient.projectUserRefreshToken.findFirst({
      where: {
        tenancyId: auth.tenancy.id,
        id: params.id,
      },
    });

    const externalSession = session == null ? await prisma.externalAuthSession.findFirst({
      where: {
        tenancyId: auth.tenancy.id,
        id: params.id,
        revokedAt: null,
      },
      include: {
        externalAuthMethod: true,
      },
    }) : null;
    const sessionUserId = session?.projectUserId ?? externalSession?.externalAuthMethod.projectUserId;
    if (sessionUserId == null || (auth.type === 'client' && auth.user?.id !== sessionUserId)) {
      throw new StatusError(StatusError.NotFound, 'Session not found.');
    }
    // External sessions are guarded the same way: an external access token carries the external session's
    // id as its refreshTokenId, so without this a client could revoke the session it is using here.
    if (auth.refreshTokenId === params.id) {
      throw new KnownErrors.CannotDeleteCurrentSession();
    }

    if (session != null) {
      await recordExternalDbSyncDeletion(globalPrismaClient, {
        tableName: "ProjectUserRefreshToken",
        tenancyId: auth.tenancy.id,
        refreshTokenId: params.id,
      });
      await globalPrismaClient.projectUserRefreshToken.deleteMany({
        where: {
          tenancyId: auth.tenancy.id,
          id: params.id,
        },
      });
    } else {
      const revoked = await prisma.externalAuthSession.updateMany({
        where: {
          tenancyId: auth.tenancy.id,
          id: params.id,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
      if (revoked.count === 0) {
        throw new StatusError(StatusError.NotFound, 'Session not found.');
      }
    }
  },
}));

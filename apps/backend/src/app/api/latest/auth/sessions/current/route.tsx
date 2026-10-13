import { recordExternalDbSyncDeletion } from "@/lib/external-db-sync";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const DELETE = createSmartRouteHandler({
  metadata: {
    summary: "Sign out of the current session",
    description: "Sign out and invalidate the current Hexclave or delegated external session",
    tags: ["Sessions"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema,
      refreshTokenId: yupString().optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["success"]).defined(),
  }),


  async handler({ auth: { tenancy, refreshTokenId } }) {
    if (!refreshTokenId) {
      // Only here for transition period, remove this once all access tokens are updated
      // TODO next-release
      throw new KnownErrors.AccessTokenExpired(new Date(), undefined, undefined, undefined);
    }

    const prisma = await getPrismaClientForTenancy(tenancy);
    const refreshToken = await globalPrismaClient.projectUserRefreshToken.findFirst({
      where: {
        tenancyId: tenancy.id,
        id: refreshTokenId,
      },
    });
    if (refreshToken != null) {
      await recordExternalDbSyncDeletion(globalPrismaClient, {
        tableName: "ProjectUserRefreshToken",
        tenancyId: tenancy.id,
        refreshTokenId,
      });

      await globalPrismaClient.projectUserRefreshToken.deleteMany({
        where: {
          tenancyId: tenancy.id,
          id: refreshTokenId,
        },
      });
    } else {
      const externalSessionUpdate = await prisma.externalAuthSession.updateMany({
        where: {
          tenancyId: tenancy.id,
          id: refreshTokenId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
      if (externalSessionUpdate.count === 0) {
        throw new KnownErrors.RefreshTokenNotFoundOrExpired();
      }
    }

    return {
      statusCode: 200,
      bodyType: "success",
    };
  },
});

import { revokeRefreshTokenSession } from "@/lib/tokens";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { Prisma } from "@/generated/prisma/client";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const DELETE = createSmartRouteHandler({
  metadata: {
    summary: "Sign out of the current session",
    description: "Sign out of the current session and invalidate the refresh token",
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

    try {
      const deletedCount = await revokeRefreshTokenSession({ tenancyId: tenancy.id, refreshTokenId });
      // If no records were deleted, throw the same error as before
      if (deletedCount === 0) {
        throw new KnownErrors.RefreshTokenNotFoundOrExpired();
      }
    } catch (e) {
      // TODO make this less hacky, use a transaction to delete-if-exists instead of try-catch
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
        throw new KnownErrors.RefreshTokenNotFoundOrExpired();
      } else {
        throw e;
      }
    }

    return {
      statusCode: 200,
      bodyType: "success",
    };
  },
});

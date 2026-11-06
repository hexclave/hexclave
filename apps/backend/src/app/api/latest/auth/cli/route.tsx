import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { Prisma } from "@/generated/prisma/client";
import { getPrismaClientForTenancy, getPrismaSchemaForTenancy, globalPrismaClient, sqlQuoteIdent } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

type RefreshTokenRow = {
  tenancyId: string,
  projectUserId: string,
  expiresAt: Date | null,
};

export const POST = createSmartRouteHandler({
  metadata: {
    summary: 'Initiate CLI authentication',
    description: 'Create a new CLI authentication session and return polling and login codes',
    tags: ['CLI Authentication'],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupObject({
      // Default 2 hours, max 24 hours, so users who get distracted mid-`login` (or need to sign up first) don't
      // have to restart. This was briefly 2 minutes (max 15), which turned out to be too strict in practice.
      expires_in_millis: yupNumber().max(1000 * 60 * 60 * 24).default(1000 * 60 * 60 * 2),
      anon_refresh_token: yupString().optional(),
    }).default({}),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(['json']).defined(),
    body: yupObject({
      polling_code: yupString().defined(),
      login_code: yupString().defined(),
      expires_at: yupString().defined(),
    }).defined(),
  }),
  async handler({ auth: { tenancy }, body: { expires_in_millis, anon_refresh_token } }) {
    let anonRefreshToken: string | null = null;

    if (anon_refresh_token != null) {
      const refreshTokenRows = await globalPrismaClient.$replica().$queryRaw<RefreshTokenRow[]>(Prisma.sql`
        SELECT "tenancyId", "projectUserId", "expiresAt"
        FROM "ProjectUserRefreshToken"
        WHERE "refreshToken" = ${anon_refresh_token}
        LIMIT 1
      `);
      if (refreshTokenRows.length === 0) {
        throw new StatusError(400, "Invalid anon refresh token");
      }
      const refreshTokenObj = refreshTokenRows[0];

      if (refreshTokenObj.tenancyId !== tenancy.id) {
        throw new StatusError(400, "Anon refresh token does not belong to this project");
      }

      if (refreshTokenObj.expiresAt != null && refreshTokenObj.expiresAt < new Date()) {
        throw new StatusError(400, "The provided anon refresh token has expired");
      }

      // ProjectUser lives in the tenancy's source-of-truth DB, not global.
      // Use the CRUD handler which is topology-aware (matches tokens.tsx:206).
      let user;
      try {
        user = await usersCrudHandlers.adminRead({
          tenancy,
          user_id: refreshTokenObj.projectUserId,
          allowedErrorTypes: [KnownErrors.UserNotFound],
        });
      } catch (error) {
        if (error instanceof KnownErrors.UserNotFound) {
          throw new StatusError(400, "User not found for provided refresh token");
        }
        throw error;
      }

      if (!user.is_anonymous) {
        throw new StatusError(400, "The provided refresh token does not belong to an anonymous user");
      }

      anonRefreshToken = anon_refresh_token;
    }

    const pollingCode = generateSecureRandomString();
    const loginCode = generateSecureRandomString();
    const expiresAt = new Date(Date.now() + expires_in_millis);

    // CliAuthAttempt lives in the tenancy's source-of-truth DB, consistent with cli/poll/route.tsx.
    const prisma = await getPrismaClientForTenancy(tenancy);
    const schema = await getPrismaSchemaForTenancy(tenancy);
    const rows = await prisma.$queryRaw<{ pollingCode: string, loginCode: string, expiresAt: Date }[]>(Prisma.sql`
      INSERT INTO ${sqlQuoteIdent(schema)}."CliAuthAttempt" ("tenancyId", "id", "pollingCode", "loginCode", "expiresAt", "anonRefreshToken", "updatedAt")
      VALUES (
        ${tenancy.id}::UUID,
        gen_random_uuid(),
        ${pollingCode},
        ${loginCode},
        ${expiresAt},
        ${anonRefreshToken},
        NOW()
      )
      RETURNING "pollingCode", "loginCode", "expiresAt"
    `);
    const cliAuth = rows[0];

    return {
      statusCode: 200,
      bodyType: 'json',
      body: {
        polling_code: cliAuth.pollingCode,
        login_code: cliAuth.loginCode,
        expires_at: cliAuth.expiresAt.toISOString(),
      },
    };
  },
});

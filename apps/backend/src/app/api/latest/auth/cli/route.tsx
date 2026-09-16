import { createDeviceAuthAttempt, getAnonymousSessionForRefreshToken, getRefreshTokenSessionForTenancy } from "@/lib/device-auth";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

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
      expires_in_millis: yupNumber().max(1000 * 60 * 15).default(1000 * 60 * 2), // Default: 2 minutes, max: 15 minutes
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
    if (anon_refresh_token != null) {
      if (await getRefreshTokenSessionForTenancy(tenancy.id, anon_refresh_token) == null) {
        throw new StatusError(400, "Invalid anon refresh token");
      }
      if (await getAnonymousSessionForRefreshToken(tenancy, anon_refresh_token) == null) {
        throw new StatusError(400, "The provided refresh token does not belong to an anonymous user");
      }
    }

    const attempt = await createDeviceAuthAttempt({
      tenancy,
      expiresInMillis: expires_in_millis,
      anonRefreshToken: anon_refresh_token ?? null,
    });

    return {
      statusCode: 200,
      bodyType: 'json',
      body: {
        polling_code: attempt.pollingCode,
        login_code: attempt.loginCode,
        expires_at: attempt.expiresAt.toISOString(),
      },
    };
  },
});

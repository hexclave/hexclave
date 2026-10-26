import { externalAuthProviderIds, verifyExternalAuthToken } from "@/lib/external-auth";
import { getOrCreateExternalAuthSession } from "@/lib/external-auth-users";
import { getApiUrlForRequest } from "@/lib/request-api-url";
import { generateAccessTokenForExternalAuthSession } from "@/lib/tokens";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Exchange an external authentication token",
    description: "Verifies a configured external provider session and returns a short-lived Hexclave access token.",
    tags: ["External authentication"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema,
      user: adaptSchema.optional(),
    }).defined(),
    body: yupObject({
      provider_id: yupString().oneOf(externalAuthProviderIds).defined().meta({ openapiField: { description: 'The external authentication integration that issued the token.', exampleValue: 'clerk-integration' } }),
      token: yupString().defined().nonEmpty().meta({ openapiField: { description: "The provider's signed session token (a JWT). It must contain sub, sid and exp claims.", exampleValue: '<external-provider-jwt>' } }),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      access_token: yupString().defined(),
      session_id: yupString().uuid().defined(),
      user_id: yupString().uuid().defined(),
      is_new_user: yupBoolean().defined(),
    }).defined(),
  }),
  async handler({ auth: { tenancy, user }, body }, fullReq) {
    const identity = await verifyExternalAuthToken({
      tenancy,
      providerId: body.provider_id,
      token: body.token,
    });
    const external = await getOrCreateExternalAuthSession({
      tenancy,
      providerId: body.provider_id,
      identity,
      currentUser: user ?? null,
    });
    const accessToken = await generateAccessTokenForExternalAuthSession({
      tenancy,
      externalAuthSession: external.session,
      providerTokenExpiresAt: identity.expiresAt,
      apiUrl: getApiUrlForRequest(fullReq),
    });
    if (accessToken == null) {
      throw new KnownErrors.InvalidExternalAuthToken("malformed_token");
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        access_token: accessToken,
        session_id: external.session.id,
        user_id: external.authMethod.projectUserId,
        is_new_user: external.isNewUser,
      },
    };
  },
});

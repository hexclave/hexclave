import { getApiUrlForRequest } from "@/lib/request-api-url";
import { recordAuditEvent } from "@/lib/audit-log";
import { createImpersonationAuthTokens, createAuthTokens, MAX_AUTH_SESSION_EXPIRATION_MS } from "@/lib/tokens";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, serverOrHigherAuthTypeSchema, userIdOrMeSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { usersCrudHandlers } from "../../users/crud";
import { sessionsCrudHandlers } from "./crud";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Create session",
    description: "Create a new session for a given user. This will return a refresh token that can be used to impersonate the user.",
    tags: ["Sessions"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
      adminUser: adaptSchema,
    }).defined(),
    body: yupObject({
      user_id: userIdOrMeSchema.defined(),
      expires_in_millis: yupNumber().max(MAX_AUTH_SESSION_EXPIRATION_MS).default(1000 * 60 * 60 * 24 * 365),
      is_impersonation: yupBoolean().optional(),
      // Optional support-session note stored on Audit Log events when that app is enabled.
      reason: yupString().max(500).nullable().optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      refresh_token: yupString().defined(),
      access_token: yupString().defined(),
    }).defined(),
  }),
  async handler({ auth, body: { user_id: userId, expires_in_millis: expiresInMillis, is_impersonation: isImpersonation, reason } }, fullReq) {
    const { tenancy } = auth;
    let user;
    try {
      user = await usersCrudHandlers.adminRead({
        user_id: userId,
        tenancy: tenancy,
        allowedErrorTypes: [
          KnownErrors.UserNotFound,
        ],
      });
    } catch (e) {
      if (KnownErrors.UserNotFound.isInstance(e)) {
        throw new KnownErrors.UserIdDoesNotExist(userId);
      }
      throw e;
    }

    const { refreshToken, accessToken, refreshTokenId } = isImpersonation
      ? await createImpersonationAuthTokens({
        tenancy,
        projectUserId: user.id,
        expiresInMillis,
        apiUrl: getApiUrlForRequest(fullReq),
      })
      : await createAuthTokens({
        tenancy,
        projectUserId: user.id,
        expiresAt: new Date(Date.now() + expiresInMillis),
        isImpersonation: false,
        apiUrl: getApiUrlForRequest(fullReq),
      });

    if (isImpersonation) {
      await recordAuditEvent({
        tenancy,
        auth,
        action: "impersonation.started",
        targetUserId: user.id,
        reason,
        metadata: {
          refresh_token_id: refreshTokenId,
          expires_at_millis: Date.now() + expiresInMillis,
          source: "auth.sessions",
        },
      });
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        refresh_token: refreshToken,
        access_token: accessToken,
      }
    };
  },
});

export const GET = sessionsCrudHandlers.listHandler;

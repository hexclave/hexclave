import { completeDeviceAuthAttempt, getAnonymousSessionForRefreshToken, getRefreshTokenSessionForTenancy, getWaitingDeviceAuthAttemptByLoginCode, takeAnonRefreshTokenFromDeviceAuthAttempt } from "@/lib/device-auth";
import { getApiUrlForRequest } from "@/lib/request-api-url";
import { Tenancy } from "@/lib/tenancies";
import { generateAccessTokenFromRefreshTokenIfValid } from "@/lib/tokens";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupBoolean, yupNumber, yupObject, yupString, yupUnion } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import type { InferType } from "yup";

type CliSessionState = "anonymous" | "none";

const postCliAuthCompleteRequestSchema = yupObject({
  auth: yupObject({
    type: clientOrHigherAuthTypeSchema,
    tenancy: adaptSchema.defined(),
  }).defined(),
  body: yupObject({
    login_code: yupString().defined(),
    mode: yupString().oneOf(["check", "claim-anon-session", "complete"]).default("complete"),
    refresh_token: yupString().optional(),
  }).defined(),
});

const postCliAuthCompleteResponseSchema = yupUnion(
  yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      cli_session_state: yupString().oneOf(["anonymous", "none"]).defined(),
    }).defined(),
  }).defined(),
  yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      access_token: yupString().defined(),
      refresh_token: yupString().defined(),
    }).defined(),
  }).defined(),
  yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      success: yupBoolean().oneOf([true]).defined(),
    }).defined(),
  }).defined(),
).defined();

type PostCliAuthCompleteRequest = InferType<typeof postCliAuthCompleteRequestSchema>;
type PostCliAuthCompleteResponse = InferType<typeof postCliAuthCompleteResponseSchema>;

function cliAuthCompleteCheckResponse(cliSessionState: CliSessionState): PostCliAuthCompleteResponse {
  return {
    statusCode: 200,
    bodyType: "json",
    body: {
      cli_session_state: cliSessionState,
    },
  };
}

function cliAuthCompleteClaimResponse(accessToken: string, refreshToken: string): PostCliAuthCompleteResponse {
  return {
    statusCode: 200,
    bodyType: "json",
    body: {
      access_token: accessToken,
      refresh_token: refreshToken,
    },
  };
}

function cliAuthCompleteSuccessResponse(): PostCliAuthCompleteResponse {
  return {
    statusCode: 200,
    bodyType: "json",
    body: {
      success: true,
    },
  };
}

async function getWaitingCliAuthAttempt(tenancy: Tenancy, loginCode: string) {
  const attempt = await getWaitingDeviceAuthAttemptByLoginCode(tenancy, loginCode);
  // Agent registrations share the table but are confirmed through /agent/register/confirm.
  if (attempt == null || attempt.agentName != null) {
    throw new StatusError(400, "Invalid login code or the code has expired");
  }
  return attempt;
}

export const POST = createSmartRouteHandler<PostCliAuthCompleteRequest, PostCliAuthCompleteResponse>({
  metadata: {
    summary: "Complete CLI authentication",
    description: "Inspect, claim, or complete a CLI authentication session",
    tags: ["CLI Authentication"],
  },
  request: postCliAuthCompleteRequestSchema,
  response: postCliAuthCompleteResponseSchema,
  async handler({ auth: { tenancy }, body: { login_code, mode, refresh_token } }, fullReq) {
    const cliAuth = await getWaitingCliAuthAttempt(tenancy, login_code);

    if (mode === "check") {
      const cliAnonymousSession = await getAnonymousSessionForRefreshToken(tenancy, cliAuth.anonRefreshToken);
      const cliSessionState: CliSessionState = cliAnonymousSession != null ? "anonymous" : "none";

      return cliAuthCompleteCheckResponse(cliSessionState);
    }

    if (mode === "claim-anon-session") {
      const cliAnonymousSession = await getAnonymousSessionForRefreshToken(tenancy, cliAuth.anonRefreshToken);
      if (cliAnonymousSession == null || cliAuth.anonRefreshToken == null) {
        throw new StatusError(400, "No anonymous session associated with this code");
      }

      // Mint the access token before detaching so a failure here leaves the
      // attempt claimable again, mirroring the poll routes.
      const accessToken = await generateAccessTokenFromRefreshTokenIfValid({
        tenancy,
        refreshTokenObj: cliAnonymousSession.session,
        apiUrl: getApiUrlForRequest(fullReq),
      });
      if (accessToken == null) {
        throw new StatusError(400, "Anonymous session is no longer valid");
      }

      // One-shot: detach the anon session from the attempt so a repeated
      // claim-anon-session call cannot re-retrieve the anon user's refresh token.
      const taken = await takeAnonRefreshTokenFromDeviceAuthAttempt({ tenancy, attemptId: cliAuth.id, anonRefreshToken: cliAuth.anonRefreshToken });
      if (!taken) {
        throw new StatusError(400, "No anonymous session associated with this code");
      }

      return cliAuthCompleteClaimResponse(accessToken, cliAnonymousSession.session.refreshToken);
    }

    if (refresh_token == null) {
      throw new StatusError(400, "refresh_token is required when mode is 'complete'");
    }

    const browserRefreshTokenSession = await getRefreshTokenSessionForTenancy(tenancy.id, refresh_token);
    if (browserRefreshTokenSession == null) {
      throw new StatusError(400, "Invalid refresh token");
    }

    // Any anonymous session attached to this attempt is intentionally ignored —
    // we do NOT merge the anonymous user into the authenticated user (that was
    // a security risk). The anonymous user is simply orphaned from this flow.
    const completed = await completeDeviceAuthAttempt({ tenancy, attemptId: cliAuth.id, refreshToken: refresh_token });
    if (!completed) {
      throw new StatusError(400, "Invalid login code or the code has expired");
    }

    return cliAuthCompleteSuccessResponse();
  },
});

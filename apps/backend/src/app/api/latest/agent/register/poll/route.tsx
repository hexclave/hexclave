import { assertAgentAuthEnabled, pollAgentAuthAttempt } from "@/lib/agent-auth";
import { getApiUrlForRequest } from "@/lib/request-api-url";
import { generateAccessTokenFromRefreshTokenIfValid } from "@/lib/tokens";
import { globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

type AgentAuthPollResponseBody = {
  status: "pending" | "approved" | "denied" | "expired" | "used",
  session?: {
    user_id: string,
    access_token: string,
    refresh_token: string,
  },
};

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Poll for agent approval",
    description: "Checks whether the human has approved the agent registration. Once approved, the agent's session tokens are returned exactly once; subsequent polls report `used`. Poll roughly every few seconds until the status is no longer `pending`.",
    tags: ["Agent Auth"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupObject({
      poll_token: yupString().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200, 201]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      status: yupString().oneOf(["pending", "approved", "denied", "expired", "used"]).defined(),
      session: yupObject({
        user_id: yupString().defined(),
        access_token: yupString().defined(),
        refresh_token: yupString().defined(),
      }).optional().meta({ openapiField: { description: "Only present when status is `approved`." } }),
    }).defined(),
  }),
  handler: async ({ auth, body }, fullReq): Promise<{ statusCode: 200 | 201, bodyType: "json", body: AgentAuthPollResponseBody }> => {
    assertAgentAuthEnabled(auth.tenancy);

    const result = await pollAgentAuthAttempt(auth.tenancy, body.poll_token);
    if (result.status !== "approved") {
      return {
        statusCode: 200,
        bodyType: "json",
        body: { status: result.status },
      };
    }

    const refreshTokenObj = await globalPrismaClient.projectUserRefreshToken.findUnique({
      where: { refreshToken: result.refreshToken },
      select: { id: true, projectUserId: true, expiresAt: true },
    });
    const accessToken = await generateAccessTokenFromRefreshTokenIfValid({
      tenancy: auth.tenancy,
      refreshTokenObj,
      apiUrl: getApiUrlForRequest(fullReq),
    });
    if (accessToken == null) {
      // The approving user revoked the agent session (or was deleted) between
      // approval and the agent's first poll. The attempt is already consumed,
      // so the agent has to register again — same as an expired attempt.
      return {
        statusCode: 200,
        bodyType: "json",
        body: { status: "expired" },
      };
    }

    return {
      statusCode: 201,
      bodyType: "json",
      body: {
        status: "approved",
        session: {
          user_id: result.userId,
          access_token: accessToken,
          refresh_token: result.refreshToken,
        },
      },
    };
  },
});

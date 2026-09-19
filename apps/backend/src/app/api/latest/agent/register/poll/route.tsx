import { assertAgentAuthEnabled, pollAgentAuthAttempt } from "@/lib/agent-auth";
import { deviceAuthAttemptStatuses } from "@/lib/device-auth";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Poll for agent approval",
    description: "Checks whether the human has approved the agent registration. Once approved (`success`), the agent's session tokens are returned exactly once; subsequent polls report `used`. Poll roughly every few seconds while the status is `waiting`.",
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
      status: yupString().oneOf(deviceAuthAttemptStatuses).defined(),
      session: yupObject({
        user_id: yupString().defined(),
        access_token: yupString().defined(),
        refresh_token: yupString().defined(),
      }).optional().meta({ openapiField: { description: "Only present when status is `success`." } }),
    }).defined(),
  }),
  handler: async ({ auth, body }, fullReq) => {
    assertAgentAuthEnabled(auth.tenancy);

    const result = await pollAgentAuthAttempt({ tenancy: auth.tenancy, pollToken: body.poll_token, fullReq });
    if (result.status !== "success") {
      return {
        statusCode: 200 as const,
        bodyType: "json" as const,
        body: { status: result.status },
      };
    }
    return {
      statusCode: 201 as const,
      bodyType: "json" as const,
      body: {
        status: result.status,
        session: {
          user_id: result.userId,
          access_token: result.accessToken,
          refresh_token: result.refreshToken,
        },
      },
    };
  },
});

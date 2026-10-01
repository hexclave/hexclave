import { consumeDeviceAuthAttempt, getDeviceAuthAttemptByPollingCode, getDeviceAuthAttemptStatus } from "@/lib/device-auth";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

const cliPollStatuses = ["waiting", "success", "expired", "used"] as const;
type CliPollStatus = typeof cliPollStatuses[number];

const createResponse = (status: CliPollStatus, refreshToken?: string) => ({
  statusCode: status === 'success' ? 201 : 200,
  bodyType: "json" as const,
  body: {
    status,
    ...(refreshToken && { refresh_token: refreshToken }),
  },
});

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Poll CLI authentication status",
    description: "Check the status of a CLI authentication session using the polling code",
    tags: ["CLI Authentication"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupObject({
      polling_code: yupString().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200, 201]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      status: yupString().oneOf(cliPollStatuses).defined(),
      refresh_token: yupString().optional(),
    }).defined(),
  }),
  async handler({ auth: { tenancy }, body: { polling_code } }) {
    const attempt = await getDeviceAuthAttemptByPollingCode(tenancy, polling_code);
    if (attempt == null || attempt.agentName != null) {
      throw new KnownErrors.InvalidPollingCodeError();
    }

    const status = getDeviceAuthAttemptStatus(attempt);
    switch (status) {
      case "denied": {
        // CLI attempts have no deny action, so a denied row can only be reached
        // through the agent flow, which is excluded above.
        throw new KnownErrors.InvalidPollingCodeError();
      }
      case "success": {
        const refreshToken = await consumeDeviceAuthAttempt({ tenancy, attemptId: attempt.id });
        if (refreshToken == null) {
          return createResponse("used");
        }
        return createResponse("success", refreshToken);
      }
      default: {
        return createResponse(status);
      }
    }
  },
});

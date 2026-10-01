import { approveAgentAuthAttempt, assertAgentAuthEnabled, denyAgentAuthAttempt, getWaitingAgentAuthAttemptByClaimCode } from "@/lib/agent-auth";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

/**
 * The human side of agent auth. Called by the agent-auth-confirm page with the
 * signed-in user's session. `inspect` shows who is asking before the user
 * commits; `approve` mints the agent's session on the caller's account;
 * `deny` closes the attempt so the agent stops polling.
 *
 * The signed-in user is the approver, always; there is no way to approve on
 * someone else's behalf. Anonymous/restricted users are rejected by the
 * default access-token checks in smart-request, so an agent cannot approve
 * its own registration with the anonymous session it got from /register.
 */
export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Inspect, approve, or deny an agent registration",
    description: "Used by the agent-auth-confirm page. `inspect` returns the agent's details for the claim code; `approve` creates a new session for the agent on the calling user's account; `deny` rejects the registration.",
    tags: ["Agent Auth"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
      user: adaptSchema.defined(),
    }).defined(),
    body: yupObject({
      claim_code: yupString().defined(),
      action: yupString().oneOf(["inspect", "approve", "deny"]).defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      agent: yupObject({
        name: yupString().defined(),
        description: yupString().nullable().defined(),
        url: yupString().nullable().defined(),
      }).defined(),
      user_hint: yupString().nullable().defined(),
      expires_at_millis: yupNumber().defined(),
      status: yupString().oneOf(["waiting", "success", "denied"]).defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }, fullReq) => {
    assertAgentAuthEnabled(auth.tenancy);
    if (auth.user.is_anonymous) {
      throw new KnownErrors.AnonymousAuthenticationNotAllowed();
    }

    const attempt = await getWaitingAgentAuthAttemptByClaimCode(auth.tenancy, body.claim_code);

    let status: "waiting" | "success" | "denied" = "waiting";
    switch (body.action) {
      case "inspect": {
        break;
      }
      case "approve": {
        await approveAgentAuthAttempt({ tenancy: auth.tenancy, attempt, approvingUserId: auth.user.id, fullReq });
        status = "success";
        break;
      }
      case "deny": {
        await denyAgentAuthAttempt({ tenancy: auth.tenancy, attempt });
        status = "denied";
        break;
      }
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        agent: {
          name: attempt.agentName,
          description: attempt.agentDescription,
          url: attempt.agentUrl,
        },
        user_hint: attempt.userHint,
        expires_at_millis: attempt.expiresAt.getTime(),
        status,
      },
    };
  },
});

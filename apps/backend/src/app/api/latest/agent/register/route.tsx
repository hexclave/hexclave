import { agentAuthDefaults, assertAgentAuthEnabled, getAgentConfirmHandlerUrl, getAgentConfirmUrl, registerAgent } from "@/lib/agent-auth";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, urlSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Register an AI agent",
    description: "Starts the agent-auth flow. The agent describes itself and receives (a) an anonymous session it can use immediately (send `x-hexclave-allow-anonymous-user: true` with those requests), (b) a short claim code and confirm URL to show to a human, and (c) a poll token to exchange for the approved session. Requires the Agent Auth app to be enabled for the project.",
    tags: ["Agent Auth"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    body: yupObject({
      agent: yupObject({
        name: yupString().trim().min(1).max(100).defined().meta({ openapiField: { description: "Human-readable name of the agent, shown to the user on the confirm page and in their session list.", exampleValue: "Claude Code" } }),
        description: yupString().trim().max(500).optional().meta({ openapiField: { description: "What the agent intends to do with the access.", exampleValue: "Triage support tickets" } }),
        url: urlSchema.max(300).optional().meta({ openapiField: { description: "Homepage or documentation URL of the agent.", exampleValue: "https://example.com/agent" } }),
      }).defined(),
      user_hint: yupString().trim().max(256).optional().meta({ openapiField: { description: "Optional hint (usually an email) about which user is expected to approve. Purely informational, shown on the confirm page.", exampleValue: "alice@example.com" } }),
      app_url: urlSchema.max(300).optional().meta({ openapiField: { description: "URL of the app the agent is connecting to, if known. Must be one of the project's trusted domains; the confirm URL is then built on that app so the user approves where they are already signed in.", exampleValue: "https://app.example.com" } }),
      expires_in_millis: yupNumber().min(1000 * 30).max(agentAuthDefaults.maxAttemptExpiresInMillis).default(agentAuthDefaults.attemptExpiresInMillis),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      claim_code: yupString().defined().meta({ openapiField: { description: "Short code the user types or sees on the confirm page.", exampleValue: "K7PQ-3XWM" } }),
      confirm_url: yupString().defined().meta({ openapiField: { description: "URL to show or open for the user; already includes the claim code.", exampleValue: "https://app.example.com/handler/agent-auth-confirm?code=K7PQ-3XWM" } }),
      poll_token: yupString().defined().meta({ openapiField: { description: "Secret held by the agent. Send it to /agent/register/poll to check for approval.", exampleValue: "<poll token>" } }),
      expires_at_millis: yupNumber().defined(),
      anonymous_session: yupObject({
        user_id: yupString().defined(),
        access_token: yupString().defined(),
        refresh_token: yupString().defined(),
      }).defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }, fullReq) => {
    assertAgentAuthEnabled(auth.tenancy);
    // Validated before anything is written so a bad app_url has no side effects.
    const confirmHandlerUrl = getAgentConfirmHandlerUrl(auth.tenancy, body.app_url ?? null);

    const { attempt, anonymousSession } = await registerAgent({
      tenancy: auth.tenancy,
      agent: {
        name: body.agent.name,
        description: body.agent.description ?? null,
        url: body.agent.url ?? null,
        userHint: body.user_hint ?? null,
      },
      expiresInMillis: body.expires_in_millis,
      fullReq,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        claim_code: attempt.loginCode,
        confirm_url: getAgentConfirmUrl(confirmHandlerUrl, attempt.loginCode),
        poll_token: attempt.pollingCode,
        expires_at_millis: attempt.expiresAt.getTime(),
        anonymous_session: {
          user_id: anonymousSession.userId,
          access_token: anonymousSession.accessToken,
          refresh_token: anonymousSession.refreshToken,
        },
      },
    };
  },
});

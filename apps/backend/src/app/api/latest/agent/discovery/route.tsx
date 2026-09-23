import { agentAuthDiscoveryRequestSchema, getAgentAuthDiscoveryForRequest } from "@/lib/agent-auth-discovery";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupBoolean, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Agent auth discovery document",
    description: "Machine-readable description of this project's agent-auth endpoints. Companion to /agent/auth.md. Only the project ID header is required to read it.",
    tags: ["Agent Auth"],
  },
  request: agentAuthDiscoveryRequestSchema,
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      issuer: yupString().defined(),
      registration_endpoint: yupString().defined(),
      token_endpoint: yupString().defined(),
      revocation_endpoint: yupString().defined(),
      agent_auth_md: yupString().defined(),
      hexclave_agent_auth: yupObject({
        enabled: yupBoolean().defined(),
        project_id: yupString().defined(),
        project_display_name: yupString().defined(),
        publishable_client_key: yupString().nullable().defined(),
        publishable_client_key_required: yupBoolean().defined(),
        poll_endpoint: yupString().defined(),
        confirm_endpoint: yupString().defined(),
        sessions_endpoint: yupString().defined(),
        anonymous_session_header: yupMixed().defined(),
        claim_code_format: yupString().defined(),
        default_attempt_lifetime_millis: yupNumber().defined(),
        agent_session_lifetime_millis: yupNumber().defined(),
        required_headers: yupMixed().defined(),
      }).defined(),
    }).defined(),
  }),
  handler: async (req, fullReq) => {
    return {
      statusCode: 200,
      bodyType: "json",
      body: await getAgentAuthDiscoveryForRequest(req, fullReq),
    };
  },
});

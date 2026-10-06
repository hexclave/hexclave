import { agentAuthDiscoveryRequestSchema, getAgentAuthDiscoveryForRequest, renderAgentAuthMd } from "@/lib/agent-auth-discovery";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Agent auth guide (auth.md)",
    description: "A Markdown guide, written for AI agents, that explains how to register with this project and obtain a session. All commands are pre-filled with the project's values. Only the project ID header is required to read it.",
    tags: ["Agent Auth"],
  },
  request: agentAuthDiscoveryRequestSchema,
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["text"]).defined(),
    headers: yupMixed().defined(),
    body: yupString().defined(),
  }),
  handler: async (req, fullReq) => {
    const discovery = await getAgentAuthDiscoveryForRequest(req, fullReq);
    return {
      statusCode: 200,
      bodyType: "text",
      headers: {
        "content-type": ["text/markdown; charset=utf-8"],
      },
      body: renderAgentAuthMd(discovery),
    };
  },
});

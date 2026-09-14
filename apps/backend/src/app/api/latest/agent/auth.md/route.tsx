import { getAgentAuthDiscovery, renderAgentAuthMd } from "@/lib/agent-auth-discovery";
import { getApiUrlForRequest } from "@/lib/request-api-url";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Agent auth guide (auth.md)",
    description: "A Markdown guide, written for AI agents, that explains how to register with this project and obtain a session. All commands are pre-filled with the project's values.",
    tags: ["Agent Auth"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
    }).defined(),
    headers: yupObject({
      "x-stack-publishable-client-key": yupTuple([yupString().optional()]).optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["text"]).defined(),
    headers: yupMixed().defined(),
    body: yupString().defined(),
  }),
  handler: async ({ auth }, fullReq) => {
    const discovery = getAgentAuthDiscovery({
      tenancy: auth.tenancy,
      apiUrl: getApiUrlForRequest(fullReq),
      publishableClientKey: fullReq.headers["x-stack-publishable-client-key"]?.[0] ?? null,
    });
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

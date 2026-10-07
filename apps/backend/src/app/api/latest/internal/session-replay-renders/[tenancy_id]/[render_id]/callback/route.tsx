import { handleSessionReplayRenderCallback } from "@/lib/session-replay-renders";
import { getTenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Session replay render callback",
    description: "Internal endpoint called by a session replay render machine once it has uploaded its result, authenticated with the per-render secret it was handed. Carries no data; the backend reads the outcome from storage.",
    tags: ["Session Replays"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({}).nullable().optional(),
    method: yupString().oneOf(["POST"]).defined(),
    params: yupObject({
      tenancy_id: yupString().uuid().defined(),
      render_id: yupString().uuid().defined(),
    }).defined(),
    headers: yupObject({
      authorization: yupTuple([yupString().defined()]).defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      status: yupString().defined(),
    }).defined(),
  }),
  handler: async ({ params, headers }) => {
    const token = /^Bearer (.+)$/.exec(headers.authorization[0])?.[1];
    const tenancy = token == null ? null : await getTenancy(params.tenancy_id);
    if (token == null || tenancy == null) {
      throw new KnownErrors.ItemNotFound(params.render_id);
    }
    const prisma = await getPrismaClientForTenancy(tenancy);
    const render = await handleSessionReplayRenderCallback(prisma, tenancy.id, params.render_id, token);
    return {
      statusCode: 200,
      bodyType: "json",
      body: { status: render.status.toLowerCase() },
    };
  },
});

import { getSessionReplayRender, sessionReplayRenderToApi } from "@/lib/session-replay-renders";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { sessionReplayRenderSchema } from "../render-schema";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Get session replay render",
    description: "Returns the status of a session replay video render. Poll this every few seconds until `status` is `succeeded` or `failed`. A succeeded render includes a short-lived `video.url` to download the MP4; fetch the render again for a fresh URL.",
    tags: ["Session Replays"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      session_replay_id: yupString().uuid().defined(),
      render_id: yupString().uuid().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: sessionReplayRenderSchema,
  }),
  async handler({ auth, params }) {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const render = await getSessionReplayRender(prisma, auth.tenancy.id, params.session_replay_id, params.render_id);
    return {
      statusCode: 200,
      bodyType: "json",
      body: await sessionReplayRenderToApi(render),
    };
  },
});

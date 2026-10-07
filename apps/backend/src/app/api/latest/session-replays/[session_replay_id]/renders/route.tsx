import { createSessionReplayRender, listSessionReplayRenders, sessionReplayRenderToApi } from "@/lib/session-replay-renders";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupArray, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { sessionReplayRenderSchema } from "./render-schema";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Render session replay to video",
    description: "Starts rendering one tab (segment) of a session replay to an MP4 video. Rendering runs in the background and usually takes about as long as the replay; poll the returned render until its status is `succeeded` (it then carries a download URL) or `failed`.",
    tags: ["Session Replays"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      session_replay_id: yupString().uuid().defined(),
    }).defined(),
    body: yupObject({
      session_replay_segment_id: yupString().optional().meta({ openapiField: { description: "Which tab of the replay to render. Defaults to the tab with the most activity." } }),
      fps: yupNumber().integer().min(1).max(30).optional().meta({ openapiField: { description: "Frames per second of the video. Defaults to 15." } }),
      speed: yupNumber().min(0.25).max(8).optional().meta({ openapiField: { description: "Playback speed multiplier. Defaults to 1." } }),
      skip_inactivity: yupBoolean().optional().meta({ openapiField: { description: "Cut idle stretches longer than two seconds down to about one second. Defaults to true." } }),
    }).default({}),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: sessionReplayRenderSchema,
  }),
  async handler({ auth, params, body }) {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const render = await createSessionReplayRender({
      prisma,
      tenancyId: auth.tenancy.id,
      sessionReplayId: params.session_replay_id,
      sessionReplaySegmentId: body.session_replay_segment_id ?? null,
      renderOptions: {
        fps: body.fps ?? 15,
        speed: body.speed ?? 1,
        skipInactivity: body.skip_inactivity ?? true,
      },
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: await sessionReplayRenderToApi(render),
    };
  },
});

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "List session replay renders",
    description: "Lists the 20 most recent video renders of a session replay, newest first.",
    tags: ["Session Replays"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      session_replay_id: yupString().uuid().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      items: yupArray(sessionReplayRenderSchema).defined(),
    }).defined(),
  }),
  async handler({ auth, params }) {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const renders = await listSessionReplayRenders(prisma, auth.tenancy.id, params.session_replay_id);
    return {
      statusCode: 200,
      bodyType: "json",
      body: { items: await Promise.all(renders.map(sessionReplayRenderToApi)) },
    };
  },
});

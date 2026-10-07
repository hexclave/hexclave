import { advanceStaleSessionReplayRenders } from "@/lib/session-replay-renders";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Advance session replay renders",
    description: "Internal endpoint invoked by Vercel Cron. Moves along session replay video renders that nobody is polling, so they still finish (and their render machines are freed) when the caller stops watching.",
    tags: ["Session Replays"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({}).nullable().optional(),
    method: yupString().oneOf(["GET"]).defined(),
    headers: yupObject({
      "authorization": yupTuple([yupString()]).defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      advanced: yupNumber().defined(),
    }).defined(),
  }),
  handler: async ({ headers }) => {
    if (headers.authorization[0] !== `Bearer ${getEnvVariable("CRON_SECRET")}`) {
      throw new StatusError(401, "Unauthorized");
    }
    return {
      statusCode: 200,
      bodyType: "json",
      body: await advanceStaleSessionReplayRenders(),
    };
  },
});

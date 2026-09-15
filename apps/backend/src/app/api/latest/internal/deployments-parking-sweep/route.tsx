import { sweepFreePlanParking } from "@/lib/deployments/parking";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Sweep Free plan deployment parking",
    description: "Internal endpoint invoked by Vercel Cron. Parks Free-plan services that have outlived the plan's deployment window, and unparks the services of projects that have since upgraded.",
    tags: ["Deployments"],
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
    // The counts are the whole point of the response: this runs unattended, so a
    // tick that did nothing has to say WHY it did nothing (see ParkingSweepSummary's
    // `skipped`) rather than answering an indistinguishable `{ ok: true }`.
    body: yupObject({
      skipped: yupString().nullable().defined(),
      parked: yupNumber().defined(),
      unparked: yupNumber().defined(),
      failed: yupNumber().defined(),
    }).defined(),
  }),
  handler: async ({ headers }) => {
    if (headers.authorization[0] !== `Bearer ${getEnvVariable("CRON_SECRET")}`) {
      throw new StatusError(401, "Unauthorized");
    }
    const summary = await sweepFreePlanParking();
    return {
      statusCode: 200,
      bodyType: "json",
      body: summary,
    };
  },
});

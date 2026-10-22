import { runFreePlanRegrantSweep } from "@/lib/payments/free-plan-regrant-sweep";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupBoolean, yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Regrant the free plan to newly-expired billing teams",
    description: "Internal endpoint invoked by Vercel Cron. Non-Stripe subscriptions emit no period-end event, so nothing fires when one expires; this sweep is the timer that regrants the free plan to internal billing teams whose last plan just ended.",
    tags: ["Payments"],
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
      ok: yupBoolean().defined(),
      // Returned so a manual `curl` can tell "swept, nothing to do" apart from
      // "swept, repaired N teams" without digging through logs.
      candidates: yupNumber().defined(),
      granted: yupNumber().defined(),
      failed: yupNumber().defined(),
    }).defined(),
  }),
  handler: async ({ headers }) => {
    const authHeader = headers.authorization[0];
    if (authHeader !== `Bearer ${getEnvVariable('CRON_SECRET')}`) {
      throw new StatusError(401, "Unauthorized");
    }

    // A single pass, unlike the queue-draining crons: the sweep's work is
    // bounded by how many subscriptions ended in the lookback window, and
    // repairs here don't cascade into more work the way the growth watchdog's
    // do. Nothing to loop over.
    const result = await runFreePlanRegrantSweep();

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        ok: true,
        ...result,
      },
    };
  },
});

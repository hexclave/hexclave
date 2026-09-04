import { processScheduledExperimentRuns } from "@/lib/feature-flags/experiment-runs";
import { cleanupExpiredFeatureFlagExposureReceipts } from "@/lib/feature-flags/exposure-receipts";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

const BATCH_LIMIT = 500;

// Cron-invoked processor for scheduled experiment runs (same invocation
// pattern as the external-db-sync poller): starts DRAFT runs whose
// scheduledStartAt has passed and completes active runs whose scheduledEndAt
// has passed. Safe to invoke concurrently and repeatedly — every mutation is a
// per-row compare-and-swap, so a second overlapping invocation (or a racing
// manual transition) just processes zero rows.
export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Process scheduled experiment runs",
    description: "Internal endpoint invoked by cron to start/complete experiment runs on their schedule.",
    tags: ["Feature Flags"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({}).nullable().optional(),
    method: yupString().oneOf(["GET"]).defined(),
    headers: yupObject({
      authorization: yupTuple([yupString().defined()]).optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      started: yupNumber().defined(),
      completed: yupNumber().defined(),
      exposure_receipts_deleted: yupNumber().defined(),
    }).defined(),
  }),
  handler: async ({ headers, auth }) => {
    const isAdmin = auth?.type === "admin" && auth.project.id === "internal";
    const authHeader = headers.authorization?.[0];
    if (!isAdmin && authHeader !== `Bearer ${getEnvVariable("CRON_SECRET")}`) {
      throw new StatusError(StatusError.Unauthorized, "Invalid cron authorization");
    }

    const result = await processScheduledExperimentRuns({ now: new Date(), batchLimit: BATCH_LIMIT });
    const exposureReceiptsDeleted = await cleanupExpiredFeatureFlagExposureReceipts(new Date());
    return {
      statusCode: 200,
      bodyType: "json",
      body: { started: result.started, completed: result.completed, exposure_receipts_deleted: exposureReceiptsDeleted },
    };
  },
});

import {
  IssueMaterializationBatchNotVisibleError,
  processIssueMaterializationBatch,
} from "@/lib/issues/issue-reconciler";
import { getTenancy } from "@/lib/tenancies";
import { ensureUpstashSignature } from "@/lib/upstash";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { captureError, StatusError } from "@hexclave/shared/dist/utils/errors";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Apply one telemetry batch to control-plane read models",
    description: "Receives a signed QStash delivery and applies one known telemetry batch idempotently.",
    tags: ["Analytics Events"],
    hidden: true,
  },
  request: yupObject({
    headers: yupObject({
      "upstash-signature": yupTuple([yupString()]).defined(),
    }).defined(),
    body: yupObject({
      tenancyId: yupString().trim().min(1).max(128).defined(),
      batchId: yupString().trim().min(1).max(512).defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      status: yupString().defined(),
    }).defined(),
  }),
  handler: async ({ body }, fullReq) => {
    await ensureUpstashSignature(fullReq);

    const tenancy = await getTenancy(body.tenancyId);
    if (tenancy === null) {
      return {
        statusCode: 200,
        bodyType: "json" as const,
        body: { status: "deleted_tenancy" },
      };
    }

    try {
      const result = await processIssueMaterializationBatch({
        tenancy,
        batchId: body.batchId,
      });
      if (result.status === "deferred_locked") {
        throw new StatusError(StatusError.ServiceUnavailable, "Issue materialization is waiting for a merge lock to clear; QStash will retry");
      }
      return {
        statusCode: 200,
        bodyType: "json" as const,
        body: { status: result.status },
      };
    } catch (error) {
      if (error instanceof IssueMaterializationBatchNotVisibleError) {
        throw new StatusError(StatusError.ServiceUnavailable, "Telemetry batch is not available yet; QStash will retry");
      }
      captureError("telemetry-materialization-worker", error);
      throw new StatusError(StatusError.ServiceUnavailable, "Telemetry materialization is temporarily unavailable");
    }
  },
});

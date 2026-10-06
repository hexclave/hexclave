import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { replayIssueAlertDelivery } from "@/lib/issues/issue-alerts/api";
import { IssueAlertDeliveryResponseSchema } from "@/lib/issues/issue-alerts/contract";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { issueAlertAuthSchema, issueAlertDeliveryParamsSchema } from "../../../_shared";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Replay an issue alert delivery",
    description: "Requeues only failed or dropped deliveries; repeat requests while a replay is in flight are idempotent reads.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: issueAlertAuthSchema,
    params: issueAlertDeliveryParamsSchema,
  }).defined(),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ delivery: IssueAlertDeliveryResponseSchema, replayed: yupBoolean().defined() }).defined(),
  }),
  async handler({ auth, params }) {
    assertObservabilityEnabled(auth.tenancy);
    const result = await replayIssueAlertDelivery(auth.tenancy, params.delivery_id);
    if (result === null) throw new StatusError(StatusError.NotFound, "Issue alert delivery not found");
    return { statusCode: 200, bodyType: "json", body: result } as const;
  },
});

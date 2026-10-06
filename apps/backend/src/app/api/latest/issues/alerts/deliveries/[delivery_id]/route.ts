import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { getIssueAlertDelivery } from "@/lib/issues/issue-alerts/api";
import { IssueAlertDeliveryResponseSchema } from "@/lib/issues/issue-alerts/contract";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { issueAlertAuthSchema, issueAlertDeliveryParamsSchema } from "../../_shared";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Get an issue alert delivery",
    description: "Returns one tenant-, project-, and branch-scoped issue alert delivery with merge redirect metadata.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: issueAlertAuthSchema,
    params: issueAlertDeliveryParamsSchema,
  }).defined(),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ delivery: IssueAlertDeliveryResponseSchema }).defined(),
  }),
  async handler({ auth, params }) {
    assertObservabilityEnabled(auth.tenancy);
    const delivery = await getIssueAlertDelivery(auth.tenancy, params.delivery_id);
    if (delivery === null) throw new StatusError(StatusError.NotFound, "Issue alert delivery not found");
    return { statusCode: 200, bodyType: "json", body: { delivery } } as const;
  },
});

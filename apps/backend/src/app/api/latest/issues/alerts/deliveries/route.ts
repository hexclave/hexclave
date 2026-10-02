import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { listIssueAlertDeliveriesPage, parseIssueAlertListLimit } from "@/lib/issues/issue-alerts/api";
import { IssueAlertDeliveryListResponseSchema } from "@/lib/issues/issue-alerts/contract";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { issueAlertAuthSchema } from "../_shared";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "List issue alert deliveries",
    description: "Returns a bounded, tenant-, project-, and branch-scoped delivery history for issue alert rules.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: issueAlertAuthSchema,
    query: yupObject({ limit: yupString().optional() }).optional(),
  }).defined(),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: IssueAlertDeliveryListResponseSchema,
  }),
  async handler({ auth, query }) {
    assertObservabilityEnabled(auth.tenancy);
    const page = await listIssueAlertDeliveriesPage(auth.tenancy, parseIssueAlertListLimit(query.limit));
    return { statusCode: 200, bodyType: "json", body: { deliveries: [...page.items], truncated: page.truncated } } as const;
  },
});

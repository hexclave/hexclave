import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { disableIssueAlertRule } from "@/lib/issues/issue-alerts/api";
import { IssueAlertRuleResponseSchema, serializeIssueAlertRuleResponse } from "@/lib/issues/issue-alerts/contract";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { issueAlertAuthSchema, issueAlertRuleParamsSchema } from "../../_shared";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Disable an issue alert rule",
    description: "Disables every stored version of a tenant-, project-, and branch-scoped issue alert rule without deleting delivery history.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: issueAlertAuthSchema,
    params: issueAlertRuleParamsSchema,
  }).defined(),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ rule: IssueAlertRuleResponseSchema, changed: yupBoolean().defined() }).defined(),
  }),
  async handler({ auth, params }) {
    assertObservabilityEnabled(auth.tenancy);
    const result = await disableIssueAlertRule(auth.tenancy, params.rule_id);
    if (result === null) throw new StatusError(StatusError.NotFound, "Issue alert rule not found");
    return {
      statusCode: 200,
      bodyType: "json",
      body: { rule: serializeIssueAlertRuleResponse(result.rule), changed: result.changed },
    } as const;
  },
});

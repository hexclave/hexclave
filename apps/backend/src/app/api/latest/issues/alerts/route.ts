import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { listIssueAlertRulesPage, parseIssueAlertListLimit, saveIssueAlertRule } from "@/lib/issues/issue-alerts/api";
import {
  IssueAlertRuleListResponseSchema,
  IssueAlertRuleMutationSchema,
  IssueAlertRuleResponseSchema,
  serializeIssueAlertRuleResponse,
} from "@/lib/issues/issue-alerts/contract";
import { ensureIssueAlertEmailWorkflow } from "@/lib/workflows/issue-alerts/registration";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { issueAlertAuthSchema } from "./_shared";

const requestBase = {
  auth: issueAlertAuthSchema,
};

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "List issue alert rules",
    description: "Returns the active version of each issue alert rule for the authenticated project branch.",
    tags: ["Issues"],
  },
  request: yupObject({
    ...requestBase,
    query: yupObject({ limit: yupString().optional() }).optional(),
  }).defined(),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: IssueAlertRuleListResponseSchema,
  }),
  async handler({ auth, query }) {
    assertObservabilityEnabled(auth.tenancy);
    const page = await listIssueAlertRulesPage(auth.tenancy, parseIssueAlertListLimit(query.limit));
    return {
      statusCode: 200,
      bodyType: "json",
      body: { rules: page.items.map(serializeIssueAlertRuleResponse), truncated: page.truncated },
    } as const;
  },
});

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Create or update an issue alert rule",
    description: "Persists a versioned issue alert rule and ensures its Workflows email definition is registered.",
    tags: ["Issues"],
  },
  request: yupObject({ ...requestBase, body: yupObject({ rule: IssueAlertRuleMutationSchema }).defined() }).defined(),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ rule: IssueAlertRuleResponseSchema }).defined(),
  }),
  async handler({ auth, body }) {
    assertObservabilityEnabled(auth.tenancy);
    await ensureIssueAlertEmailWorkflow(auth.tenancy);
    const rule = await saveIssueAlertRule(auth.tenancy, body.rule);
    return { statusCode: 200, bodyType: "json", body: { rule: serializeIssueAlertRuleResponse(rule) } } as const;
  },
});

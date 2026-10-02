import { setIssuePriority } from "@/lib/issues/issue-lifecycle";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import {
  IssueActionAuthSchema,
  IssueActionParamsSchema,
  actorUserId,
  assertIssueActionsEnabled,
  withIssueActionTarget,
} from "../_shared";

const BodySchema = yupObject({ priority: yupString().oneOf(["low", "medium", "high"]).nullable().defined() }).defined();
const ResponseSchema = yupObject({
  issue_id: yupString().uuid().defined(),
  previous_priority: yupString().oneOf(["low", "medium", "high"]).nullable().defined(),
  priority: yupString().oneOf(["low", "medium", "high"]).nullable().defined(),
  changed: yupBoolean().defined(),
  changed_at_millis: yupNumber().integer().min(0).defined(),
}).defined();

export const POST = createSmartRouteHandler({
  metadata: { summary: "Set issue priority", description: "Persists low, medium, high, or no priority for an issue.", tags: ["Issues"] },
  request: yupObject({ auth: IssueActionAuthSchema, params: IssueActionParamsSchema, body: BodySchema }).defined(),
  response: yupObject({ statusCode: yupNumber().oneOf([200]).defined(), bodyType: yupString().oneOf(["json"]).defined(), body: ResponseSchema }).defined(),
  async handler({ auth, params, body }, fullReq) {
    assertIssueActionsEnabled(auth.tenancy);
    const { target, result } = await withIssueActionTarget({
      tenancy: auth.tenancy,
      rawIssueId: params.issue_id,
      action: (resolved) => setIssuePriority({ tenancy: auth.tenancy, issueId: resolved.issueId, priority: body.priority, actorUserId: actorUserId(fullReq) }),
    });
    return { statusCode: 200, bodyType: "json", body: { issue_id: target.issueId, previous_priority: result.previousPriority, priority: result.priority, changed: result.changed, changed_at_millis: result.changedAt.getTime() } } as const;
  },
});

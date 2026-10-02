import { assignIssue } from "@/lib/issues/issue-lifecycle";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import {
  IssueActionAuthSchema,
  IssueActionParamsSchema,
  IssueActionResponseSchema,
  actorUserId,
  assertIssueActionsEnabled,
  baseActionResponse,
  withIssueActionTarget,
} from "../_shared";

const AssignIssueBodySchema = yupObject({
  assignee_user_id: yupString().uuid().defined(),
}).defined();

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Assign an issue",
    description: "Assigns an issue to one authenticated project user.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: IssueActionAuthSchema,
    params: IssueActionParamsSchema,
    body: AssignIssueBodySchema,
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: IssueActionResponseSchema,
  }),
  async handler({ auth, params, body }, fullReq) {
    assertIssueActionsEnabled(auth.tenancy);
    const { target, result } = await withIssueActionTarget({
      tenancy: auth.tenancy,
      rawIssueId: params.issue_id,
      action: (resolved) => assignIssue({
        tenancy: auth.tenancy,
        issueId: resolved.issueId,
        assigneeUserId: body.assignee_user_id,
        actorUserId: actorUserId(fullReq),
      }),
    });
    const response = baseActionResponse({
      target,
      action: "assign",
      changed: result.changed,
      changedAt: result.changedAt,
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        ...response,
        previous_assignee_user_id: result.previousAssigneeUserId,
        assignee_user_id: result.assigneeUserId,
      },
    } as const;
  },
});

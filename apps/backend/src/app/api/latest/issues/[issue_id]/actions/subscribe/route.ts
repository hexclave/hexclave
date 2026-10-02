import { setIssueSubscription } from "@/lib/issues/issue-activity";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { IssueActionAuthSchema, IssueActionParamsSchema, actorUserId, assertIssueActionsEnabled, withIssueActionTarget } from "../_shared";

const BodySchema = yupObject({ subject_type: yupString().oneOf(["user", "team"]).defined(), subject_id: yupString().uuid().defined(), subscribed: yupBoolean().defined(), reason: yupString().max(64).nullable().defined(), idempotency_key: yupString().nonEmpty().max(128).defined() }).defined();
const ResponseSchema = yupObject({ issue_id: yupString().uuid().defined(), subject_type: yupString().oneOf(["user", "team"]).defined(), subject_id: yupString().uuid().defined(), subscribed: yupBoolean().defined(), reason: yupString().nullable().defined(), updated_at_millis: yupNumber().integer().min(0).defined() }).defined();

export const POST = createSmartRouteHandler({
  metadata: { summary: "Subscribe to an issue", description: "Creates or updates a durable user/team subscription for an issue.", tags: ["Issues"] },
  request: yupObject({ auth: IssueActionAuthSchema, params: IssueActionParamsSchema, body: BodySchema }).defined(),
  response: yupObject({ statusCode: yupNumber().oneOf([200]).defined(), bodyType: yupString().oneOf(["json"]).defined(), body: ResponseSchema }).defined(),
  async handler({ auth, params, body }, fullReq) {
    assertIssueActionsEnabled(auth.tenancy);
    const { target, result } = await withIssueActionTarget({ tenancy: auth.tenancy, rawIssueId: params.issue_id, action: (resolved) => setIssueSubscription({ tenancy: auth.tenancy, issueId: resolved.issueId, subject: { type: body.subject_type, id: body.subject_id }, subscribed: body.subscribed, reason: body.reason, actorUserId: actorUserId(fullReq), idempotencyKey: body.idempotency_key }) });
    return { statusCode: 200, bodyType: "json", body: { issue_id: target.issueId, subject_type: result.type, subject_id: result.id, subscribed: result.isActive, reason: result.reason, updated_at_millis: result.updatedAt.getTime() } } as const;
  },
});

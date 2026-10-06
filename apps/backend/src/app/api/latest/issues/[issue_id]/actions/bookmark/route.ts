import { setIssueBookmark } from "@/lib/issues/issue-activity";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { IssueActionAuthSchema, IssueActionParamsSchema, actorUserId, assertIssueActionsEnabled, withIssueActionTarget } from "../_shared";

const BodySchema = yupObject({ user_id: yupString().uuid().defined(), bookmarked: yupBoolean().defined(), idempotency_key: yupString().nonEmpty().max(128).defined() }).defined();
const ResponseSchema = yupObject({ issue_id: yupString().uuid().defined(), user_id: yupString().uuid().defined(), bookmarked: yupBoolean().defined(), changed: yupBoolean().defined(), changed_at_millis: yupNumber().integer().min(0).defined() }).defined();

export const POST = createSmartRouteHandler({
  metadata: { summary: "Bookmark an issue", description: "Creates or removes a branch-scoped per-user issue bookmark.", tags: ["Issues"] },
  request: yupObject({ auth: IssueActionAuthSchema, params: IssueActionParamsSchema, body: BodySchema }).defined(),
  response: yupObject({ statusCode: yupNumber().oneOf([200]).defined(), bodyType: yupString().oneOf(["json"]).defined(), body: ResponseSchema }).defined(),
  async handler({ auth, params, body }, fullReq) {
    assertIssueActionsEnabled(auth.tenancy);
    const { target, result } = await withIssueActionTarget({ tenancy: auth.tenancy, rawIssueId: params.issue_id, action: (resolved) => setIssueBookmark({ tenancy: auth.tenancy, issueId: resolved.issueId, userId: body.user_id, bookmarked: body.bookmarked, actorUserId: actorUserId(fullReq), idempotencyKey: body.idempotency_key }) });
    return { statusCode: 200, bodyType: "json", body: { issue_id: target.issueId, user_id: result.userId, bookmarked: result.bookmarked, changed: result.changed, changed_at_millis: result.changedAt.getTime() } } as const;
  },
});

import { addIssueComment } from "@/lib/issues/issue-activity";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { IssueActionAuthSchema, IssueActionParamsSchema, actorUserId, assertIssueActionsEnabled, withIssueActionTarget } from "../_shared";

const BodySchema = yupObject({ body: yupString().nonEmpty().max(10_000).defined(), idempotency_key: yupString().nonEmpty().max(128).defined() }).defined();
const ResponseSchema = yupObject({ issue_id: yupString().uuid().defined(), id: yupString().uuid().defined(), author_user_id: yupString().uuid().defined(), body: yupString().defined(), idempotency_key: yupString().defined(), created_at_millis: yupNumber().integer().min(0).defined() }).defined();

export const POST = createSmartRouteHandler({
  metadata: { summary: "Comment on an issue", description: "Adds an idempotent, bounded issue comment and activity entry.", tags: ["Issues"] },
  request: yupObject({ auth: IssueActionAuthSchema, params: IssueActionParamsSchema, body: BodySchema }).defined(),
  response: yupObject({ statusCode: yupNumber().oneOf([200]).defined(), bodyType: yupString().oneOf(["json"]).defined(), body: ResponseSchema }).defined(),
  async handler({ auth, params, body }, fullReq) {
    assertIssueActionsEnabled(auth.tenancy);
    const userId = actorUserId(fullReq);
    if (userId === null) throw new StatusError(StatusError.BadRequest, "Issue comments require an authenticated user");
    const { target, result } = await withIssueActionTarget({ tenancy: auth.tenancy, rawIssueId: params.issue_id, action: (resolved) => addIssueComment({ tenancy: auth.tenancy, issueId: resolved.issueId, actorUserId: userId, body: body.body, idempotencyKey: body.idempotency_key }) });
    return { statusCode: 200, bodyType: "json", body: { id: result.id, author_user_id: result.authorUserId, body: result.body, idempotency_key: result.idempotencyKey, created_at_millis: result.createdAt.getTime(), issue_id: target.issueId } } as const;
  },
});

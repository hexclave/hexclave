import { clearManualIssueOwners, setIssueOwner } from "@/lib/issues/issue-product";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { IssueActionAuthSchema, IssueActionParamsSchema, actorUserId, assertIssueActionsEnabled, withIssueActionTarget } from "../_shared";

const BodySchema = yupObject({ type: yupString().oneOf(["user", "team"]).defined(), user_id: yupString().uuid().nullable().defined(), team_id: yupString().uuid().nullable().defined(), source: yupString().oneOf(["manual", "ownership_rule", "codeowners", "suspect_commit", "seer_suggested"]).defined(), context: yupMixed().nullable().defined() }).defined();
const ResponseSchema = yupObject({ issue_id: yupString().uuid().defined(), id: yupString().uuid().defined(), type: yupString().oneOf(["user", "team"]).defined(), user_id: yupString().uuid().nullable().defined(), team_id: yupString().uuid().nullable().defined(), source: yupString().defined(), context: yupMixed().nullable().defined(), updated_at_millis: yupNumber().integer().min(0).defined() }).defined();

export const POST = createSmartRouteHandler({
  metadata: { summary: "Set issue ownership metadata", description: "Persists a bounded, branch-scoped user/team ownership record for an issue.", tags: ["Issues"] },
  request: yupObject({ auth: IssueActionAuthSchema, params: IssueActionParamsSchema, body: BodySchema }).defined(),
  response: yupObject({ statusCode: yupNumber().oneOf([200]).defined(), bodyType: yupString().oneOf(["json"]).defined(), body: ResponseSchema }).defined(),
  async handler({ auth, params, body }, fullReq) {
    assertIssueActionsEnabled(auth.tenancy);
    const { target, result } = await withIssueActionTarget({ tenancy: auth.tenancy, rawIssueId: params.issue_id, action: (resolved) => setIssueOwner({ tenancy: auth.tenancy, issueId: resolved.issueId, owner: { type: body.type, userId: body.user_id ?? undefined, teamId: body.team_id ?? undefined, source: body.source, context: body.context }, actorUserId: actorUserId(fullReq) }) });
    return { statusCode: 200, bodyType: "json", body: { issue_id: target.issueId, id: result.id, type: result.type, user_id: result.userId, team_id: result.teamId, source: result.source, context: result.context, updated_at_millis: result.updatedAt.getTime() } } as const;
  },
});

const DeleteResponseSchema = yupObject({
  issue_id: yupString().uuid().defined(),
  deleted_count: yupNumber().integer().min(0).defined(),
  updated_at_millis: yupNumber().integer().min(0).defined(),
}).defined();

export const DELETE = createSmartRouteHandler({
  metadata: { summary: "Clear manual issue ownership", description: "Removes manual ownership while preserving rule and code-owner records.", tags: ["Issues"] },
  request: yupObject({ auth: IssueActionAuthSchema, params: IssueActionParamsSchema }).defined(),
  response: yupObject({ statusCode: yupNumber().oneOf([200]).defined(), bodyType: yupString().oneOf(["json"]).defined(), body: DeleteResponseSchema }).defined(),
  async handler({ auth, params }, fullReq) {
    assertIssueActionsEnabled(auth.tenancy);
    const { target, result } = await withIssueActionTarget({
      tenancy: auth.tenancy,
      rawIssueId: params.issue_id,
      action: async (resolved) => await clearManualIssueOwners({ tenancy: auth.tenancy, issueId: resolved.issueId, actorUserId: actorUserId(fullReq) }),
    });
    return { statusCode: 200, bodyType: "json", body: { issue_id: target.issueId, deleted_count: result.deletedCount, updated_at_millis: result.updatedAt.getTime() } } as const;
  },
});

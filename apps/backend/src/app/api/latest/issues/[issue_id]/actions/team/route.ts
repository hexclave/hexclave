import { assignIssueToTeam } from "@/lib/issues/issue-lifecycle";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { IssueActionAuthSchema, IssueActionParamsSchema, actorUserId, assertIssueActionsEnabled, withIssueActionTarget } from "../_shared";

const BodySchema = yupObject({ team_id: yupString().uuid().nullable().defined() }).defined();
const ResponseSchema = yupObject({ issue_id: yupString().uuid().defined(), previous_team_id: yupString().uuid().nullable().defined(), team_id: yupString().uuid().nullable().defined(), changed: yupBoolean().defined(), changed_at_millis: yupNumber().integer().min(0).defined() }).defined();

export const POST = createSmartRouteHandler({
  metadata: { summary: "Assign an issue to a team", description: "Persists a branch-scoped team assignment for an issue.", tags: ["Issues"] },
  request: yupObject({ auth: IssueActionAuthSchema, params: IssueActionParamsSchema, body: BodySchema }).defined(),
  response: yupObject({ statusCode: yupNumber().oneOf([200]).defined(), bodyType: yupString().oneOf(["json"]).defined(), body: ResponseSchema }).defined(),
  async handler({ auth, params, body }, fullReq) {
    assertIssueActionsEnabled(auth.tenancy);
    const { target, result } = await withIssueActionTarget({ tenancy: auth.tenancy, rawIssueId: params.issue_id, action: (resolved) => assignIssueToTeam({ tenancy: auth.tenancy, issueId: resolved.issueId, teamId: body.team_id, actorUserId: actorUserId(fullReq) }) });
    return { statusCode: 200, bodyType: "json", body: { issue_id: target.issueId, previous_team_id: result.previousTeamId, team_id: result.teamId, changed: result.changed, changed_at_millis: result.changedAt.getTime() } } as const;
  },
});

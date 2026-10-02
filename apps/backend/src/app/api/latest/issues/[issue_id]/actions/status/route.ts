import { transitionIssueStatus } from "@/lib/issues/issue-lifecycle";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import {
  IssueActionAuthSchema,
  IssueActionParamsSchema,
  IssueActionResponseSchema,
  assertIssueActionsEnabled,
  transitionActionResponse,
  withIssueActionTarget,
} from "../_shared";

const IssueStatusBodySchema = yupObject({
  status: yupString().oneOf(["resolved", "ignored", "unresolved"]).defined(),
}).defined();

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Change issue status",
    description: "Resolves, ignores, or reopens an issue in the authenticated project branch.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: IssueActionAuthSchema,
    params: IssueActionParamsSchema,
    body: IssueStatusBodySchema,
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: IssueActionResponseSchema,
  }),
  async handler({ auth, params, body }) {
    assertIssueActionsEnabled(auth.tenancy);
    const action = body.status === "resolved" ? "resolve" : body.status === "ignored" ? "ignore" : "unresolve";
    const { target, result } = await withIssueActionTarget({
      tenancy: auth.tenancy,
      rawIssueId: params.issue_id,
      action: (resolved) => transitionIssueStatus({
        tenancy: auth.tenancy,
        issueId: resolved.issueId,
        mutation: { status: body.status },
      }),
    });
    if (result.current.status !== body.status) {
      throw new StatusError(StatusError.Conflict, "Issue status transition was not applied");
    }
    return {
      statusCode: 200,
      bodyType: "json",
      body: transitionActionResponse({ target, action, transition: result }),
    } as const;
  },
});

import { transitionIssueStatus } from "@/lib/issues/issue-lifecycle";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import {
  IssueActionAuthSchema,
  IssueActionParamsSchema,
  IssueActionResponseSchema,
  MAX_ACTION_TIMESTAMP_MILLIS,
  assertIssueActionsEnabled,
  transitionActionResponse,
  withIssueActionTarget,
} from "../_shared";

const SnoozeIssueBodySchema = yupObject({
  ignored_until_millis: yupNumber().integer().min(1).max(MAX_ACTION_TIMESTAMP_MILLIS).defined(),
}).defined();

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Snooze an issue",
    description: "Ignores an issue until the requested bounded future timestamp.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: IssueActionAuthSchema,
    params: IssueActionParamsSchema,
    body: SnoozeIssueBodySchema,
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: IssueActionResponseSchema,
  }),
  async handler({ auth, params, body }) {
    const ignoredUntil = new Date(body.ignored_until_millis);
    if (ignoredUntil.getTime() <= Date.now()) {
      throw new StatusError(StatusError.BadRequest, "ignored_until_millis must be in the future");
    }
    assertIssueActionsEnabled(auth.tenancy);
    const { target, result } = await withIssueActionTarget({
      tenancy: auth.tenancy,
      rawIssueId: params.issue_id,
      action: (resolved) => transitionIssueStatus({
        tenancy: auth.tenancy,
        issueId: resolved.issueId,
        mutation: { status: "ignored", ignoredUntil },
      }),
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: transitionActionResponse({ target, action: "snooze", transition: result }),
    } as const;
  },
});

import { applyIssueOccurrenceLifecycle } from "@/lib/issues/issue-lifecycle";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import {
  IssueActionAuthSchema,
  IssueActionParamsSchema,
  IssueActionResponseSchema,
  assertIssueActionsEnabled,
  transitionActionResponse,
  withIssueActionTarget,
} from "../_shared";

const EmptyActionBodySchema = yupObject({}).defined();

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Apply issue regression",
    description: "Applies server-receipt regression semantics to an issue.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: IssueActionAuthSchema,
    params: IssueActionParamsSchema,
    body: EmptyActionBodySchema,
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: IssueActionResponseSchema,
  }),
  async handler({ auth, params }) {
    assertIssueActionsEnabled(auth.tenancy);
    const { target, result } = await withIssueActionTarget({
      tenancy: auth.tenancy,
      rawIssueId: params.issue_id,
      action: (resolved) => applyIssueOccurrenceLifecycle({
        tenancy: auth.tenancy,
        issueId: resolved.issueId,
        receivedAt: new Date(),
      }),
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: transitionActionResponse({ target, action: "regress", transition: result }),
    } as const;
  },
});

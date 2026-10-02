import { resolveIssueIdentity } from "@/lib/issues/issue-identity";
import { unmergeIssue } from "@/lib/issues/issue-merge";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { IssueUnmergeRequestSchema, IssueUnmergeResponseSchema } from "@hexclave/shared/dist/interface/admin-issues";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
    params: yupObject({
      issue_id: yupString().defined(),
    }).defined(),
    body: IssueUnmergeRequestSchema,
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: IssueUnmergeResponseSchema,
  }),
  handler: async ({ auth, params, body }) => {
    assertObservabilityEnabled(auth.tenancy);

    const identity = await resolveIssueIdentity(auth.tenancy, params.issue_id);
    if (identity === null) throw new StatusError(StatusError.NotFound, "Issue not found");

    const { sourceIssueId, newIssueId, countersTruncatedAt } = await unmergeIssue({
      tenancy: auth.tenancy,
      issueId: identity.issueId,
      hashes: body.hashes,
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        source_issue_id: sourceIssueId,
        new_issue_id: newIssueId,
        counters_truncated_at_millis: countersTruncatedAt.getTime(),
      },
    };
  },
});

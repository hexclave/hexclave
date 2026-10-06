import { mergeIssues } from "@/lib/issues/issue-merge";
import { emitIssueLifecycleWebhook } from "@/lib/issues/issue-webhooks";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { IssueMergeRequestSchema, IssueMergeResponseSchema } from "@hexclave/shared/dist/interface/admin-issues";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { mapWithConcurrency } from "@hexclave/shared/dist/utils/promises";
import { resolveIssueIdentity } from "@/lib/issues/issue-identity";
import { createHash } from "node:crypto";

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
    body: IssueMergeRequestSchema,
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: IssueMergeResponseSchema,
  }),
  handler: async ({ auth, body }) => {
    assertObservabilityEnabled(auth.tenancy);

    const { primaryIssueId, mergedIssueIds } = await mergeIssues({
      tenancy: auth.tenancy,
      issueIds: body.issue_ids,
    });
    const retryIdentities = mergedIssueIds.length === 0
      ? await mapWithConcurrency(body.issue_ids, 8, (issueId) => resolveIssueIdentity(auth.tenancy, issueId, { consistency: "primary" }))
      : [];
    const retryingCompletedMerge = retryIdentities.length > 0
      && retryIdentities.every((identity) => identity !== null && identity.issueId === primaryIssueId)
      && retryIdentities.some((identity) => identity !== null && identity.redirectedFromIssueId !== null);
    const mergeEventIssueIds = retryingCompletedMerge
      ? [primaryIssueId, ...retryIdentities.map((identity) => {
        if (identity === null) throw new Error("Completed merge retry proof contained a missing issue identity");
        return identity.redirectedFromIssueId ?? identity.issueId;
      })]
      : [primaryIssueId, ...body.issue_ids];
    const mergeEventId = createHash("sha256")
      .update(JSON.stringify([...new Set(mergeEventIssueIds)].sort()))
      .digest("hex");
    if (mergedIssueIds.length > 0 || retryingCompletedMerge) {
      runAsynchronouslyAndWaitUntil(emitIssueLifecycleWebhook({
        tenancy: auth.tenancy,
        issueId: primaryIssueId,
        event: "merged",
        now: new Date(),
        eventId: mergeEventId,
      }));
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        primary_issue_id: primaryIssueId,
        merged_issue_ids: mergedIssueIds,
      },
    };
  },
});

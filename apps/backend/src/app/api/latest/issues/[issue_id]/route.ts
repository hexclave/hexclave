import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { loadPublicIssueDetail } from "@/lib/issues/issue-detail";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import {
  PublicIssueDetailQuerySchema,
  PublicIssueDetailResponseSchema,
  parsePublicIssueDetailQuery,
} from "../contract";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Get an issue for the authenticated project branch",
    description: "Returns one public issue summary and an optionally navigable occurrence for the authenticated project branch.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({ issue_id: yupString().defined() }).defined(),
    query: PublicIssueDetailQuerySchema.optional(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: PublicIssueDetailResponseSchema,
  }),
  async handler({ auth, params, query }) {
    assertObservabilityEnabled(auth.tenancy);
    const parsedQuery = parsePublicIssueDetailQuery(query);
    const result = await loadPublicIssueDetail({
      tenancy: auth.tenancy,
      issueId: params.issue_id,
      hours: parsedQuery.hours,
      occurrence: parsedQuery.occurrence,
      direction: parsedQuery.direction,
    });
    if (result === null) throw new StatusError(StatusError.NotFound, "Issue not found");

    return {
      statusCode: 200,
      bodyType: "json",
      body: result,
    } as const;
  },
});

import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { loadPublicIssueOccurrences } from "@/lib/issues/issue-occurrences";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import {
  PublicIssueOccurrencesQuerySchema,
  PublicIssueOccurrencesResponseSchema,
  parsePublicIssueOccurrencesQuery,
} from "../../contract";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "List issue occurrences for the authenticated project branch",
    description: "Returns paginated error occurrences for one issue in the authenticated project branch.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({ issue_id: yupString().defined() }).defined(),
    query: PublicIssueOccurrencesQuerySchema.optional(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: PublicIssueOccurrencesResponseSchema,
  }),
  async handler({ auth, params, query }) {
    assertObservabilityEnabled(auth.tenancy);
    const parsedQuery = parsePublicIssueOccurrencesQuery(query);
    const result = await loadPublicIssueOccurrences({
      tenancy: auth.tenancy,
      issueId: params.issue_id,
      cursor: parsedQuery.cursor,
      direction: parsedQuery.direction,
      limit: parsedQuery.limit,
    });
    if (result === null) throw new StatusError(StatusError.NotFound, "Issue not found");

    return {
      statusCode: 200,
      bodyType: "json",
      body: result,
    } as const;
  },
});

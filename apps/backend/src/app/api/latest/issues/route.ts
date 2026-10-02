import { listIssues } from "@/lib/issues/issue-queries";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import {
  PublicIssueListQuerySchema,
  PublicIssueListResponseSchema,
  parsePublicIssueListQuery,
  toPublicIssue,
} from "./contract";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "List issues for the authenticated project branch",
    description: "Returns public issue summaries and window-scoped counts for the authenticated project branch.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    query: PublicIssueListQuerySchema.optional(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: PublicIssueListResponseSchema,
  }),
  async handler({ auth, query }) {
    assertObservabilityEnabled(auth.tenancy);
    const filters = parsePublicIssueListQuery(query);
    const result = await listIssues({ tenancy: auth.tenancy, filters });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        items: result.items.map(toPublicIssue),
        next_cursor: result.cursor,
        counts: result.counts,
        approximate: result.approximate,
      },
    } as const;
  },
});

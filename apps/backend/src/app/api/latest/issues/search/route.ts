import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import {
  hasPublicSearchAttachmentFilter,
  PublicSearchQuerySchema,
  PublicSearchResponseSchema,
  parsePublicSearchQuery,
} from "@/lib/issues/public-search/contract";
import { searchPublicRecords } from "@/lib/issues/public-search/query";

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Search authenticated observability issue records",
    description: "Searches bounded issue, event, or occurrence records in the authenticated project branch. Supports status, level, handled, service, environment, release, user ID, tag, direct scalar context/extra properties, bounded facets, and event-level attachment filename/content-type/type filters. Event records are stored error events with an event ID; occurrence records also include legacy error rows. Results contain scrubbed metadata only; attachment bytes and storage keys are never returned.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    query: PublicSearchQuerySchema.optional(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: PublicSearchResponseSchema,
  }),
  async handler({ auth, query }) {
    assertObservabilityEnabled(auth.tenancy);
    const filters = parsePublicSearchQuery(query);
    const body = await searchPublicRecords({
      tenancy: auth.tenancy,
      filters,
      dependencies: filters.record === "issue" || hasPublicSearchAttachmentFilter(filters)
        ? { prisma: await getPrismaClientForTenancy(auth.tenancy) }
        : undefined,
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body,
    };
  },
});

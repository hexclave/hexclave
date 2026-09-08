import { requireGrowthAdminTenancy } from "@/lib/growth/admin";
import { publishAllGrowthAdminCategoryPageDrafts, publishGrowthAdminCategoryPage, unpublishGrowthAdminCategoryPage } from "@/lib/growth/category-pages";
import { GROWTH_CATEGORIES } from "@/lib/growth/categories";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupArray, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

/**
 * Putting a stage page in front of a customer, and taking it back down.
 *
 * POST publishes a specific version, which is also how rollback works. PUT publishes the five
 * current drafts atomically as one complete journey. DELETE takes one live page down, and that
 * stage falls back to its raw suggestion/note lanes.
 */

const authSchema = yupObject({ type: clientOrHigherAuthTypeSchema.defined(), project: adaptSchema.defined(), user: adaptSchema }).defined();
const responseSchema = yupObject({ statusCode: yupNumber().defined(), bodyType: yupString().oneOf(["json"]).defined(), body: yupMixed().defined() });

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: authSchema,
    body: yupObject({
      target_project_id: yupString().defined(),
      category: yupString().oneOf(GROWTH_CATEGORIES).defined(),
      // Explicit rather than "publish the draft": the staff member publishes the
      // version they were looking at, so a concurrent edit cannot be published by
      // someone who never read it.
      version: yupNumber().integer().min(1).defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: responseSchema,
  handler: async ({ auth, body }) => {
    const tenancy = await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id);
    const publishedByUserId = auth.user?.id ?? throwErr("requireGrowthAdminTenancy returned without an authenticated staff user.");
    return {
      statusCode: 200,
      bodyType: "json",
      body: await publishGrowthAdminCategoryPage(tenancy, { category: body.category, version: body.version, publishedByUserId }),
    };
  },
});

/** Publishes every stage draft in one transaction, after all five versions have been validated. */
export const PUT = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: authSchema,
    body: yupObject({
      target_project_id: yupString().defined(),
      drafts: yupArray(yupObject({
        category: yupString().oneOf(GROWTH_CATEGORIES).defined(),
        version: yupNumber().integer().min(1).defined(),
      }).defined()).length(GROWTH_CATEGORIES.length).defined(),
      report_id: yupString().uuid().nullable().defined(),
    }).defined(),
    method: yupString().oneOf(["PUT"]).defined(),
  }),
  response: responseSchema,
  handler: async ({ auth, body }) => {
    const tenancy = await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id);
    const publishedByUserId = auth.user?.id ?? throwErr("requireGrowthAdminTenancy returned without an authenticated staff user.");
    return {
      statusCode: 200,
      bodyType: "json",
      body: await publishAllGrowthAdminCategoryPageDrafts(tenancy, { drafts: body.drafts, reportId: body.report_id, publishedByUserId }),
    };
  },
});

export const DELETE = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: authSchema,
    body: yupObject({ target_project_id: yupString().defined(), category: yupString().oneOf(GROWTH_CATEGORIES).defined() }).defined(),
    method: yupString().oneOf(["DELETE"]).defined(),
  }),
  response: responseSchema,
  handler: async ({ auth, body }) => ({
    statusCode: 200,
    bodyType: "json",
    body: await unpublishGrowthAdminCategoryPage(await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id), body.category),
  }),
});

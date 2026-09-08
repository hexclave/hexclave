import { requireGrowthAdminTenancy } from "@/lib/growth/admin";
import { getGrowthAdminReport, publishGrowthReport, saveGrowthAdminReportDocument, unpublishGrowthReport } from "@/lib/growth/report-release";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

/**
 * One report as the customer reads it, and the pull-it-back control.
 *
 * GET returns the report through the same builder the customer route uses, only with the
 * published-only filter lifted, so staff can still read a report they have unpublished.
 */
export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({ type: clientOrHigherAuthTypeSchema.defined(), project: adaptSchema.defined(), user: adaptSchema }).defined(),
    method: yupString().oneOf(["GET"]).defined(),
    params: yupObject({
      // Not .uuid(): non-UUID values 404 inside the lib, keeping the miss shape identical whether
      // the id is malformed or belongs to another project.
      report_id: yupString().defined(),
    }).defined(),
    query: yupObject({ project_id: yupString().defined() }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
  }),
  handler: async ({ auth, params, query }) => ({
    statusCode: 200,
    bodyType: "json",
    body: await getGrowthAdminReport(await requireGrowthAdminTenancy(auth.project.id, auth.user, query.project_id), params.report_id),
  }),
});

/** Saves the authored growth-mdx-v1 source after compiling it into the customer renderer's AST. */
export const PUT = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({ type: clientOrHigherAuthTypeSchema.defined(), project: adaptSchema.defined(), user: adaptSchema }).defined(),
    method: yupString().oneOf(["PUT"]).defined(),
    params: yupObject({ report_id: yupString().defined() }).defined(),
    body: yupObject({
      target_project_id: yupString().defined(),
      document: yupMixed().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
  }),
  handler: async ({ auth, params, body }) => ({
    statusCode: 200,
    bodyType: "json",
    body: await saveGrowthAdminReportDocument(
      await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id),
      params.report_id,
      body.document,
    ),
  }),
});

/**
 * Publishing is the explicit staff gate that opens the customer workspace. Unpublishing remains
 * the matching recovery action; neither can happen as a side effect of editing report content.
 */
export const PATCH = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({ type: clientOrHigherAuthTypeSchema.defined(), project: adaptSchema.defined(), user: adaptSchema }).defined(),
    method: yupString().oneOf(["PATCH"]).defined(),
    params: yupObject({ report_id: yupString().defined() }).defined(),
    body: yupObject({
      target_project_id: yupString().defined(),
      action: yupString().oneOf(["publish", "unpublish"]).defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
  }),
  handler: async ({ auth, params, body }) => {
    const tenancy = await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id);
    const result = body.action === "publish"
      ? await publishGrowthReport(tenancy, params.report_id, {
        publishedByUserId: auth.user?.id ?? throwErr("Growth admin report publication requires the authenticated user validated by requireGrowthAdminTenancy."),
        now: new Date(),
      })
      : await unpublishGrowthReport(tenancy, params.report_id);
    return { statusCode: 200, bodyType: "json", body: result };
  },
});

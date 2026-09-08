import { requireGrowthAdminTenancy } from "@/lib/growth/admin";
import { discardGrowthAdminFindingPageDraft, getGrowthAdminFindingPage, publishGrowthAdminFindingPageDraft, saveGrowthAdminFindingPageDraft } from "@/lib/growth/finding-pages";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

const authSchema = yupObject({ type: clientOrHigherAuthTypeSchema.defined(), project: adaptSchema.defined(), user: adaptSchema }).defined();
const paramsSchema = yupObject({ finding_id: yupString().uuid().defined() }).defined();
const responseSchema = yupObject({ statusCode: yupNumber().defined(), bodyType: yupString().oneOf(["json"]).defined(), body: yupMixed().defined() });

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({ auth: authSchema, params: paramsSchema, query: yupObject({ project_id: yupString().defined() }).defined(), method: yupString().oneOf(["GET"]).defined() }),
  response: responseSchema,
  handler: async ({ auth, params, query }) => ({
    statusCode: 200,
    bodyType: "json",
    body: await getGrowthAdminFindingPage(await requireGrowthAdminTenancy(auth.project.id, auth.user, query.project_id), params.finding_id),
  }),
});

export const PUT = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: authSchema,
    params: paramsSchema,
    body: yupObject({ target_project_id: yupString().defined(), document: yupMixed().defined(), expected_draft_updated_at_millis: yupNumber().nullable().defined() }).defined(),
    method: yupString().oneOf(["PUT"]).defined(),
  }),
  response: responseSchema,
  handler: async ({ auth, params, body }) => ({
    statusCode: 200,
    bodyType: "json",
    body: await saveGrowthAdminFindingPageDraft(await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id), params.finding_id, {
      document: body.document,
      expectedDraftUpdatedAtMillis: body.expected_draft_updated_at_millis,
    }),
  }),
});

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: authSchema,
    params: paramsSchema,
    body: yupObject({ target_project_id: yupString().defined(), expected_draft_updated_at_millis: yupNumber().defined() }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: responseSchema,
  handler: async ({ auth, params, body }) => ({
    statusCode: 200,
    bodyType: "json",
    body: await publishGrowthAdminFindingPageDraft(await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id), params.finding_id, {
      expectedDraftUpdatedAtMillis: body.expected_draft_updated_at_millis,
      publishedByUserId: auth.user?.id ?? throwErr("requireGrowthAdminTenancy returned without an authenticated staff user."),
    }),
  }),
});

export const DELETE = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({ auth: authSchema, params: paramsSchema, body: yupObject({ target_project_id: yupString().defined() }).defined(), method: yupString().oneOf(["DELETE"]).defined() }),
  response: responseSchema,
  handler: async ({ auth, params, body }) => ({
    statusCode: 200,
    bodyType: "json",
    body: await discardGrowthAdminFindingPageDraft(await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id), params.finding_id),
  }),
});

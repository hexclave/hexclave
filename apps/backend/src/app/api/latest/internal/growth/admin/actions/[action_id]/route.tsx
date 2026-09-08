import { requireGrowthAdminTenancy, updateGrowthAdminAction } from "@/lib/growth/admin";
import { discardGrowthAdminActionPageDraft, getGrowthAdminActionPage, publishGrowthAdminActionPageDraft, saveGrowthAdminActionPageDraft } from "@/lib/growth/action-pages";
import { GROWTH_METRIC_IDS } from "@/lib/growth/action-item-types";
import { GROWTH_CATEGORIES } from "@/lib/growth/categories";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupArray, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

const workflowSchema = yupObject({ workflow_id: yupString().min(1).max(64).defined(), source: yupString().min(1).defined(), explanation: yupString().min(1).max(5000).defined(), rollback_note: yupString().min(1).max(5000).defined() });
const authSchema = yupObject({ type: clientOrHigherAuthTypeSchema.defined(), project: adaptSchema.defined(), user: adaptSchema }).defined();
const paramsSchema = yupObject({ action_id: yupString().uuid().defined() }).defined();
const responseSchema = yupObject({ statusCode: yupNumber().defined(), bodyType: yupString().oneOf(["json"]).defined(), body: yupMixed().defined() });

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({ auth: authSchema, params: paramsSchema, query: yupObject({ project_id: yupString().defined() }).defined(), method: yupString().oneOf(["GET"]).defined() }),
  response: responseSchema,
  handler: async ({ auth, params, query }) => ({ statusCode: 200, bodyType: "json", body: await getGrowthAdminActionPage(await requireGrowthAdminTenancy(auth.project.id, auth.user, query.project_id), params.action_id) }),
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
    body: await saveGrowthAdminActionPageDraft(await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id), params.action_id, { document: body.document, expectedDraftUpdatedAtMillis: body.expected_draft_updated_at_millis }),
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
    body: await publishGrowthAdminActionPageDraft(await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id), params.action_id, {
      expectedDraftUpdatedAtMillis: body.expected_draft_updated_at_millis,
      publishedByUserId: auth.user?.id ?? throwErr("requireGrowthAdminTenancy returned without an authenticated staff user."),
    }),
  }),
});

export const DELETE = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({ auth: authSchema, params: paramsSchema, body: yupObject({ target_project_id: yupString().defined() }).defined(), method: yupString().oneOf(["DELETE"]).defined() }),
  response: responseSchema,
  handler: async ({ auth, params, body }) => ({ statusCode: 200, bodyType: "json", body: await discardGrowthAdminActionPageDraft(await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id), params.action_id) }),
});

export const PATCH = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: authSchema, params: paramsSchema,
    body: yupObject({
      target_project_id: yupString().defined(), type_id: yupString().oneOf(["run_ads", "publish_blog", "custom"]).defined(), category: yupString().oneOf(GROWTH_CATEGORIES).defined(), tags: yupArray(yupString().min(1).max(40).defined()).max(10).default([]),
      title: yupString().min(1).max(500).defined(), description: yupString().min(1).max(10_000).defined(), payload: yupMixed().optional(), status: yupString().oneOf(["proposed", "active", "completed", "dismissed"]).defined(),
      watched_metrics: yupArray(yupObject({ metric_id: yupString().oneOf(GROWTH_METRIC_IDS).defined(), window_days: yupNumber().integer().min(1).max(90).defined() }).defined()).max(10).optional(), workflow: workflowSchema.nullable().optional(),
    }).defined(), method: yupString().oneOf(["PATCH"]).defined(),
  }),
  response: responseSchema,
  handler: async ({ auth, params, body }) => ({
    statusCode: 200,
    bodyType: "json",
    body: await updateGrowthAdminAction(await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id), params.action_id, {
      typeId: body.type_id, category: body.category, tags: body.tags, title: body.title, description: body.description, payload: body.payload, watchedMetrics: body.watched_metrics,
      workflow: body.workflow === undefined ? undefined : body.workflow === null ? null : { workflowId: body.workflow.workflow_id, source: body.workflow.source, explanation: body.workflow.explanation, rollbackNote: body.workflow.rollback_note }, status: body.status,
    }),
  }),
});

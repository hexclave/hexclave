import { repairGrowthProject, runGrowthProjectAnalysisStep } from "@/lib/growth/admin-recovery";
import { getGrowthAdminStageRunState, GROWTH_ADMIN_STAGE_IDS, runGrowthAdminStage, type GrowthAdminStageRunState } from "@/lib/growth/admin-stage-run";
import { requireGrowthAdminTenancy } from "@/lib/growth/admin";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300;

const authSchema = yupObject({ type: clientOrHigherAuthTypeSchema.defined(), project: adaptSchema.defined(), user: adaptSchema }).defined();

function stageStateToWire(value: GrowthAdminStageRunState) {
  return { stage: value.stage, state: value.state, can_run: value.canRun, message: value.message };
}

/**
 * Runs one server-side scheduler step from the internal GTM admin page. This is intentionally a
 * user-authenticated route rather than a browser-visible CRON_SECRET route: Preview deployments do
 * not receive scheduled Vercel Cron invocations, and the cron secret must never reach dashboard JS.
 */
export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Run Growth scheduler step",
    description: "Advance or repair one selected project's Growth analysis from the internal Growth admin page.",
    tags: ["Growth"],
    hidden: true,
  },
  request: yupObject({
    auth: authSchema,
    method: yupString().oneOf(["POST"]).defined(),
    body: yupObject({
      step: yupString().oneOf(["analysis_tick", "project_recovery", "lifecycle_stage_state", "lifecycle_stage"]).defined(),
      target_project_id: yupString().defined(),
      stage: yupString().oneOf(GROWTH_ADMIN_STAGE_IDS).optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
  }),
  handler: async ({ auth, body }) => {
    if (auth.user == null) throw new KnownErrors.UserAuthenticationRequired();
    const tenancy = await requireGrowthAdminTenancy(auth.project.id, auth.user, body.target_project_id);
    if (body.step === "lifecycle_stage_state") {
      if (body.stage == null) throw new StatusError(400, "Select the Growth lifecycle stage to inspect.");
      return {
        statusCode: 200,
        bodyType: "json",
        body: { step: body.step, ...stageStateToWire(await getGrowthAdminStageRunState(tenancy, body.stage)) },
      };
    }
    if (body.step === "lifecycle_stage") {
      if (body.stage == null) throw new StatusError(400, "Select the Growth lifecycle stage to run.");
      const result = await runGrowthAdminStage(tenancy, body.stage);
      return {
        statusCode: 200,
        bodyType: "json",
        body: {
          step: body.step,
          ...stageStateToWire(result),
          did_work: result.didWork,
          leg_started: result.legStarted,
        },
      };
    }
    const result = body.step === "analysis_tick"
      ? { ...await runGrowthProjectAnalysisStep(tenancy), legStarted: null }
      : await repairGrowthProject(tenancy);

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        step: body.step,
        did_work: result.didWork,
        leg_started: result.legStarted,
      },
    };
  },
});

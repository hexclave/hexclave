import { ensureAnalyticsInstalledForExperiments, experimentActorFromAuth, experimentRunResponseSchema, experimentRunToApiFormat } from "@/lib/feature-flags/experiment-api";
import { createExperimentRun, listExperimentRuns } from "@/lib/feature-flags/experiment-runs";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, userSpecifiedIdSchema, yupArray, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const GET = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      experiment_id: userSpecifiedIdSchema("experimentId").defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      items: yupArray(experimentRunResponseSchema).defined(),
    }).defined(),
  }),
  async handler({ auth, params }) {
    ensureAnalyticsInstalledForExperiments(auth.tenancy);
    const runs = await listExperimentRuns({ tenancy: auth.tenancy, experimentId: params.experiment_id });
    return {
      statusCode: 200,
      bodyType: "json",
      body: { items: runs.map(experimentRunToApiFormat) },
    };
  },
});

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
      user: adaptSchema,
    }).defined(),
    params: yupObject({
      experiment_id: userSpecifiedIdSchema("experimentId").defined(),
    }).defined(),
    body: yupObject({
      // Validated in-depth by validateExperimentConfig (the wire contract for
      // experiment definitions); yup can't express that schema, so the body
      // field is passed through opaquely.
      experiment_config: yupMixed().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([201]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: experimentRunResponseSchema,
  }),
  async handler({ auth, params, body }) {
    ensureAnalyticsInstalledForExperiments(auth.tenancy);
    const run = await createExperimentRun({
      tenancy: auth.tenancy,
      experimentId: params.experiment_id,
      config: body.experiment_config,
      actor: experimentActorFromAuth(auth),
    });
    return {
      statusCode: 201,
      bodyType: "json",
      body: experimentRunToApiFormat(run),
    };
  },
});

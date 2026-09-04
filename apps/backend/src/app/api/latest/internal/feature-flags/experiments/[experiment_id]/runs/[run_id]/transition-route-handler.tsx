import { ensureAnalyticsInstalledForExperiments, experimentActorFromAuth, experimentRunResponseSchema, experimentRunToApiFormat } from "@/lib/feature-flags/experiment-api";
import type { ExperimentRun } from "@/generated/prisma/client";
import type { ExperimentActor } from "@/lib/feature-flags/experiment-runs";
import type { Tenancy } from "@/lib/tenancies";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, userSpecifiedIdSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

/**
 * All four lifecycle transition endpoints (start/pause/resume/complete) plus
 * the revision endpoint share the exact same request/response shape; only the
 * lib call differs. This factory keeps them from drifting apart. Transitions
 * are deliberately separate POST endpoints (rather than one PATCH with a
 * target state) so each transition's semantics and error surface stay
 * explicit.
 */
export function createExperimentRunTransitionHandler(options: {
  transition: (args: {
    tenancy: Tenancy,
    experimentId: string,
    runId: string,
    actor: ExperimentActor,
    config?: unknown,
  }) => Promise<ExperimentRun>,
  acceptsConfig: boolean,
  configRequired?: boolean,
}) {
  return createSmartRouteHandler({
    metadata: { hidden: true },
    request: yupObject({
      auth: yupObject({
        type: adminAuthTypeSchema.defined(),
        tenancy: adaptSchema.defined(),
        user: adaptSchema,
      }).defined(),
      params: yupObject({
        experiment_id: userSpecifiedIdSchema("experimentId").defined(),
        run_id: yupString().uuid().defined(),
      }).defined(),
      body: yupObject({
        // Deep-validated by validateExperimentConfig inside the lib call.
        experiment_config: yupMixed().optional(),
      }).nullable().optional(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: experimentRunResponseSchema,
    }),
    async handler({ auth, params, body }) {
      ensureAnalyticsInstalledForExperiments(auth.tenancy);
      const config = options.acceptsConfig ? (body ?? {}).experiment_config : undefined;
      if (options.configRequired && config === undefined) {
        throw new StatusError(StatusError.BadRequest, "experiment_config is required");
      }
      const run = await options.transition({
        tenancy: auth.tenancy,
        experimentId: params.experiment_id,
        runId: params.run_id,
        actor: experimentActorFromAuth(auth),
        ...config !== undefined ? { config } : {},
      });
      return {
        statusCode: 200,
        bodyType: "json",
        body: experimentRunToApiFormat(run),
      };
    },
  });
}

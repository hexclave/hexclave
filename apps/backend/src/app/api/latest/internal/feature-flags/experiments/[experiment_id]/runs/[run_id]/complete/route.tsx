import { completeExperimentRun } from "@/lib/feature-flags/experiment-runs";
import { createExperimentRunTransitionHandler } from "../transition-route-handler";

export const POST = createExperimentRunTransitionHandler({
  transition: completeExperimentRun,
  acceptsConfig: false,
});

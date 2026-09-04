import { resumeExperimentRun } from "@/lib/feature-flags/experiment-runs";
import { createExperimentRunTransitionHandler } from "../transition-route-handler";

export const POST = createExperimentRunTransitionHandler({
  transition: resumeExperimentRun,
  acceptsConfig: false,
});

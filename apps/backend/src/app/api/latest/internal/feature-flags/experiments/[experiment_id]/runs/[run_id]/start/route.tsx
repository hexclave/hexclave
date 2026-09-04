import { startExperimentRun } from "@/lib/feature-flags/experiment-runs";
import { createExperimentRunTransitionHandler } from "../transition-route-handler";

// Starting freezes the snapshot: if experiment_config is passed, the draft's
// provisional snapshot is replaced with it at this moment; either way the
// snapshot becomes immutable once the run is RUNNING.
export const POST = createExperimentRunTransitionHandler({
  transition: startExperimentRun,
  acceptsConfig: true,
});

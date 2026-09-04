import { createNewRevision } from "@/lib/feature-flags/experiment-runs";
import { createExperimentRunTransitionHandler } from "../transition-route-handler";

// "Editing" an active run: completes the current run and atomically creates a
// RUNNING successor with revisionNumber + 1 and the new (frozen) config. The
// response is the successor run.
export const POST = createExperimentRunTransitionHandler({
  transition: async (args) => await createNewRevision({ ...args, config: args.config }),
  acceptsConfig: true,
  configRequired: true,
});

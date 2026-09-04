import { globalPrismaClient } from "@/prisma-client";
import type { Tenancy } from "@/lib/tenancies";
import type { FeatureFlagsConfig } from "@hexclave/shared/dist/feature-flags/types";
import { overlayActiveExperimentRuns, type ActiveExperimentRunOverlay } from "./active-experiment-overlay";
import { validateExperimentConfig } from "./experiment-config";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const reportedInvalidSnapshots = new Set<string>();

/**
 * Overlays currently running immutable experiment snapshots onto branch config.
 * Lifecycle state stays in Prisma, while the shared evaluator remains pure and
 * server bootstrap consumers receive the exact same deterministic rules.
 */
export async function withActiveExperimentRuns(tenancy: Tenancy, config: FeatureFlagsConfig): Promise<FeatureFlagsConfig> {
  // Regular feature flags do not require Analytics, but experiment assignment
  // and exposure attribution do. If Analytics is disabled after a run starts,
  // stop assigning experiment traffic instead of producing unrecordable data.
  if (tenancy.config.apps.installed["analytics"]?.enabled !== true) return config;

  const runs = await globalPrismaClient.experimentRun.findMany({
    where: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      state: "RUNNING",
    },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
  });
  if (runs.length === 0) return config;

  const overlays = (await Promise.all(runs.map(async (run): Promise<ActiveExperimentRunOverlay | undefined> => {
    try {
      return {
        id: run.id,
        experimentId: run.experimentId,
        configRevisionHash: run.configRevisionHash,
        snapshot: await validateExperimentConfig(run.configSnapshot),
      };
    } catch (error) {
      // Schema tightening or a corrupt row must not 500 every evaluate and
      // bootstrap request. Report once per process so a persistent bad row
      // cannot flood telemetry on every bootstrap/evaluate.
      if (!reportedInvalidSnapshots.has(run.id)) {
        reportedInvalidSnapshots.add(run.id);
        captureError("feature-flags-invalid-experiment-snapshot", new HexclaveAssertionError(
          `Frozen experiment snapshot for run ${run.id} is invalid; skipping overlay so other flags still evaluate`,
          { cause: error },
        ));
      }
      return undefined;
    }
  }))).filter((overlay): overlay is ActiveExperimentRunOverlay => overlay !== undefined);
  return overlayActiveExperimentRuns(config, overlays);
}

import { findFeatureFlagIdByKey } from "@hexclave/shared/dist/feature-flags/evaluator";
import { getFeatureFlagsConfigErrors } from "@hexclave/shared/dist/feature-flags/schema";
import type { FeatureFlagDefinition, FeatureFlagValue, FeatureFlagsConfig } from "@hexclave/shared/dist/feature-flags/types";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

export type ActiveExperimentSnapshot = {
  flag_id: string,
  assignment_unit: "user" | "team",
  traffic_allocation_basis_points: number,
  control_variant_id: string,
  variants: Record<string, { weight_basis_points: number, flag_value: FeatureFlagValue }>,
  mutual_exclusion_group_id?: string,
};

export type ActiveExperimentRunOverlay = {
  id: string,
  experimentId: string,
  configRevisionHash: string,
  snapshot: ActiveExperimentSnapshot,
};

/**
 * Pure overlay used by both the request path and tests. A run that would make
 * the published config fail whole-config validation is skipped: server SDKs
 * re-validate bootstrap with `getFeatureFlagsConfigErrors`, so one deleted or
 * type-changed experiment must not take down every local flag evaluation.
 */
export function overlayActiveExperimentRuns(
  config: FeatureFlagsConfig,
  runs: readonly ActiveExperimentRunOverlay[],
): FeatureFlagsConfig {
  if (runs.length === 0) return config;

  let flags: Record<string, FeatureFlagDefinition | undefined> = { ...config.flags };
  let experiments = { ...config.experiments };
  const activeFlagIds = new Set<string>();
  for (const run of runs) {
    const snapshot = run.snapshot;
    const flagId = flags[snapshot.flag_id] !== undefined
      ? snapshot.flag_id
      : findFeatureFlagIdByKey({ flags }, snapshot.flag_id);
    if (flagId === undefined) {
      // A pushed config can race a lifecycle request. The frozen run remains
      // intact for audit/results, but without the flag's public definition
      // there is no safe key through which to expose it in this config version.
      continue;
    }
    if (activeFlagIds.has(flagId)) {
      // The migration's partial unique index prevents new collisions. Keep the
      // oldest run (caller must pass oldest-first) if legacy/corrupt data
      // predates it so a single bad row cannot make every flag evaluation fail.
      continue;
    }
    const flag = flags[flagId];
    const experiment = experiments[run.experimentId];
    if (flag === undefined || experiment === undefined || experiment.archived === true) {
      continue;
    }
    // Freeze values on the overlay rule only. Mutating flag.variants would
    // rewrite the published meaning of those keys for holdout, fallback, and
    // every non-experiment rule while the run is RUNNING.
    const variantWeights: Record<string, number> = {};
    const variantValues: Record<string, FeatureFlagValue> = {};
    for (const [variantId, variant] of Object.entries(snapshot.variants)) {
      variantWeights[variantId] = variant.weight_basis_points;
      variantValues[variantId] = variant.flag_value;
    }
    const ruleId = `experiment_${run.id}`;
    const candidate: FeatureFlagsConfig = {
      ...config,
      flags: {
        ...flags,
        [flagId]: {
          ...flag,
          ...(snapshot.mutual_exclusion_group_id === undefined ? {} : { mutualExclusionGroupId: snapshot.mutual_exclusion_group_id }),
          rules: {
            ...flag.rules,
            [ruleId]: {
              enabled: true,
              priority: 2_000_000,
              rolloutBasisPoints: snapshot.traffic_allocation_basis_points,
              allocationSalt: run.configRevisionHash,
              stickyBy: snapshot.assignment_unit === "team" ? "teamId" : "userId",
              variantWeights,
              variantValues,
              experimentId: run.experimentId,
              experimentRunId: run.id,
              experimentConfigRevision: run.configRevisionHash,
            },
          },
        },
      },
      experiments: {
        ...experiments,
        [run.experimentId]: {
          ...experiment,
          flagId,
          assignmentUnit: snapshot.assignment_unit,
          trafficAllocationBasisPoints: snapshot.traffic_allocation_basis_points,
          controlVariantKey: snapshot.control_variant_id,
          variantWeights,
        },
      },
    };
    if (getFeatureFlagsConfigErrors(candidate).length > 0) {
      continue;
    }
    flags = candidate.flags ?? throwErr("Overlay candidate omitted flags after a successful validation");
    experiments = candidate.experiments ?? throwErr("Overlay candidate omitted experiments after a successful validation");
    activeFlagIds.add(flagId);
  }
  // When every run was skipped, hand back the published config object itself
  // rather than a copy: spreading would turn an absent `experiments` into `{}`,
  // which changes the config shape (and anything derived from it, like the
  // bootstrap ETag) without any experiment actually being overlaid.
  if (activeFlagIds.size === 0) return config;
  return { ...config, flags, experiments };
}

const checkoutFlag = {
  key: "checkout",
  type: "boolean" as const,
  enabled: true,
  allocationSalt: "checkout-allocation",
  fallbackVariantKey: "off",
  variants: { on: { value: true }, off: { value: false } },
};

const checkoutExperiment = {
  key: "checkout-copy",
  hypothesis: "The new copy increases checkout completion",
  flagId: "checkout",
  assignmentUnit: "user" as const,
  trafficAllocationBasisPoints: 10_000,
  controlVariantKey: "off",
  variantWeights: { off: 5_000, on: 5_000 },
  primaryMetric: {
    id: "completed",
    type: "custom_event" as const,
    direction: "increase" as const,
    eventName: "checkout-completed",
    attributionWindowSeconds: 86_400,
  },
};

function checkoutSnapshot(flagId = "checkout"): ActiveExperimentSnapshot {
  return {
    flag_id: flagId,
    assignment_unit: "user",
    traffic_allocation_basis_points: 10_000,
    control_variant_id: "off",
    variants: {
      off: { weight_basis_points: 5_000, flag_value: false },
      on: { weight_basis_points: 5_000, flag_value: true },
    },
  };
}

import.meta.vitest?.test("overlays a running experiment without invalidating the published config", ({ expect }) => {
  const config: FeatureFlagsConfig = {
    flags: { checkout: checkoutFlag },
    experiments: { checkoutExperiment },
  };
  const overlaid = overlayActiveExperimentRuns(config, [{
    id: "run-1",
    experimentId: "checkoutExperiment",
    configRevisionHash: "revision-1",
    snapshot: checkoutSnapshot(),
  }]);
  expect(getFeatureFlagsConfigErrors(overlaid)).toEqual([]);
  expect(overlaid.flags?.checkout?.variants?.on?.value).toBe(true);
  expect(overlaid.flags?.checkout?.variants?.off?.value).toBe(false);
  expect(overlaid.flags?.checkout?.rules?.["experiment_run-1"]).toMatchObject({
    experimentId: "checkoutExperiment",
    experimentRunId: "run-1",
    stickyBy: "userId",
    priority: 2_000_000,
    variantValues: { off: false, on: true },
  });
});

import.meta.vitest?.test("does not rewrite published variant values for non-experiment traffic", ({ expect }) => {
  const config: FeatureFlagsConfig = {
    flags: {
      copy: {
        key: "copy",
        type: "string",
        enabled: true,
        allocationSalt: "copy-allocation",
        fallbackVariantKey: "control",
        variants: { control: { value: "published-control" }, treatment: { value: "published-treatment" } },
        rules: { everyone: { variantKey: "treatment" } },
      },
    },
    experiments: {
      copyExperiment: {
        key: "copy-test",
        hypothesis: "New copy converts better",
        flagId: "copy",
        assignmentUnit: "user",
        trafficAllocationBasisPoints: 10_000,
        controlVariantKey: "control",
        variantWeights: { control: 5_000, treatment: 5_000 },
        primaryMetric: {
          id: "completed",
          type: "custom_event",
          direction: "increase",
          eventName: "checkout-completed",
          attributionWindowSeconds: 86_400,
        },
      },
    },
  };
  const overlaid = overlayActiveExperimentRuns(config, [{
    id: "run-1",
    experimentId: "copyExperiment",
    configRevisionHash: "revision-1",
    snapshot: {
      flag_id: "copy",
      assignment_unit: "user",
      traffic_allocation_basis_points: 5_000,
      control_variant_id: "control",
      variants: {
        control: { weight_basis_points: 5_000, flag_value: "frozen-control" },
        treatment: { weight_basis_points: 5_000, flag_value: "frozen-treatment" },
      },
    },
  }]);
  expect(overlaid.flags?.copy?.variants?.control?.value).toBe("published-control");
  expect(overlaid.flags?.copy?.variants?.treatment?.value).toBe("published-treatment");
  expect(overlaid.flags?.copy?.rules?.["experiment_run-1"]?.variantValues).toEqual({
    control: "frozen-control",
    treatment: "frozen-treatment",
  });
});

import.meta.vitest?.test("skips a run whose experiment was removed so bootstrap validation still passes", ({ expect }) => {
  const config: FeatureFlagsConfig = { flags: { checkout: checkoutFlag } };
  const overlaid = overlayActiveExperimentRuns(config, [{
    id: "run-1",
    experimentId: "deletedExperiment",
    configRevisionHash: "revision-1",
    snapshot: checkoutSnapshot(),
  }]);
  expect(overlaid).toEqual(config);
  expect(getFeatureFlagsConfigErrors(overlaid)).toEqual([]);
});

import.meta.vitest?.test("skips a run that would change a boolean flag to incompatible frozen values", ({ expect }) => {
  const config: FeatureFlagsConfig = {
    flags: { checkout: checkoutFlag },
    experiments: { checkoutExperiment },
  };
  const overlaid = overlayActiveExperimentRuns(config, [{
    id: "run-1",
    experimentId: "checkoutExperiment",
    configRevisionHash: "revision-1",
    snapshot: {
      ...checkoutSnapshot(),
      variants: {
        off: { weight_basis_points: 5_000, flag_value: "off" },
        on: { weight_basis_points: 5_000, flag_value: "on" },
      },
    },
  }]);
  expect(overlaid.flags?.checkout?.rules?.["experiment_run-1"]).toBeUndefined();
  expect(overlaid.flags?.checkout?.variants?.on?.value).toBe(true);
  expect(getFeatureFlagsConfigErrors(overlaid)).toEqual([]);
});

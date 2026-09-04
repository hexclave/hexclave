import { use } from "@hexclave/shared/dist/utils/react";
import { useMemo } from "react";
import { canonicalFeatureFlagRequestKey, narrowFeatureFlagDetails, type FeatureFlagController, type FeatureFlagDetails, type FeatureFlagIdentity, type FeatureFlagOptions } from "./feature-flags";
import type { Json } from "@hexclave/shared/dist/utils/json";

export function useFeatureFlagDetailsFromController<TIdentity, T extends Json>(
  controller: FeatureFlagController<TIdentity>,
  identity: FeatureFlagIdentity<TIdentity>,
  key: string,
  fallback: T,
  options?: FeatureFlagOptions,
): FeatureFlagDetails<T> {
  const requestKey = canonicalFeatureFlagRequestKey([{ key, fallback, options }]);
  const evaluation = useMemo(
    () => controller.getFeatureFlags(identity, [{ key, fallback, options }]),
    [controller, identity.cacheKey, identity.value, requestKey],
  );
  const details = use(evaluation).get(key);
  if (details == null) throw new Error(`Feature flag evaluation did not include ${JSON.stringify(key)}.`);
  return narrowFeatureFlagDetails(details, fallback);
}

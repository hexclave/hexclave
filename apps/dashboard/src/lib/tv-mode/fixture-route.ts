import { TV_FIXTURE_VARIANTS, type TvFixtureVariant } from "./types";

const TV_FIXTURE_VARIANT_SET = new Set<string>(TV_FIXTURE_VARIANTS);

export function resolveTvFixtureVariant(
  value: string | null,
  developmentFeaturesEnabled: boolean,
): TvFixtureVariant | null {
  if (!developmentFeaturesEnabled || value == null || !TV_FIXTURE_VARIANT_SET.has(value)) {
    return null;
  }
  // Membership in TV_FIXTURE_VARIANTS above is the runtime proof that this
  // string satisfies the corresponding literal union without a type cast.
  return TV_FIXTURE_VARIANTS.find((variant) => variant === value) ?? null;
}

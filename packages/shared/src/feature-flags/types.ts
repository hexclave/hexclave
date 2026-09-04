import type { Json } from "../utils/json";

export type FeatureFlagValue = Json;

export function isFeatureFlagValue(value: unknown): value is FeatureFlagValue {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    switch (typeof current) {
      case "string":
      case "boolean": { break; }
      case "number": {
        if (!Number.isFinite(current)) return false;
        break;
      }
      case "object": {
        if (current === null) break;
        if (seen.has(current)) return false;
        seen.add(current);
        if (!Array.isArray(current)) {
          const prototype = Object.getPrototypeOf(current);
          if (prototype !== Object.prototype && prototype !== null) return false;
        }
        pending.push(...Object.values(current));
        break;
      }
      default: { return false; }
    }
  }
  return true;
}

export type FeatureFlagVariantType = "boolean" | "string" | "number" | "json";

export const featureFlagConditionOperators = [
  "eq",
  "neq",
  "in",
  "not_in",
  "starts_with",
  "ends_with",
  "contains",
  "not_contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_set",
  "is_not_set",
  "before",
  "after",
  "semver_eq",
  "semver_gt",
  "semver_gte",
  "semver_lt",
  "semver_lte",
  "in_segment",
  "not_in_segment",
] as const;

export type FeatureFlagConditionOperator = typeof featureFlagConditionOperators[number];

export type FeatureFlagCondition = {
  attribute?: string,
  operator?: FeatureFlagConditionOperator,
  value?: FeatureFlagValue,
};

export type FeatureFlagSegment = {
  displayName?: string,
  match?: "all" | "any",
  conditions?: Record<string, FeatureFlagCondition | undefined>,
};

export type FeatureFlagVariant = {
  value?: FeatureFlagValue,
  description?: string,
};

export type FeatureFlagPrerequisite = {
  flagId?: string,
  variantKeys?: Record<string, true | undefined>,
};

export type FeatureFlagRule = {
  displayName?: string,
  enabled?: boolean,
  priority?: number,
  conditions?: Record<string, FeatureFlagCondition | undefined>,
  rolloutBasisPoints?: number,
  allocationSalt?: string,
  stickyBy?: "distinctId" | "userId" | "teamId",
  variantKey?: string,
  variantWeights?: Record<string, number | undefined>,
  // Overlay-only: experiment snapshots freeze values on the matching rule so
  // published variants stay intact for holdout, fallback, and non-experiment
  // traffic. Absent means "use flag.variants[variantKey].value".
  variantValues?: Record<string, FeatureFlagValue | undefined>,
  experimentId?: string,
  experimentRunId?: string,
  experimentConfigRevision?: string,
};

export type FeatureFlagDefinition = {
  key?: string,
  displayName?: string,
  description?: string,
  type?: FeatureFlagVariantType,
  enabled?: boolean,
  killed?: boolean,
  archived?: boolean,
  allocationSalt?: string,
  variants?: Record<string, FeatureFlagVariant | undefined>,
  fallbackVariantKey?: string,
  prerequisites?: Record<string, FeatureFlagPrerequisite | undefined>,
  holdoutId?: string,
  mutualExclusionGroupId?: string,
  rules?: Record<string, FeatureFlagRule | undefined>,
  createdAtMillis?: number,
};

export type FeatureFlagHoldout = {
  displayName?: string,
  allocationBasisPoints?: number,
  allocationSalt?: string,
};

export type FeatureFlagMutualExclusionGroup = {
  displayName?: string,
  allocationSalt?: string,
  experimentWeights?: Record<string, number | undefined>,
};

export type FeatureFlagMetric = {
  id?: string,
  displayName?: string,
  eventName?: string,
  type?: "page_view" | "click" | "funnel" | "custom_event" | "numeric_value",
  direction?: "increase" | "decrease",
  urlPattern?: string,
  selector?: string,
  funnelSteps?: Record<string, string | undefined>,
  numericProperty?: string,
  numericAggregation?: "sum" | "average",
  attributionWindowSeconds?: number,
};

export type FeatureFlagExperiment = {
  key?: string,
  displayName?: string,
  hypothesis?: string,
  flagId?: string,
  assignmentUnit?: "user" | "team",
  trafficAllocationBasisPoints?: number,
  controlVariantKey?: string,
  variantWeights?: Record<string, number | undefined>,
  primaryMetric?: FeatureFlagMetric,
  secondaryMetrics?: Record<string, FeatureFlagMetric | undefined>,
  guardrailMetrics?: Record<string, FeatureFlagMetric | undefined>,
  mutualExclusionGroupId?: string,
  startsAt?: string,
  endsAt?: string,
  archived?: boolean,
  createdAtMillis?: number,
};

export type FeatureFlagsConfig = {
  flags?: Record<string, FeatureFlagDefinition | undefined>,
  segments?: Record<string, FeatureFlagSegment | undefined>,
  holdouts?: Record<string, FeatureFlagHoldout | undefined>,
  mutualExclusionGroups?: Record<string, FeatureFlagMutualExclusionGroup | undefined>,
  experiments?: Record<string, FeatureFlagExperiment | undefined>,
};

export type FeatureFlagJsonObject = Record<string, FeatureFlagValue | undefined>;

export type FeatureFlagEvaluationContext = {
  distinctId?: string,
  userId?: string,
  teamId?: string,
  user?: FeatureFlagJsonObject,
  team?: FeatureFlagJsonObject,
  context?: FeatureFlagJsonObject,
  segments?: ReadonlySet<string>,
};

export type FeatureFlagEvaluationReason =
  | "missing"
  | "archived"
  | "killed"
  | "disabled"
  | "prerequisite_unmet"
  | "dependency_cycle"
  | "holdout"
  | "mutual_exclusion"
  | "matched_rule"
  | "fallback";

export type FeatureFlagEvaluationResult = {
  flagId: string,
  flagKey: string,
  variantKey?: string,
  value?: FeatureFlagValue,
  reason: FeatureFlagEvaluationReason,
  ruleId?: string,
  experimentId?: string,
  experimentRunId?: string,
  experimentConfigRevision?: string,
};

export type FeatureFlagsBootstrap = {
  config: FeatureFlagsConfig,
  flagIdsByKey: Record<string, string>,
  configVersion: string,
};

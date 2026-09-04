import type { FeatureFlagsConfig } from "../../feature-flags/types";
import type { Json } from "../../utils/json";

export type FeatureFlagEvaluationReason = string;

export type FeatureFlagEvaluateRequest = {
  flag_keys: string[],
  fallbacks?: Record<string, Json>,
  distinct_id?: string,
  user_id?: string,
  team_id?: string,
  user?: Record<string, Json>,
  team?: Record<string, Json>,
  context?: Record<string, Json>,
  segments?: Record<string, true>,
};

export type FeatureFlagEvaluateResult<T extends Json = Json> = {
  flag_key: string,
  value: T,
  variant_key: string | null,
  reason: FeatureFlagEvaluationReason,
  rule_id: string | null,
  config_version: string,
  experiment_id: string | null,
  experiment_run_id: string | null,
  exposure_token: string | null,
  /** SDK-local metadata; public evaluate responses omit this field. */
  is_stale?: boolean,
};

export type FeatureFlagEvaluateResponse<T extends Json = Json> = {
  results: Record<string, FeatureFlagEvaluateResult<T>>,
};

export type FeatureFlagBootstrapResponse = {
  config: FeatureFlagsConfig,
  flag_ids_by_key: Record<string, string>,
  config_version: string,
};

export type FeatureFlagExposureRequest = {
  event_id: string,
  exposure_token: string,
  exposed_at_ms: number,
};

export type FeatureFlagExposureBatchRequest = {
  batch_id: string,
  exposures: FeatureFlagExposureRequest[],
};

export type FeatureFlagExperimentRunStatus = "draft" | "running" | "paused" | "completed";

export type FeatureFlagExperimentRun = {
  id: string,
  experiment_id: string,
  revision_number: number,
  config_revision_hash: string,
  config_snapshot: Json,
  state: FeatureFlagExperimentRunStatus,
  scheduled_start_at_millis: number | null,
  scheduled_end_at_millis: number | null,
  created_at_millis: number,
  started_at_millis: number | null,
  paused_at_millis: number | null,
  completed_at_millis: number | null,
  created_by_user_id: string | null,
};

export type FeatureFlagExperimentMetricVariantResult = {
  variant_id: string,
  exposed_subjects: number,
  converted_subjects: number | null,
  sum_values: number | null,
  posterior_mean: number,
  credible_interval_95: { lower: number, upper: number },
  probability_best: number,
  is_guardrail_regression: boolean | null,
};

export type FeatureFlagExperimentMetricResult = {
  metric_id: string,
  kind: "binary" | "numeric" | "funnel",
  role: "primary" | "secondary" | "guardrail",
  direction: "increase" | "decrease",
  variants: FeatureFlagExperimentMetricVariantResult[],
};

export type FeatureFlagExperimentResults = {
  run_id: string,
  experiment_id: string,
  config_revision_hash: string,
  total_exposed_subjects: number,
  exposed_subjects_by_variant: Record<string, number>,
  min_exposed_subjects_for_winner: number,
  srm: { detected: boolean, statistic: number | null, p_value: number | null },
  metrics: FeatureFlagExperimentMetricResult[],
  winner:
    | { status: "winner", variant_id: string, probability_best: number }
    | { status: "no_winner", reason: "insufficient_data" | "no_variant_confident" | "guardrail_regression" | "srm_detected" },
  winner_rollout: { flag_id: string, variant_id: string, flag_value: Json } | null,
};

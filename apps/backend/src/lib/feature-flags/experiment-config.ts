import { MAX_CUSTOM_EVENT_NAME_LENGTH } from "@/lib/analytics-custom-events";
import { userSpecifiedIdSchema, yupArray, yupMixed, yupNumber, yupObject, yupRecord, yupString, yupValidate } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { createHash } from "node:crypto";
import * as yup from "yup";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { isJsonSerializable } from "@hexclave/shared/dist/utils/json";

/**
 * Backend-local wire schema for experiment definitions.
 *
 * INTEGRATION NOTE (for the feature-flags core workstream): the shared config
 * contract is expected to expose `featureFlags.experiments` (plus flags,
 * segments, holdouts, mutualExclusionGroups) from packages/shared. Once those
 * exist, this module should be replaced by (or re-export) the intended shared
 * exports — expected to be importable roughly as:
 *
 *   import { experimentConfigSchema, type ExperimentConfig } from "@hexclave/shared/dist/feature-flags";
 *
 * with the same field semantics as below (snake_case on the wire / in frozen
 * snapshots; the branch-config form may be camelCase like other config
 * sections, in which case a converter to this wire form is needed). Until the
 * core branch lands, the admin create-run route takes the experiment
 * definition in the request body and validates it against this schema.
 */

export const MAX_VARIANTS_PER_EXPERIMENT = 10;
export const MAX_METRICS_PER_KIND = 10;
export const MAX_FUNNEL_STEPS = 10;
export const BASIS_POINTS_TOTAL = 10_000;

// Event names in metric definitions must be valid *customer* analytics event
// names — reserved ($-prefixed) events can't be experiment metrics because
// conversions are always customer-defined. Same bounds as the analytics events
// batch route accepts (see analytics-custom-events.ts).
const metricEventNameSchema = yupString().defined().min(1).max(MAX_CUSTOM_EVENT_NAME_LENGTH).test(
  "not-reserved",
  "Metric event names must be customer events, $page-view, or $click",
  (value) => !value.startsWith("$") || value === "$page-view" || value === "$click",
);

const metricDirectionSchema = yupString().oneOf(["increase", "decrease"] as const).defined();

const binaryMetricSchema = yupObject({
  id: userSpecifiedIdSchema("metricId").defined(),
  kind: yupString().oneOf(["binary"] as const).defined(),
  event_name: metricEventNameSchema,
  direction: metricDirectionSchema,
  event_filter: yupObject({
    field: yupString().oneOf(["path", "selector"] as const).defined(),
    operator: yupString().oneOf(["eq", "starts_with", "ends_with", "contains"] as const).defined(),
    value: yupString().defined().min(1).max(2048),
  }).optional(),
});

const numericMetricSchema = yupObject({
  id: userSpecifiedIdSchema("metricId").defined(),
  kind: yupString().oneOf(["numeric"] as const).defined(),
  event_name: metricEventNameSchema,
  direction: metricDirectionSchema,
  property_name: yupString().defined().min(1).max(64),
  aggregation: yupString().oneOf(["sum", "average"] as const).defined(),
});

const funnelMetricSchema = yupObject({
  id: userSpecifiedIdSchema("metricId").defined(),
  kind: yupString().oneOf(["funnel"] as const).defined(),
  // Ordered: a subject converts only if the events happen in this order (see experiment-results.ts).
  steps: yupArray(metricEventNameSchema).defined().min(2).max(MAX_FUNNEL_STEPS),
  direction: metricDirectionSchema,
});

// yup has no discriminated-union primitive, so we validate the `kind` field
// first and then the matching object schema in validateExperimentMetric below.
export type ExperimentMetricDefinition =
  | { id: string, kind: "binary", event_name: string, direction: "increase" | "decrease", event_filter?: { field: "path" | "selector", operator: "eq" | "starts_with" | "ends_with" | "contains", value: string } }
  | { id: string, kind: "numeric", event_name: string, direction: "increase" | "decrease", property_name: string, aggregation: "sum" | "average" }
  | { id: string, kind: "funnel", steps: string[], direction: "increase" | "decrease" };

const metricKindSchema = yupObject({
  kind: yupString().oneOf(["binary", "numeric", "funnel"] as const).defined(),
});

// yupValidate does not enforce yup's .noUnknown() (it validates with unknown
// keys ignored), so unknown-field rejection is explicit: anything not in the
// allowed set fails loudly instead of being silently dropped from the frozen
// snapshot — a typoed field name must never look like it was accepted.
function rejectUnknownKeys(value: unknown, allowedKeys: readonly string[], label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new yup.ValidationError(`Unknown field ${JSON.stringify(key)} in ${label}`, value, key);
    }
  }
}

async function validateExperimentMetric(value: unknown): Promise<ExperimentMetricDefinition> {
  const { kind } = await yupValidate(metricKindSchema, value, { abortEarly: false });
  switch (kind) {
    case "binary": {
      rejectUnknownKeys(value, ["id", "kind", "event_name", "direction", "event_filter"], "binary metric");
      if (typeof value === "object" && value !== null && !Array.isArray(value) && "event_filter" in value && value.event_filter !== undefined) {
        rejectUnknownKeys(value.event_filter, ["field", "operator", "value"], "binary metric event_filter");
      }
      return { ...await yupValidate(binaryMetricSchema, value, { abortEarly: false }), kind: "binary" };
    }
    case "numeric": {
      rejectUnknownKeys(value, ["id", "kind", "event_name", "direction", "property_name", "aggregation"], "numeric metric");
      return { ...await yupValidate(numericMetricSchema, value, { abortEarly: false }), kind: "numeric" };
    }
    case "funnel": {
      rejectUnknownKeys(value, ["id", "kind", "steps", "direction"], "funnel metric");
      const funnel = await yupValidate(funnelMetricSchema, value, { abortEarly: false });
      return { ...funnel, kind: "funnel", steps: [...funnel.steps] };
    }
  }
}

const experimentConfigBaseSchema = yupObject({
  display_name: yupString().max(256).optional(),
  hypothesis: yupString().max(4096).optional(),
  // The feature flag this experiment assigns variants for.
  flag_id: userSpecifiedIdSchema("flagId").defined(),
  assignment_unit: yupString().oneOf(["user", "team"] as const).defined(),
  // Fraction of eligible traffic enrolled in the experiment, in basis points (0..10000).
  traffic_allocation_basis_points: yupNumber().integer().min(0).max(BASIS_POINTS_TOTAL).defined(),
  control_variant_id: userSpecifiedIdSchema("variantId").defined(),
  variants: yupRecord(
    userSpecifiedIdSchema("variantId"),
    yupObject({
      // Relative assignment weight in basis points; all weights must sum to exactly 10000.
      weight_basis_points: yupNumber().integer().min(0).max(BASIS_POINTS_TOTAL).defined(),
      // The flag value served to this variant; any JSON value.
      flag_value: yupMixed().nullable().defined(),
    }),
  ).defined(),
  primary_metric: yupMixed().defined(),
  secondary_metrics: yupArray(yupMixed().defined()).max(MAX_METRICS_PER_KIND).optional(),
  guardrail_metrics: yupArray(yupMixed().defined()).max(MAX_METRICS_PER_KIND).optional(),
  // Conversions are only attributed within this window after a subject's first eligible exposure.
  attribution_window_seconds: yupNumber().integer().min(1).max(90 * 24 * 60 * 60).defined(),
  mutual_exclusion_group_id: userSpecifiedIdSchema("mutualExclusionGroupId").optional(),
  schedule: yupObject({
    start_at_millis: yupNumber().integer().min(0).optional(),
    end_at_millis: yupNumber().integer().min(0).optional(),
  }).optional().default(undefined),
});

export type ExperimentConfig = {
  display_name?: string,
  hypothesis?: string,
  flag_id: string,
  assignment_unit: "user" | "team",
  traffic_allocation_basis_points: number,
  control_variant_id: string,
  variants: Record<string, { weight_basis_points: number, flag_value: Json }>,
  primary_metric: ExperimentMetricDefinition,
  secondary_metrics: ExperimentMetricDefinition[],
  guardrail_metrics: ExperimentMetricDefinition[],
  attribution_window_seconds: number,
  mutual_exclusion_group_id?: string,
  schedule?: { start_at_millis?: number, end_at_millis?: number },
};

/**
 * Validates an untrusted experiment definition (from the admin API today, from
 * the shared config after integration) into the frozen snapshot form. Throws
 * StatusError(400) with the yup validation messages on invalid input — the
 * smart route handler only auto-maps yup errors during *request schema*
 * validation, so an in-handler ValidationError would otherwise surface as a
 * 500 internal error.
 */
export async function validateExperimentConfig(value: unknown): Promise<ExperimentConfig> {
  try {
    return await validateExperimentConfigInner(value);
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      // yup messages only describe the submitted document, so they're safe to
      // return to the (admin) caller.
      throw new StatusError(StatusError.BadRequest, `Invalid experiment configuration: ${error.errors.join("; ")}`);
    }
    throw error;
  }
}

async function validateExperimentConfigInner(value: unknown): Promise<ExperimentConfig> {
  rejectUnknownKeys(value, [
    "display_name", "hypothesis", "flag_id", "assignment_unit", "traffic_allocation_basis_points",
    "control_variant_id", "variants", "primary_metric", "secondary_metrics", "guardrail_metrics",
    "attribution_window_seconds", "schedule",
    "mutual_exclusion_group_id",
  ], "experiment configuration");
  if (typeof value === "object" && value !== null && !Array.isArray(value) && "schedule" in value) {
    rejectUnknownKeys(value.schedule, ["start_at_millis", "end_at_millis"], "experiment schedule");
  }
  const base = await yupValidate(experimentConfigBaseSchema.defined(), value, { abortEarly: false });

  const variantEntries = Object.entries(base.variants);
  if (variantEntries.length < 2 || variantEntries.length > MAX_VARIANTS_PER_EXPERIMENT) {
    throw new yup.ValidationError(`Experiments must define between 2 and ${MAX_VARIANTS_PER_EXPERIMENT} variants`, value, "variants");
  }
  const weightSum = variantEntries.reduce((acc, [, v]) => acc + v.weight_basis_points, 0);
  if (weightSum !== BASIS_POINTS_TOTAL) {
    throw new yup.ValidationError(`Variant weights must sum to exactly ${BASIS_POINTS_TOTAL} basis points, got ${weightSum}`, value, "variants");
  }
  if (variantEntries.filter(([, variant]) => variant.weight_basis_points > 0).length < 2) {
    throw new yup.ValidationError("Experiments must define at least two variants with positive weights", value, "variants");
  }
  if (!Object.hasOwn(base.variants, base.control_variant_id)) {
    throw new yup.ValidationError(`control_variant_id ${JSON.stringify(base.control_variant_id)} is not a key of variants`, value, "control_variant_id");
  }
  if (base.variants[base.control_variant_id].weight_basis_points <= 0) {
    throw new yup.ValidationError("The control variant must have a positive weight", value, "control_variant_id");
  }
  if (base.schedule?.start_at_millis != null && base.schedule.end_at_millis != null && base.schedule.end_at_millis <= base.schedule.start_at_millis) {
    throw new yup.ValidationError("schedule.end_at_millis must be after schedule.start_at_millis", value, "schedule");
  }

  const variants: ExperimentConfig["variants"] = {};
  for (const [variantId, variant] of variantEntries) {
    if (!isJsonSerializable(variant.flag_value)) {
      throw new yup.ValidationError(`Variant ${JSON.stringify(variantId)} flag_value must be JSON-serializable`, value, `variants.${variantId}.flag_value`);
    }
    variants[variantId] = {
      weight_basis_points: variant.weight_basis_points,
      flag_value: variant.flag_value,
    };
  }

  const primaryMetric = await validateExperimentMetric(base.primary_metric);
  const secondaryMetrics = await Promise.all((base.secondary_metrics ?? []).map(validateExperimentMetric));
  const guardrailMetrics = await Promise.all((base.guardrail_metrics ?? []).map(validateExperimentMetric));
  const allMetricIds = [primaryMetric, ...secondaryMetrics, ...guardrailMetrics].map((m) => m.id);
  if (new Set(allMetricIds).size !== allMetricIds.length) {
    throw new yup.ValidationError("Metric ids must be unique across primary, secondary, and guardrail metrics", value, "primary_metric");
  }

  return {
    ...base.display_name != null ? { display_name: base.display_name } : {},
    ...base.hypothesis != null ? { hypothesis: base.hypothesis } : {},
    flag_id: base.flag_id,
    assignment_unit: base.assignment_unit,
    traffic_allocation_basis_points: base.traffic_allocation_basis_points,
    control_variant_id: base.control_variant_id,
    variants,
    primary_metric: primaryMetric,
    secondary_metrics: secondaryMetrics,
    guardrail_metrics: guardrailMetrics,
    attribution_window_seconds: base.attribution_window_seconds,
    ...base.mutual_exclusion_group_id != null ? { mutual_exclusion_group_id: base.mutual_exclusion_group_id } : {},
    ...base.schedule != null ? {
      schedule: {
        ...base.schedule.start_at_millis != null ? { start_at_millis: base.schedule.start_at_millis } : {},
        ...base.schedule.end_at_millis != null ? { end_at_millis: base.schedule.end_at_millis } : {},
      },
    } : {},
  };
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalizeJson(v)]),
    );
  }
  return value;
}

/**
 * Canonical revision hash of an experiment configuration: SHA-256 over the
 * sorted-keys JSON serialization. Key order and `undefined` members don't
 * affect the hash, so two semantically identical configs always produce the
 * same revision hash regardless of how they were constructed.
 */
export function computeExperimentConfigRevisionHash(config: ExperimentConfig): string {
  // JSON.stringify's declared return type is plain `string`, but at runtime it
  // returns undefined for non-JSON roots; the retyped reference makes the
  // guard below visible to the type system so we fail loudly instead of
  // hashing the string "undefined".
  const stringifyOrUndefined: (value: unknown) => string | undefined = JSON.stringify;
  const canonical = stringifyOrUndefined(canonicalizeJson(config));
  if (canonical === undefined) {
    throw new HexclaveAssertionError("Experiment config serialized to undefined; validateExperimentConfig should have rejected non-JSON input");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

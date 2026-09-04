import { yupBoolean, yupMixed, yupNumber, yupObject, yupRecord, yupString } from "../schema-fields";
import { HexclaveAssertionError } from "../utils/errors";
import { isStrictSemver, isStrictUtcTimestamp } from "./evaluator";
import type { FeatureFlagCondition, FeatureFlagDefinition, FeatureFlagExperiment, FeatureFlagMetric, FeatureFlagsConfig } from "./types";
import { featureFlagConditionOperators, isFeatureFlagValue } from "./types";

const configIdSchema = yupString().matches(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/, "ID must contain only letters, numbers, underscores, and hyphens");
const publicKeySchema = yupString().matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "Flag key must contain only letters, numbers, dots, underscores, and hyphens");
const basisPointsSchema = yupNumber().integer().min(0).max(10_000);
const strictUtcTimestampSchema = yupString().test("strict-utc", "Timestamp must be a strict UTC ISO timestamp", (value) => value === undefined || isStrictUtcTimestamp(value));
const featureFlagTypes = ["boolean", "string", "number", "json"] as const;
const stickyByValues = ["distinctId", "userId", "teamId"] as const;
const segmentMatchValues = ["all", "any"] as const;
const assignmentUnitValues = ["user", "team"] as const;
const metricTypeValues = ["page_view", "click", "funnel", "custom_event", "numeric_value"] as const;

const jsonValueSchema = yupMixed()
  .nullable()
  .test("json-value", "Value must be JSON serializable", (value) => value === undefined || isFeatureFlagValue(value));

function conditionValueIsValid(condition: FeatureFlagCondition): boolean {
  if (condition.operator === undefined) return true;
  if (condition.operator === "is_set" || condition.operator === "is_not_set") return condition.value === undefined;
  if (condition.value === undefined) return false;
  switch (condition.operator) {
    case "eq":
    case "neq": { return isFeatureFlagValue(condition.value); }
    case "in":
    case "not_in": { return Array.isArray(condition.value); }
    case "starts_with":
    case "ends_with": { return typeof condition.value === "string"; }
    case "contains":
    case "not_contains": { return typeof condition.value === "string" || isFeatureFlagValue(condition.value); }
    case "gt":
    case "gte":
    case "lt":
    case "lte": { return typeof condition.value === "number" && Number.isFinite(condition.value); }
    case "before":
    case "after": { return typeof condition.value === "string" && isStrictUtcTimestamp(condition.value); }
    case "semver_eq":
    case "semver_gt":
    case "semver_gte":
    case "semver_lt":
    case "semver_lte": { return typeof condition.value === "string" && isStrictSemver(condition.value); }
    case "in_segment":
    case "not_in_segment": { return typeof condition.value === "string"; }
  }
}

const conditionSchema = yupObject({
  attribute: yupString().min(1).max(256),
  operator: yupString().oneOf(featureFlagConditionOperators),
  value: jsonValueSchema.optional(),
}).test("operator-value", "Condition value does not match its operator", conditionValueIsValid);

const segmentSchema = yupObject({
  displayName: yupString().max(128),
  match: yupString().oneOf(segmentMatchValues),
  conditions: yupRecord(configIdSchema, conditionSchema),
});

const variantSchema = yupObject({
  value: jsonValueSchema,
  description: yupString().max(500),
});

const prerequisiteSchema = yupObject({
  flagId: configIdSchema,
  variantKeys: yupRecord(configIdSchema, yupBoolean().oneOf([true])),
});

const ruleSchema = yupObject({
  displayName: yupString().max(128),
  enabled: yupBoolean(),
  priority: yupNumber().integer().min(0),
  conditions: yupRecord(configIdSchema, conditionSchema),
  rolloutBasisPoints: basisPointsSchema,
  allocationSalt: yupString().max(256),
  stickyBy: yupString().oneOf(stickyByValues),
  variantKey: configIdSchema,
  variantWeights: yupRecord(configIdSchema, basisPointsSchema),
  variantValues: yupRecord(configIdSchema, jsonValueSchema),
  experimentId: configIdSchema,
});

const flagSchema = yupObject({
  key: publicKeySchema,
  displayName: yupString().max(128),
  description: yupString().max(1000),
  type: yupString().oneOf(featureFlagTypes),
  enabled: yupBoolean(),
  killed: yupBoolean(),
  archived: yupBoolean(),
  allocationSalt: yupString().max(256),
  variants: yupRecord(configIdSchema, variantSchema),
  fallbackVariantKey: configIdSchema,
  prerequisites: yupRecord(configIdSchema, prerequisiteSchema),
  holdoutId: configIdSchema,
  mutualExclusionGroupId: configIdSchema,
  rules: yupRecord(configIdSchema, ruleSchema),
  createdAtMillis: yupNumber().integer().min(0),
});

const holdoutSchema = yupObject({
  displayName: yupString().max(128),
  allocationBasisPoints: basisPointsSchema,
  allocationSalt: yupString().max(256),
});

const mutualExclusionGroupSchema = yupObject({
  displayName: yupString().max(128),
  allocationSalt: yupString().max(256),
  experimentWeights: yupRecord(configIdSchema, basisPointsSchema),
});

const metricSchema = yupObject({
  id: configIdSchema,
  displayName: yupString().max(128),
  eventName: yupString().min(1).max(128),
  type: yupString().oneOf(metricTypeValues),
  direction: yupString().oneOf(["increase", "decrease"]),
  urlPattern: yupString().max(2048),
  selector: yupString().max(2048),
  funnelSteps: yupRecord(configIdSchema, yupString().min(1).max(128)),
  numericProperty: yupString().min(1).max(128),
  numericAggregation: yupString().oneOf(["sum", "average"]),
  attributionWindowSeconds: yupNumber().integer().min(1).max(31_536_000),
});

const experimentSchema = yupObject({
  key: publicKeySchema,
  displayName: yupString().max(128),
  hypothesis: yupString().max(2000),
  flagId: configIdSchema,
  assignmentUnit: yupString().oneOf(assignmentUnitValues),
  trafficAllocationBasisPoints: basisPointsSchema,
  controlVariantKey: configIdSchema,
  variantWeights: yupRecord(configIdSchema, basisPointsSchema),
  primaryMetric: metricSchema,
  secondaryMetrics: yupRecord(configIdSchema, metricSchema),
  guardrailMetrics: yupRecord(configIdSchema, metricSchema),
  mutualExclusionGroupId: configIdSchema,
  startsAt: strictUtcTimestampSchema,
  endsAt: strictUtcTimestampSchema,
  archived: yupBoolean(),
  createdAtMillis: yupNumber().integer().min(0),
});

function sumDefined(record: Record<string, number | undefined> | undefined): number {
  let sum = 0;
  for (const value of Object.values(record ?? {})) sum += value ?? 0;
  return sum;
}

function hasRecordKey(record: Record<string, unknown> | undefined, key: string | undefined): boolean {
  return key !== undefined && Object.entries(record ?? {}).some(([entryKey, value]) => entryKey === key && value !== undefined);
}

function findGraphCycle(graph: ReadonlyMap<string, readonly string[]>): readonly string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string, path: readonly string[]): readonly string[] | undefined => {
    if (visiting.has(node)) return [...path, node];
    if (visited.has(node)) return undefined;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next, [...path, node]);
      if (cycle !== undefined) return cycle;
    }
    visiting.delete(node);
    visited.add(node);
    return undefined;
  };
  for (const node of graph.keys()) {
    const cycle = visit(node, []);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function validateExperimentMetric(
  experimentId: string,
  metricPath: string,
  metric: FeatureFlagMetric | undefined,
  errors: string[],
): number | undefined {
  const label = `Metric "${metricPath}" on experiment "${experimentId}"`;
  if (metric === undefined) {
    errors.push(`${label} is required`);
    return undefined;
  }
  if (!isNonEmptyString(metric.id)) errors.push(`${label} must define an id`);
  if (metric.type === undefined) errors.push(`${label} must define a type`);
  if (metric.direction === undefined) errors.push(`${label} must define a direction`);
  if (metric.attributionWindowSeconds === undefined) errors.push(`${label} must define an attribution window`);

  switch (metric.type) {
    case undefined: { break; }
    case "page_view": {
      if (metric.eventName !== "$page-view") errors.push(`${label} must use the $page-view event`);
      const pattern = metric.urlPattern?.trim();
      if (pattern === undefined || pattern.length === 0 || pattern.replace(/^\*/, "").replace(/\*$/, "").length === 0) {
        errors.push(`${label} must define a non-empty URL pattern`);
      }
      break;
    }
    case "click": {
      if (metric.eventName !== "$click") errors.push(`${label} must use the $click event`);
      if (!isNonEmptyString(metric.selector)) errors.push(`${label} must define a selector`);
      break;
    }
    case "funnel": {
      const steps = Object.entries(metric.funnelSteps ?? {}).map(([stepId, eventName]) => {
        const match = /^step_([1-9]\d*)$/.exec(stepId);
        return { position: match === null ? undefined : Number(match[1]), eventName };
      }).sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER));
      if (steps.length < 2 || steps.length > 10) errors.push(`${label} must define between 2 and 10 funnel steps`);
      for (const [index, step] of steps.entries()) {
        if (step.position !== index + 1) errors.push(`${label} funnel steps must be consecutively named step_1, step_2, ...`);
        if (!isNonEmptyString(step.eventName)) errors.push(`${label} funnel step ${index + 1} must define an event name`);
      }
      break;
    }
    case "custom_event": {
      if (!isNonEmptyString(metric.eventName) || metric.eventName.startsWith("$")) errors.push(`${label} must define a non-reserved event name`);
      break;
    }
    case "numeric_value": {
      if (!isNonEmptyString(metric.eventName) || metric.eventName.startsWith("$")) errors.push(`${label} must define a non-reserved event name`);
      if (!isNonEmptyString(metric.numericProperty)) errors.push(`${label} must define a numeric property`);
      if (metric.numericAggregation === undefined) errors.push(`${label} must define a numeric aggregation`);
      break;
    }
  }
  return metric.attributionWindowSeconds;
}

export function getFeatureFlagsConfigErrors(config: FeatureFlagsConfig): string[] {
  const errors: string[] = [];
  const publicKeys = new Set<string>();
  for (const [flagId, flag] of Object.entries(config.flags ?? {})) {
    if (flag === undefined) continue;
    if (flag.key === undefined) {
      errors.push(`Feature flag "${flagId}" must define a public key`);
    } else {
      if (publicKeys.has(flag.key)) errors.push(`Feature flag key "${flag.key}" is duplicated`);
      publicKeys.add(flag.key);
    }
    if (flag.type === undefined) errors.push(`Feature flag "${flagId}" must define a type`);
    if (Object.keys(flag.variants ?? {}).length === 0) errors.push(`Feature flag "${flagId}" must define at least one variant`);
    if (flag.fallbackVariantKey === undefined) errors.push(`Feature flag "${flagId}" must define a fallback variant`);
    if (flag.allocationSalt === undefined || flag.allocationSalt.length === 0) errors.push(`Feature flag "${flagId}" must define a stable allocation salt`);
    if (flag.fallbackVariantKey !== undefined && !hasRecordKey(flag.variants, flag.fallbackVariantKey)) {
      errors.push(`Feature flag "${flagId}" references missing fallback variant "${flag.fallbackVariantKey}"`);
    }
    if (flag.holdoutId !== undefined && !hasRecordKey(config.holdouts, flag.holdoutId)) {
      errors.push(`Feature flag "${flagId}" references missing holdout "${flag.holdoutId}"`);
    }
    if (flag.mutualExclusionGroupId !== undefined && !hasRecordKey(config.mutualExclusionGroups, flag.mutualExclusionGroupId)) {
      errors.push(`Feature flag "${flagId}" references missing mutual exclusion group "${flag.mutualExclusionGroupId}"`);
    }
    for (const [prerequisiteId, prerequisite] of Object.entries(flag.prerequisites ?? {})) {
      if (prerequisite?.flagId === undefined) errors.push(`Prerequisite "${prerequisiteId}" on feature flag "${flagId}" must reference a flag`);
      if (Object.keys(prerequisite?.variantKeys ?? {}).length === 0) errors.push(`Prerequisite "${prerequisiteId}" on feature flag "${flagId}" must allow at least one variant`);
      if (prerequisite?.flagId !== undefined && !hasRecordKey(config.flags, prerequisite.flagId)) {
        errors.push(`Prerequisite "${prerequisiteId}" on feature flag "${flagId}" references missing flag "${prerequisite.flagId}"`);
      }
      const prerequisiteFlag = prerequisite?.flagId === undefined ? undefined : config.flags?.[prerequisite.flagId];
      for (const variantKey of Object.keys(prerequisite?.variantKeys ?? {})) {
        if (!hasRecordKey(prerequisiteFlag?.variants, variantKey)) errors.push(`Prerequisite "${prerequisiteId}" references missing variant "${variantKey}"`);
      }
    }
    for (const [ruleId, rule] of Object.entries(flag.rules ?? {})) {
      if (rule === undefined) continue;
      if ((rule.variantKey === undefined) === (rule.variantWeights === undefined)) errors.push(`Rule "${ruleId}" must define exactly one of variantKey or variantWeights`);
      if (rule.variantKey !== undefined && !hasRecordKey(flag.variants, rule.variantKey)) errors.push(`Rule "${ruleId}" references missing variant "${rule.variantKey}"`);
      if (rule.variantWeights !== undefined && sumDefined(rule.variantWeights) !== 10_000) errors.push(`Rule "${ruleId}" variant weights must total 10000 basis points`);
      for (const variantKey of Object.keys(rule.variantWeights ?? {})) {
        if (!hasRecordKey(flag.variants, variantKey)) errors.push(`Rule "${ruleId}" references missing variant "${variantKey}"`);
      }
      for (const [variantKey, value] of Object.entries(rule.variantValues ?? {})) {
        if (!hasRecordKey(flag.variants, variantKey)) errors.push(`Rule "${ruleId}" variantValues references missing variant "${variantKey}"`);
        if (value !== undefined && flag.type !== undefined && flag.type !== "json" && typeof value !== flag.type) {
          errors.push(`Rule "${ruleId}" variantValues "${variantKey}" must have a ${flag.type} value`);
        }
      }
      if (rule.experimentId !== undefined && !hasRecordKey(config.experiments, rule.experimentId)) {
        errors.push(`Rule "${ruleId}" references missing experiment "${rule.experimentId}"`);
      } else if (rule.experimentId !== undefined && config.experiments?.[rule.experimentId]?.flagId !== flagId) {
        errors.push(`Rule "${ruleId}" on feature flag "${flagId}" references experiment "${rule.experimentId}" for a different flag`);
      }
      for (const condition of Object.values(rule.conditions ?? {})) {
        if (condition?.attribute === undefined || condition.operator === undefined) errors.push(`Rule "${ruleId}" contains an incomplete condition`);
        if ((condition?.operator === "in_segment" || condition?.operator === "not_in_segment") && typeof condition.value === "string" && !hasRecordKey(config.segments, condition.value)) {
          errors.push(`Rule "${ruleId}" references missing segment "${condition.value}"`);
        }
      }
    }
    for (const [variantKey, variant] of Object.entries(flag.variants ?? {})) {
      const value = variant?.value;
      if (value === undefined || flag.type === undefined || flag.type === "json") continue;
      if (typeof value !== flag.type) errors.push(`Variant "${variantKey}" on feature flag "${flagId}" must have a ${flag.type} value`);
    }
  }
  for (const [segmentId, segment] of Object.entries(config.segments ?? {})) {
    for (const condition of Object.values(segment?.conditions ?? {})) {
      if (condition?.attribute === undefined || condition.operator === undefined) errors.push(`Segment "${segmentId}" contains an incomplete condition`);
      if ((condition?.operator === "in_segment" || condition?.operator === "not_in_segment") && typeof condition.value === "string" && !hasRecordKey(config.segments, condition.value)) {
        errors.push(`Segment "${segmentId}" references missing segment "${condition.value}"`);
      }
    }
  }
  const experimentKeys = new Set<string>();
  const activeExperimentByFlagId = new Map<string, string>();
  for (const [experimentId, experiment] of Object.entries(config.experiments ?? {})) {
    if (experiment === undefined) continue;
    if (!isNonEmptyString(experiment.key)) {
      errors.push(`Experiment "${experimentId}" must define a public key`);
    } else {
      if (experimentKeys.has(experiment.key)) errors.push(`Experiment key "${experiment.key}" is duplicated`);
      experimentKeys.add(experiment.key);
    }
    if (!isNonEmptyString(experiment.hypothesis)) errors.push(`Experiment "${experimentId}" must define a hypothesis`);
    if (experiment.flagId === undefined) errors.push(`Experiment "${experimentId}" must reference a flag`);
    if (experiment.assignmentUnit === undefined) errors.push(`Experiment "${experimentId}" must define an assignment unit`);
    if (experiment.trafficAllocationBasisPoints === undefined) errors.push(`Experiment "${experimentId}" must define a traffic allocation`);
    if (experiment.controlVariantKey === undefined) errors.push(`Experiment "${experimentId}" must define a control variant`);
    if (experiment.flagId !== undefined && !hasRecordKey(config.flags, experiment.flagId)) errors.push(`Experiment "${experimentId}" references missing flag "${experiment.flagId}"`);
    if (experiment.archived !== true && experiment.flagId !== undefined) {
      const ownerId = activeExperimentByFlagId.get(experiment.flagId);
      if (ownerId !== undefined) {
        errors.push(`Experiment "${experimentId}" targets flag "${experiment.flagId}" which is already targeted by "${ownerId}"`);
      } else {
        activeExperimentByFlagId.set(experiment.flagId, experimentId);
      }
    }

    const variantEntries = Object.entries(experiment.variantWeights ?? {});
    if (variantEntries.length < 2 || variantEntries.length > 10) errors.push(`Experiment "${experimentId}" must define between 2 and 10 variants`);
    if (experiment.variantWeights === undefined || sumDefined(experiment.variantWeights) !== 10_000) errors.push(`Experiment "${experimentId}" variant weights must total 10000 basis points`);
    for (const [variantKey, weight] of variantEntries) {
      if (weight === undefined) errors.push(`Experiment "${experimentId}" variant "${variantKey}" must define a weight`);
    }
    const flag = experiment.flagId === undefined ? undefined : config.flags?.[experiment.flagId];
    for (const variantKey of Object.keys(experiment.variantWeights ?? {})) {
      if (!hasRecordKey(flag?.variants, variantKey)) errors.push(`Experiment "${experimentId}" references missing variant "${variantKey}"`);
    }
    if (experiment.controlVariantKey !== undefined && !hasRecordKey(flag?.variants, experiment.controlVariantKey)) {
      errors.push(`Experiment "${experimentId}" references missing control variant "${experiment.controlVariantKey}"`);
    }
    if (experiment.controlVariantKey !== undefined && !hasRecordKey(experiment.variantWeights, experiment.controlVariantKey)) {
      errors.push(`Experiment "${experimentId}" control variant "${experiment.controlVariantKey}" must be allocated by the experiment`);
    }
    if (experiment.mutualExclusionGroupId !== undefined && !hasRecordKey(config.mutualExclusionGroups, experiment.mutualExclusionGroupId)) {
      errors.push(`Experiment "${experimentId}" references missing mutual exclusion group "${experiment.mutualExclusionGroupId}"`);
    }

    const metrics: [string, FeatureFlagMetric | undefined][] = [
      ["primaryMetric", experiment.primaryMetric],
      ...Object.entries(experiment.secondaryMetrics ?? {}).map(([metricId, metric]): [string, FeatureFlagMetric | undefined] => [`secondaryMetrics.${metricId}`, metric]),
      ...Object.entries(experiment.guardrailMetrics ?? {}).map(([metricId, metric]): [string, FeatureFlagMetric | undefined] => [`guardrailMetrics.${metricId}`, metric]),
    ];
    const metricIds = new Set<string>();
    const attributionWindows = new Set<number>();
    for (const [metricPath, metric] of metrics) {
      const attributionWindow = validateExperimentMetric(experimentId, metricPath, metric, errors);
      if (attributionWindow !== undefined) attributionWindows.add(attributionWindow);
      if (metric?.id !== undefined) {
        if (metricIds.has(metric.id)) errors.push(`Experiment "${experimentId}" metric id "${metric.id}" is duplicated`);
        metricIds.add(metric.id);
      }
    }
    if (attributionWindows.size > 1) errors.push(`Experiment "${experimentId}" metrics must use the same attribution window`);

    if (experiment.startsAt !== undefined && !isStrictUtcTimestamp(experiment.startsAt)) errors.push(`Experiment "${experimentId}" start must be a strict UTC timestamp`);
    if (experiment.endsAt !== undefined && !isStrictUtcTimestamp(experiment.endsAt)) errors.push(`Experiment "${experimentId}" end must be a strict UTC timestamp`);
    if (experiment.startsAt !== undefined && experiment.endsAt !== undefined && isStrictUtcTimestamp(experiment.startsAt) && isStrictUtcTimestamp(experiment.endsAt) && new Date(experiment.endsAt).getTime() <= new Date(experiment.startsAt).getTime()) {
      errors.push(`Experiment "${experimentId}" end must be after its start`);
    }
  }
  for (const [groupId, group] of Object.entries(config.mutualExclusionGroups ?? {})) {
    if (group?.experimentWeights !== undefined && sumDefined(group.experimentWeights) !== 10_000) errors.push(`Mutual exclusion group "${groupId}" weights must total 10000 basis points`);
    for (const experimentId of Object.keys(group?.experimentWeights ?? {})) {
      if (!hasRecordKey(config.experiments, experimentId)) errors.push(`Mutual exclusion group "${groupId}" references missing experiment "${experimentId}"`);
    }
    const assignmentUnits = new Set(Object.keys(group?.experimentWeights ?? {}).flatMap((experimentId) => {
      const unit = config.experiments?.[experimentId]?.assignmentUnit;
      return unit === undefined ? [] : [unit];
    }));
    if (assignmentUnits.size > 1) errors.push(`Mutual exclusion group "${groupId}" mixes user and team assignment units`);
  }
  const prerequisiteGraph = new Map(Object.entries(config.flags ?? {}).map(([flagId, flag]) => [
    flagId,
    Object.values(flag?.prerequisites ?? {}).flatMap((prerequisite) => prerequisite?.flagId === undefined ? [] : [prerequisite.flagId]),
  ]));
  const prerequisiteCycle = findGraphCycle(prerequisiteGraph);
  if (prerequisiteCycle !== undefined) errors.push(`Feature flag prerequisites contain a cycle: ${prerequisiteCycle.join(" -> ")}`);

  const segmentGraph = new Map(Object.entries(config.segments ?? {}).map(([segmentId, segment]) => [
    segmentId,
    Object.values(segment?.conditions ?? {}).flatMap((condition) => (condition?.operator === "in_segment" || condition?.operator === "not_in_segment") && typeof condition.value === "string" ? [condition.value] : []),
  ]));
  const segmentCycle = findGraphCycle(segmentGraph);
  if (segmentCycle !== undefined) errors.push(`Feature flag segments contain a cycle: ${segmentCycle.join(" -> ")}`);
  return errors;
}

function isFeatureFlagsConfig(value: unknown): value is FeatureFlagsConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  for (const key of ["flags", "segments", "holdouts", "mutualExclusionGroups", "experiments"]) {
    const entry = Object.entries(value).find(([entryKey]) => entryKey === key)?.[1];
    if (entry !== undefined && (entry === null || typeof entry !== "object" || Array.isArray(entry))) return false;
  }
  return true;
}

export function parseFeatureFlagsConfig(value: unknown): FeatureFlagsConfig {
  if (!isFeatureFlagsConfig(value)) throw new HexclaveAssertionError("Feature flags config was not validated as a record");
  return value;
}

function getSchemaCrossReferenceErrors(value: unknown): string[] {
  // Yup runs object-level tests for absent optional subtrees too. Shape/type
  // errors are handled by the object schema; cross-reference validation only
  // applies once the value has the expected record shape.
  return isFeatureFlagsConfig(value) ? getFeatureFlagsConfigErrors(value) : [];
}

export const featureFlagsConfigSchema = yupObject({
  flags: yupRecord(configIdSchema, flagSchema),
  segments: yupRecord(configIdSchema, segmentSchema),
  holdouts: yupRecord(configIdSchema, holdoutSchema),
  mutualExclusionGroups: yupRecord(configIdSchema, mutualExclusionGroupSchema),
  experiments: yupRecord(configIdSchema, experimentSchema),
}).test("feature-flags-cross-references", "Feature flag definitions contain invalid references", function (value) {
  const errors = getSchemaCrossReferenceErrors(value);
  return errors.length === 0 || this.createError({ message: errors.join("\n") });
});

import.meta.vitest?.test("feature flag schema validates operator types, references, and basis points", async ({ expect }) => {
  await expect(featureFlagsConfigSchema.validate({
    flags: { flag: { key: "checkout", type: "boolean", allocationSalt: "checkout", variants: { on: { value: true }, off: { value: false } }, fallbackVariantKey: "off", rules: { all: { variantWeights: { on: 5_000, off: 5_000 } } } } },
  }, { strict: true })).resolves.toBeDefined();
  await expect(conditionSchema.validate({ attribute: "user.plan", operator: "not_in", value: "pro" }, { strict: true })).rejects.toThrow("Condition value does not match its operator");
  await expect(conditionSchema.validate({ attribute: "context.version", operator: "semver_gt", value: "1.0.0-01" }, { strict: true })).rejects.toThrow("Condition value does not match its operator");
  await expect(conditionSchema.validate({ attribute: "context.timestamp", operator: "before", value: "2026-02-30T00:00:00Z" }, { strict: true })).rejects.toThrow("Condition value does not match its operator");
  expect(getFeatureFlagsConfigErrors({ flags: { flag: { fallbackVariantKey: "missing", variants: {} } } })).toContain('Feature flag "flag" references missing fallback variant "missing"');
  expect(getFeatureFlagsConfigErrors({ flags: { flag: { variants: { on: { value: true } }, rules: { all: { variantWeights: { on: 9_999 } } } } } })).toContain('Rule "all" variant weights must total 10000 basis points');
  expect(getFeatureFlagsConfigErrors({ flags: { a: { prerequisites: { b: { flagId: "b" } } }, b: { prerequisites: { a: { flagId: "a" } } } } })).toContain("Feature flag prerequisites contain a cycle: a -> b -> a");
  expect(getFeatureFlagsConfigErrors({
    flags: { a: {}, b: {} },
    experiments: { userExperiment: { flagId: "a", assignmentUnit: "user" }, teamExperiment: { flagId: "b", assignmentUnit: "team" } },
    mutualExclusionGroups: { mixed: { experimentWeights: { userExperiment: 5_000, teamExperiment: 5_000 } } },
  })).toContain('Mutual exclusion group "mixed" mixes user and team assignment units');
  expect(getFeatureFlagsConfigErrors({
    flags: { shared: {} },
    experiments: { first: { flagId: "shared" }, second: { flagId: "shared" } },
  })).toContain('Experiment "second" targets flag "shared" which is already targeted by "first"');
  expect(getFeatureFlagsConfigErrors({
    flags: { shared: {} },
    experiments: { archived: { flagId: "shared", archived: true }, next: { flagId: "shared" } },
  }).some((error) => error.includes("already targeted"))).toBe(false);
  expect(getFeatureFlagsConfigErrors({
    flags: {
      flag: {
        key: "checkout",
        type: "boolean",
        allocationSalt: "checkout",
        fallbackVariantKey: "off",
        variants: { on: { value: true }, off: { value: false } },
        rules: { experiment: { variantWeights: { on: 5_000, off: 5_000 }, variantValues: { on: "on" } } },
      },
    },
  })).toContain('Rule "experiment" variantValues "on" must have a boolean value');
});

import.meta.vitest?.test("whole-config validation rejects incomplete experiment definitions", ({ expect }) => {
  const flag: FeatureFlagDefinition = {
    key: "checkout", type: "boolean", allocationSalt: "checkout-allocation",
    variants: { control: { value: false }, treatment: { value: true } }, fallbackVariantKey: "control",
  };
  const validExperiment: FeatureFlagExperiment = {
    key: "checkout-copy", hypothesis: "The new copy increases checkout completion", flagId: "checkout",
    assignmentUnit: "user", trafficAllocationBasisPoints: 10_000,
    controlVariantKey: "control", variantWeights: { control: 5_000, treatment: 5_000 },
    primaryMetric: {
      id: "completed", type: "custom_event", direction: "increase",
      eventName: "checkout-completed", attributionWindowSeconds: 86_400,
    },
  };
  expect(getFeatureFlagsConfigErrors({ flags: { checkout: flag }, experiments: { checkoutExperiment: validExperiment } })).toEqual([]);
  expect(getFeatureFlagsConfigErrors({
    flags: {
      checkout: flag,
      other: {
        key: "other", type: "boolean", allocationSalt: "other-allocation", fallbackVariantKey: "off",
        variants: { on: { value: true }, off: { value: false } },
        rules: { experiment: { experimentId: "checkoutExperiment", variantKey: "on" } },
      },
    },
    experiments: { checkoutExperiment: validExperiment },
  })).toContain('Rule "experiment" on feature flag "other" references experiment "checkoutExperiment" for a different flag');

  expect(getFeatureFlagsConfigErrors({ flags: { checkout: flag }, experiments: { incomplete: {} } })).toEqual(expect.arrayContaining([
    'Experiment "incomplete" must define a public key',
    'Experiment "incomplete" must define a hypothesis',
    'Experiment "incomplete" must reference a flag',
    'Experiment "incomplete" must define an assignment unit',
    'Experiment "incomplete" must define a traffic allocation',
    'Experiment "incomplete" must define a control variant',
    'Metric "primaryMetric" on experiment "incomplete" is required',
  ]));

  expect(getFeatureFlagsConfigErrors({
    flags: { checkout: flag },
    experiments: {
      checkoutExperiment: {
        ...validExperiment,
        startsAt: "2026-07-20T00:00:00Z",
        endsAt: "2026-07-19T00:00:00Z",
        secondaryMetrics: {
          value: {
            id: "completed", type: "numeric_value", direction: "increase", eventName: "checkout-completed",
            numericProperty: "total", numericAggregation: "sum", attributionWindowSeconds: 3_600,
          },
        },
      },
    },
  })).toEqual(expect.arrayContaining([
    'Experiment "checkoutExperiment" metric id "completed" is duplicated',
    'Experiment "checkoutExperiment" metrics must use the same attribution window',
    'Experiment "checkoutExperiment" end must be after its start',
  ]));
});

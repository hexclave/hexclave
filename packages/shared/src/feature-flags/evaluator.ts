import { chooseFeatureFlagVariant, featureFlagBucket } from "./hashing";
import type {
  FeatureFlagCondition,
  FeatureFlagConditionOperator,
  FeatureFlagDefinition,
  FeatureFlagEvaluationContext,
  FeatureFlagEvaluationResult,
  FeatureFlagsConfig,
  FeatureFlagValue,
} from "./types";

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function getOwnDottedValue(root: FeatureFlagEvaluationContext, path: string): unknown {
  if (path.length === 0) return undefined;
  let cursor: unknown = root;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    const entry = Object.entries(cursor).find(([key]) => key === part);
    if (entry === undefined) return undefined;
    cursor = entry[1];
  }
  return cursor;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEquals(value, right[index]));
  }
  const leftEntries = Object.entries(left).sort(([a], [b]) => lexicalCompare(a, b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => lexicalCompare(a, b));
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value], index) => {
    const rightEntry = rightEntries[index];
    return key === rightEntry[0] && jsonEquals(value, rightEntry[1]);
  });
}

function parseStrictUtcTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    ? `${value.slice(0, -1)}.000Z`
    : value;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(normalized);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) return undefined;
  return date.getTime();
}

export function isStrictUtcTimestamp(value: string): boolean {
  return parseStrictUtcTimestamp(value) !== undefined;
}

type ParsedSemver = {
  core: readonly [string, string, string],
  prerelease?: readonly string[],
};

function parseSemver(value: string): ParsedSemver | undefined {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return undefined;
  const withoutBuild = value.split("+")[0];
  const dashIndex = withoutBuild.indexOf("-");
  const coreText = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex);
  const prereleaseText = dashIndex === -1 ? undefined : withoutBuild.slice(dashIndex + 1);
  const core = coreText.split(".");
  const prerelease = prereleaseText === undefined ? undefined : prereleaseText.split(".");
  if (prereleaseText !== undefined && prereleaseText.split(".").some((part) => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))) return undefined;
  return {
    core: [core[0], core[1], core[2]],
    ...(prerelease === undefined ? {} : { prerelease: prerelease }),
  };
}

export function isStrictSemver(value: string): boolean {
  return parseSemver(value) !== undefined;
}

function compareSemver(left: string, right: string): number | undefined {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (parsedLeft === undefined || parsedRight === undefined) return undefined;
  for (let index = 0; index < 3; index++) {
    const leftPart = parsedLeft.core[index];
    const rightPart = parsedRight.core[index];
    if (leftPart !== rightPart) return leftPart.length - rightPart.length || lexicalCompare(leftPart, rightPart);
  }
  if (parsedLeft.prerelease === undefined && parsedRight.prerelease === undefined) return 0;
  if (parsedLeft.prerelease === undefined) return 1;
  if (parsedRight.prerelease === undefined) return -1;
  const length = Math.min(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === rightPart) continue;
    const leftIsNumeric = /^\d+$/.test(leftPart);
    const rightIsNumeric = /^\d+$/.test(rightPart);
    if (leftIsNumeric && rightIsNumeric) return leftPart.length - rightPart.length || lexicalCompare(leftPart, rightPart);
    if (leftIsNumeric) return -1;
    if (rightIsNumeric) return 1;
    return lexicalCompare(leftPart, rightPart);
  }
  return parsedLeft.prerelease.length - parsedRight.prerelease.length;
}

function conditionMatches(
  condition: FeatureFlagCondition,
  config: FeatureFlagsConfig,
  context: FeatureFlagEvaluationContext,
  segmentStack: ReadonlySet<string>,
): boolean {
  const operator = condition.operator;
  const attribute = condition.attribute;
  if (operator === undefined || attribute === undefined) return false;
  const actual = getOwnDottedValue(context, attribute);
  const expected = condition.value;
  return applyOperator(operator, actual, expected, config, context, segmentStack);
}

function applyOperator(
  operator: FeatureFlagConditionOperator,
  actual: unknown,
  expected: unknown,
  config: FeatureFlagsConfig,
  context: FeatureFlagEvaluationContext,
  segmentStack: ReadonlySet<string>,
): boolean {
  if (operator !== "is_set" && operator !== "is_not_set" && expected === undefined) return false;
  switch (operator) {
    case "eq": { return jsonEquals(actual, expected); }
    case "neq": { return actual !== undefined && !jsonEquals(actual, expected); }
    case "in": { return Array.isArray(expected) && expected.some((value) => jsonEquals(actual, value)); }
    // Invalid negative predicates fail closed instead of accidentally targeting everyone.
    case "not_in": { return actual !== undefined && Array.isArray(expected) && !expected.some((value) => jsonEquals(actual, value)); }
    case "starts_with": { return typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected); }
    case "ends_with": { return typeof actual === "string" && typeof expected === "string" && actual.endsWith(expected); }
    case "contains": {
      if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
      return Array.isArray(actual) && actual.some((value) => jsonEquals(value, expected));
    }
    case "not_contains": {
      if (typeof actual === "string" && typeof expected === "string") return !actual.includes(expected);
      return Array.isArray(actual) && !actual.some((value) => jsonEquals(value, expected));
    }
    case "gt": { return typeof actual === "number" && typeof expected === "number" && actual > expected; }
    case "gte": { return typeof actual === "number" && typeof expected === "number" && actual >= expected; }
    case "lt": { return typeof actual === "number" && typeof expected === "number" && actual < expected; }
    case "lte": { return typeof actual === "number" && typeof expected === "number" && actual <= expected; }
    case "is_set": { return actual !== undefined && actual !== null && expected === undefined; }
    case "is_not_set": { return (actual === undefined || actual === null) && expected === undefined; }
    case "before": {
      const actualTime = parseStrictUtcTimestamp(actual);
      const expectedTime = parseStrictUtcTimestamp(expected);
      return actualTime !== undefined && expectedTime !== undefined && actualTime < expectedTime;
    }
    case "after": {
      const actualTime = parseStrictUtcTimestamp(actual);
      const expectedTime = parseStrictUtcTimestamp(expected);
      return actualTime !== undefined && expectedTime !== undefined && actualTime > expectedTime;
    }
    case "semver_eq":
    case "semver_gt":
    case "semver_gte":
    case "semver_lt":
    case "semver_lte": {
      if (typeof actual !== "string" || typeof expected !== "string") return false;
      const comparison = compareSemver(actual, expected);
      if (comparison === undefined) return false;
      if (operator === "semver_eq") return comparison === 0;
      if (operator === "semver_gt") return comparison > 0;
      if (operator === "semver_gte") return comparison >= 0;
      if (operator === "semver_lt") return comparison < 0;
      return comparison <= 0;
    }
    case "in_segment":
    case "not_in_segment": {
      if (typeof expected !== "string") return false;
      if (context.segments?.has(expected) === true) return operator === "in_segment";
      if (segmentStack.has(expected)) return false;
      const segment = config.segments?.[expected];
      if (segment === undefined) return false;
      const nextStack = new Set(segmentStack);
      nextStack.add(expected);
      const conditions = Object.values(segment.conditions ?? {}).filter((value) => value !== undefined);
      if (conditions.length === 0) return false;
      const matches = segment.match === "any"
        ? conditions.some((value) => conditionMatches(value, config, context, nextStack))
        : conditions.every((value) => conditionMatches(value, config, context, nextStack));
      return operator === "in_segment" ? matches : !matches;
    }
  }
}

function getStickySubject(rule: { stickyBy?: "distinctId" | "userId" | "teamId" }, context: FeatureFlagEvaluationContext): string | undefined {
  switch (rule.stickyBy) {
    case "userId": { return context.userId; }
    case "teamId": { return context.teamId; }
    case "distinctId":
    case undefined: { return context.distinctId ?? context.userId; }
  }
}

function variantValue(flag: FeatureFlagDefinition, variantKey: string | undefined): FeatureFlagValue | undefined {
  return variantKey === undefined ? undefined : flag.variants?.[variantKey]?.value;
}

function defaultResult(
  flagId: string,
  flag: FeatureFlagDefinition,
  reason: FeatureFlagEvaluationResult["reason"],
): FeatureFlagEvaluationResult {
  return {
    flagId,
    flagKey: flag.key ?? flagId,
    variantKey: flag.fallbackVariantKey,
    value: variantValue(flag, flag.fallbackVariantKey),
    reason,
  };
}

function selectedMutualExclusionExperiment(
  groupId: string,
  config: FeatureFlagsConfig,
  context: FeatureFlagEvaluationContext,
): string | undefined {
  const group = config.mutualExclusionGroups?.[groupId];
  if (group === undefined) return undefined;
  const assignmentUnits = new Set(Object.keys(group.experimentWeights ?? {}).flatMap((experimentId) => {
    const unit = config.experiments?.[experimentId]?.assignmentUnit;
    return unit === undefined ? [] : [unit];
  }));
  if (assignmentUnits.size !== 1) return undefined;
  const assignmentUnit = assignmentUnits.values().next().value;
  const subjectId = assignmentUnit === "team" ? context.teamId : context.distinctId ?? context.userId;
  if (subjectId === undefined) return undefined;
  const weights = Object.entries(group.experimentWeights ?? {})
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .sort(([left], [right]) => lexicalCompare(left, right))
    .map(([key, weight]) => ({ key, weight }));
  return chooseFeatureFlagVariant(subjectId, `mutex.${groupId}.${group.allocationSalt ?? groupId}`, weights);
}

function getFlagAllocationSubject(flag: FeatureFlagDefinition, config: FeatureFlagsConfig, context: FeatureFlagEvaluationContext): string | undefined {
  const experimentIds = Object.values(flag.rules ?? {}).flatMap((rule) => rule?.experimentId === undefined ? [] : [rule.experimentId]);
  const assignmentUnits = new Set(experimentIds.flatMap((experimentId) => {
    const unit = config.experiments?.[experimentId]?.assignmentUnit;
    return unit === undefined ? [] : [unit];
  }));
  if (assignmentUnits.size > 1) return undefined;
  return assignmentUnits.values().next().value === "team" ? context.teamId : context.distinctId ?? context.userId;
}

export type EvaluateFeatureFlagOptions = {
  seenFlagIds?: ReadonlySet<string>,
  ignoreExperimentAssignments?: boolean,
};

export function evaluateFeatureFlag(
  flagId: string,
  config: FeatureFlagsConfig,
  context: FeatureFlagEvaluationContext,
  options: EvaluateFeatureFlagOptions = {},
): FeatureFlagEvaluationResult {
  const seenFlagIds = options.seenFlagIds ?? new Set<string>();
  const ignoreExperimentAssignments = options.ignoreExperimentAssignments === true;
  const flag = config.flags?.[flagId];
  if (flag === undefined) return { flagId, flagKey: flagId, reason: "missing" };
  if (seenFlagIds.has(flagId)) return defaultResult(flagId, flag, "dependency_cycle");
  if (flag.archived === true) return defaultResult(flagId, flag, "archived");
  if (flag.killed === true) return defaultResult(flagId, flag, "killed");
  if (flag.enabled === false) return defaultResult(flagId, flag, "disabled");

  const nextSeen = new Set(seenFlagIds);
  nextSeen.add(flagId);
  for (const prerequisite of Object.values(flag.prerequisites ?? {})) {
    if (prerequisite === undefined || prerequisite.flagId === undefined) return defaultResult(flagId, flag, "prerequisite_unmet");
    const evaluated = evaluateFeatureFlag(prerequisite.flagId, config, context, {
      seenFlagIds: nextSeen,
      ignoreExperimentAssignments,
    });
    if (evaluated.reason === "dependency_cycle") return defaultResult(flagId, flag, "dependency_cycle");
    if (evaluated.variantKey === undefined || prerequisite.variantKeys?.[evaluated.variantKey] !== true) {
      return defaultResult(flagId, flag, "prerequisite_unmet");
    }
  }

  if (flag.holdoutId !== undefined) {
    const holdout = config.holdouts?.[flag.holdoutId];
    if (holdout !== undefined) {
      const subjectId = getFlagAllocationSubject(flag, config, context);
      // Mixed assignment units (or a missing subject) cannot compute a stable
      // holdout bucket. Fail closed to the fallback rather than letting those
      // subjects skip the holdout and enter targeting.
      if (subjectId === undefined) return defaultResult(flagId, flag, "holdout");
      const allocation = holdout.allocationBasisPoints ?? 0;
      if (featureFlagBucket(subjectId, `holdout.${flag.holdoutId}.${holdout.allocationSalt ?? flag.holdoutId}`) * 10_000 < allocation) {
        return defaultResult(flagId, flag, "holdout");
      }
    }
  }

  const selectedExperimentId = flag.mutualExclusionGroupId === undefined
    ? undefined
    : selectedMutualExclusionExperiment(flag.mutualExclusionGroupId, config, context);
  if (flag.mutualExclusionGroupId !== undefined && (selectedExperimentId === undefined || config.experiments?.[selectedExperimentId]?.flagId !== flagId)) return defaultResult(flagId, flag, "mutual_exclusion");

  const rules = Object.entries(flag.rules ?? {})
    .filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== undefined)
    .sort(([leftId, left], [rightId, right]) => (right.priority ?? 0) - (left.priority ?? 0) || lexicalCompare(leftId, rightId));
  for (const [ruleId, rule] of rules) {
    if (rule.enabled === false) continue;
    // Stale server bootstrap still contains overlay rules, but those
    // assignments cannot mint exposure tokens. Skip them so unauditable
    // experiment traffic is not served from a snapshot that may also be
    // paused or completed on the backend.
    if (ignoreExperimentAssignments && rule.experimentRunId !== undefined) continue;
    if (selectedExperimentId !== undefined && rule.experimentId !== undefined && rule.experimentId !== selectedExperimentId) continue;
    const conditions = Object.values(rule.conditions ?? {}).filter((condition) => condition !== undefined);
    if (!conditions.every((condition) => conditionMatches(condition, config, context, new Set()))) continue;
    const subjectId = getStickySubject(rule, context);
    const rolloutBasisPoints = rule.rolloutBasisPoints ?? 10_000;
    if (subjectId === undefined || rolloutBasisPoints <= 0) continue;
    const ruleSalt = `${flag.allocationSalt ?? flagId}.${ruleId}.${rule.allocationSalt ?? ruleId}`;
    if (featureFlagBucket(subjectId, `rollout.${flagId}.${ruleSalt}`) * 10_000 >= rolloutBasisPoints) continue;

    const weightedVariants = Object.entries(rule.variantWeights ?? {})
      .filter((entry): entry is [string, number] => entry[1] !== undefined)
      .sort(([left], [right]) => lexicalCompare(left, right))
      .map(([key, weight]) => ({ key, weight }));
    const variantKey = weightedVariants.length === 0
      ? rule.variantKey
      : chooseFeatureFlagVariant(subjectId, `variant.${flagId}.${ruleSalt}`, weightedVariants);
    if (variantKey === undefined || flag.variants?.[variantKey] === undefined) continue;
    const override = rule.variantValues?.[variantKey];
    return {
      flagId,
      flagKey: flag.key ?? flagId,
      variantKey,
      value: override !== undefined ? override : variantValue(flag, variantKey),
      reason: "matched_rule",
      ruleId,
      ...(rule.experimentId === undefined ? {} : { experimentId: rule.experimentId }),
      ...(rule.experimentRunId === undefined ? {} : { experimentRunId: rule.experimentRunId }),
      ...(rule.experimentConfigRevision === undefined ? {} : { experimentConfigRevision: rule.experimentConfigRevision }),
    };
  }

  return defaultResult(flagId, flag, "fallback");
}

export function evaluateFeatureFlags(
  config: FeatureFlagsConfig,
  context: FeatureFlagEvaluationContext,
  flagIds: readonly string[] = Object.keys(config.flags ?? {}),
  options: EvaluateFeatureFlagOptions = {},
): Map<string, FeatureFlagEvaluationResult> {
  return new Map(flagIds.map((flagId) => [flagId, evaluateFeatureFlag(flagId, config, context, options)]));
}

export function findFeatureFlagIdByKey(config: FeatureFlagsConfig, key: string): string | undefined {
  return Object.entries(config.flags ?? {}).find(([, flag]) => flag?.key === key)?.[0];
}

import.meta.vitest?.test("operators are strict, own-property-only, and negative predicates fail closed", ({ expect }) => {
  const makeConfig = (condition: FeatureFlagCondition): FeatureFlagsConfig => ({
    flags: {
      flag: {
        key: "test", enabled: true, fallbackVariantKey: "off", allocationSalt: "stable",
        variants: { on: { value: true }, off: { value: false } },
        rules: { match: { conditions: { condition }, variantKey: "on" } },
      },
    },
  });
  expect(evaluateFeatureFlag("flag", makeConfig({ attribute: "user.plan", operator: "not_in", value: "bad" }), { distinctId: "u", user: { plan: "pro" } }).value).toBe(false);
  expect(evaluateFeatureFlag("flag", makeConfig({ attribute: "user.missing", operator: "neq", value: "enterprise" }), { distinctId: "u", user: {} }).value).toBe(false);
  expect(evaluateFeatureFlag("flag", makeConfig({ attribute: "user.missing", operator: "not_in", value: ["enterprise"] }), { distinctId: "u", user: {} }).value).toBe(false);
  expect(evaluateFeatureFlag("flag", makeConfig({ attribute: "user.missing", operator: "eq" }), { distinctId: "u", user: {} }).value).toBe(false);
  expect(evaluateFeatureFlag("flag", makeConfig({ attribute: "user.toString", operator: "is_set" }), { distinctId: "u", user: {} }).value).toBe(false);
  expect(evaluateFeatureFlag("flag", makeConfig({ attribute: "user.date", operator: "before", value: "2026-01-02T00:00:00Z" }), { distinctId: "u", user: { date: "2026-01-01T00:00:00Z" } }).value).toBe(true);
  expect(evaluateFeatureFlag("flag", makeConfig({ attribute: "user.date", operator: "before", value: "2026-01-02" }), { distinctId: "u", user: { date: "2026-01-01" } }).value).toBe(false);
  expect(evaluateFeatureFlag("flag", makeConfig({ attribute: "context.version", operator: "semver_gt", value: "1.0.0" }), { distinctId: "u", context: { version: "1.0.1" } }).value).toBe(true);
  expect(evaluateFeatureFlag("flag", makeConfig({ attribute: "context.version", operator: "semver_gt", value: "1.0" }), { distinctId: "u", context: { version: "1.0.1" } }).value).toBe(false);
});

import.meta.vitest?.test("every supported typed operator evaluates without coercion", ({ expect }) => {
  const matches = (condition: FeatureFlagCondition, actual: FeatureFlagValue | undefined, configExtension: FeatureFlagsConfig = {}) => {
    const config: FeatureFlagsConfig = {
      ...configExtension,
      flags: {
        flag: {
          key: "operator", enabled: true, fallbackVariantKey: "off", allocationSalt: "operator",
          variants: { on: { value: true }, off: { value: false } },
          rules: { match: { conditions: { condition }, variantKey: "on" } },
        },
      },
    };
    return evaluateFeatureFlag("flag", config, { distinctId: "u", context: actual === undefined ? {} : { actual } }).value;
  };
  const condition = (operator: FeatureFlagConditionOperator, value?: FeatureFlagValue): FeatureFlagCondition => ({ attribute: "context.actual", operator, ...(value === undefined ? {} : { value }) });
  expect(matches(condition("eq", "pro"), "pro")).toBe(true);
  expect(matches(condition("neq", "free"), "pro")).toBe(true);
  expect(matches(condition("in", ["pro", "enterprise"]), "pro")).toBe(true);
  expect(matches(condition("not_in", ["free"]), "pro")).toBe(true);
  expect(matches(condition("starts_with", "pro"), "pro-plan")).toBe(true);
  expect(matches(condition("ends_with", "plan"), "pro-plan")).toBe(true);
  expect(matches(condition("contains", "-"), "pro-plan")).toBe(true);
  expect(matches(condition("not_contains", "free"), "pro-plan")).toBe(true);
  expect(matches(condition("gt", 3), 4)).toBe(true);
  expect(matches(condition("gte", 4), 4)).toBe(true);
  expect(matches(condition("lt", 5), 4)).toBe(true);
  expect(matches(condition("lte", 4), 4)).toBe(true);
  expect(matches(condition("is_set"), false)).toBe(true);
  expect(matches(condition("is_not_set"), undefined)).toBe(true);
  expect(matches(condition("after", "2026-01-01T00:00:00Z"), "2026-01-02T00:00:00.000Z")).toBe(true);
  expect(matches(condition("semver_eq", "1.0.0+left"), "1.0.0+right")).toBe(true);
  expect(matches(condition("semver_lt", "2.0.0"), "2.0.0-alpha.1")).toBe(true);
  expect(matches(condition("semver_gt", "9007199254740992.0.0"), "9007199254740993.0.0")).toBe(true);
  expect(matches(condition("semver_gt", "1.0.0-9007199254740992"), "1.0.0-9007199254740993")).toBe(true);
  expect(matches(condition("in_segment", "paid"), "ignored", { segments: { paid: { conditions: { plan: { attribute: "context.actual", operator: "eq", value: "ignored" } } } } })).toBe(true);
  expect(matches(condition("gt", 3), "4")).toBe(false);
});

import.meta.vitest?.test("priority, prerequisites, cycles, holdouts, and mutual exclusion are deterministic", ({ expect }) => {
  const config: FeatureFlagsConfig = {
    flags: {
      gate: { key: "gate", enabled: true, fallbackVariantKey: "off", variants: { on: { value: true }, off: { value: false } }, rules: { all: { variantKey: "on" } } },
      child: {
        key: "child", enabled: true, fallbackVariantKey: "off", allocationSalt: "child",
        variants: { high: { value: "high" }, low: { value: "low" }, off: { value: "off" } },
        prerequisites: { gate: { flagId: "gate", variantKeys: { on: true } } },
        rules: { low: { priority: 1, variantKey: "low" }, high: { priority: 10, variantKey: "high" } },
      },
      cycleA: { key: "a", fallbackVariantKey: "off", variants: { off: { value: false } }, prerequisites: { b: { flagId: "cycleB", variantKeys: { on: true } } } },
      cycleB: { key: "b", fallbackVariantKey: "on", variants: { on: { value: true } }, prerequisites: { a: { flagId: "cycleA", variantKeys: { off: true } } } },
      held: { key: "held", fallbackVariantKey: "off", holdoutId: "all", variants: { on: { value: true }, off: { value: false } }, rules: { all: { variantKey: "on" } } },
    },
    holdouts: { all: { allocationBasisPoints: 10_000 } },
  };
  expect(evaluateFeatureFlag("child", config, { distinctId: "stable" })).toMatchObject({ variantKey: "high", reason: "matched_rule", ruleId: "high" });
  expect(evaluateFeatureFlag("cycleA", config, { distinctId: "stable" }).reason).toBe("dependency_cycle");
  expect(evaluateFeatureFlag("held", config, { distinctId: "stable" }).reason).toBe("holdout");
  expect(evaluateFeatureFlag("child", config, { distinctId: "stable" })).toEqual(evaluateFeatureFlag("child", config, { distinctId: "stable" }));

  const mutuallyExclusive: FeatureFlagsConfig = {
    flags: {
      first: { key: "first", fallbackVariantKey: "off", mutualExclusionGroupId: "group", variants: { on: { value: true }, off: { value: false } }, rules: { experiment: { experimentId: "firstExperiment", variantKey: "on" } } },
      second: { key: "second", fallbackVariantKey: "off", mutualExclusionGroupId: "group", variants: { on: { value: true }, off: { value: false } }, rules: { experiment: { experimentId: "secondExperiment", variantKey: "on" } } },
    },
    experiments: {
      firstExperiment: { flagId: "first", assignmentUnit: "user" },
      secondExperiment: { flagId: "second", assignmentUnit: "user" },
    },
    mutualExclusionGroups: { group: { experimentWeights: { firstExperiment: 5_000, secondExperiment: 5_000 } } },
  };
  const first = evaluateFeatureFlag("first", mutuallyExclusive, { distinctId: "one-subject" });
  const second = evaluateFeatureFlag("second", mutuallyExclusive, { distinctId: "one-subject" });
  expect([first.reason, second.reason].filter((reason) => reason === "matched_rule")).toHaveLength(1);
  expect([first.reason, second.reason].filter((reason) => reason === "mutual_exclusion")).toHaveLength(1);
});

import.meta.vitest?.test("team experiments use the team for holdout and mutual-exclusion allocation", ({ expect }) => {
  const config: FeatureFlagsConfig = {
    flags: {
      first: {
        key: "first", fallbackVariantKey: "off", holdoutId: "holdout", mutualExclusionGroupId: "group",
        variants: { on: { value: true }, off: { value: false } },
        rules: { experiment: { experimentId: "firstExperiment", stickyBy: "teamId", variantKey: "on" } },
      },
      second: {
        key: "second", fallbackVariantKey: "off", mutualExclusionGroupId: "group",
        variants: { on: { value: true }, off: { value: false } },
        rules: { experiment: { experimentId: "secondExperiment", stickyBy: "teamId", variantKey: "on" } },
      },
    },
    holdouts: { holdout: { allocationBasisPoints: 5_000, allocationSalt: "team-holdout" } },
    experiments: {
      firstExperiment: { flagId: "first", assignmentUnit: "team" },
      secondExperiment: { flagId: "second", assignmentUnit: "team" },
    },
    mutualExclusionGroups: { group: { allocationSalt: "team-mutex", experimentWeights: { firstExperiment: 5_000, secondExperiment: 5_000 } } },
  };
  const firstUser = { distinctId: "user-a", userId: "user-a", teamId: "shared-team" };
  const secondUser = { distinctId: "user-b", userId: "user-b", teamId: "shared-team" };
  expect(evaluateFeatureFlag("first", config, firstUser)).toEqual(evaluateFeatureFlag("first", config, secondUser));
  expect(evaluateFeatureFlag("second", config, firstUser)).toEqual(evaluateFeatureFlag("second", config, secondUser));
});

import.meta.vitest?.test("holdout fails closed when mixed assignment units make the subject unresolvable", ({ expect }) => {
  const config: FeatureFlagsConfig = {
    flags: {
      mixed: {
        key: "mixed",
        fallbackVariantKey: "off",
        holdoutId: "holdout",
        variants: { on: { value: true }, off: { value: false } },
        rules: {
          userRule: { experimentId: "userExperiment", stickyBy: "userId", variantKey: "on" },
          teamRule: { experimentId: "teamExperiment", stickyBy: "teamId", variantKey: "on" },
        },
      },
    },
    holdouts: { holdout: { allocationBasisPoints: 5_000 } },
    experiments: {
      userExperiment: { flagId: "mixed", assignmentUnit: "user" },
      teamExperiment: { flagId: "mixed", assignmentUnit: "team" },
    },
  };
  expect(evaluateFeatureFlag("mixed", config, { distinctId: "user-a", userId: "user-a", teamId: "team-a" }).reason).toBe("holdout");
});

import.meta.vitest?.test("rule-local variantValues apply only to the matching experiment rule", ({ expect }) => {
  const config: FeatureFlagsConfig = {
    flags: {
      copy: {
        key: "copy",
        enabled: true,
        fallbackVariantKey: "control",
        allocationSalt: "copy",
        variants: { control: { value: "published-control" }, treatment: { value: "published-treatment" } },
        rules: {
          experiment: {
            priority: 2_000_000,
            variantWeights: { control: 5_000, treatment: 5_000 },
            variantValues: { control: "frozen-control", treatment: "frozen-treatment" },
            experimentId: "copyExperiment",
            experimentRunId: "run-1",
            stickyBy: "userId",
          },
          everyone: { priority: 1, variantKey: "treatment" },
        },
      },
    },
    experiments: {
      copyExperiment: { flagId: "copy", assignmentUnit: "user" },
    },
  };
  const inExperiment = evaluateFeatureFlag("copy", config, { distinctId: "user-a", userId: "user-a" });
  expect(inExperiment.reason).toBe("matched_rule");
  expect(inExperiment.ruleId).toBe("experiment");
  expect(["frozen-control", "frozen-treatment"]).toContain(inExperiment.value);

  const ignored = evaluateFeatureFlag("copy", config, { distinctId: "user-a", userId: "user-a" }, { ignoreExperimentAssignments: true });
  expect(ignored).toMatchObject({ reason: "matched_rule", ruleId: "everyone", value: "published-treatment" });
  expect(ignored.experimentRunId).toBeUndefined();
});

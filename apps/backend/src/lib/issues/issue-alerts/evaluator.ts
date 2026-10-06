import { utf8ByteLength } from "@/lib/utf8";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { createHash } from "node:crypto";
import {
  ISSUE_ALERT_RULE_SCHEMA_VERSION,
  type IssueAlertConditionGroup,
  type IssueAlertCooldown,
  type IssueAlertDrop,
  type IssueAlertEvaluation,
  type IssueAlertEventKind,
  type IssueAlertFrequencyOperator,
  type IssueAlertLevel,
  type IssueAlertLevelOperator,
  type IssueAlertMatch,
  type IssueAlertNoMatch,
  type IssueAlertNoMatchReason,
  type IssueAlertPredicate,
  type IssueAlertRule,
  type IssueAlertScalar,
  type IssueAlertSignal,
  type IssueAlertStatus,
  type IssueAlertTagFilter,
  type IssueAlertValueOperator,
} from "./types";
import { describeIssueAlertDestination, isIssueAlertAction } from "./destinations";

const MAX_RULE_ID_BYTES = 128;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_FILTER_VALUES = 64;
const MAX_TAG_FILTERS = 32;
const MAX_PREDICATES = 64;
const MAX_RECIPIENTS = 64;
const MAX_COOLDOWN_SECONDS = 30 * 24 * 60 * 60;
const MAX_FREQUENCY_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const MAX_FREQUENCY_COUNT = 1_000_000_000;

const ISSUE_ALERT_STATUSES: readonly IssueAlertStatus[] = ["unresolved", "resolved", "ignored"];
const ISSUE_ALERT_COOLDOWN_SCOPES: readonly IssueAlertCooldown["keyBy"][] = [
  "issue",
  "issue_environment",
  "issue_release",
  "issue_environment_release",
];
const ISSUE_ALERT_VALUE_OPERATORS: readonly IssueAlertValueOperator[] = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "in",
  "exists",
  "not_exists",
];
const ISSUE_ALERT_FREQUENCY_OPERATORS: readonly IssueAlertFrequencyOperator[] = ["gt", "gte", "lt", "lte", "eq"];
const ISSUE_ALERT_LEVELS: readonly IssueAlertLevel[] = ["trace", "debug", "info", "warn", "error"];
const ISSUE_ALERT_LEVEL_OPERATORS: readonly IssueAlertLevelOperator[] = ["equals", "gte", "lte"];
const ISSUE_ALERT_LEVEL_SEVERITY = new Map<IssueAlertLevel, number>([
  ["trace", 0],
  ["debug", 1],
  ["info", 2],
  ["warn", 3],
  ["error", 4],
]);
const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f]/u;

type PredicateResult =
  | { matched: true }
  | { matched: false, reason: IssueAlertNoMatchReason };

type RuleValidationResult =
  | { valid: true }
  | { valid: false, reason: "invalid_rule" };

function isScalar(value: unknown): value is IssueAlertScalar {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && !SAFE_TEXT_PATTERN.test(value)
    && utf8ByteLength(value) <= maxBytes;
}

function isOptionalBoundedText(value: unknown, maxBytes: number): value is string | null {
  return value === null || isBoundedText(value, maxBytes);
}

function isPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isNonNegativeInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isSafeIdentifier(value: unknown): value is string {
  return isBoundedText(value, MAX_IDENTIFIER_BYTES);
}

function isStringArray(value: unknown, maxEntries: number): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= maxEntries
    && value.every((item) => isBoundedText(item, MAX_IDENTIFIER_BYTES));
}

function hasOnlyUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function isStatus(value: unknown): value is IssueAlertStatus {
  return isOneOf(ISSUE_ALERT_STATUSES, value);
}

function isStatusArray(value: unknown): value is readonly IssueAlertStatus[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_FILTER_VALUES
    && value.every((item) => isStatus(item))
    && hasOnlyUniqueStrings(value);
}

function isValueOperator(value: unknown): value is IssueAlertValueOperator {
  return isOneOf(ISSUE_ALERT_VALUE_OPERATORS, value);
}

function isFrequencyOperator(value: unknown): value is IssueAlertFrequencyOperator {
  return isOneOf(ISSUE_ALERT_FREQUENCY_OPERATORS, value);
}

function isLevel(value: unknown): value is IssueAlertLevel {
  return isOneOf(ISSUE_ALERT_LEVELS, value);
}

function isLevelOperator(value: unknown): value is IssueAlertLevelOperator {
  return isOneOf(ISSUE_ALERT_LEVEL_OPERATORS, value);
}

function validateExpectedValue(operator: IssueAlertValueOperator, value: unknown, allowNull: boolean, stringsOnly: boolean): boolean {
  if (operator === "exists" || operator === "not_exists") return value === undefined;
  if (operator === "in") {
    return Array.isArray(value)
      && value.length > 0
      && value.length <= MAX_FILTER_VALUES
      && value.every((item) => (stringsOnly ? typeof item === "string" : isScalar(item)) && (allowNull || item !== null));
  }
  if (!isScalar(value)) return false;
  return (!stringsOnly || typeof value === "string") && (allowNull || value !== null);
}

function validateTagFilter(filter: unknown): boolean {
  if (!isRecord(filter) || !isBoundedText(filter.key, MAX_IDENTIFIER_BYTES) || !isValueOperator(filter.operator)) return false;
  return validateExpectedValue(filter.operator, filter.value, false, true);
}

function validateAttributePredicate(predicate: unknown): boolean {
  if (!isRecord(predicate) || predicate.type !== "attribute" || !isBoundedText(predicate.path, MAX_IDENTIFIER_BYTES) || !isValueOperator(predicate.operator)) return false;
  return validateExpectedValue(predicate.operator, predicate.value, true, false);
}

function validatePredicate(predicate: unknown): boolean {
  if (!isRecord(predicate) || typeof predicate.type !== "string") return false;

  switch (predicate.type) {
    case "new": {
      return typeof predicate.value === "boolean";
    }
    case "regression": {
      return typeof predicate.value === "boolean";
    }
    case "level": {
      return isLevelOperator(predicate.operator) && isLevel(predicate.value);
    }
    case "status": {
      return (predicate.operator === "equals" && isStatus(predicate.value))
        || (predicate.operator === "in" && isStatusArray(predicate.value));
    }
    case "frequency": {
      return isFrequencyOperator(predicate.operator)
        && isPositiveInteger(predicate.windowSeconds, MAX_FREQUENCY_WINDOW_SECONDS)
        && isPositiveInteger(predicate.count, MAX_FREQUENCY_COUNT);
    }
    case "attribute": {
      return validateAttributePredicate(predicate);
    }
    default: {
      return false;
    }
  }
}

function validateConditionGroup(group: unknown): boolean {
  if (!isRecord(group)) return false;
  const all = group.all;
  if (all !== undefined && (!Array.isArray(all) || all.length > MAX_PREDICATES || !all.every(validatePredicate))) return false;
  const any = group.any;
  if (any !== undefined && (!Array.isArray(any) || any.length === 0 || any.length > MAX_PREDICATES || !any.every(validatePredicate))) return false;
  return true;
}

function validateRuleFilters(filters: unknown): boolean {
  if (filters === undefined) return true;
  if (!isRecord(filters)) return false;
  if (filters.projectIds !== undefined && (!isStringArray(filters.projectIds, MAX_FILTER_VALUES) || !hasOnlyUniqueStrings(filters.projectIds))) return false;
  if (filters.environments !== undefined && (!isStringArray(filters.environments, MAX_FILTER_VALUES) || !hasOnlyUniqueStrings(filters.environments))) return false;
  if (filters.releases !== undefined && (!isStringArray(filters.releases, MAX_FILTER_VALUES) || !hasOnlyUniqueStrings(filters.releases))) return false;
  const tags = filters.tags;
  if (tags !== undefined && (!Array.isArray(tags) || tags.length === 0 || tags.length > MAX_TAG_FILTERS || !tags.every(validateTagFilter))) return false;
  return true;
}

function validateRuleAction(action: unknown): boolean {
  if (!isIssueAlertAction(action)) return false;
  if (action.type !== "email") return true;
  return (action.userIds === undefined || hasOnlyUniqueStrings(action.userIds))
    && (action.userIds !== undefined || action.routing !== undefined);
}

function validateRule(rule: unknown): RuleValidationResult {
  if (!isRecord(rule)) return { valid: false, reason: "invalid_rule" };
  if (rule.schemaVersion !== ISSUE_ALERT_RULE_SCHEMA_VERSION
    || typeof rule.id !== "string"
    || !RULE_ID_PATTERN.test(rule.id)
    || utf8ByteLength(rule.id) > MAX_RULE_ID_BYTES
    || !isPositiveInteger(rule.version, Number.MAX_SAFE_INTEGER)
    || typeof rule.enabled !== "boolean"
    || !validateRuleFilters(rule.filters)
    || !validateConditionGroup(rule.conditions)) {
    return { valid: false, reason: "invalid_rule" };
  }
  const cooldown = rule.cooldown;
  if (!isRecord(cooldown)
    || !isNonNegativeInteger(cooldown.durationSeconds, MAX_COOLDOWN_SECONDS)
    || !isOneOf(ISSUE_ALERT_COOLDOWN_SCOPES, cooldown.keyBy)
    || !validateRuleAction(rule.action)) {
    return { valid: false, reason: "invalid_rule" };
  }
  return { valid: true };
}

function validateSignal(signal: IssueAlertSignal): boolean {
  return isRecord(signal)
    && isSafeIdentifier(signal.tenancyId)
    && isSafeIdentifier(signal.projectId)
    && isSafeIdentifier(signal.branchId)
    && isRecord(signal.issue)
    && isSafeIdentifier(signal.issue.id)
    && isBoundedText(signal.issue.shortId, MAX_IDENTIFIER_BYTES)
    && isBoundedText(signal.issue.type, MAX_TEXT_BYTES)
    && isBoundedText(signal.issue.value, MAX_TEXT_BYTES)
    && isOptionalBoundedText(signal.issue.culprit, MAX_TEXT_BYTES)
    && isStatus(signal.issue.status)
    && typeof signal.issue.isNew === "boolean"
    && typeof signal.issue.isRegression === "boolean"
    && !(signal.issue.isNew && signal.issue.isRegression)
    && isRecord(signal.occurrence)
    && isSafeIdentifier(signal.occurrence.id)
    && signal.occurrence.occurredAt instanceof Date
    && Number.isFinite(signal.occurrence.occurredAt.getTime())
    && (signal.level === undefined || isLevel(signal.level))
    && isOptionalBoundedText(signal.environment, MAX_IDENTIFIER_BYTES)
    && isOptionalBoundedText(signal.release, MAX_IDENTIFIER_BYTES)
    && signal.tags instanceof Map
    && signal.attributes instanceof Map
    && signal.frequencyCounts instanceof Map
    && [...signal.tags].every(([key, value]) => isBoundedText(key, MAX_IDENTIFIER_BYTES) && isBoundedText(value, MAX_TEXT_BYTES))
    && [...signal.attributes].every(([key, value]) => isBoundedText(key, MAX_IDENTIFIER_BYTES) && isScalar(value))
    && [...signal.frequencyCounts].every(([windowSeconds, count]) => isPositiveInteger(windowSeconds, MAX_FREQUENCY_WINDOW_SECONDS) && isNonNegativeInteger(count, MAX_FREQUENCY_COUNT));
}

function compareScalar(
  observed: IssueAlertScalar | undefined,
  exists: boolean,
  operator: IssueAlertValueOperator,
  expected: IssueAlertScalar | readonly IssueAlertScalar[] | undefined,
): boolean {
  if (operator === "exists") return exists;
  if (operator === "not_exists") return !exists;
  if (!exists || expected === undefined) return false;

  if (operator === "in") {
    return Array.isArray(expected) && expected.some((candidate) => candidate === observed);
  }
  if (Array.isArray(expected)) return false;
  if (operator === "equals") return observed === expected;
  if (operator === "not_equals") return observed !== expected;
  if (typeof observed !== "string" || typeof expected !== "string") return false;
  if (operator === "contains") return observed.includes(expected);
  return observed.startsWith(expected);
}

function compareFrequency(operator: IssueAlertFrequencyOperator, observed: number, expected: number): boolean {
  switch (operator) {
    case "gt": { return observed > expected; }
    case "gte": { return observed >= expected; }
    case "lt": { return observed < expected; }
    case "lte": { return observed <= expected; }
    case "eq": { return observed === expected; }
  }
}

function compareLevel(operator: IssueAlertLevelOperator, observed: IssueAlertLevel, expected: IssueAlertLevel): boolean {
  const observedSeverity = ISSUE_ALERT_LEVEL_SEVERITY.get(observed);
  const expectedSeverity = ISSUE_ALERT_LEVEL_SEVERITY.get(expected);
  if (observedSeverity === undefined || expectedSeverity === undefined) return false;
  if (operator === "equals") return observedSeverity === expectedSeverity;
  if (operator === "gte") return observedSeverity >= expectedSeverity;
  return observedSeverity <= expectedSeverity;
}

function predicateReason(type: IssueAlertPredicate["type"]): IssueAlertNoMatchReason {
  switch (type) {
    case "new": { return "new_predicate"; }
    case "regression": { return "regression_predicate"; }
    case "level": { return "level_predicate"; }
    case "status": { return "status_predicate"; }
    case "frequency": { return "frequency_predicate"; }
    case "attribute": { return "attribute_predicate"; }
  }
}

function evaluatePredicate(predicate: IssueAlertPredicate, signal: IssueAlertSignal): PredicateResult {
  switch (predicate.type) {
    case "new": {
      return predicate.value === signal.issue.isNew
        ? { matched: true }
        : { matched: false, reason: "new_predicate" };
    }
    case "regression": {
      return predicate.value === signal.issue.isRegression
        ? { matched: true }
        : { matched: false, reason: "regression_predicate" };
    }
    case "level": {
      return signal.level !== undefined && compareLevel(predicate.operator, signal.level, predicate.value)
        ? { matched: true }
        : { matched: false, reason: "level_predicate" };
    }
    case "status": {
      const matches = predicate.operator === "equals"
        ? signal.issue.status === predicate.value
        : Array.isArray(predicate.value) && predicate.value.includes(signal.issue.status);
      return matches ? { matched: true } : { matched: false, reason: "status_predicate" };
    }
    case "frequency": {
      const count = signal.frequencyCounts.get(predicate.windowSeconds);
      if (count === undefined) return { matched: false, reason: "frequency_unavailable" };
      return compareFrequency(predicate.operator, count, predicate.count)
        ? { matched: true }
        : { matched: false, reason: "frequency_predicate" };
    }
    case "attribute": {
      const exists = signal.attributes.has(predicate.path);
      const observed = signal.attributes.get(predicate.path);
      return compareScalar(observed, exists, predicate.operator, predicate.value)
        ? { matched: true }
        : { matched: false, reason: predicateReason(predicate.type) };
    }
  }
}

function evaluateConditionGroup(group: IssueAlertConditionGroup, signal: IssueAlertSignal): IssueAlertNoMatchReason | null {
  for (const predicate of group.all ?? []) {
    const result = evaluatePredicate(predicate, signal);
    if (!result.matched) return result.reason;
  }

  const anyPredicates = group.any ?? [];
  if (anyPredicates.length === 0) return null;

  let hasUnavailableFrequency = false;
  for (const predicate of anyPredicates) {
    const result = evaluatePredicate(predicate, signal);
    if (result.matched) return null;
    hasUnavailableFrequency ||= result.reason === "frequency_unavailable";
  }
  return hasUnavailableFrequency ? "frequency_unavailable" : "any_predicates";
}

function matchesStringFilter(value: string | null, allowed: readonly string[]): boolean {
  return value !== null && allowed.includes(value);
}

function matchesTagFilter(filter: IssueAlertTagFilter, tags: ReadonlyMap<string, string>): boolean {
  const exists = tags.has(filter.key);
  const observed = tags.get(filter.key);
  const expected = filter.value === undefined ? undefined : filter.value;
  return compareScalar(observed, exists, filter.operator, expected);
}

function eventKindForSignal(signal: IssueAlertSignal): IssueAlertEventKind {
  if (signal.issue.isNew) return "new";
  if (signal.issue.isRegression) return "regression";
  return "occurrence";
}

function keyPart(value: string | null): string {
  return value === null ? "-1:" : `${value.length}:${value}`;
}

function hashAlertKey(kind: string, parts: readonly (string | null)[]): string {
  const serialized = [kind, ...parts.map(keyPart)].join("\u001f");
  return createHash("sha256").update("hexclave-issue-alert:v1\u0000").update(serialized).digest("hex");
}

export function buildIssueAlertDeduplicationKey(rule: IssueAlertRule, signal: IssueAlertSignal): string {
  if (validateRule(rule).valid === false || validateSignal(signal) === false) {
    throw new Error("Cannot build an issue-alert key from an invalid rule or signal");
  }
  return `ia1-dedupe-${hashAlertKey("occurrence", [
    signal.tenancyId,
    signal.projectId,
    signal.branchId,
    rule.id,
    String(rule.version),
    signal.issue.id,
    signal.occurrence.id,
  ])}`;
}

export function buildIssueAlertCooldownKey(rule: IssueAlertRule, signal: IssueAlertSignal): string {
  if (validateRule(rule).valid === false || validateSignal(signal) === false) {
    throw new Error("Cannot build an issue-alert key from an invalid rule or signal");
  }
  const scopeParts: (string | null)[] = [signal.tenancyId, signal.projectId, signal.branchId, rule.id, String(rule.version), signal.issue.id];
  if (rule.cooldown.keyBy === "issue_environment" || rule.cooldown.keyBy === "issue_environment_release") scopeParts.push(signal.environment);
  if (rule.cooldown.keyBy === "issue_release" || rule.cooldown.keyBy === "issue_environment_release") scopeParts.push(signal.release);
  return `ia1-cooldown-${hashAlertKey("cooldown", scopeParts)}`;
}

function noMatch(rule: IssueAlertRule, reason: IssueAlertNoMatchReason): IssueAlertNoMatch {
  return {
    outcome: "no-match",
    ruleId: rule.id,
    ruleVersion: rule.version,
    reason,
    reasons: [reason],
  };
}

function drop(rule: IssueAlertRule | null, reason: "invalid_rule" | "invalid_signal" | "unsupported_action"): IssueAlertDrop {
  return {
    outcome: "drop",
    ruleId: rule?.id ?? null,
    ruleVersion: rule?.version ?? null,
    reason,
  };
}

export function evaluateIssueAlertRule(rule: IssueAlertRule, signal: IssueAlertSignal): IssueAlertEvaluation {
  const ruleValidation = validateRule(rule);
  if (!ruleValidation.valid) return drop(rule, ruleValidation.reason);
  if (!validateSignal(signal)) return drop(rule, "invalid_signal");
  if (!rule.enabled) return noMatch(rule, "rule_disabled");
  if (describeIssueAlertDestination(rule.action).status === "unsupported") return drop(rule, "unsupported_action");

  const filters = rule.filters;
  if (filters?.projectIds !== undefined && !filters.projectIds.includes(signal.projectId)) return noMatch(rule, "project_filter");
  if (filters?.environments !== undefined && !matchesStringFilter(signal.environment, filters.environments)) return noMatch(rule, "environment_filter");
  if (filters?.releases !== undefined && !matchesStringFilter(signal.release, filters.releases)) return noMatch(rule, "release_filter");
  if (filters?.tags !== undefined && filters.tags.some((filter) => !matchesTagFilter(filter, signal.tags))) return noMatch(rule, "tag_filter");

  const conditionReason = evaluateConditionGroup(rule.conditions, signal);
  if (conditionReason !== null) return noMatch(rule, conditionReason);

  const eventKind = eventKindForSignal(signal);
  const cooldownKey = buildIssueAlertCooldownKey(rule, signal);
  const deduplicationKey = buildIssueAlertDeduplicationKey(rule, signal);
  const match: IssueAlertMatch = {
    outcome: "match",
    ruleId: rule.id,
    ruleVersion: rule.version,
    issueId: signal.issue.id,
    occurrenceId: signal.occurrence.id,
    eventKind,
    action: rule.action,
    cooldown: rule.cooldown,
    cooldownKey,
    deduplicationKey,
    signal,
  };
  return match;
}

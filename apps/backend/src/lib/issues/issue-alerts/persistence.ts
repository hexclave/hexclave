import { utf8ByteLength } from "@/lib/utf8";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import {
  IssueAlertDeliveryOutcome,
  IssueAlertDeliveryState,
  IssueAlertEventKind as PrismaIssueAlertEventKind,
  type IssueAlertDeliveryOutcome as IssueAlertDeliveryOutcomeValue,
  type IssueAlertDeliveryState as IssueAlertDeliveryStateValue,
  type IssueAlertEventKind as PrismaIssueAlertEventKindValue,
} from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { globalPrismaClient, retryTransaction, type PrismaClientTransaction } from "@/prisma-client";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { randomUUID } from "node:crypto";
import type {
  IssueAlertCooldownKeyScope,
  IssueAlertConditionGroup,
  IssueAlertEventKind,
  IssueAlertFrequencyOperator,
  IssueAlertLevel,
  IssueAlertLevelOperator,
  IssueAlertMatch,
  IssueAlertPredicate,
  IssueAlertRule,
  IssueAlertRuleFilters,
  IssueAlertRuleRepository,
  IssueAlertRuleScope,
  IssueAlertScalar,
  IssueAlertStatus,
  IssueAlertTagFilter,
  IssueAlertValueOperator,
} from "./types";
import { parseIssueAlertAction } from "./destinations";
import type { IssueAlertWorkflowEventPayload } from "@/lib/workflows/issue-alerts/contract";
import { anyVersionUuidPattern as UUID_PATTERN } from "@hexclave/shared/dist/utils/uuids";

export const ISSUE_ALERT_RULE_CONFIG_MAX_BYTES = 64 * 1024;
export const ISSUE_ALERT_MAX_ACTIVE_RULES = 1_000;
export const ISSUE_ALERT_KEY_MAX_BYTES = 256;
export const ISSUE_ALERT_OCCURRENCE_ID_MAX_BYTES = 256;
export const ISSUE_ALERT_ERROR_MAX_BYTES = 8 * 1024;
export const ISSUE_ALERT_MAX_COOLDOWN_SECONDS = 30 * 24 * 60 * 60;

const ISSUE_ALERT_MAX_FILTER_VALUES = 64;
const ISSUE_ALERT_MAX_TAG_FILTERS = 32;
const ISSUE_ALERT_MAX_PREDICATES = 64;
const ISSUE_ALERT_RULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const ISSUE_ALERT_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

const ISSUE_ALERT_VALUE_OPERATORS: readonly IssueAlertValueOperator[] = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "in",
  "exists",
  "not_exists",
];
const ISSUE_ALERT_COOLDOWN_SCOPES: readonly IssueAlertCooldownKeyScope[] = [
  "issue",
  "issue_environment",
  "issue_release",
  "issue_environment_release",
];
const ISSUE_ALERT_STATUSES: readonly IssueAlertStatus[] = ["unresolved", "resolved", "ignored"];
const ISSUE_ALERT_FREQUENCY_OPERATORS: readonly IssueAlertFrequencyOperator[] = ["gt", "gte", "lt", "lte", "eq"];
const ISSUE_ALERT_LEVELS: readonly IssueAlertLevel[] = ["trace", "debug", "info", "warn", "error"];
const ISSUE_ALERT_LEVEL_OPERATORS: readonly IssueAlertLevelOperator[] = ["equals", "gte", "lte"];

export class IssueAlertPersistenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueAlertPersistenceInputError";
  }
}

export type IssueAlertRuleRecord = {
  databaseId: string,
  scope: IssueAlertRuleScope,
  rule: IssueAlertRule,
};

export type IssueAlertDeliveryClaimInput = {
  scope: IssueAlertRuleScope,
  databaseRuleId: string,
  match: IssueAlertMatch,
  now?: Date,
};

export type IssueAlertDeliverySnapshot = {
  id: string,
  scope: IssueAlertRuleScope,
  databaseRuleId: string,
  issueId: string,
  occurrenceId: string,
  ruleVersion: number,
  eventKind: PrismaIssueAlertEventKindValue,
  deduplicationKey: string,
  cooldownKey: string,
  cooldownDurationSeconds: number,
  cooldownExpiresAt: Date | null,
  state: IssueAlertDeliveryStateValue,
  outcome: IssueAlertDeliveryOutcomeValue,
  workflowEventId: string | null,
  workflowPayload: unknown,
  attemptCount: number,
  replayCount: number,
  lastAttemptAt: Date | null,
  nextRetryAt: Date | null,
  lastError: string | null,
  claimedAt: Date,
  enqueuedAt: Date | null,
  completedAt: Date | null,
  createdAt: Date,
  updatedAt: Date,
};

export type IssueAlertDeliveryClaimResult =
  | { status: "claimed", delivery: IssueAlertDeliverySnapshot }
  | { status: "duplicate", delivery: IssueAlertDeliverySnapshot }
  | { status: "cooldown_active", delivery: IssueAlertDeliverySnapshot }
  | { status: "invalid_rule" };

export type IssueAlertWorkflowUpdate =
  | { kind: "enqueued", workflowEventId: string, payload?: IssueAlertWorkflowEventPayload, at?: Date }
  | { kind: "delivered", at?: Date }
  | { kind: "dropped", error?: string, at?: Date };

export type IssueAlertWorkflowDeliveryExpectation = {
  state: IssueAlertDeliveryStateValue,
  nextRetryAt: Date | null,
  lastAttemptAt: Date | null,
};

type StoredRuleRow = {
  id: string,
  tenancyId: string,
  projectId: string,
  branchId: string,
  ruleKey: string,
  version: number,
  schemaVersion: number,
  enabled: boolean,
  config: unknown,
};

type DeliverySelect = {
  id: true,
  tenancyId: true,
  projectId: true,
  branchId: true,
  ruleId: true,
  issueId: true,
  occurrenceId: true,
  ruleVersion: true,
  eventKind: true,
  deduplicationKey: true,
  cooldownKey: true,
  cooldownDurationSeconds: true,
  cooldownExpiresAt: true,
  state: true,
  outcome: true,
  workflowEventId: true,
  workflowPayload: true,
  attemptCount: true,
  replayCount: true,
  lastAttemptAt: true,
  nextRetryAt: true,
  lastError: true,
  claimedAt: true,
  enqueuedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
};

const DELIVERY_SELECT: DeliverySelect = {
  id: true,
  tenancyId: true,
  projectId: true,
  branchId: true,
  ruleId: true,
  issueId: true,
  occurrenceId: true,
  ruleVersion: true,
  eventKind: true,
  deduplicationKey: true,
  cooldownKey: true,
  cooldownDurationSeconds: true,
  cooldownExpiresAt: true,
  state: true,
  outcome: true,
  workflowEventId: true,
  workflowPayload: true,
  attemptCount: true,
  replayCount: true,
  lastAttemptAt: true,
  nextRetryAt: true,
  lastError: true,
  claimedAt: true,
  enqueuedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
};

type DeliveryRow = {
  id: string,
  tenancyId: string,
  projectId: string,
  branchId: string,
  ruleId: string,
  issueId: string,
  occurrenceId: string,
  ruleVersion: number,
  eventKind: PrismaIssueAlertEventKindValue,
  deduplicationKey: string,
  cooldownKey: string,
  cooldownDurationSeconds: number,
  cooldownExpiresAt: Date | null,
  state: IssueAlertDeliveryStateValue,
  outcome: IssueAlertDeliveryOutcomeValue,
  workflowEventId: string | null,
  workflowPayload: unknown,
  attemptCount: number,
  replayCount: number,
  lastAttemptAt: Date | null,
  nextRetryAt: Date | null,
  lastError: string | null,
  claimedAt: Date,
  enqueuedAt: Date | null,
  completedAt: Date | null,
  createdAt: Date,
  updatedAt: Date,
};

function isJsonValue(value: unknown, ancestors: ReadonlySet<object> = new Set()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, nextAncestors));
  }

  if (!isRecord(value)) return false;
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined
      && isJsonValue(value[key], nextAncestors);
  });
}

function serializedJson(value: unknown): string | null {
  if (!isJsonValue(value)) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  return utf8ByteLength(serialized) <= ISSUE_ALERT_RULE_CONFIG_MAX_BYTES ? serialized : null;
}

function isBoundedText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && (allowEmpty || value.length > 0)
    && !ISSUE_ALERT_CONTROL_CHARACTER_PATTERN.test(value)
    && utf8ByteLength(value) <= maxBytes;
}

function isSafeIdentifier(value: unknown): value is string {
  return isBoundedText(value, ISSUE_ALERT_KEY_MAX_BYTES);
}

function isPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isNonNegativeInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isScalar(value: unknown): value is IssueAlertScalar {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function parseValueOperator(value: unknown): IssueAlertValueOperator | null {
  return isOneOf(ISSUE_ALERT_VALUE_OPERATORS, value) ? value : null;
}

function parseStatus(value: unknown): IssueAlertStatus | null {
  return isOneOf(ISSUE_ALERT_STATUSES, value) ? value : null;
}

function parseLevel(value: unknown): IssueAlertLevel | null {
  if (value === "warning") return "warn";
  if (value === "fatal") return "error";
  return isOneOf(ISSUE_ALERT_LEVELS, value) ? value : null;
}

function parseStringArray(value: unknown, maximum: number): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (!isBoundedText(entry, ISSUE_ALERT_KEY_MAX_BYTES) || result.includes(entry)) return null;
    result.push(entry);
  }
  return result;
}

function parseTagValue(value: unknown, operator: IssueAlertValueOperator): string | string[] | undefined | null {
  if (operator === "exists" || operator === "not_exists") return value === undefined ? undefined : null;
  if (operator === "in") return parseStringArray(value, ISSUE_ALERT_MAX_FILTER_VALUES);
  return isBoundedText(value, ISSUE_ALERT_KEY_MAX_BYTES) ? value : null;
}

function parseScalarArray(value: unknown): IssueAlertScalar[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > ISSUE_ALERT_MAX_FILTER_VALUES) return null;
  const result: IssueAlertScalar[] = [];
  for (const entry of value) {
    if (!isScalar(entry)) return null;
    result.push(entry);
  }
  return result;
}

function parseAttributeValue(value: unknown, operator: IssueAlertValueOperator): IssueAlertScalar | IssueAlertScalar[] | undefined | null {
  if (operator === "exists" || operator === "not_exists") return value === undefined ? undefined : null;
  if (operator === "in") return parseScalarArray(value);
  return isScalar(value) ? value : null;
}

function parseTagFilter(value: unknown): IssueAlertTagFilter | null {
  if (!isRecord(value) || !isBoundedText(value.key, ISSUE_ALERT_KEY_MAX_BYTES)) return null;
  const operator = parseValueOperator(value.operator);
  if (operator === null) return null;
  const parsedValue = parseTagValue(value.value, operator);
  if (parsedValue === null) return null;
  return parsedValue === undefined
    ? { key: value.key, operator }
    : { key: value.key, operator, value: parsedValue };
}

function parsePredicate(value: unknown): IssueAlertPredicate | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "new":
    case "regression": {
      return typeof value.value === "boolean" ? { type: value.type, value: value.value } : null;
    }
    case "level": {
      const level = parseLevel(value.value);
      return level !== null && isOneOf(ISSUE_ALERT_LEVEL_OPERATORS, value.operator)
        ? { type: "level", operator: value.operator, value: level }
        : null;
    }
    case "status": {
      if (value.operator === "equals") {
        const status = parseStatus(value.value);
        return status === null ? null : { type: "status", operator: "equals", value: status };
      }
      if (value.operator !== "in") return null;
      const statuses = parseStringArray(value.value, ISSUE_ALERT_MAX_FILTER_VALUES);
      if (statuses === null) return null;
      const parsedStatuses: IssueAlertStatus[] = [];
      for (const status of statuses) {
        const parsed = parseStatus(status);
        if (parsed === null) return null;
        parsedStatuses.push(parsed);
      }
      return { type: "status", operator: "in", value: parsedStatuses };
    }
    case "frequency": {
      return isOneOf(ISSUE_ALERT_FREQUENCY_OPERATORS, value.operator)
        && isPositiveInteger(value.windowSeconds, ISSUE_ALERT_MAX_COOLDOWN_SECONDS)
        && isPositiveInteger(value.count, 1_000_000_000)
        ? { type: "frequency", operator: value.operator, windowSeconds: value.windowSeconds, count: value.count }
        : null;
    }
    case "attribute": {
      if (!isBoundedText(value.path, ISSUE_ALERT_KEY_MAX_BYTES)) return null;
      const operator = parseValueOperator(value.operator);
      if (operator === null) return null;
      const parsedValue = parseAttributeValue(value.value, operator);
      if (parsedValue === null) return null;
      return parsedValue === undefined
        ? { type: "attribute", path: value.path, operator }
        : { type: "attribute", path: value.path, operator, value: parsedValue };
    }
    default: {
      return null;
    }
  }
}

function parsePredicateArray(value: unknown, maximum: number, requireNonEmpty: boolean): IssueAlertPredicate[] | null {
  if (!Array.isArray(value) || value.length > maximum || (requireNonEmpty && value.length === 0)) return null;
  const result: IssueAlertPredicate[] = [];
  for (const entry of value) {
    const parsed = parsePredicate(entry);
    if (parsed === null) return null;
    result.push(parsed);
  }
  return result;
}

function parseConditionGroup(value: unknown): IssueAlertConditionGroup | null {
  if (!isRecord(value)) return null;
  const all = value.all === undefined ? undefined : parsePredicateArray(value.all, ISSUE_ALERT_MAX_PREDICATES, false);
  const any = value.any === undefined ? undefined : parsePredicateArray(value.any, ISSUE_ALERT_MAX_PREDICATES, true);
  if ((value.all !== undefined && all === null) || (value.any !== undefined && any === null)) return null;
  const result: IssueAlertConditionGroup = {};
  if (all !== undefined && all !== null) result.all = all;
  if (any !== undefined && any !== null) result.any = any;
  return result;
}

function parseFilters(value: unknown): IssueAlertRuleFilters | null {
  if (!isRecord(value)) return null;
  const projectIds = value.projectIds === undefined ? undefined : parseStringArray(value.projectIds, ISSUE_ALERT_MAX_FILTER_VALUES);
  const environments = value.environments === undefined ? undefined : parseStringArray(value.environments, ISSUE_ALERT_MAX_FILTER_VALUES);
  const releases = value.releases === undefined ? undefined : parseStringArray(value.releases, ISSUE_ALERT_MAX_FILTER_VALUES);
  if ((value.projectIds !== undefined && projectIds === null)
    || (value.environments !== undefined && environments === null)
    || (value.releases !== undefined && releases === null)) return null;

  let tags: IssueAlertTagFilter[] | undefined;
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length === 0 || value.tags.length > ISSUE_ALERT_MAX_TAG_FILTERS) return null;
    tags = [];
    for (const tag of value.tags) {
      const parsed = parseTagFilter(tag);
      if (parsed === null) return null;
      tags.push(parsed);
    }
  }
  const result: IssueAlertRuleFilters = {};
  if (projectIds !== undefined && projectIds !== null) result.projectIds = projectIds;
  if (environments !== undefined && environments !== null) result.environments = environments;
  if (releases !== undefined && releases !== null) result.releases = releases;
  if (tags !== undefined) result.tags = tags;
  return result;
}

function parseRuleConfig(value: unknown): IssueAlertRule | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== "string"
    || !ISSUE_ALERT_RULE_ID_PATTERN.test(value.id) || !isPositiveInteger(value.version, Number.MAX_SAFE_INTEGER)
    || typeof value.enabled !== "boolean") return null;

  let filters: IssueAlertRuleFilters | undefined;
  if (value.filters !== undefined) {
    const parsedFilters = parseFilters(value.filters);
    if (parsedFilters === null) return null;
    filters = parsedFilters;
  }
  const conditions = parseConditionGroup(value.conditions);
  const cooldownValue = value.cooldown;
  const action = parseIssueAlertAction(value.action);
  if (conditions === null || !isRecord(cooldownValue) || action === null) return null;
  if (!isNonNegativeInteger(cooldownValue.durationSeconds, ISSUE_ALERT_MAX_COOLDOWN_SECONDS)
    || !isOneOf(ISSUE_ALERT_COOLDOWN_SCOPES, cooldownValue.keyBy)) return null;

  const rule: IssueAlertRule = {
    schemaVersion: 1,
    id: value.id,
    version: value.version,
    enabled: value.enabled,
    conditions,
    cooldown: { durationSeconds: cooldownValue.durationSeconds, keyBy: cooldownValue.keyBy },
    action,
  };
  if (filters !== undefined) rule.filters = filters;
  return rule;
}

export function parseStoredIssueAlertRule(row: StoredRuleRow): IssueAlertRule | null {
  const serialized = serializedJson(row.config);
  if (serialized === null) return null;
  const parsed = parseRuleConfig(row.config);
  if (parsed === null || parsed.id !== row.ruleKey || parsed.version !== row.version
    || parsed.schemaVersion !== row.schemaVersion || parsed.enabled !== row.enabled) return null;
  return parsed;
}

function validateScope(scope: IssueAlertRuleScope): void {
  if (!UUID_PATTERN.test(scope.tenancyId) || !isSafeIdentifier(scope.projectId) || !isSafeIdentifier(scope.branchId)) {
    throw new IssueAlertPersistenceInputError("Issue alert scope is invalid");
  }
}

function validateKey(value: string, field: string): void {
  if (!isBoundedText(value, ISSUE_ALERT_KEY_MAX_BYTES)) {
    throw new IssueAlertPersistenceInputError(`${field} must be a non-empty bounded string`);
  }
}

function validateOccurrenceId(value: string): void {
  if (!isBoundedText(value, ISSUE_ALERT_OCCURRENCE_ID_MAX_BYTES)) {
    throw new IssueAlertPersistenceInputError("occurrenceId must be a non-empty bounded string");
  }
}

function validateMatchScope(scope: IssueAlertRuleScope, match: IssueAlertMatch): void {
  if (match.signal.tenancyId !== scope.tenancyId || match.signal.projectId !== scope.projectId || match.signal.branchId !== scope.branchId) {
    throw new IssueAlertPersistenceInputError("Issue alert match scope does not match the persistence scope");
  }
  validateKey(match.ruleId, "ruleId");
  validateKey(match.issueId, "issueId");
  validateOccurrenceId(match.occurrenceId);
  validateKey(match.deduplicationKey, "deduplicationKey");
  validateKey(match.cooldownKey, "cooldownKey");
  if (!isPositiveInteger(match.ruleVersion, Number.MAX_SAFE_INTEGER)
    || !isNonNegativeInteger(match.cooldown.durationSeconds, ISSUE_ALERT_MAX_COOLDOWN_SECONDS)
    || !UUID_PATTERN.test(match.issueId)) {
    throw new IssueAlertPersistenceInputError("Issue alert match has invalid persistence fields");
  }
}

function toPrismaEventKind(kind: IssueAlertEventKind): PrismaIssueAlertEventKindValue {
  switch (kind) {
    case "new": {
      return PrismaIssueAlertEventKind.NEW;
    }
    case "regression": {
      return PrismaIssueAlertEventKind.REGRESSION;
    }
    case "occurrence": {
      return PrismaIssueAlertEventKind.OCCURRENCE;
    }
  }
}

function toDeliverySnapshot(row: DeliveryRow): IssueAlertDeliverySnapshot {
  return {
    id: row.id,
    scope: { tenancyId: row.tenancyId, projectId: row.projectId, branchId: row.branchId },
    databaseRuleId: row.ruleId,
    issueId: row.issueId,
    occurrenceId: row.occurrenceId,
    ruleVersion: row.ruleVersion,
    eventKind: row.eventKind,
    deduplicationKey: row.deduplicationKey,
    cooldownKey: row.cooldownKey,
    cooldownDurationSeconds: row.cooldownDurationSeconds,
    cooldownExpiresAt: row.cooldownExpiresAt,
    state: row.state,
    outcome: row.outcome,
    workflowEventId: row.workflowEventId,
    workflowPayload: row.workflowPayload,
    attemptCount: row.attemptCount,
    replayCount: row.replayCount,
    lastAttemptAt: row.lastAttemptAt,
    nextRetryAt: row.nextRetryAt,
    lastError: row.lastError,
    claimedAt: row.claimedAt,
    enqueuedAt: row.enqueuedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function findDelivery(client: PrismaClientTransaction, scope: IssueAlertRuleScope, where: { id?: string, deduplicationKey?: string }): Promise<IssueAlertDeliverySnapshot | null> {
  const rowWhere: Prisma.IssueAlertDeliveryWhereInput = {
    tenancyId: scope.tenancyId,
    projectId: scope.projectId,
    branchId: scope.branchId,
  };
  if (where.id !== undefined) rowWhere.id = where.id;
  if (where.deduplicationKey !== undefined) rowWhere.deduplicationKey = where.deduplicationKey;
  const row = await client.issueAlertDelivery.findFirst({
    where: rowWhere,
    select: DELIVERY_SELECT,
  });
  return row === null ? null : toDeliverySnapshot(row);
}

function validateWorkflowEventId(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new IssueAlertPersistenceInputError("workflowEventId must be a UUID");
}

function validateTimestamp(value: Date | undefined, field: string): Date {
  const result = value ?? new Date();
  if (!Number.isFinite(result.getTime())) throw new IssueAlertPersistenceInputError(`${field} must be a valid date`);
  return result;
}

export async function claimIssueAlertDeliveryInTransaction(
  client: PrismaClientTransaction,
  input: IssueAlertDeliveryClaimInput,
): Promise<IssueAlertDeliveryClaimResult> {
  validateScope(input.scope);
  validateScope(input.match.signal);
  validateMatchScope(input.scope, input.match);
  if (!UUID_PATTERN.test(input.databaseRuleId)) throw new IssueAlertPersistenceInputError("databaseRuleId must be a UUID");
  const now = validateTimestamp(input.now, "now");
  const workflowRule = await client.issueAlertRule.findFirst({
    where: {
      tenancyId: input.scope.tenancyId,
      projectId: input.scope.projectId,
      branchId: input.scope.branchId,
      id: input.databaseRuleId,
    },
    select: {
      id: true,
      ruleKey: true,
      version: true,
      schemaVersion: true,
      enabled: true,
      config: true,
    },
  });
  if (workflowRule === null) return { status: "invalid_rule" };
  const parsedRule = parseStoredIssueAlertRule({
    id: workflowRule.id,
    tenancyId: input.scope.tenancyId,
    projectId: input.scope.projectId,
    branchId: input.scope.branchId,
    ruleKey: workflowRule.ruleKey,
    version: workflowRule.version,
    schemaVersion: workflowRule.schemaVersion,
    enabled: workflowRule.enabled,
    config: workflowRule.config,
  });
  if (parsedRule === null || !parsedRule.enabled || parsedRule.id !== input.match.ruleId || parsedRule.version !== input.match.ruleVersion) {
    return { status: "invalid_rule" };
  }

  const existingDelivery = await findDelivery(client, input.scope, { deduplicationKey: input.match.deduplicationKey });
  if (existingDelivery !== null) {
    return { status: "duplicate", delivery: existingDelivery };
  }

  const cooldownExpiresAt = new Date(now.getTime() + input.match.cooldown.durationSeconds * 1000);
  const cooldownClaim = await client.$queryRaw<{ id: string, expiresAt: Date }[]>(Prisma.sql`
    INSERT INTO "IssueAlertCooldownClaim" (
      "tenancyId", "projectId", "branchId", "id", "ruleId", "cooldownKey", "expiresAt", "lastClaimedAt", "createdAt", "updatedAt"
    ) VALUES (
      ${input.scope.tenancyId}::uuid, ${input.scope.projectId}, ${input.scope.branchId}, ${randomUUID()}::uuid,
      ${input.databaseRuleId}::uuid, ${input.match.cooldownKey}, ${cooldownExpiresAt}, ${now}, ${now}, ${now}
    )
    ON CONFLICT ("tenancyId", "cooldownKey") DO UPDATE
      SET "expiresAt" = EXCLUDED."expiresAt", "lastClaimedAt" = EXCLUDED."lastClaimedAt", "updatedAt" = EXCLUDED."updatedAt"
      WHERE "IssueAlertCooldownClaim"."expiresAt" <= ${now}
    RETURNING "id", "expiresAt"
  `);

  let deliveryState: IssueAlertDeliveryStateValue = IssueAlertDeliveryState.CLAIMED;
  let deliveryOutcome: IssueAlertDeliveryOutcomeValue = IssueAlertDeliveryOutcome.NONE;
  let deliveryCooldownExpiresAt = cooldownExpiresAt;
  let deliveryCompletedAt: Date | null = null;
  let resultStatus: "claimed" | "cooldown_active" = "claimed";
  if (cooldownClaim.length === 0) {
    const activeCooldown = await client.issueAlertCooldownClaim.findFirst({
      where: {
        tenancyId: input.scope.tenancyId,
        projectId: input.scope.projectId,
        branchId: input.scope.branchId,
        cooldownKey: input.match.cooldownKey,
      },
      select: { expiresAt: true },
    });
    if (activeCooldown === null) throw new Error("Issue alert cooldown conflict had no readable winner");
    deliveryState = IssueAlertDeliveryState.SUPPRESSED;
    deliveryOutcome = IssueAlertDeliveryOutcome.COOLDOWN_ACTIVE;
    deliveryCooldownExpiresAt = activeCooldown.expiresAt;
    deliveryCompletedAt = now;
    resultStatus = "cooldown_active";
  }

  const insertedDelivery = await client.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "IssueAlertDelivery" (
      "tenancyId", "projectId", "branchId", "id", "ruleId", "issueId", "occurrenceId", "ruleVersion", "eventKind",
      "deduplicationKey", "cooldownKey", "cooldownDurationSeconds", "cooldownExpiresAt", "state", "outcome", "claimedAt", "completedAt", "createdAt", "updatedAt"
    ) VALUES (
      ${input.scope.tenancyId}::uuid, ${input.scope.projectId}, ${input.scope.branchId}, ${randomUUID()}::uuid,
      ${input.databaseRuleId}::uuid, ${input.match.issueId}::uuid, ${input.match.occurrenceId}, ${input.match.ruleVersion}, ${toPrismaEventKind(input.match.eventKind)}::"IssueAlertEventKind",
      ${input.match.deduplicationKey}, ${input.match.cooldownKey}, ${input.match.cooldown.durationSeconds}, ${deliveryCooldownExpiresAt},
      ${deliveryState}::"IssueAlertDeliveryState", ${deliveryOutcome}::"IssueAlertDeliveryOutcome", ${now}, ${deliveryCompletedAt}, ${now}, ${now}
    )
    ON CONFLICT ("tenancyId", "deduplicationKey") DO NOTHING
    RETURNING "id"
  `);
  if (insertedDelivery.length === 0) {
    const duplicate = await findDelivery(client, input.scope, { deduplicationKey: input.match.deduplicationKey });
    if (duplicate === null) throw new Error("Issue alert deduplication conflict had no readable winner");
    return { status: "duplicate", delivery: duplicate };
  }

  const delivery = await findDelivery(client, input.scope, { id: insertedDelivery[0].id });
  if (delivery === null) throw new Error("Issue alert delivery disappeared after claim");
  return { status: resultStatus, delivery };
}

async function recordWorkflowUpdateInTransaction(
  client: PrismaClientTransaction,
  scope: IssueAlertRuleScope,
  deliveryId: string,
  update: IssueAlertWorkflowUpdate,
  expectedWorkflowEventId?: string,
  expectedDelivery?: IssueAlertWorkflowDeliveryExpectation,
): Promise<IssueAlertDeliverySnapshot | null> {
  validateScope(scope);
  if (!UUID_PATTERN.test(deliveryId)) throw new IssueAlertPersistenceInputError("deliveryId must be a UUID");
  if (expectedWorkflowEventId !== undefined) validateWorkflowEventId(expectedWorkflowEventId);
  if (expectedWorkflowEventId === undefined && expectedDelivery !== undefined) {
    throw new IssueAlertPersistenceInputError("expected workflow delivery state requires an expected workflow event id");
  }
  const at = validateTimestamp(update.at, "workflow update time");
  const workflowEventGuard = expectedWorkflowEventId === undefined ? {} : { workflowEventId: expectedWorkflowEventId };
  const expectedDeliveryGuard = expectedDelivery === undefined ? {} : {
    state: expectedDelivery.state,
    nextRetryAt: expectedDelivery.nextRetryAt,
    lastAttemptAt: expectedDelivery.lastAttemptAt,
  };
  const lifecycleStateGuard = {
    state: {
      notIn: [
        IssueAlertDeliveryState.DELIVERED,
        IssueAlertDeliveryState.DROPPED,
        IssueAlertDeliveryState.SUPPRESSED,
      ],
    },
  };
  switch (update.kind) {
    case "enqueued": {
      validateWorkflowEventId(update.workflowEventId);
      if (expectedDelivery !== undefined && expectedDelivery.state !== IssueAlertDeliveryState.CLAIMED) return null;
      const data: Prisma.IssueAlertDeliveryUpdateManyMutationInput = {
        state: IssueAlertDeliveryState.ENQUEUED,
        outcome: IssueAlertDeliveryOutcome.WORKFLOW_ENQUEUED,
        workflowEventId: update.workflowEventId,
        enqueuedAt: at,
      };
      if (update.payload !== undefined) data.workflowPayload = update.payload;
      const updated = await client.issueAlertDelivery.updateMany({
        where: {
          tenancyId: scope.tenancyId,
          projectId: scope.projectId,
          branchId: scope.branchId,
          id: deliveryId,
          ...(expectedDelivery === undefined
            ? { ...workflowEventGuard, state: IssueAlertDeliveryState.CLAIMED }
            : { ...workflowEventGuard, ...expectedDeliveryGuard }),
        },
        data,
      });
      if (expectedWorkflowEventId !== undefined && updated.count === 0) return null;
      break;
    }
    case "delivered": {
      const updated = await client.issueAlertDelivery.updateMany({
        where: {
          tenancyId: scope.tenancyId,
          projectId: scope.projectId,
          branchId: scope.branchId,
          id: deliveryId,
          ...workflowEventGuard,
          ...lifecycleStateGuard,
          ...expectedDeliveryGuard,
        },
        data: {
          state: IssueAlertDeliveryState.DELIVERED,
          outcome: IssueAlertDeliveryOutcome.WORKFLOW_DELIVERED,
          completedAt: at,
          lastAttemptAt: at,
          attemptCount: { increment: 1 },
          nextRetryAt: null,
          lastError: null,
        },
      });
      if (expectedWorkflowEventId !== undefined && updated.count === 0) return null;
      break;
    }
    case "dropped": {
      if (update.error !== undefined && !isBoundedText(update.error, ISSUE_ALERT_ERROR_MAX_BYTES)) {
        throw new IssueAlertPersistenceInputError("workflow drop error must be a bounded string");
      }
      const updated = await client.issueAlertDelivery.updateMany({
        where: {
          tenancyId: scope.tenancyId,
          projectId: scope.projectId,
          branchId: scope.branchId,
          id: deliveryId,
          ...workflowEventGuard,
          ...lifecycleStateGuard,
          ...expectedDeliveryGuard,
        },
        data: {
          state: IssueAlertDeliveryState.DROPPED,
          outcome: IssueAlertDeliveryOutcome.WORKFLOW_DROPPED,
          completedAt: at,
          lastAttemptAt: at,
          attemptCount: { increment: 1 },
          nextRetryAt: null,
          lastError: update.error ?? null,
        },
      });
      if (expectedWorkflowEventId !== undefined && updated.count === 0) return null;
      break;
    }
    default: {
      const exhaustive: never = update;
      throw new HexclaveAssertionError(`Unhandled issue alert workflow update: ${JSON.stringify(exhaustive)}`);
    }
  }

  const row = await findDelivery(client, scope, { id: deliveryId });
  if (row === null) throw new Error("Issue alert delivery was not found while recording workflow state");
  return row;
}

export async function recordIssueAlertWorkflowUpdateInTransaction(
  client: PrismaClientTransaction,
  scope: IssueAlertRuleScope,
  deliveryId: string,
  update: IssueAlertWorkflowUpdate,
): Promise<IssueAlertDeliverySnapshot> {
  const row = await recordWorkflowUpdateInTransaction(client, scope, deliveryId, update);
  if (row === null) throw new Error("Issue alert delivery was not found while recording workflow state");
  return row;
}

export class IssueAlertPersistenceService implements IssueAlertRuleRepository {
  constructor(private readonly client: typeof globalPrismaClient = globalPrismaClient) {}

  async listActiveRuleRecords(scope: IssueAlertRuleScope): Promise<readonly IssueAlertRuleRecord[]> {
    validateScope(scope);
    const rows = await this.client.$replica().$queryRaw<StoredRuleRow[]>(Prisma.sql`
      SELECT DISTINCT ON ("ruleKey")
        "id", "tenancyId", "projectId", "branchId", "ruleKey",
        "version", "schemaVersion", "enabled", "config"
      FROM "IssueAlertRule"
      WHERE "tenancyId" = ${scope.tenancyId}::uuid
        AND "projectId" = ${scope.projectId}
        AND "branchId" = ${scope.branchId}
        AND "enabled" = true
      ORDER BY "ruleKey" ASC, "version" DESC
      LIMIT ${ISSUE_ALERT_MAX_ACTIVE_RULES + 1}
    `);

    const records: IssueAlertRuleRecord[] = [];
    for (const row of rows) {
      const rule = parseStoredIssueAlertRule(row);
      if (rule === null) continue;
      if (records.length >= ISSUE_ALERT_MAX_ACTIVE_RULES) break;
      records.push({
        databaseId: row.id,
        scope: { tenancyId: row.tenancyId, projectId: row.projectId, branchId: row.branchId },
        rule,
      });
    }
    return records;
  }

  async listActiveRules(scope: IssueAlertRuleScope): Promise<readonly IssueAlertRule[]> {
    const records = await this.listActiveRuleRecords(scope);
    return records.map((record) => record.rule);
  }

  async saveRule(scope: IssueAlertRuleScope, rule: IssueAlertRule): Promise<IssueAlertRuleRecord> {
    validateScope(scope);
    const serialized = serializedJson(rule);
    if (serialized === null || parseStoredIssueAlertRule({
      id: randomUUID(),
      tenancyId: scope.tenancyId,
      projectId: scope.projectId,
      branchId: scope.branchId,
      ruleKey: rule.id,
      version: rule.version,
      schemaVersion: rule.schemaVersion,
      enabled: rule.enabled,
      config: rule,
    }) === null) {
      throw new IssueAlertPersistenceInputError("Issue alert rule is malformed or oversized");
    }

    const databaseId = await retryTransaction(this.client, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        INSERT INTO "IssueAlertRule" (
          "tenancyId", "projectId", "branchId", "id", "ruleKey", "version", "schemaVersion", "enabled", "config", "createdAt", "updatedAt"
        ) VALUES (
          ${scope.tenancyId}::uuid, ${scope.projectId}, ${scope.branchId}, ${randomUUID()}::uuid, ${rule.id}, ${rule.version}, ${rule.schemaVersion}, ${rule.enabled}, ${serialized}::text::jsonb, NOW(), NOW()
        )
        ON CONFLICT ("tenancyId", "projectId", "branchId", "ruleKey", "version") DO UPDATE
          SET "projectId" = EXCLUDED."projectId", "branchId" = EXCLUDED."branchId", "schemaVersion" = EXCLUDED."schemaVersion",
              "enabled" = EXCLUDED."enabled", "config" = EXCLUDED."config", "updatedAt" = NOW()
        RETURNING "id"
      `);
      if (rows.length !== 1) throw new Error("Issue alert rule upsert returned an unexpected row count");
      return rows[0].id;
    });
    return { databaseId, scope, rule };
  }

  async claimDelivery(input: IssueAlertDeliveryClaimInput): Promise<IssueAlertDeliveryClaimResult> {
    return await retryTransaction(this.client, async (tx) => await claimIssueAlertDeliveryInTransaction(tx, input), {
      level: "serializable",
    });
  }

  async recordWorkflowUpdate(scope: IssueAlertRuleScope, deliveryId: string, update: IssueAlertWorkflowUpdate): Promise<IssueAlertDeliverySnapshot> {
    return await retryTransaction(this.client, async (tx) => {
      const row = await recordWorkflowUpdateInTransaction(tx, scope, deliveryId, update);
      if (row === null) throw new Error("Issue alert delivery was not found while recording workflow state");
      return row;
    });
  }

  async recordWorkflowUpdateIfCurrent(
    scope: IssueAlertRuleScope,
    deliveryId: string,
    expectedWorkflowEventId: string,
    expectedDelivery: IssueAlertWorkflowDeliveryExpectation,
    update: IssueAlertWorkflowUpdate,
  ): Promise<IssueAlertDeliverySnapshot | null> {
    return await retryTransaction(this.client, async (tx) => await recordWorkflowUpdateInTransaction(
      tx,
      scope,
      deliveryId,
      update,
      expectedWorkflowEventId,
      expectedDelivery,
    ));
  }

  async inspectDelivery(
    scope: IssueAlertRuleScope,
    deliveryId: string,
    options?: { consistency: "primary" | "replica" },
  ): Promise<IssueAlertDeliverySnapshot | null> {
    validateScope(scope);
    if (!UUID_PATTERN.test(deliveryId)) throw new IssueAlertPersistenceInputError("deliveryId must be a UUID");
    const client = options?.consistency === "primary" ? this.client : this.client.$replica();
    const row = await client.issueAlertDelivery.findFirst({
      where: { tenancyId: scope.tenancyId, projectId: scope.projectId, branchId: scope.branchId, id: deliveryId },
      select: DELIVERY_SELECT,
    });
    return row === null ? null : toDeliverySnapshot(row);
  }

  async listDeliveries(scope: IssueAlertRuleScope, limit = 100): Promise<readonly IssueAlertDeliverySnapshot[]> {
    validateScope(scope);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) throw new IssueAlertPersistenceInputError("limit must be between 1 and 1000");
    const rows = await this.client.$replica().issueAlertDelivery.findMany({
      where: { tenancyId: scope.tenancyId, projectId: scope.projectId, branchId: scope.branchId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: DELIVERY_SELECT,
    });
    return rows.map(toDeliverySnapshot);
  }
}

export const issueAlertPersistenceService = new IssueAlertPersistenceService();

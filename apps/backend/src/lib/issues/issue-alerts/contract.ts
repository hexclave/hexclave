import {
  yupArray,
  yupBoolean,
  yupNumber,
  yupObject,
  yupString,
  yupUnion,
} from "@hexclave/shared/dist/schema-fields";
import type { IssueAlertRuleResponse } from "./api";
import type { IssueAlertPredicate, IssueAlertRuleFilters, IssueAlertScalar, IssueAlertTagFilter, IssueAlertValueOperator } from "./types";
import type { IssueAlertAction, IssueAlertEmailRouting } from "./destinations";


const issueAlertValueOperatorSchema = yupString().oneOf([
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "in",
  "exists",
  "not_exists",
]).defined();

const issueAlertStatusSchema = yupString().oneOf(["unresolved", "resolved", "ignored"]).defined();
const issueAlertLevelOperatorSchema = yupString().oneOf(["equals", "gte", "lte"]).defined();
const issueAlertFrequencyOperatorSchema = yupString().oneOf(["gt", "gte", "lt", "lte", "eq"]).defined();
const issueAlertCooldownKeyScopeSchema = yupString().oneOf([
  "issue",
  "issue_environment",
  "issue_release",
  "issue_environment_release",
]).defined();

const issueAlertScalarSchema = yupUnion(
  yupString().defined(),
  yupNumber().defined(),
  yupBoolean().defined(),
).nullable();

function issueAlertTagFilterSchema() {
  return yupObject({
    key: yupString().defined(),
    operator: issueAlertValueOperatorSchema,
    value: yupUnion(
      yupString().defined(),
      yupArray(yupString().defined()).defined(),
    ).optional(),
  }).defined();
}

function issueAlertFiltersSchema() {
  return yupObject({
    projectIds: yupArray(yupString().defined()).optional(),
    environments: yupArray(yupString().defined()).optional(),
    releases: yupArray(yupString().defined()).optional(),
    tags: yupArray(issueAlertTagFilterSchema()).optional(),
  }).optional();
}

function issueAlertPredicateSchema(levels: readonly string[]) {
  return yupUnion(
    yupObject({
      type: yupString().oneOf(["new"]).defined(),
      value: yupBoolean().defined(),
    }).defined(),
    yupObject({
      type: yupString().oneOf(["regression"]).defined(),
      value: yupBoolean().defined(),
    }).defined(),
    yupObject({
      type: yupString().oneOf(["level"]).defined(),
      operator: issueAlertLevelOperatorSchema,
      value: yupString().oneOf([...levels]).defined(),
    }).defined(),
    yupObject({
      type: yupString().oneOf(["status"]).defined(),
      operator: yupString().oneOf(["equals", "in"]).defined(),
      value: yupUnion(
        issueAlertStatusSchema,
        yupArray(issueAlertStatusSchema).defined(),
      ).defined(),
    }).defined(),
    yupObject({
      type: yupString().oneOf(["frequency"]).defined(),
      operator: issueAlertFrequencyOperatorSchema,
      count: yupNumber().integer().min(1).defined(),
      windowSeconds: yupNumber().integer().min(1).defined(),
    }).defined(),
    yupObject({
      type: yupString().oneOf(["attribute"]).defined(),
      path: yupString().defined(),
      operator: issueAlertValueOperatorSchema,
      value: yupUnion(
        issueAlertScalarSchema.defined(),
        yupArray(issueAlertScalarSchema.defined()).defined(),
      ).nullable().optional(),
    }).defined(),
  );
}

function issueAlertConditionGroupSchema(levels: readonly string[]) {
  return yupObject({
    all: yupArray(issueAlertPredicateSchema(levels).defined()).optional(),
    any: yupArray(issueAlertPredicateSchema(levels).defined()).optional(),
  }).defined();
}

const issueAlertEmailRoutingSchema = yupUnion(
  yupObject({
    type: yupString().oneOf(["team"]).defined(),
    teamId: yupString().defined(),
  }).defined(),
  yupObject({
    type: yupString().oneOf(["issue_owners"]).defined(),
    fallthrough: yupString().oneOf(["active_members", "all_members", "none"]).defined(),
  }).defined(),
);

const issueAlertActionSchema = yupUnion(
  yupObject({
    type: yupString().oneOf(["email"]).defined(),
    userIds: yupArray(yupString().defined()).optional(),
    routing: issueAlertEmailRoutingSchema.optional(),
    subject: yupString().defined(),
    html: yupString().defined(),
    notificationCategoryName: yupString().optional(),
  }).defined(),
  yupObject({
    type: yupString().oneOf(["webhook"]).defined(),
    integrationId: yupString().defined(),
  }).defined(),
);

function issueAlertRuleSchema(levels: readonly string[]) {
  return yupObject({
    schemaVersion: yupNumber().oneOf([1]).defined(),
    id: yupString().defined(),
    version: yupNumber().integer().min(1).defined(),
    enabled: yupBoolean().defined(),
    filters: issueAlertFiltersSchema(),
    conditions: issueAlertConditionGroupSchema(levels),
    cooldown: yupObject({
      durationSeconds: yupNumber().integer().min(0).defined(),
      keyBy: issueAlertCooldownKeyScopeSchema,
    }).defined(),
    action: issueAlertActionSchema.defined(),
  }).defined();
}

export const IssueAlertRuleMutationSchema = issueAlertRuleSchema(
  ["trace", "debug", "info", "warn", "error", "warning", "fatal"],
);

export const IssueAlertRuleResponseSchema = issueAlertRuleSchema(
  ["trace", "debug", "info", "warn", "error"],
).concat(yupObject({
  database_id: yupString().uuid().defined(),
}).defined());

export const IssueAlertRuleListResponseSchema = yupObject({
  rules: yupArray(IssueAlertRuleResponseSchema).defined(),
  truncated: yupBoolean().defined(),
}).defined();

export const IssueAlertDeliveryResponseSchema = yupObject({
  id: yupString().uuid().defined(),
  rule_id: yupString().uuid().defined(),
  issue_id: yupString().uuid().defined(),
  canonical_issue_id: yupString().uuid().defined(),
  redirected: yupBoolean().defined(),
  redirected_from_issue_id: yupString().uuid().nullable().defined(),
  occurrence_id: yupString().defined(),
  rule_version: yupNumber().integer().defined(),
  event_kind: yupString().oneOf(["new", "regression", "occurrence"]).defined(),
  deduplication_key: yupString().defined(),
  cooldown_key: yupString().defined(),
  cooldown_duration_seconds: yupNumber().integer().defined(),
  cooldown_expires_at_millis: yupNumber().integer().nullable().defined(),
  state: yupString().oneOf(["claimed", "suppressed", "enqueued", "delivered", "failed", "dropped"]).defined(),
  outcome: yupString().oneOf(["none", "cooldown_active", "workflow_enqueued", "workflow_delivered", "workflow_failed", "workflow_dropped", "invalid_rule"]).defined(),
  workflow_event_id: yupString().uuid().nullable().defined(),
  attempt_count: yupNumber().integer().defined(),
  replay_count: yupNumber().integer().defined(),
  last_attempt_at_millis: yupNumber().integer().nullable().defined(),
  next_retry_at_millis: yupNumber().integer().nullable().defined(),
  last_error: yupString().nullable().defined(),
  claimed_at_millis: yupNumber().integer().defined(),
  enqueued_at_millis: yupNumber().integer().nullable().defined(),
  completed_at_millis: yupNumber().integer().nullable().defined(),
  created_at_millis: yupNumber().integer().defined(),
  updated_at_millis: yupNumber().integer().defined(),
}).defined();

export const IssueAlertDeliveryListResponseSchema = yupObject({
  deliveries: yupArray(IssueAlertDeliveryResponseSchema).defined(),
  truncated: yupBoolean().defined(),
}).defined();

function serializeIssueAlertTagFilter(filter: IssueAlertTagFilter) {
  const serialized: { key: string, operator: IssueAlertValueOperator, value?: string | string[] } = {
    key: filter.key,
    operator: filter.operator,
  };
  if (filter.value !== undefined) serialized.value = typeof filter.value === "string" ? filter.value : [...filter.value];
  return serialized;
}

function serializeIssueAlertFilters(filters: IssueAlertRuleFilters) {
  const serialized: {
    projectIds?: string[],
    environments?: string[],
    releases?: string[],
    tags?: ReturnType<typeof serializeIssueAlertTagFilter>[],
  } = {};
  if (filters.projectIds !== undefined) serialized.projectIds = [...filters.projectIds];
  if (filters.environments !== undefined) serialized.environments = [...filters.environments];
  if (filters.releases !== undefined) serialized.releases = [...filters.releases];
  if (filters.tags !== undefined) serialized.tags = filters.tags.map(serializeIssueAlertTagFilter);
  return serialized;
}

function isScalarArray(value: IssueAlertScalar | readonly IssueAlertScalar[]): value is readonly IssueAlertScalar[] {
  return Array.isArray(value);
}

function serializeIssueAlertPredicate(predicate: IssueAlertPredicate) {
  switch (predicate.type) {
    case "new": {
      return { type: predicate.type, value: predicate.value };
    }
    case "regression": {
      return { type: predicate.type, value: predicate.value };
    }
    case "level": {
      return { type: predicate.type, operator: predicate.operator, value: predicate.value };
    }
    case "status": {
      return {
        type: predicate.type,
        operator: predicate.operator,
        value: typeof predicate.value === "string" ? predicate.value : [...predicate.value],
      };
    }
    case "frequency": {
      return {
        type: predicate.type,
        operator: predicate.operator,
        count: predicate.count,
        windowSeconds: predicate.windowSeconds,
      };
    }
    case "attribute": {
      const serialized: {
        type: "attribute",
        path: string,
        operator: IssueAlertValueOperator,
        value?: IssueAlertScalar | IssueAlertScalar[],
      } = {
        type: predicate.type,
        path: predicate.path,
        operator: predicate.operator,
      };
      if (predicate.value !== undefined) serialized.value = isScalarArray(predicate.value) ? [...predicate.value] : predicate.value;
      return serialized;
    }
  }
}

function serializeIssueAlertEmailRouting(routing: IssueAlertEmailRouting) {
  return routing.type === "team"
    ? { type: routing.type, teamId: routing.teamId }
    : { type: routing.type, fallthrough: routing.fallthrough };
}

function serializeIssueAlertAction(action: IssueAlertAction) {
  if (action.type === "webhook") {
    return { type: action.type, integrationId: action.integrationId };
  }
  const serialized: {
    type: "email",
    subject: string,
    html: string,
    userIds?: string[],
    routing?: ReturnType<typeof serializeIssueAlertEmailRouting>,
    notificationCategoryName?: string,
  } = { type: action.type, subject: action.subject, html: action.html };
  if (action.userIds !== undefined) serialized.userIds = [...action.userIds];
  if (action.routing !== undefined) serialized.routing = serializeIssueAlertEmailRouting(action.routing);
  if (action.notificationCategoryName !== undefined) serialized.notificationCategoryName = action.notificationCategoryName;
  return serialized;
}

export function serializeIssueAlertRuleResponse(rule: IssueAlertRuleResponse) {
  const conditions: {
    all?: ReturnType<typeof serializeIssueAlertPredicate>[],
    any?: ReturnType<typeof serializeIssueAlertPredicate>[],
  } = {};
  if (rule.conditions.all !== undefined) conditions.all = rule.conditions.all.map(serializeIssueAlertPredicate);
  if (rule.conditions.any !== undefined) conditions.any = rule.conditions.any.map(serializeIssueAlertPredicate);
  const serialized: {
    schemaVersion: number,
    id: string,
    version: number,
    enabled: boolean,
    filters?: ReturnType<typeof serializeIssueAlertFilters>,
    conditions: typeof conditions,
    cooldown: { durationSeconds: number, keyBy: IssueAlertRuleResponse["cooldown"]["keyBy"] },
    action: ReturnType<typeof serializeIssueAlertAction>,
    database_id: string,
  } = {
    schemaVersion: rule.schemaVersion,
    id: rule.id,
    version: rule.version,
    enabled: rule.enabled,
    conditions,
    cooldown: { durationSeconds: rule.cooldown.durationSeconds, keyBy: rule.cooldown.keyBy },
    action: serializeIssueAlertAction(rule.action),
    database_id: rule.database_id,
  };
  if (rule.filters !== undefined) serialized.filters = serializeIssueAlertFilters(rule.filters);
  return serialized;
}

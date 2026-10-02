
export const ISSUE_ALERT_RULE_SCHEMA_VERSION: 1 = 1;

export type IssueAlertScalar = string | number | boolean | null;

export type IssueAlertLevel = "trace" | "debug" | "info" | "warn" | "error";

export type IssueAlertLevelOperator = "equals" | "gte" | "lte";

export type IssueAlertStatus = "unresolved" | "resolved" | "ignored";

export type IssueAlertEventKind = "new" | "regression" | "occurrence";

export type IssueAlertValueOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "starts_with"
  | "in"
  | "exists"
  | "not_exists";

export type IssueAlertFrequencyOperator = "gt" | "gte" | "lt" | "lte" | "eq";

export type IssueAlertTagFilter = {
  key: string,
  operator: IssueAlertValueOperator,
  value?: string | readonly string[],
};

export type IssueAlertRuleFilters = {
  projectIds?: readonly string[],
  environments?: readonly string[],
  releases?: readonly string[],
  tags?: readonly IssueAlertTagFilter[],
};

export type IssueAlertAttributePredicate = {
  type: "attribute",
  path: string,
  operator: IssueAlertValueOperator,
  value?: IssueAlertScalar | readonly IssueAlertScalar[],
};

export type IssueAlertPredicate =
  | { type: "new", value: boolean }
  | { type: "regression", value: boolean }
  | { type: "level", operator: IssueAlertLevelOperator, value: IssueAlertLevel }
  | { type: "status", operator: "equals" | "in", value: IssueAlertStatus | readonly IssueAlertStatus[] }
  | { type: "frequency", operator: IssueAlertFrequencyOperator, count: number, windowSeconds: number }
  | IssueAlertAttributePredicate;

export type IssueAlertConditionGroup = {
  all?: readonly IssueAlertPredicate[],
  any?: readonly IssueAlertPredicate[],
};

export type IssueAlertCooldownKeyScope =
  | "issue"
  | "issue_environment"
  | "issue_release"
  | "issue_environment_release";

export type IssueAlertCooldown = {
  durationSeconds: number,
  keyBy: IssueAlertCooldownKeyScope,
};

export type {
  IssueAlertAction,
  IssueAlertEmailAction,
  IssueAlertEmailRouting,
  IssueAlertOwnerFallthrough,
  IssueAlertWebhookAction,
} from "./destinations";
import type { IssueAlertAction } from "./destinations";

export type IssueAlertRule = {
  schemaVersion: typeof ISSUE_ALERT_RULE_SCHEMA_VERSION,
  id: string,
  version: number,
  enabled: boolean,
  filters?: IssueAlertRuleFilters,
  conditions: IssueAlertConditionGroup,
  cooldown: IssueAlertCooldown,
  action: IssueAlertAction,
};

export type IssueAlertSignal = {
  tenancyId: string,
  projectId: string,
  branchId: string,
  issue: {
    id: string,
    shortId: string,
    type: string,
    value: string,
    culprit: string | null,
    status: IssueAlertStatus,
    isNew: boolean,
    isRegression: boolean,
  },
  occurrence: {
    id: string,
    occurredAt: Date,
  },
  level?: IssueAlertLevel,
  environment: string | null,
  release: string | null,
  tags: ReadonlyMap<string, string>,
  attributes: ReadonlyMap<string, IssueAlertScalar>,
  frequencyCounts: ReadonlyMap<number, number>,
};

export type IssueAlertRuleScope = Pick<IssueAlertSignal, "tenancyId" | "projectId" | "branchId">;

export type IssueAlertRuleRepository = {
  listActiveRules(scope: IssueAlertRuleScope): Promise<readonly IssueAlertRule[]>;
};

export type IssueAlertNoMatchReason =
  | "rule_disabled"
  | "project_filter"
  | "environment_filter"
  | "release_filter"
  | "tag_filter"
  | "new_predicate"
  | "regression_predicate"
  | "level_predicate"
  | "status_predicate"
  | "frequency_predicate"
  | "frequency_unavailable"
  | "attribute_predicate"
  | "all_predicates"
  | "any_predicates";

export type IssueAlertDropReason =
  | "invalid_rule"
  | "invalid_signal"
  | "unsupported_action";

export type IssueAlertMatch = {
  outcome: "match",
  ruleId: string,
  ruleVersion: number,
  issueId: string,
  occurrenceId: string,
  eventKind: IssueAlertEventKind,
  action: IssueAlertAction,
  cooldown: IssueAlertCooldown,
  cooldownKey: string,
  deduplicationKey: string,
  signal: IssueAlertSignal,
};

export type IssueAlertNoMatch = {
  outcome: "no-match",
  ruleId: string,
  ruleVersion: number,
  reason: IssueAlertNoMatchReason,
  reasons: readonly IssueAlertNoMatchReason[],
};

export type IssueAlertDrop = {
  outcome: "drop",
  ruleId: string | null,
  ruleVersion: number | null,
  reason: IssueAlertDropReason,
};

export type IssueAlertEvaluation = IssueAlertMatch | IssueAlertNoMatch | IssueAlertDrop;

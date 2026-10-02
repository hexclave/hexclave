import {
  DEFAULT_ISSUE_ALERT_EMAIL_HTML,
  DEFAULT_ISSUE_ALERT_EMAIL_SUBJECT,
} from "./issue-alert-email-template";
import type {
  IssueAlertConditionGroup,
  IssueAlertEmailAction,
  IssueAlertPredicate,
  IssueAlertRule,
  IssueAlertRulePayload,
  IssueAlertRuleResponse,
} from "./issue-alerts-data";

export type AlertRuleTrigger = "new" | "regression" | "new_or_regression" | "frequency";

export type AlertRuleDraft = {
  id: string,
  trigger: AlertRuleTrigger,
  frequencyCount: string,
  frequencyWindowSeconds: string,
  cooldownDurationSeconds: string,
  cooldownKeyBy: IssueAlertRule["cooldown"]["keyBy"],
  subject: string,
  html: string,
  notificationCategoryName: string,
  userIds: string[],
  enabled: boolean,
};

export const DEFAULT_ALERT_RULE_DRAFT: AlertRuleDraft = {
  id: "issue-alert",
  trigger: "new_or_regression",
  frequencyCount: "10",
  frequencyWindowSeconds: "300",
  cooldownDurationSeconds: "3600",
  cooldownKeyBy: "issue",
  subject: DEFAULT_ISSUE_ALERT_EMAIL_SUBJECT,
  html: DEFAULT_ISSUE_ALERT_EMAIL_HTML,
  notificationCategoryName: "",
  userIds: [],
  enabled: true,
};

function hasConfiguredFilters(filters: IssueAlertRule["filters"]): boolean {
  if (filters == null) return false;
  return (filters.projectIds != null && filters.projectIds.length > 0)
    || (filters.environments != null && filters.environments.length > 0)
    || (filters.releases != null && filters.releases.length > 0)
    || (filters.tags != null && filters.tags.length > 0);
}

function isTruePredicate(predicate: IssueAlertPredicate, type: "new" | "regression"): boolean {
  return predicate.type === type && predicate.value === true;
}

function getConditionPredicates(group: IssueAlertConditionGroup, key: "all" | "any"): IssueAlertPredicate[] {
  const predicates = group[key];
  return predicates == null ? [] : predicates;
}

type FrequencyGtePredicate = IssueAlertPredicate & {
  type: "frequency",
  operator: "gte",
  count: number,
  windowSeconds: number,
};

function isFrequencyGtePredicate(predicate: IssueAlertPredicate): predicate is FrequencyGtePredicate {
  return predicate.type === "frequency"
    && predicate.operator === "gte"
    && typeof predicate.count === "number"
    && typeof predicate.windowSeconds === "number";
}

export function getSupportedAlertRuleDraft(rule: IssueAlertRuleResponse): AlertRuleDraft | null {
  if (rule.filters != null && hasConfiguredFilters(rule.filters)) return null;

  const all = getConditionPredicates(rule.conditions, "all");
  const any = getConditionPredicates(rule.conditions, "any");
  let trigger: AlertRuleTrigger | null = null;
  let frequencyCount = DEFAULT_ALERT_RULE_DRAFT.frequencyCount;
  let frequencyWindowSeconds = DEFAULT_ALERT_RULE_DRAFT.frequencyWindowSeconds;

  if (all.length === 0 && any.length === 1 && isTruePredicate(any[0], "new")) {
    trigger = "new";
  } else if (all.length === 0 && any.length === 1 && isTruePredicate(any[0], "regression")) {
    trigger = "regression";
  } else if (
    all.length === 0
    && any.length === 2
    && isTruePredicate(any[0], "new")
    && isTruePredicate(any[1], "regression")
  ) {
    trigger = "new_or_regression";
  } else if (
    any.length === 0
    && all.length === 1
    && isFrequencyGtePredicate(all[0])
  ) {
    trigger = "frequency";
    frequencyCount = String(all[0].count);
    frequencyWindowSeconds = String(all[0].windowSeconds);
  }

  if (trigger == null) return null;

  if (rule.action.type === "webhook") return null;
  if (rule.action.userIds === undefined) return null;

  return {
    id: rule.id,
    trigger,
    frequencyCount,
    frequencyWindowSeconds,
    cooldownDurationSeconds: String(rule.cooldown.durationSeconds),
    cooldownKeyBy: rule.cooldown.keyBy,
    subject: rule.action.subject,
    html: rule.action.html,
    notificationCategoryName: rule.action.notificationCategoryName ?? "",
    userIds: [...rule.action.userIds],
    enabled: rule.enabled,
  };
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function issueAlertTriggerLabel(rule: IssueAlertRule): string {
  const all = getConditionPredicates(rule.conditions, "all");
  const any = getConditionPredicates(rule.conditions, "any");
  if (all.length === 0 && any.some((predicate) => isTruePredicate(predicate, "new"))
    && any.some((predicate) => isTruePredicate(predicate, "regression"))) {
    return "New or regressed issues";
  }
  if (all.length === 0 && any.length === 1 && isTruePredicate(any[0], "new")) return "New issues";
  if (all.length === 0 && any.length === 1 && isTruePredicate(any[0], "regression")) return "Regressions";
  if (any.length === 0 && all.length === 1 && isFrequencyGtePredicate(all[0])) {
    return `${all[0].operator} ${all[0].count} events / ${formatDuration(all[0].windowSeconds)}`;
  }
  return "Advanced conditions";
}

export function issueAlertRuleToPayload(rule: IssueAlertRuleResponse): IssueAlertRulePayload {
  const payload: IssueAlertRulePayload = {
    schemaVersion: rule.schemaVersion,
    id: rule.id,
    version: rule.version,
    enabled: rule.enabled,
    conditions: rule.conditions,
    cooldown: rule.cooldown,
    action: rule.action,
  };
  if (rule.filters != null) payload.filters = rule.filters;
  return payload;
}

type BuildRuleResult =
  | { status: "ok", rule: IssueAlertRulePayload }
  | { status: "error", message: string };

function boundedText(
  value: string,
  field: string,
  maxBytes: number,
  options?: { allowHtmlWhitespace?: boolean },
): string | null {
  if (value.length === 0) return `${field} is required`;
  const controlPattern = options?.allowHtmlWhitespace === true
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if (controlPattern.test(value)) return `${field} contains unsupported control characters`;
  if (new TextEncoder().encode(value).byteLength > maxBytes) return `${field} is too long`;
  return null;
}

function parseInteger(value: string, field: string, maximum: number, allowZero: boolean): number | null {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0) || parsed > maximum) {
    return null;
  }
  return parsed;
}

export function buildIssueAlertRule(
  draft: AlertRuleDraft,
  existingRule: IssueAlertRuleResponse | null,
): BuildRuleResult {
  const id = draft.id.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id)) {
    return { status: "error", message: "Rule key must start with a lowercase letter or number and use only a-z, 0-9, dot, dash, or underscore." };
  }
  if (existingRule != null && existingRule.version >= Number.MAX_SAFE_INTEGER) {
    return { status: "error", message: "This rule has reached the maximum supported version and cannot be updated safely." };
  }
  if (draft.userIds.length === 0) return { status: "error", message: "Choose at least one team member to receive the email." };
  if (draft.userIds.some((userId) => userId.trim() === "")) return { status: "error", message: "Recipients must be valid team member IDs." };

  const subject = draft.subject.trim();
  const html = draft.html.trim();
  const subjectError = boundedText(subject, "Subject", 8 * 1024);
  if (subjectError != null) return { status: "error", message: subjectError };
  const htmlError = boundedText(html, "HTML body", 8 * 1024, { allowHtmlWhitespace: true });
  if (htmlError != null) return { status: "error", message: htmlError };
  const category = draft.notificationCategoryName.trim();
  if (category !== "") {
    const categoryError = boundedText(category, "Notification category", 256);
    if (categoryError != null) return { status: "error", message: categoryError };
  }
  const action: IssueAlertEmailAction = {
    type: "email",
    userIds: [...new Set(draft.userIds)],
    subject,
    html,
  };
  if (category !== "") action.notificationCategoryName = category;

  const cooldownDurationSeconds = parseInteger(draft.cooldownDurationSeconds, "Cooldown", 30 * 24 * 60 * 60, true);
  if (cooldownDurationSeconds == null) return { status: "error", message: "Cooldown must be a whole number from 0 to 30 days in seconds." };

  let conditions: IssueAlertConditionGroup;
  if (draft.trigger === "new") {
    conditions = { any: [{ type: "new", value: true }] };
  } else if (draft.trigger === "regression") {
    conditions = { any: [{ type: "regression", value: true }] };
  } else if (draft.trigger === "new_or_regression") {
    conditions = {
      any: [
        { type: "new", value: true },
        { type: "regression", value: true },
      ],
    };
  } else {
    const count = parseInteger(draft.frequencyCount, "Frequency count", 1_000_000_000, false);
    const windowSeconds = parseInteger(draft.frequencyWindowSeconds, "Frequency window", 30 * 24 * 60 * 60, false);
    if (count == null || windowSeconds == null) {
      return { status: "error", message: "Frequency count and window must be whole positive numbers within the supported limits." };
    }
    conditions = {
      all: [{ type: "frequency", operator: "gte", count, windowSeconds }],
    };
  }

  const rule: IssueAlertRulePayload = {
    schemaVersion: 1,
    id,
    version: existingRule == null ? 1 : existingRule.version + 1,
    enabled: draft.enabled,
    conditions,
    cooldown: {
      durationSeconds: cooldownDurationSeconds,
      keyBy: draft.cooldownKeyBy,
    },
    action,
  };
  return { status: "ok", rule };
}

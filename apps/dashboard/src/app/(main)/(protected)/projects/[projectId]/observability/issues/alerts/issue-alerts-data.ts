import * as yup from "yup";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { sendInternalAdminRequest } from "@/lib/hexclave-app-internals";

export type IssueAlertValueOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "starts_with"
  | "in"
  | "exists"
  | "not_exists";

export type IssueAlertScalar = string | number | boolean | null;

export type IssueAlertTagFilter = {
  key: string,
  operator: IssueAlertValueOperator,
  value?: string | string[],
};

export type IssueAlertRuleFilters = {
  projectIds?: string[],
  environments?: string[],
  releases?: string[],
  tags?: IssueAlertTagFilter[],
};

export type IssueAlertPredicate =
 {
   type: string,
    value?: unknown,
   operator?: string,
   path?: string,
   count?: number,
   windowSeconds?: number,
 };

export type IssueAlertConditionGroup = {
  all?: IssueAlertPredicate[],
  any?: IssueAlertPredicate[],
};

export type IssueAlertCooldownKeyScope =
  | "issue"
  | "issue_environment"
  | "issue_release"
  | "issue_environment_release";

export type IssueAlertRule = {
  schemaVersion: number,
  id: string,
  version: number,
  enabled: boolean,
  filters?: IssueAlertRuleFilters,
  conditions: IssueAlertConditionGroup,
  cooldown: {
    durationSeconds: number,
    keyBy: IssueAlertCooldownKeyScope,
  },
  action: IssueAlertAction,
};

export type IssueAlertEmailRouting =
  | { type: "team", teamId: string }
  | { type: "issue_owners", fallthrough: "active_members" | "all_members" | "none" };

type IssueAlertEmailActionBase = {
  type: "email",
  subject: string,
  html: string,
  notificationCategoryName?: string,
};

export type IssueAlertEmailAction = IssueAlertEmailActionBase & (
  | { userIds: string[], routing?: never }
  | { userIds?: never, routing: IssueAlertEmailRouting }
);

export type IssueAlertWebhookAction = {
  type: "webhook",
  integrationId: string,
};

export type IssueAlertAction = IssueAlertEmailAction | IssueAlertWebhookAction;

function isIssueAlertAction(value: unknown): value is IssueAlertAction {
  if (!isRecord(value)) return false;
  const action = value;
  if (action.type === "webhook") return typeof action.integrationId === "string" && action.integrationId.length > 0;
  const hasValidUserIds = Array.isArray(action.userIds)
    && action.userIds.length > 0
    && action.userIds.every((userId) => typeof userId === "string" && userId.length > 0);
  const routing = isRecord(action.routing) ? action.routing : null;
  const hasValidRouting = routing != null
    && (
      (routing.type === "team" && typeof routing.teamId === "string" && routing.teamId.length > 0)
      || (routing.type === "issue_owners"
        && typeof routing.fallthrough === "string"
        && ["active_members", "all_members", "none"].includes(routing.fallthrough))
    );
  return action.type === "email"
    && hasValidUserIds !== hasValidRouting
    && typeof action.subject === "string"
    && typeof action.html === "string"
    && (action.notificationCategoryName === undefined || typeof action.notificationCategoryName === "string");
}

export type IssueAlertRuleResponse = IssueAlertRule & {
  database_id: string,
};

export type IssueAlertRulePayload = IssueAlertRule;

export type IssueAlertDelivery = {
  id: string,
  rule_id: string,
  issue_id: string,
  canonical_issue_id: string,
  redirected: boolean,
  redirected_from_issue_id: string | null,
  occurrence_id: string,
  rule_version: number,
  event_kind: string,
  deduplication_key: string,
  cooldown_key: string,
  cooldown_duration_seconds: number,
  cooldown_expires_at_millis: number | null,
  state: string,
  outcome: string,
  workflow_event_id: string | null,
  attempt_count: number,
  replay_count: number,
  last_attempt_at_millis: number | null,
  next_retry_at_millis: number | null,
  last_error: string | null,
  claimed_at_millis: number,
  enqueued_at_millis: number | null,
  completed_at_millis: number | null,
  created_at_millis: number,
  updated_at_millis: number,
};

export type IssueAlertDeliveryPage = {
  deliveries: IssueAlertDelivery[],
  truncated: boolean,
};

const predicateSchema = yup.object({
  type: yup.string().defined(),
  value: yup.mixed().optional(),
  operator: yup.string().optional(),
  path: yup.string().optional(),
  count: yup.number().optional(),
  windowSeconds: yup.number().optional(),
}).defined();

const issueAlertRuleSchema = yup.object({
  schemaVersion: yup.number().oneOf([1]).defined(),
  id: yup.string().defined(),
  version: yup.number().integer().positive().defined(),
  enabled: yup.boolean().defined(),
  filters: yup.mixed<IssueAlertRuleFilters>().optional(),
  conditions: yup.object({
    all: yup.array(predicateSchema).optional(),
    any: yup.array(predicateSchema).optional(),
  }).defined(),
  cooldown: yup.object({
    durationSeconds: yup.number().integer().min(0).defined(),
    keyBy: yup.string().oneOf([
      "issue",
      "issue_environment",
      "issue_release",
      "issue_environment_release",
    ]).defined(),
  }).defined(),
  action: yup.mixed<IssueAlertAction>().test("issue-alert-action", "Invalid issue alert destination", isIssueAlertAction).defined(),
  database_id: yup.string().defined(),
}).defined();

const issueAlertRulesResponseSchema = yup.object({
  rules: yup.array(issueAlertRuleSchema).defined(),
  truncated: yup.boolean().optional(),
}).defined();

const issueAlertRuleResponseSchema = yup.object({
  rule: issueAlertRuleSchema,
}).defined();

const issueAlertDeliverySchema = yup.object({
  id: yup.string().defined(),
  rule_id: yup.string().defined(),
  issue_id: yup.string().defined(),
  canonical_issue_id: yup.string().defined(),
  redirected: yup.boolean().defined(),
  redirected_from_issue_id: yup.string().nullable().defined(),
  occurrence_id: yup.string().defined(),
  rule_version: yup.number().integer().positive().defined(),
  event_kind: yup.string().oneOf(["new", "regression", "occurrence"]).defined(),
  deduplication_key: yup.string().defined(),
  cooldown_key: yup.string().defined(),
  cooldown_duration_seconds: yup.number().integer().min(0).defined(),
  cooldown_expires_at_millis: yup.number().integer().min(0).nullable().defined(),
  state: yup.string().oneOf(["claimed", "suppressed", "enqueued", "delivered", "failed", "dropped"]).defined(),
  outcome: yup.string().oneOf(["none", "cooldown_active", "workflow_enqueued", "workflow_delivered", "workflow_failed", "workflow_dropped", "invalid_rule"]).defined(),
  workflow_event_id: yup.string().nullable().defined(),
  attempt_count: yup.number().integer().min(0).defined(),
  replay_count: yup.number().integer().min(0).defined(),
  last_attempt_at_millis: yup.number().integer().min(0).nullable().defined(),
  next_retry_at_millis: yup.number().integer().min(0).nullable().defined(),
  last_error: yup.string().nullable().defined(),
  claimed_at_millis: yup.number().integer().min(0).defined(),
  enqueued_at_millis: yup.number().integer().min(0).nullable().defined(),
  completed_at_millis: yup.number().integer().min(0).nullable().defined(),
  created_at_millis: yup.number().integer().min(0).defined(),
  updated_at_millis: yup.number().integer().min(0).defined(),
}).defined();

const issueAlertDeliveriesResponseSchema = yup.object({
  deliveries: yup.array(issueAlertDeliverySchema).defined(),
  truncated: yup.boolean().defined(),
}).defined();

async function readJsonOrThrow(response: Response, operation: string): Promise<Json> {
  if (!response.ok) {
    throw new HexclaveAssertionError(`${operation} failed with status ${response.status}`);
  }
  return await response.json();
}

export async function fetchIssueAlertRules(adminApp: object): Promise<{ rules: IssueAlertRuleResponse[], truncated: boolean }> {
  const response = await sendInternalAdminRequest(adminApp, "/issues/alerts", { method: "GET" });
  const body = await issueAlertRulesResponseSchema.validate(await readJsonOrThrow(response, "Loading issue alert rules"));
  return { rules: body.rules, truncated: body.truncated === true };
}

export async function replayIssueAlertDelivery(
  adminApp: object,
  deliveryId: string,
): Promise<{ replayed: boolean }> {
  const response = await sendInternalAdminRequest(
    adminApp,
    `/issues/alerts/deliveries/${encodeURIComponent(deliveryId)}/replay`,
    { method: "POST" },
  );
  const body = await yup.object({
    replayed: yup.boolean().defined(),
  }).defined().validate(await readJsonOrThrow(response, "Replaying issue alert delivery"));
  return { replayed: body.replayed };
}

export async function saveIssueAlertRule(
  adminApp: object,
  rule: IssueAlertRulePayload,
): Promise<IssueAlertRuleResponse> {
  const response = await sendInternalAdminRequest(adminApp, "/issues/alerts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rule }),
  });
  const body = await issueAlertRuleResponseSchema.validate(await readJsonOrThrow(response, "Saving issue alert rule"));
  return body.rule;
}

export const ISSUE_ALERT_DELIVERY_LIMIT = 20;

export async function fetchIssueAlertDeliveries(
  adminApp: object,
  limit = ISSUE_ALERT_DELIVERY_LIMIT,
): Promise<IssueAlertDeliveryPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HexclaveAssertionError("Issue alert delivery limit must be a whole number from 1 to 100");
  }
  const params = new URLSearchParams({ limit: String(limit) });
  const response = await sendInternalAdminRequest(adminApp, `/issues/alerts/deliveries?${params.toString()}`, { method: "GET" });
  return await issueAlertDeliveriesResponseSchema.validate(await readJsonOrThrow(response, "Loading issue alert deliveries"));
}

import {
  ISSUE_ALERT_EMAIL_WORKFLOW_ID,
  ISSUE_ALERT_WORKFLOW_CUSTOM_EVENT_NAME,
  ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
} from "./contract";

export const ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE = `
import { customEvent, hexclaveApp, NonRetriableError, workflow } from "@hexclave/workflows";

type IssueAlertAction = {
  type: "email",
  user_ids?: string[],
  emails?: string[],
  routing_resolution?: {
    schema_version: 1,
    target: {
      type: "team",
      team_id: string,
    } | {
      type: "issue_owners",
      fallthrough: "active_members" | "all_members" | "none",
    },
    status: "resolved" | "empty" | "rejected",
    reason: string,
    recipient_count: number,
    output_truncated: boolean,
    trace_truncated: boolean,
    trace: Array<{
      stage: string,
      decision: string,
      code: string,
      participant_type?: string,
      participant_id?: string,
      target_type?: string,
      owner_source?: string,
      count?: number,
    }>,
  },
  subject: string,
  html: string,
  notification_category_name?: string,
} | {
  type: "webhook",
  integration_id: string,
};

type IssueAlertPayload = {
  schema_version: 2,
  kind: "issue_alert",
  cooldown_key: string,
  cooldown_seconds: number,
  action: IssueAlertAction,
};

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIdentifier(value: unknown): value is string {
  return isString(value)
    && !/[\\u0000-\\u001f\\u007f]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= 256;
}

function isOneOf(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value);
}

function isStringArray(value: unknown, allowEmpty: boolean): value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 64) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isIdentifier(item) || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function isRoutingResolution(value: unknown): value is NonNullable<IssueAlertAction["routing_resolution"]> {
  if (!isObject(value)
    || value.schema_version !== 1
    || (value.status !== "resolved" && value.status !== "empty" && value.status !== "rejected")
    || !isOneOf(value.reason, ["target_resolved", "fallthrough_resolved", "no_recipient", "invalid_input", "invalid_timestamp", "duplicate_member", "duplicate_team", "input_limit", "scope_mismatch"])
    || typeof value.recipient_count !== "number"
    || !Number.isSafeInteger(value.recipient_count)
    || value.recipient_count < 0
    || value.recipient_count > 64
    || typeof value.output_truncated !== "boolean"
    || typeof value.trace_truncated !== "boolean"
    || !Array.isArray(value.trace)
    || value.trace.length > 64) return false;
  if (!isObject(value.target)) return false;
  if (value.target.type === "team") {
    if (!isIdentifier(value.target.team_id)) return false;
  } else if (value.target.type === "issue_owners") {
    if (value.target.fallthrough !== "active_members"
      && value.target.fallthrough !== "all_members"
      && value.target.fallthrough !== "none") return false;
  } else {
    return false;
  }
  return value.trace.every((entry) => {
    if (!isObject(entry)
      || !isOneOf(entry.stage, ["scope", "input", "target", "candidate", "fallthrough", "output"])
      || !isOneOf(entry.decision, ["accepted", "selected", "skipped", "rejected", "limited"])
      || !isOneOf(entry.code, ["scope_accepted", "scope_mismatch", "invalid_input", "invalid_timestamp", "duplicate_member", "duplicate_team", "input_limit", "input_accepted", "target_member", "target_team", "target_issue_owners", "member_selected", "team_selected", "owner_selected", "member_unresolved", "team_unresolved", "owner_unresolved", "duplicate_suppressed", "fallthrough_considered", "fallthrough_selected", "fallthrough_none", "recipient_limit", "resolution_complete", "resolution_rejected", "trace_truncated"])) return false;
    if (entry.participant_type !== undefined && !isOneOf(entry.participant_type, ["user", "team"])) return false;
    if (entry.participant_id !== undefined && !isIdentifier(entry.participant_id)) return false;
    if (entry.target_type !== undefined && !isOneOf(entry.target_type, ["member", "team", "issue_owners"])) return false;
    if (entry.owner_source !== undefined && !isOneOf(entry.owner_source, ["manual", "ownership_rule", "codeowners", "suspect_commit", "seer_suggested"])) return false;
    return entry.count === undefined
      || (typeof entry.count === "number" && Number.isSafeInteger(entry.count) && entry.count >= 0 && entry.count <= 1_000_000);
  });
}

function isIssueAlertPayload(value: unknown): value is IssueAlertPayload {
  if (!isObject(value) || value.schema_version !== 2 || value.kind !== "issue_alert" || !isString(value.cooldown_key)) return false;
  if (typeof value.cooldown_seconds !== "number" || !Number.isSafeInteger(value.cooldown_seconds) || value.cooldown_seconds < 0 || value.cooldown_seconds > 2592000) return false;
  if (!isObject(value.action) || typeof value.action.type !== "string") return false;
  if (value.action.type === "email") {
    const hasUserIds = value.action.user_ids !== undefined;
    const hasEmails = value.action.emails !== undefined;
    const hasRoutingResolution = value.action.routing_resolution !== undefined;
    if (!hasUserIds
      || !isStringArray(value.action.user_ids, hasRoutingResolution)
      || (hasEmails && (hasRoutingResolution || !isStringArray(value.action.emails, false) || value.action.emails.length !== value.action.user_ids.length))
      || (hasRoutingResolution && !isRoutingResolution(value.action.routing_resolution))
      || !isString(value.action.subject)
      || !isString(value.action.html)) return false;
    if (hasRoutingResolution) {
      const resolution = value.action.routing_resolution;
      if (resolution.status === "resolved"
        ? resolution.recipient_count !== value.action.user_ids.length || value.action.user_ids.length === 0
        : resolution.recipient_count !== 0 || value.action.user_ids.length !== 0) return false;
    }
    return value.action.notification_category_name === undefined || isString(value.action.notification_category_name);
  }
  return value.action.type === "webhook" && isString(value.action.integration_id);
}

function requireIssueAlertPayload(value: unknown): IssueAlertPayload {
  if (!isIssueAlertPayload(value)) throw new NonRetriableError("Invalid issue-alert workflow payload");
  return value;
}

export default workflow<IssueAlertPayload>("issue-alert-email", {
  on: [customEvent("hexclave.issue-alert")],
  runKey: (event) => requireIssueAlertPayload(event.data).cooldown_key,
  onConflict: "skip",
}, async (event, step) => {
  requireIssueAlertPayload(event.data);
  if (event.data.action.type !== "email") {
    throw new NonRetriableError("Issue alert webhook destination is not configured");
  }
  if (event.data.action.user_ids === undefined) {
    throw new NonRetriableError("Issue alert email recipient routing is not configured");
  }
  if (event.data.action.routing_resolution !== undefined
    && (event.data.action.routing_resolution.status !== "resolved"
      || event.data.action.routing_resolution.output_truncated
      || event.data.action.user_ids.length === 0)) {
    throw new NonRetriableError("Issue alert email recipient routing resolved to no deliverable recipients");
  }
  if (event.data.action.user_ids.length === 0) {
    throw new NonRetriableError("Issue alert email recipient routing is not configured");
  }
  await step.run("send-email", async () => {
    if (event.data.action.emails !== undefined && event.data.action.emails.length > 0) {
      await hexclaveApp.sendEmail({
        idempotencyKey: event.id + ":send-email",
        emails: event.data.action.emails,
        html: event.data.action.html,
        subject: event.data.action.subject,
        notificationCategoryName: event.data.action.notification_category_name,
      });
      return;
    }
    await hexclaveApp.sendEmail({
      idempotencyKey: event.id + ":send-email",
      userIds: event.data.action.user_ids,
      html: event.data.action.html,
      subject: event.data.action.subject,
      notificationCategoryName: event.data.action.notification_category_name,
    });
  });
  if (event.data.cooldown_seconds > 0) await step.sleep("cooldown", event.data.cooldown_seconds * 1000);
});
`;

export type IssueAlertWorkflowSourceContract = {
  workflowId: typeof ISSUE_ALERT_EMAIL_WORKFLOW_ID,
  triggerEventType: typeof ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
  deliveryBoundary: "ServerApp.sendEmail",
  durableEmailStore: "EmailOutbox",
  terminalFailureState: "dropped",
  source: typeof ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE,
};

export const ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE_CONTRACT = {
  workflowId: ISSUE_ALERT_EMAIL_WORKFLOW_ID,
  triggerEventType: ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
  deliveryBoundary: "ServerApp.sendEmail",
  durableEmailStore: "EmailOutbox",
  terminalFailureState: "dropped",
  source: ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE,
} satisfies IssueAlertWorkflowSourceContract;

export type IssueAlertWorkflowSourceValidation =
  | { status: "ok" }
  | {
    status: "error",
    reason:
      | "missing_issue_alert_trigger"
      | "missing_server_app_email_action"
      | "direct_email_provider_call";
  };

const DIRECT_EMAIL_CALL_MARKERS: readonly string[] = [
  "sendemailtomany",
  "sendemailfromdefaulttemplate",
  "sendemailtoprovider",
  "nodemailer",
  "resend",
  "smtp",
  "sendmail",
  "fetch(",
];

export function validateIssueAlertWorkflowSource(source: string): IssueAlertWorkflowSourceValidation {
  const lowerSource = source.toLowerCase();
  if (DIRECT_EMAIL_CALL_MARKERS.some((marker) => lowerSource.includes(marker))) {
    return { status: "error", reason: "direct_email_provider_call" };
  }
  if (!source.includes(`customEvent("${ISSUE_ALERT_WORKFLOW_CUSTOM_EVENT_NAME}")`)) {
    return { status: "error", reason: "missing_issue_alert_trigger" };
  }
  if (!source.includes("hexclaveApp.sendEmail({")) {
    return { status: "error", reason: "missing_server_app_email_action" };
  }
  return { status: "ok" };
}

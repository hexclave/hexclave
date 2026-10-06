import { isErrorIngestScrubbedRecord, scrubErrorIngestPayload, type ErrorIngestScrubbedRecord, type ErrorIngestScrubbedValue } from "@/lib/error-ingest";
import { type PrismaClientTransaction } from "@/prisma-client";
import type { Tenancy } from "@/lib/tenancies";
import { deterministicWorkflowUuid, enqueueWorkflowEvent, type EnqueueWorkflowEventOptions } from "@/lib/workflows/events";
import type {
  IssueAlertEventKind,
  IssueAlertMatch,
  IssueAlertSignal,
  IssueAlertStatus,
} from "@/lib/issues/issue-alerts/types";
import type { IssueAlertEmailRouting } from "@/lib/issues/issue-alerts/destinations";
import {
  parseOwnershipRoutingMetadata,
  type OwnershipRoutingMetadata,
  type OwnershipRoutingResolution,
} from "@/lib/issues/ownership/routing-metadata";
import {
  interpolateIssueAlertEmailTemplate,
  type IssueAlertEmailPlaceholderToken,
} from "@/lib/issues/issue-alerts/email-template";
import { resolveIssueAlertOwnerTeamEmails } from "@/lib/issues/issue-alerts/owner-team-recipients";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { urlString } from "@hexclave/shared/dist/utils/urls";

export const ISSUE_ALERT_WORKFLOW_CUSTOM_EVENT_NAME: "hexclave.issue-alert" = "hexclave.issue-alert";
export const ISSUE_ALERT_WORKFLOW_EVENT_TYPE: "custom.hexclave.issue-alert" = "custom.hexclave.issue-alert";
export const ISSUE_ALERT_EMAIL_WORKFLOW_ID: "issue-alert-email" = "issue-alert-email";
export const ISSUE_ALERT_WORKFLOW_PAYLOAD_VERSION: 2 = 2;
export const ISSUE_ALERT_WORKFLOW_PAYLOAD_MAX_BYTES = 32 * 1024;
export const ISSUE_ALERT_WORKFLOW_MAX_STRING_BYTES = 8 * 1024;
export const ISSUE_ALERT_WORKFLOW_MAX_RECIPIENTS = 64;

export type IssueAlertWorkflowEmailAction = {
  type: "email",
  user_ids?: readonly string[],
  emails?: readonly string[],
  routing_resolution?: OwnershipRoutingMetadata,
  subject: string,
  html: string,
  notification_category_name?: string,
};

export type IssueAlertWorkflowWebhookAction = {
  type: "webhook",
  integration_id: string,
};

export type IssueAlertWorkflowAction = IssueAlertWorkflowEmailAction | IssueAlertWorkflowWebhookAction;

export type IssueAlertWorkflowEventPayload = {
  schema_version: typeof ISSUE_ALERT_WORKFLOW_PAYLOAD_VERSION,
  kind: "issue_alert",
  event_kind: IssueAlertEventKind,
  project_id: string,
  branch_id: string,
  issue_id: string,
  issue_short_id: string,
  issue_status: IssueAlertStatus,
  occurrence_id: string,
  occurred_at_millis: number,
  environment: string | null,
  release: string | null,
  summary: string,
  culprit: string | null,
  rule_id: string,
  rule_version: number,
  deduplication_key: string,
  cooldown_key: string,
  cooldown_seconds: number,
  action: IssueAlertWorkflowAction,
};

export type IssueAlertWorkflowPayloadDropReason =
  | "invalid_tenancy"
  | "ownership_resolution_required"
  | "invalid_payload"
  | "privacy_scrubbed_empty"
  | "payload_too_large";

export type IssueAlertWorkflowPayloadResult =
  | {
    status: "ok",
    payload: IssueAlertWorkflowEventPayload,
    byteLength: number,
    scrubbed: boolean,
  }
  | {
    status: "drop",
    reason: IssueAlertWorkflowPayloadDropReason,
    byteLength: number,
    scrubbed: boolean,
  };

export type IssueAlertWorkflowEventWriteResult =
  | {
    status: "ok",
    payload: IssueAlertWorkflowEventPayload,
    byteLength: number,
    scrubbed: boolean,
    write: IssueAlertWorkflowEventWrite,
  }
  | {
    status: "drop",
    reason: IssueAlertWorkflowPayloadDropReason,
    byteLength: number,
    scrubbed: boolean,
  };

export type IssueAlertWorkflowEventWrite = Omit<EnqueueWorkflowEventOptions, "payload" | "type"> & {
  type: typeof ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
  payload: IssueAlertWorkflowEventPayload,
  eventId: string,
};

export type IssueAlertWorkflowEventWriter = (
  options: IssueAlertWorkflowEventWrite,
) => Promise<{ eventId: string } | null>;

export type IssueAlertWorkflowEnqueueResult =
  | {
    status: "enqueued",
    eventId: string,
    payload: IssueAlertWorkflowEventPayload,
    byteLength: number,
  }
  | {
    status: "dropped",
    reason: IssueAlertWorkflowPayloadDropReason | "workflow_event_rejected",
    byteLength: number,
  };

function getField(object: ErrorIngestScrubbedRecord, key: string): ErrorIngestScrubbedValue | undefined {
  return object[key];
}

function getRequiredString(object: ErrorIngestScrubbedRecord, key: string): string | null {
  const value = getField(object, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getNullableString(object: ErrorIngestScrubbedRecord, key: string): string | null | undefined {
  const value = getField(object, key);
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function getRequiredNumber(object: ErrorIngestScrubbedRecord, key: string): number | null {
  const value = getField(object, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getStringArray(object: ErrorIngestScrubbedRecord, key: string, allowEmpty: boolean): readonly string[] | null {
  const value = getField(object, key);
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > ISSUE_ALERT_WORKFLOW_MAX_RECIPIENTS) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string"
      || item.length === 0
      || /[\u0000-\u001f\u007f]/u.test(item)
      || new TextEncoder().encode(item).byteLength > 256
      || seen.has(item)) return null;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function isIssueAlertEventKind(value: string | null): value is IssueAlertEventKind {
  return value === "new" || value === "regression" || value === "occurrence";
}

function isIssueAlertStatus(value: string | null): value is IssueAlertStatus {
  return value === "unresolved" || value === "resolved" || value === "ignored";
}

function isIssueAlertTenancy(tenancy: Pick<Tenancy, "id">): tenancy is Tenancy {
  return "project" in tenancy;
}

function routingMetadataMatches(routing: IssueAlertEmailRouting | undefined, metadata: OwnershipRoutingMetadata): boolean {
  if (routing === undefined) return false;
  if (routing.type === "team") {
    return metadata.target.type === "team" && metadata.target.team_id === routing.teamId;
  }
  return metadata.target.type === "issue_owners" && metadata.target.fallthrough === routing.fallthrough;
}

function eventKindLabel(kind: IssueAlertEventKind): string {
  switch (kind) {
    case "new": {
      return "New issue";
    }
    case "regression": {
      return "Regression";
    }
    case "occurrence": {
      return "Frequency threshold";
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown issue alert event kind: ${exhaustive}`);
    }
  }
}

function formatOccurredAt(occurredAt: Date): string {
  return `${occurredAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function issueDashboardUrl(projectId: string, issueId: string): string {
  const dashboardUrl = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL", "");
  if (dashboardUrl === "") return "";
  return urlString`${dashboardUrl}/projects/${projectId}/observability/issues/${issueId}`;
}

function issueAlertEmailValues(match: IssueAlertMatch): Map<IssueAlertEmailPlaceholderToken, string> {
  const signal = match.signal;
  return new Map([
    ["short_id", signal.issue.shortId],
    ["type", signal.issue.type],
    ["summary", signal.issue.value],
    ["culprit", signal.issue.culprit ?? "—"],
    ["environment", signal.environment ?? "—"],
    ["release", signal.release ?? "—"],
    ["status", signal.issue.status],
    ["kind", eventKindLabel(match.eventKind)],
    ["occurred_at", formatOccurredAt(signal.occurrence.occurredAt)],
    ["issue_url", issueDashboardUrl(signal.projectId, signal.issue.id)],
  ]);
}

function renderIssueAlertEmailAction(match: IssueAlertMatch): { subject: string, html: string } {
  if (match.action.type !== "email") {
    throw new Error("Issue alert email rendering requires an email action");
  }
  const values = issueAlertEmailValues(match);
  return {
    subject: interpolateIssueAlertEmailTemplate(match.action.subject, values, { escapeHtml: false }),
    html: interpolateIssueAlertEmailTemplate(match.action.html, values, { escapeHtml: true }),
  };
}

function buildRawPayload(
  match: IssueAlertMatch,
  routingResolution?: OwnershipRoutingResolution,
  recipientEmails?: readonly string[],
): IssueAlertWorkflowEventPayload {
  const signal: IssueAlertSignal = match.signal;
  let action: IssueAlertWorkflowAction;
  if (match.action.type === "email") {
    const emailAction = renderIssueAlertEmailAction(match);
    const email: IssueAlertWorkflowEmailAction = {
      type: "email",
      subject: emailAction.subject,
      html: emailAction.html,
    };
    if (match.action.userIds === undefined) {
      email.user_ids = routingResolution?.recipients.map((recipient) => recipient.userId) ?? [];
      if (routingResolution !== undefined) email.routing_resolution = routingResolution.metadata;
    } else {
      email.user_ids = match.action.userIds;
      if (recipientEmails !== undefined && recipientEmails.length > 0) email.emails = recipientEmails;
    }
    if (match.action.notificationCategoryName !== undefined) email.notification_category_name = match.action.notificationCategoryName;
    action = email;
  } else {
    action = { type: "webhook", integration_id: match.action.integrationId };
  }
  return {
    schema_version: ISSUE_ALERT_WORKFLOW_PAYLOAD_VERSION,
    kind: "issue_alert",
    event_kind: match.eventKind,
    project_id: signal.projectId,
    branch_id: signal.branchId,
    issue_id: signal.issue.id,
    issue_short_id: signal.issue.shortId,
    issue_status: signal.issue.status,
    occurrence_id: signal.occurrence.id,
    occurred_at_millis: signal.occurrence.occurredAt.getTime(),
    environment: signal.environment,
    release: signal.release,
    summary: signal.issue.value,
    culprit: signal.issue.culprit,
    rule_id: match.ruleId,
    rule_version: match.ruleVersion,
    deduplication_key: match.deduplicationKey,
    cooldown_key: match.cooldownKey,
    cooldown_seconds: match.cooldown.durationSeconds,
    action,
  };
}

export function buildIssueAlertWorkflowPayload(
  match: IssueAlertMatch,
  ownershipResolution?: OwnershipRoutingResolution,
  recipientEmails?: readonly string[],
): IssueAlertWorkflowPayloadResult {
  if (match.action.type === "email"
    && match.action.userIds === undefined
    && ownershipResolution === undefined) {
    return { status: "drop", reason: "ownership_resolution_required", byteLength: 0, scrubbed: false };
  }
  if (match.action.type === "email"
    && match.action.userIds !== undefined
    && ownershipResolution !== undefined) {
    return { status: "drop", reason: "invalid_payload", byteLength: 0, scrubbed: false };
  }
  const scrubbed = scrubErrorIngestPayload(buildRawPayload(match, ownershipResolution, recipientEmails), {
    maxDepth: 6,
    maxPayloadBytes: ISSUE_ALERT_WORKFLOW_PAYLOAD_MAX_BYTES,
    maxStringBytes: ISSUE_ALERT_WORKFLOW_MAX_STRING_BYTES,
    maxKeyBytes: 128,
    maxCollectionEntries: ISSUE_ALERT_WORKFLOW_MAX_RECIPIENTS,
  });
  if (scrubbed.value === undefined) {
    const tooLarge = scrubbed.dropped.some((path) => path.endsWith(".bytes"));
    return {
      status: "drop",
      reason: tooLarge ? "payload_too_large" : "privacy_scrubbed_empty",
      byteLength: scrubbed.byteLength,
      scrubbed: scrubbed.truncated,
    };
  }
  if (!isErrorIngestScrubbedRecord(scrubbed.value)) {
    return { status: "drop", reason: "invalid_payload", byteLength: scrubbed.byteLength, scrubbed: scrubbed.truncated };
  }

  const actionValue = getField(scrubbed.value, "action");
  if (!isErrorIngestScrubbedRecord(actionValue)) {
    return { status: "drop", reason: "invalid_payload", byteLength: scrubbed.byteLength, scrubbed: scrubbed.truncated };
  }

  const schemaVersion = getRequiredNumber(scrubbed.value, "schema_version");
  const ruleVersion = getRequiredNumber(scrubbed.value, "rule_version");
  const occurredAtMillis = getRequiredNumber(scrubbed.value, "occurred_at_millis");
  const cooldownSeconds = getRequiredNumber(scrubbed.value, "cooldown_seconds");
  const projectId = getRequiredString(scrubbed.value, "project_id");
  const branchId = getRequiredString(scrubbed.value, "branch_id");
  const issueId = getRequiredString(scrubbed.value, "issue_id");
  const issueShortId = getRequiredString(scrubbed.value, "issue_short_id");
  const occurrenceId = getRequiredString(scrubbed.value, "occurrence_id");
  const summary = getRequiredString(scrubbed.value, "summary");
  const ruleId = getRequiredString(scrubbed.value, "rule_id");
  const deduplicationKey = getRequiredString(scrubbed.value, "deduplication_key");
  const cooldownKey = getRequiredString(scrubbed.value, "cooldown_key");
  const environment = getNullableString(scrubbed.value, "environment");
  const release = getNullableString(scrubbed.value, "release");
  const culprit = getNullableString(scrubbed.value, "culprit");
  const eventKind = getRequiredString(scrubbed.value, "event_kind");
  const issueStatus = getRequiredString(scrubbed.value, "issue_status");
  const actionType = getRequiredString(actionValue, "type");
  const userIdsValue = getField(actionValue, "user_ids");
  const routingResolutionValue = getField(actionValue, "routing_resolution");
  const parsedRoutingResolution = routingResolutionValue === undefined
    ? undefined
    : parseOwnershipRoutingMetadata(routingResolutionValue);
  const userIds = userIdsValue === undefined
    ? undefined
    : getStringArray(actionValue, "user_ids", routingResolutionValue !== undefined);
  const emailsValue = getField(actionValue, "emails");
  const emails = emailsValue === undefined
    ? undefined
    : getStringArray(actionValue, "emails", false);
  const subject = getRequiredString(actionValue, "subject");
  const html = getRequiredString(actionValue, "html");
  const integrationId = getRequiredString(actionValue, "integration_id");
  const notificationCategoryRaw = getField(actionValue, "notification_category_name");
  const notificationCategoryName = getNullableString(actionValue, "notification_category_name");

  if (schemaVersion !== ISSUE_ALERT_WORKFLOW_PAYLOAD_VERSION
    || ruleVersion === null
    || occurredAtMillis === null
    || cooldownSeconds === null
    || projectId === null
    || branchId === null
    || issueId === null
    || issueShortId === null
    || occurrenceId === null
    || summary === null
    || ruleId === null
    || deduplicationKey === null
    || cooldownKey === null
    || environment === undefined
    || release === undefined
    || culprit === undefined
    || !isIssueAlertEventKind(eventKind)
    || !isIssueAlertStatus(issueStatus)
    || (notificationCategoryRaw !== undefined && notificationCategoryName === undefined)) {
    return { status: "drop", reason: "invalid_payload", byteLength: scrubbed.byteLength, scrubbed: scrubbed.truncated };
  }

  let action: IssueAlertWorkflowAction;
  if (actionType === "email") {
    if (match.action.type !== "email"
      || userIds === undefined
      || userIds === null
      || emails === null
      || (routingResolutionValue !== undefined && parsedRoutingResolution === null)
      || (emails !== undefined && (routingResolutionValue !== undefined || emails.length !== userIds.length))
      || subject === null
      || html === null) {
      return { status: "drop", reason: "invalid_payload", byteLength: scrubbed.byteLength, scrubbed: scrubbed.truncated };
    }
    if (parsedRoutingResolution !== undefined && parsedRoutingResolution !== null) {
      const recipientCountMatches = parsedRoutingResolution.recipient_count === userIds.length;
      if (!routingMetadataMatches(match.action.routing, parsedRoutingResolution)
        || (parsedRoutingResolution.status === "resolved" && (userIds.length === 0 || !recipientCountMatches))
        || (parsedRoutingResolution.status !== "resolved" && (userIds.length !== 0 || parsedRoutingResolution.recipient_count !== 0))) {
        return { status: "drop", reason: "invalid_payload", byteLength: scrubbed.byteLength, scrubbed: scrubbed.truncated };
      }
    }
    const emailWorkflowAction: IssueAlertWorkflowEmailAction = {
      type: "email",
      user_ids: userIds,
      subject,
      html,
    };
    if (emails !== undefined) emailWorkflowAction.emails = emails;
    if (parsedRoutingResolution !== undefined && parsedRoutingResolution !== null) emailWorkflowAction.routing_resolution = parsedRoutingResolution;
    if (notificationCategoryName !== undefined && notificationCategoryName !== null) emailWorkflowAction.notification_category_name = notificationCategoryName;
    action = emailWorkflowAction;
  } else if (actionType === "webhook") {
    if (integrationId === null) {
      return { status: "drop", reason: "invalid_payload", byteLength: scrubbed.byteLength, scrubbed: scrubbed.truncated };
    }
    action = { type: "webhook", integration_id: integrationId };
  } else {
    return { status: "drop", reason: "invalid_payload", byteLength: scrubbed.byteLength, scrubbed: scrubbed.truncated };
  }

  const payload: IssueAlertWorkflowEventPayload = {
    schema_version: ISSUE_ALERT_WORKFLOW_PAYLOAD_VERSION,
    kind: "issue_alert",
    event_kind: eventKind,
    project_id: projectId,
    branch_id: branchId,
    issue_id: issueId,
    issue_short_id: issueShortId,
    issue_status: issueStatus,
    occurrence_id: occurrenceId,
    occurred_at_millis: occurredAtMillis,
    environment,
    release,
    summary,
    culprit,
    rule_id: ruleId,
    rule_version: ruleVersion,
    deduplication_key: deduplicationKey,
    cooldown_key: cooldownKey,
    cooldown_seconds: cooldownSeconds,
    action,
  };
  const byteLength = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (byteLength > ISSUE_ALERT_WORKFLOW_PAYLOAD_MAX_BYTES) {
    return { status: "drop", reason: "payload_too_large", byteLength, scrubbed: scrubbed.truncated };
  }
  return { status: "ok", payload, byteLength, scrubbed: scrubbed.truncated };
}

export function buildIssueAlertWorkflowEventWrite(
  tenancy: Pick<Tenancy, "id">,
  match: IssueAlertMatch,
  routingResolution?: OwnershipRoutingResolution,
  recipientEmails?: readonly string[],
): IssueAlertWorkflowEventWriteResult {
  if (tenancy.id !== match.signal.tenancyId) {
    return { status: "drop", reason: "invalid_tenancy", byteLength: 0, scrubbed: false };
  }
  const payloadResult = buildIssueAlertWorkflowPayload(match, routingResolution, recipientEmails);
  if (payloadResult.status === "ok") {
    const payload = payloadResult.payload;
    return {
      status: "ok",
      payload,
      byteLength: payloadResult.byteLength,
      scrubbed: payloadResult.scrubbed,
      write: {
        tenancy,
        type: ISSUE_ALERT_WORKFLOW_EVENT_TYPE,
        payload,
        eventId: deterministicWorkflowUuid(`issue-alert:${payload.deduplication_key}`),
      },
    };
  }
  return payloadResult;
}

export async function enqueueIssueAlertWorkflowEventWithWriter(
  tenancy: Pick<Tenancy, "id">,
  match: IssueAlertMatch,
  writer: IssueAlertWorkflowEventWriter,
  routingResolution?: OwnershipRoutingResolution,
): Promise<IssueAlertWorkflowEnqueueResult> {
  const recipientResolution = isIssueAlertTenancy(tenancy)
    && match.action.type === "email"
    && match.action.userIds !== undefined
    ? await resolveIssueAlertOwnerTeamEmails(tenancy, match.action.userIds)
    : undefined;
  if (recipientResolution !== undefined && recipientResolution.status !== "ok") {
    // Explicit user IDs are owner-team identities, not arbitrary project-user
    // fallbacks. If any identity can no longer be proven, fail closed before
    // constructing a workflow payload that could send to the wrong account.
    return { status: "dropped", reason: "ownership_resolution_required", byteLength: 0 };
  }
  const recipientEmails = recipientResolution?.emails;
  const writeResult = buildIssueAlertWorkflowEventWrite(tenancy, match, routingResolution, recipientEmails);
  if (writeResult.status === "drop") return { status: "dropped", reason: writeResult.reason, byteLength: writeResult.byteLength };
  const result = await writer(writeResult.write);
  if (result === null) return { status: "dropped", reason: "workflow_event_rejected", byteLength: writeResult.byteLength };
  return {
    status: "enqueued",
    eventId: result.eventId,
    payload: writeResult.payload,
    byteLength: writeResult.byteLength,
  };
}

export async function enqueueIssueAlertWorkflowEvent(
  client: PrismaClientTransaction,
  tenancy: Pick<Tenancy, "id">,
  match: IssueAlertMatch,
  routingResolution?: OwnershipRoutingResolution,
): Promise<IssueAlertWorkflowEnqueueResult> {
  return await enqueueIssueAlertWorkflowEventWithWriter(tenancy, match, async (write) => {
    return await enqueueWorkflowEvent(client, write);
  }, routingResolution);
}

import { utf8ByteLength } from "@/lib/utf8";
import { isRecord } from "@hexclave/shared/dist/utils/objects";

export type IssueAlertEmailAction = {
  type: "email",
  userIds?: readonly string[],
  routing?: IssueAlertEmailRouting,
  subject: string,
  html: string,
  notificationCategoryName?: string,
};

export type IssueAlertEmailRouting =
  | { type: "team", teamId: string }
  | { type: "issue_owners", fallthrough: IssueAlertOwnerFallthrough };

export type IssueAlertOwnerFallthrough = "active_members" | "all_members" | "none";

export type IssueAlertWebhookAction = {
  type: "webhook",
  integrationId: string,
};

export type IssueAlertAction = IssueAlertEmailAction | IssueAlertWebhookAction;

const MAX_IDENTIFIER_BYTES = 256;
const MAX_RECIPIENTS = 64;
const MAX_TEXT_BYTES = 8 * 1024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const HTML_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SAFE_INTEGRATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/u;
const ISSUE_ALERT_OWNER_FALLTHROUGHS: readonly IssueAlertOwnerFallthrough[] = ["active_members", "all_members", "none"];

function isIssueAlertOwnerFallthrough(value: unknown): value is IssueAlertOwnerFallthrough {
  return typeof value === "string" && ISSUE_ALERT_OWNER_FALLTHROUGHS.some((candidate) => candidate === value);
}

function isBoundedText(value: unknown, maximumBytes: number, options?: { allowHtmlWhitespace?: boolean }): value is string {
  const controlPattern = options?.allowHtmlWhitespace === true
    ? HTML_CONTROL_CHARACTER_PATTERN
    : CONTROL_CHARACTER_PATTERN;
  return typeof value === "string"
    && value.length > 0
    && !controlPattern.test(value)
    && utf8ByteLength(value) <= maximumBytes;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RECIPIENTS) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (!isBoundedText(entry, MAX_IDENTIFIER_BYTES) || result.includes(entry)) return null;
    result.push(entry);
  }
  return result;
}

function parseEmailRouting(value: unknown): IssueAlertEmailRouting | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "team") {
    return isBoundedText(value.teamId, MAX_IDENTIFIER_BYTES) && SAFE_INTEGRATION_ID.test(value.teamId)
      ? { type: "team", teamId: value.teamId }
      : null;
  }
  if (value.type === "issue_owners" && isIssueAlertOwnerFallthrough(value.fallthrough)) {
    return { type: "issue_owners", fallthrough: value.fallthrough };
  }
  return null;
}

export function parseIssueAlertAction(value: unknown): IssueAlertAction | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;

  if (value.type === "email") {
    const userIds = value.userIds === undefined ? undefined : parseStringArray(value.userIds);
    const routing = value.routing === undefined ? undefined : parseEmailRouting(value.routing);
    if ((userIds === undefined) === (routing === undefined)
      || userIds === null
      || routing === null
      || !isBoundedText(value.subject, MAX_TEXT_BYTES)
      || !isBoundedText(value.html, MAX_TEXT_BYTES, { allowHtmlWhitespace: true })) return null;
    if (value.notificationCategoryName !== undefined && !isBoundedText(value.notificationCategoryName, MAX_IDENTIFIER_BYTES)) return null;
    const action: IssueAlertEmailAction = { type: "email", subject: value.subject, html: value.html };
    if (userIds !== undefined) action.userIds = userIds;
    if (routing !== undefined) action.routing = routing;
    if (value.notificationCategoryName !== undefined) action.notificationCategoryName = value.notificationCategoryName;
    return action;
  }

  if (value.type === "webhook"
    && Object.keys(value).every((key) => key === "type" || key === "integrationId")
    && isBoundedText(value.integrationId, MAX_IDENTIFIER_BYTES)
    && SAFE_INTEGRATION_ID.test(value.integrationId)) {
    return { type: "webhook", integrationId: value.integrationId };
  }

  return null;
}

export function isIssueAlertAction(value: unknown): value is IssueAlertAction {
  return parseIssueAlertAction(value) !== null;
}

export type IssueAlertDestinationExecution =
  | { status: "supported", destination: "email", routing: "users" | "team" | "issue_owners" }
  | { status: "unsupported", destination: "webhook", reason: "provider_not_configured" };

export function describeIssueAlertDestination(action: IssueAlertAction): IssueAlertDestinationExecution {
  if (action.type === "webhook") return { status: "unsupported", destination: "webhook", reason: "provider_not_configured" };
  if (action.userIds !== undefined) return { status: "supported", destination: "email", routing: "users" };
  if (action.routing?.type === "team") return { status: "supported", destination: "email", routing: "team" };
  return { status: "supported", destination: "email", routing: "issue_owners" };
}

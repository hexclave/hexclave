import { escapeHtml } from "./html";

/**
 * Cross-app contract for issue-alert email placeholders. The dashboard editor
 * (`apps/dashboard/.../issues/alerts/issue-alert-email-template.ts`) documents
 * these token names to alert authors; the backend
 * (`apps/backend/src/lib/issues/issue-alerts/email-template.ts`) substitutes
 * the same names from the triggering issue when the alert email is enqueued.
 * Both sides import from here so the vocabulary can't drift.
 *
 * Unknown `{{tokens}}` are left untouched so a typo is visible in the sent
 * mail instead of silently disappearing.
 */
export const ISSUE_ALERT_EMAIL_PLACEHOLDER_TOKENS = [
  "short_id",
  "type",
  "summary",
  "culprit",
  "environment",
  "release",
  "status",
  "kind",
  "occurred_at",
  "issue_url",
] as const;

export type IssueAlertEmailPlaceholderToken = typeof ISSUE_ALERT_EMAIL_PLACEHOLDER_TOKENS[number];

const PLACEHOLDER_PATTERN = /\{\{([a-z_]+)\}\}/g;
const KNOWN_PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set(ISSUE_ALERT_EMAIL_PLACEHOLDER_TOKENS);

function isPlaceholderToken(name: string): name is IssueAlertEmailPlaceholderToken {
  return KNOWN_PLACEHOLDER_TOKENS.has(name);
}

export function interpolateIssueAlertEmailTemplate(
  template: string,
  values: ReadonlyMap<IssueAlertEmailPlaceholderToken, string>,
  options: { escapeHtml: boolean },
): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    if (!isPlaceholderToken(name)) return match;
    const value = values.get(name);
    if (value == null) return match;
    return options.escapeHtml ? escapeHtml(value) : value;
  });
}

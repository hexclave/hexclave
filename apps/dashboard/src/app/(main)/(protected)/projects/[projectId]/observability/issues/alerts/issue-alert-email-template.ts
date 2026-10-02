import {
  ISSUE_ALERT_EMAIL_PLACEHOLDER_TOKENS,
  type IssueAlertEmailPlaceholderToken,
} from "@hexclave/shared/dist/utils/issue-alert-email-template";
import { deindent } from "@hexclave/shared/dist/utils/strings";

export {
  ISSUE_ALERT_EMAIL_PLACEHOLDER_TOKENS,
  interpolateIssueAlertEmailTemplate,
  type IssueAlertEmailPlaceholderToken,
} from "@hexclave/shared/dist/utils/issue-alert-email-template";

const ISSUE_ALERT_EMAIL_PLACEHOLDER_HINTS = new Map<IssueAlertEmailPlaceholderToken, string>([
  ["short_id", "Per-project issue number"],
  ["type", "Error type, for example TypeError"],
  ["summary", "Error message"],
  ["culprit", "Code location"],
  ["environment", "production, staging, …"],
  ["release", "Release that reported it"],
  ["status", "unresolved, resolved, or ignored"],
  ["kind", "New issue, regression, or frequency"],
  ["occurred_at", "When this occurrence was seen"],
  ["issue_url", "Dashboard link to the issue"],
]);

export const ISSUE_ALERT_EMAIL_PLACEHOLDERS: readonly {
  token: IssueAlertEmailPlaceholderToken,
  hint: string,
}[] = ISSUE_ALERT_EMAIL_PLACEHOLDER_TOKENS.map((token) => {
  const hint = ISSUE_ALERT_EMAIL_PLACEHOLDER_HINTS.get(token);
  if (hint == null) throw new Error(`No hint is defined for issue-alert email placeholder ${token}`);
  return { token, hint };
});

export const DEFAULT_ISSUE_ALERT_EMAIL_SUBJECT = "[{{kind}}] {{short_id}}: {{summary}}";

export const DEFAULT_ISSUE_ALERT_EMAIL_HTML = deindent`
  <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; font-size: 14px; line-height: 1.5; color: #111827; max-width: 560px;">
    <p style="margin: 0 0 4px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280;">Hexclave issue alert · {{kind}}</p>
    <p style="margin: 0 0 4px; font-size: 12px; color: #6b7280;">{{type}} · {{short_id}}</p>
    <p style="margin: 0 0 12px; font-size: 18px; font-weight: 600; color: #111827;">{{summary}}</p>
    <p style="margin: 0 0 16px; color: #4b5563;">{{culprit}}</p>
    <table style="border-collapse: collapse; font-size: 13px; color: #374151;">
      <tr>
        <td style="padding: 3px 20px 3px 0; color: #6b7280;">Status</td>
        <td>{{status}}</td>
      </tr>
      <tr>
        <td style="padding: 3px 20px 3px 0; color: #6b7280;">Environment</td>
        <td>{{environment}}</td>
      </tr>
      <tr>
        <td style="padding: 3px 20px 3px 0; color: #6b7280;">Release</td>
        <td>{{release}}</td>
      </tr>
      <tr>
        <td style="padding: 3px 20px 3px 0; color: #6b7280;">Seen</td>
        <td>{{occurred_at}}</td>
      </tr>
    </table>
    <p style="margin: 20px 0 0;">
      <a href="{{issue_url}}" style="color: #2563eb; font-weight: 600; text-decoration: none;">Open this issue in Hexclave →</a>
    </p>
  </div>
`;

export function createIssueAlertEmailPreviewValues(options: {
  projectId: string,
  dashboardOrigin: string,
}): Map<IssueAlertEmailPlaceholderToken, string> {
  const issueId = "3983534c-b596-44df-87a5-3962ec74a14a";
  const origin = options.dashboardOrigin.replace(/\/+$/u, "");
  return new Map<IssueAlertEmailPlaceholderToken, string>([
    ["short_id", "1842"],
    ["type", "TypeError"],
    ["summary", "Cannot read properties of undefined (reading 'id')"],
    ["culprit", "checkout.ts in submitOrder"],
    ["environment", "production"],
    ["release", "web@2026.08.12"],
    ["status", "unresolved"],
    ["kind", "New issue"],
    ["occurred_at", "2026-08-12 19:04 UTC"],
    ["issue_url", `${origin}/projects/${options.projectId}/observability/issues/${issueId}`],
  ]);
}

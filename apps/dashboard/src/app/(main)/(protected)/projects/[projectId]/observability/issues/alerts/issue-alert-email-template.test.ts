import { describe, expect, it } from "vitest";
import {
  createIssueAlertEmailPreviewValues,
  DEFAULT_ISSUE_ALERT_EMAIL_HTML,
  DEFAULT_ISSUE_ALERT_EMAIL_SUBJECT,
  interpolateIssueAlertEmailTemplate,
  ISSUE_ALERT_EMAIL_PLACEHOLDERS,
  ISSUE_ALERT_EMAIL_PLACEHOLDER_TOKENS,
} from "./issue-alert-email-template";

describe("issue-alert email templates", () => {
  it("documents a hint for every placeholder token in the shared contract", () => {
    expect(ISSUE_ALERT_EMAIL_PLACEHOLDERS.map((placeholder) => placeholder.token))
      .toEqual([...ISSUE_ALERT_EMAIL_PLACEHOLDER_TOKENS]);
  });

  it("covers every advertised placeholder in the default subject and HTML", () => {
    const values = createIssueAlertEmailPreviewValues({
      projectId: "project-1",
      dashboardOrigin: "https://app.hexclave.com",
    });
    const subject = interpolateIssueAlertEmailTemplate(DEFAULT_ISSUE_ALERT_EMAIL_SUBJECT, values, { escapeHtml: false });
    const html = interpolateIssueAlertEmailTemplate(DEFAULT_ISSUE_ALERT_EMAIL_HTML, values, { escapeHtml: true });

    expect(subject).toBe("[New issue] 1842: Cannot read properties of undefined (reading 'id')");
    expect(html).toContain("Open this issue in Hexclave");
    expect(html).toContain("/projects/project-1/observability/issues/");
    for (const placeholder of ISSUE_ALERT_EMAIL_PLACEHOLDERS) {
      expect(DEFAULT_ISSUE_ALERT_EMAIL_SUBJECT.includes(`{{${placeholder.token}}}`)
        || DEFAULT_ISSUE_ALERT_EMAIL_HTML.includes(`{{${placeholder.token}}}`)).toBe(true);
      expect(html).not.toContain(`{{${placeholder.token}}}`);
    }
  });
});

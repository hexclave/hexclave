import { describe, expect, it } from "vitest";
import {
  interpolateIssueAlertEmailTemplate,
  type IssueAlertEmailPlaceholderToken,
} from "./issue-alert-email-template";

describe("issue-alert email template interpolation", () => {
  it("substitutes known placeholders, escapes HTML in the body, and leaves unknown tokens", () => {
    const values = new Map<IssueAlertEmailPlaceholderToken, string>([
      ["short_id", "12"],
      ["type", "TypeError"],
      ["summary", "<script>alert(1)</script>"],
      ["culprit", "app.ts"],
      ["environment", "production"],
      ["release", "1.0.0"],
      ["status", "unresolved"],
      ["kind", "New issue"],
      ["occurred_at", "2026-08-12 19:04 UTC"],
      ["issue_url", "https://app.example.test/issues/12"],
    ]);

    expect(interpolateIssueAlertEmailTemplate(
      "Issue {{short_id}}: {{summary}} {{unknown}}",
      values,
      { escapeHtml: false },
    )).toBe("Issue 12: <script>alert(1)</script> {{unknown}}");
    expect(interpolateIssueAlertEmailTemplate(
      "<p>{{summary}}</p><a href=\"{{issue_url}}\">open</a>",
      values,
      { escapeHtml: true },
    )).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><a href=\"https://app.example.test/issues/12\">open</a>");
  });
});

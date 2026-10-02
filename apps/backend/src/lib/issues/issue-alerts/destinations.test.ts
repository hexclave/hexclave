import { describe, expect, it } from "vitest";
import {
  describeIssueAlertDestination,
  parseIssueAlertAction,
} from "./destinations";

describe("issue alert destinations", () => {
  it("parses safe webhook destinations so capability checks can reject them explicitly", () => {
    expect(parseIssueAlertAction({ type: "webhook", integrationId: "integration-prod-errors" }))
      .toEqual({ type: "webhook", integrationId: "integration-prod-errors" });
    expect(parseIssueAlertAction({
      type: "webhook",
      integrationId: "integration-prod-errors",
      url: "https://example.test/hook?token=secret",
    })).toBeNull();
    expect(parseIssueAlertAction({ type: "webhook", integrationId: "https://example.test/hook?token=secret" })).toBeNull();
  });

  it("rejects unbounded or duplicate email recipients and unknown destinations", () => {
    expect(parseIssueAlertAction({
      type: "email",
      userIds: ["user-1", "user-1"],
      subject: "Issue",
      html: "<p>Issue</p>",
    })).toBeNull();
    expect(parseIssueAlertAction({ type: "webhook", integrationId: "" })).toBeNull();
    expect(parseIssueAlertAction({ type: "slack", integrationId: "slack-1" })).toBeNull();
  });

  it("preserves Sentry-style team and issue-owner routing as executable references", () => {
    const teamAction = parseIssueAlertAction({
      type: "email",
      routing: { type: "team", teamId: "team-prod-errors" },
      subject: "Issue",
      html: "<p>Issue</p>",
    });
    expect(teamAction).toEqual({
      type: "email",
      routing: { type: "team", teamId: "team-prod-errors" },
      subject: "Issue",
      html: "<p>Issue</p>",
    });
    if (teamAction === null) throw new Error("Expected a team-routed email action");
    expect(describeIssueAlertDestination(teamAction)).toEqual({
      status: "supported",
      destination: "email",
      routing: "team",
    });

    expect(parseIssueAlertAction({
      type: "email",
      routing: { type: "issue_owners", fallthrough: "active_members" },
      subject: "Issue",
      html: "<p>Issue</p>",
    })).toMatchObject({ routing: { type: "issue_owners", fallthrough: "active_members" } });
    const issueOwnerAction = parseIssueAlertAction({
      type: "email",
      routing: { type: "issue_owners", fallthrough: "active_members" },
      subject: "Issue",
      html: "<p>Issue</p>",
    });
    if (issueOwnerAction === null) throw new Error("Expected an issue-owner-routed email action");
    expect(describeIssueAlertDestination(issueOwnerAction)).toEqual({
      status: "supported",
      destination: "email",
      routing: "issue_owners",
    });
    expect(parseIssueAlertAction({
      type: "email",
      userIds: ["user-1"],
      routing: { type: "issue_owners", fallthrough: "none" },
      subject: "Issue",
      html: "<p>Issue</p>",
    })).toBeNull();
  });

  it("accepts authored HTML with newlines and still rejects other control characters", () => {
    expect(parseIssueAlertAction({
      type: "email",
      userIds: ["user-1"],
      subject: "Issue",
      html: "<p>Line one</p>\n<p>Line two</p>",
    })).toMatchObject({ html: "<p>Line one</p>\n<p>Line two</p>" });
    expect(parseIssueAlertAction({
      type: "email",
      userIds: ["user-1"],
      subject: "Issue",
      html: "<p>Issue\u0000</p>",
    })).toBeNull();
    expect(parseIssueAlertAction({
      type: "email",
      userIds: ["user-1"],
      subject: "Issue\nnewline",
      html: "<p>Issue</p>",
    })).toBeNull();
  });
});

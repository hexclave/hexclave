import { describe, expect, it } from "vitest";
import { parseIssueAlertRuleInput, toIssueAlertRuleResponse } from "./api";
import type { IssueAlertRuleRecord } from "./persistence";

const rule = {
  schemaVersion: 1,
  id: "notify-new-errors",
  version: 1,
  enabled: true,
  conditions: { all: [{ type: "new", value: true }] },
  cooldown: { durationSeconds: 300, keyBy: "issue" },
  action: { type: "email", userIds: ["00000000-0000-4000-8000-000000000001"], subject: "New error", html: "<p>New error</p>" },
} as const;

describe("issue alert API contract", () => {
  it("parses the versioned evaluator DSL and exposes the database identity separately", () => {
    const parsed = parseIssueAlertRuleInput(rule);
    expect(parsed).toEqual(rule);
    const record: IssueAlertRuleRecord = {
      databaseId: "00000000-0000-4000-8000-000000000002",
      scope: { tenancyId: "00000000-0000-4000-8000-000000000003", projectId: "project", branchId: "branch" },
      rule: parsed,
    };
    expect(toIssueAlertRuleResponse(record)).toEqual({ ...rule, database_id: record.databaseId });
  });

  it("fails closed for malformed rules and arbitrary non-JSON values", () => {
    expect(() => parseIssueAlertRuleInput({ ...rule, version: 0 })).toThrow("Invalid issue alert rule");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => parseIssueAlertRuleInput(cyclic)).toThrow("Invalid issue alert rule");
  });

  it("parses a webhook destination so capability evaluation can reject it explicitly", () => {
    const webhookRule = {
      ...rule,
      id: "notify-webhook",
      action: { type: "webhook", integrationId: "integration-prod-errors" },
    } as const;
    expect(parseIssueAlertRuleInput(webhookRule).action).toEqual({ type: "webhook", integrationId: "integration-prod-errors" });
  });

  it("accepts explicit team routing metadata without converting it to a user list", () => {
    const teamRule = {
      ...rule,
      id: "notify-team",
      action: {
        type: "email",
        routing: { type: "team", teamId: "team-prod-errors" },
        subject: "Team issue",
        html: "<p>Team issue</p>",
      },
    } as const;
    expect(parseIssueAlertRuleInput(teamRule)).toEqual(teamRule);
  });

  it("normalizes Sentry level spellings while preserving ordered level predicates", () => {
    const levelRule = {
      ...rule,
      id: "notify-severe-errors",
      conditions: { all: [{ type: "level", operator: "gte", value: "warning" }] },
    } as const;

    expect(parseIssueAlertRuleInput(levelRule)).toMatchObject({
      conditions: { all: [{ type: "level", operator: "gte", value: "warn" }] },
    });
    expect(parseIssueAlertRuleInput({
      ...levelRule,
      id: "notify-fatal-errors",
      conditions: { all: [{ type: "level", operator: "equals", value: "fatal" }] },
    })).toMatchObject({
      conditions: { all: [{ type: "level", operator: "equals", value: "error" }] },
    });
  });
});

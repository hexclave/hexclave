import { describe, expect, it } from "vitest";
import {
  buildIssueAlertRule,
  DEFAULT_ALERT_RULE_DRAFT,
  getSupportedAlertRuleDraft,
  issueAlertTriggerLabel,
} from "./alert-rule-form";
import type { IssueAlertRuleResponse } from "./issue-alerts-data";

function sampleRule(overrides: Partial<IssueAlertRuleResponse> = {}): IssueAlertRuleResponse {
  return {
    schemaVersion: 1,
    id: "issue-alert",
    version: 2,
    enabled: true,
    conditions: { any: [{ type: "new", value: true }] },
    cooldown: { durationSeconds: 3600, keyBy: "issue" },
    action: {
      type: "email",
      userIds: ["user-1"],
      subject: "Issue alert",
      html: "<p>Issue alert</p>",
    },
    database_id: "rule-database-id",
    ...overrides,
  };
}

describe("getSupportedAlertRuleDraft", () => {
  it("round-trips the supported trigger shapes", () => {
    const draft = getSupportedAlertRuleDraft(sampleRule({
      conditions: {
        all: [{ type: "frequency", operator: "gte", count: 12, windowSeconds: 600 }],
      },
    }));

    expect(draft).toMatchObject({
      trigger: "frequency",
      frequencyCount: "12",
      frequencyWindowSeconds: "600",
      userIds: ["user-1"],
    });
  });

  it("keeps configured filters and advanced predicates read-only", () => {
    expect(getSupportedAlertRuleDraft(sampleRule({
      filters: { environments: ["production"] },
    }))).toBeNull();
    expect(getSupportedAlertRuleDraft(sampleRule({
      conditions: { all: [{ type: "attribute", path: "issue.value", operator: "contains", value: "timeout" }] },
    }))).toBeNull();
  });
});

describe("buildIssueAlertRule", () => {
  it("builds a new backend-compatible rule", () => {
    const result = buildIssueAlertRule({
      ...DEFAULT_ALERT_RULE_DRAFT,
      id: "production-frequency",
      trigger: "frequency",
      frequencyCount: "20",
      frequencyWindowSeconds: "900",
      userIds: ["user-1", "user-2"],
    }, null);

    expect(result).toEqual({
      status: "ok",
      rule: expect.objectContaining({
        schemaVersion: 1,
        id: "production-frequency",
        version: 1,
        enabled: true,
        conditions: { all: [{ type: "frequency", operator: "gte", count: 20, windowSeconds: 900 }] },
        action: expect.objectContaining({ userIds: ["user-1", "user-2"] }),
      }),
    });
  });

  it("increments the version for updates without changing the rule key", () => {
    const existingRule = sampleRule();
    const draft = getSupportedAlertRuleDraft(existingRule);
    if (draft == null) throw new Error("Expected the sample rule to be editable");

    const result = buildIssueAlertRule({ ...draft, subject: "Updated issue alert" }, existingRule);

    expect(result).toEqual({
      status: "ok",
      rule: expect.objectContaining({
        id: existingRule.id,
        version: existingRule.version + 1,
        action: expect.objectContaining({ subject: "Updated issue alert" }),
      }),
    });
  });

  it("keeps webhook destinations read-only because no executor exists", () => {
    expect(getSupportedAlertRuleDraft(sampleRule({
      action: { type: "webhook", integrationId: "integration-prod-errors" },
    }))).toBeNull();
  });

  it("keeps executable owner-routing rules visible but read-only in the explicit-recipient editor", () => {
    expect(getSupportedAlertRuleDraft(sampleRule({
      action: {
        type: "email",
        routing: { type: "team", teamId: "team-prod-errors" },
        subject: "Issue alert",
        html: "<p>Issue alert</p>",
      },
    }))).toBeNull();
  });

  it("rejects unsafe or incomplete editor input", () => {
    expect(buildIssueAlertRule({
      ...DEFAULT_ALERT_RULE_DRAFT,
      userIds: [],
    }, null)).toEqual({
      status: "error",
      message: "Choose at least one team member to receive the email.",
    });
    expect(buildIssueAlertRule({
      ...DEFAULT_ALERT_RULE_DRAFT,
      userIds: ["user-1"],
      subject: "Bad\nsubject",
    }, null)).toEqual({
      status: "error",
      message: "Subject contains unsupported control characters",
    });
    expect(buildIssueAlertRule({
      ...DEFAULT_ALERT_RULE_DRAFT,
      userIds: ["user-1"],
      html: "<p>Line one</p>\n<p>{{summary}}</p>",
    }, null)).toEqual(expect.objectContaining({ status: "ok" }));
  });
});

describe("issueAlertTriggerLabel", () => {
  it("labels frequency and combined issue triggers", () => {
    expect(issueAlertTriggerLabel(sampleRule({
      conditions: { all: [{ type: "frequency", operator: "gte", count: 4, windowSeconds: 60 }] },
    }))).toBe("gte 4 events / 1m");
    expect(issueAlertTriggerLabel(sampleRule({
      conditions: {
        any: [
          { type: "new", value: true },
          { type: "regression", value: true },
        ],
      },
    }))).toBe("New or regressed issues");
  });
});

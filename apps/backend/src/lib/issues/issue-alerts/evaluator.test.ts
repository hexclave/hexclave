import { describe, expect, it } from "vitest";
import {
  buildIssueAlertCooldownKey,
  buildIssueAlertDeduplicationKey,
  evaluateIssueAlertRule,
} from "./evaluator";
import type {
  IssueAlertRule,
  IssueAlertSignal,
} from "./types";

function createSignal(overrides: Partial<IssueAlertSignal> = {}): IssueAlertSignal {
  return {
    tenancyId: "tenancy-1",
    projectId: "project-1",
    branchId: "main",
    issue: {
      id: "issue-1",
      shortId: "PROJECT-1",
      type: "TypeError",
      value: "Cannot read property safely",
      culprit: "src/app.ts",
      status: "unresolved",
      isNew: true,
      isRegression: false,
    },
    occurrence: {
      id: "occurrence-1",
      occurredAt: new Date("2026-08-06T12:00:00.000Z"),
    },
    environment: "production",
    release: "web@2026.08.06",
    tags: new Map([
      ["browser", "chrome"],
      ["tier", "critical"],
    ]),
    attributes: new Map<string, string | number>([
      ["http.status_code", 500],
      ["request.method", "GET"],
    ]),
    frequencyCounts: new Map([[300, 12]]),
    ...overrides,
  };
}

function createRule(overrides: Partial<IssueAlertRule> = {}): IssueAlertRule {
  return {
    schemaVersion: 1,
    id: "notify-on-errors",
    version: 1,
    enabled: true,
    filters: {
      projectIds: ["project-1"],
      environments: ["production"],
      releases: ["web@2026.08.06"],
      tags: [{ key: "tier", operator: "equals", value: "critical" }],
    },
    conditions: {
      all: [
        { type: "new", value: true },
        { type: "status", operator: "equals", value: "unresolved" },
        { type: "frequency", operator: "gte", count: 10, windowSeconds: 300 },
      ],
      any: [
        { type: "attribute", path: "http.status_code", operator: "equals", value: 500 },
        { type: "attribute", path: "request.method", operator: "equals", value: "POST" },
      ],
    },
    cooldown: { durationSeconds: 900, keyBy: "issue_environment_release" },
    action: {
      type: "email",
      userIds: ["user-1"],
      subject: "Issue alert",
      html: "<p>Issue alert</p>",
    },
    ...overrides,
  };
}

describe("issue alert rule evaluation", () => {
  it("composes filters, all predicates, and any predicates into a match", () => {
    const result = evaluateIssueAlertRule(createRule(), createSignal());

    expect(result.outcome).toBe("match");
    if (result.outcome === "match") {
      expect(result.eventKind).toBe("new");
      expect(result.deduplicationKey).not.toBe(result.cooldownKey);
    }
  });

  it("returns explicit no-match reasons for filters and unavailable frequency windows", () => {
    const projectMismatch = evaluateIssueAlertRule(createRule(), createSignal({ projectId: "project-2" }));
    expect(projectMismatch).toMatchObject({ outcome: "no-match", reason: "project_filter" });

    const frequencyMismatch = evaluateIssueAlertRule(
      createRule({ conditions: { all: [{ type: "frequency", operator: "gte", count: 2, windowSeconds: 60 }] } }),
      createSignal(),
    );
    expect(frequencyMismatch).toMatchObject({ outcome: "no-match", reason: "frequency_unavailable" });

    const anyMismatch = evaluateIssueAlertRule(
      createRule({ conditions: { any: [{ type: "attribute", path: "request.method", operator: "equals", value: "POST" }] } }),
      createSignal(),
    );
    expect(anyMismatch).toMatchObject({ outcome: "no-match", reason: "any_predicates" });
  });

  it("evaluates Sentry-compatible ordered level predicates and fails closed without a level", () => {
    const rule = createRule({ conditions: { all: [{ type: "level", operator: "gte", value: "warn" }] } });

    expect(evaluateIssueAlertRule(rule, createSignal({ level: "error" })).outcome).toBe("match");
    expect(evaluateIssueAlertRule(rule, createSignal({ level: "warn" })).outcome).toBe("match");
    expect(evaluateIssueAlertRule(rule, createSignal({ level: "info" }))).toMatchObject({
      outcome: "no-match",
      reason: "level_predicate",
    });
    expect(evaluateIssueAlertRule(rule, createSignal({ level: undefined }))).toMatchObject({
      outcome: "no-match",
      reason: "level_predicate",
    });
  });

  it("reports a disabled rule without evaluating or persisting an action", () => {
    const result = evaluateIssueAlertRule(createRule({ enabled: false }), createSignal());
    expect(result).toEqual({
      outcome: "no-match",
      ruleId: "notify-on-errors",
      ruleVersion: 1,
      reason: "rule_disabled",
      reasons: ["rule_disabled"],
    });
  });

  it("keeps cooldown keys stable while occurrence deduplication keys remain occurrence-specific", () => {
    const rule = createRule();
    const first = createSignal({
      tags: new Map([["tier", "critical"], ["browser", "chrome"]]),
      attributes: new Map<string, string | number>([["request.method", "GET"], ["http.status_code", 500]]),
      frequencyCounts: new Map([[300, 12]]),
    });
    const second = createSignal({ occurrence: { ...first.occurrence, id: "occurrence-2" } });

    expect(buildIssueAlertCooldownKey(rule, first)).toBe(buildIssueAlertCooldownKey(rule, second));
    expect(buildIssueAlertDeduplicationKey(rule, first)).not.toBe(buildIssueAlertDeduplicationKey(rule, second));
    expect(buildIssueAlertCooldownKey(rule, first)).toBe(buildIssueAlertCooldownKey(rule, first));
  });

});

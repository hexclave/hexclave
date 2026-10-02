import { describe, expect, it } from "vitest";
import { buildIssueAlertFrequencyCountsQuery, collectIssueAlertFrequencyWindows } from "./ingestion";
import type { IssueAlertRule } from "./types";

function rule(id: string, predicates: IssueAlertRule["conditions"]["all"]): IssueAlertRule {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    enabled: true,
    conditions: { all: predicates },
    cooldown: { durationSeconds: 60, keyBy: "issue" },
    action: { type: "email", userIds: ["user"], subject: "Alert", html: "<p>Alert</p>" },
  };
}

describe("collectIssueAlertFrequencyWindows", () => {
  it("deduplicates windows across conjunctive and disjunctive rule groups", () => {
    expect(collectIssueAlertFrequencyWindows([
      rule("one", [{ type: "frequency", operator: "gte", count: 2, windowSeconds: 60 }]),
      {
        ...rule("two", [{ type: "frequency", operator: "gt", count: 4, windowSeconds: 3_600 }]),
        conditions: {
          all: [{ type: "frequency", operator: "gt", count: 4, windowSeconds: 3_600 }],
          any: [{ type: "frequency", operator: "eq", count: 1, windowSeconds: 60 }],
        },
      },
    ])).toEqual([60, 3_600]);
  });

  it("returns an empty set when no rule uses frequency", () => {
    expect(collectIssueAlertFrequencyWindows([rule("plain", [{ type: "new", value: true }])])).toEqual([]);
  });

  it("counts every alert frequency window in one bounded ClickHouse scan", () => {
    const query = buildIssueAlertFrequencyCountsQuery([60, 3_600, 86_400]);

    expect(query.match(/FROM analytics_internal\.events/g)).toHaveLength(1);
    expect(query).toContain("PREWHERE project_id = {projectId:String}");
    expect(query).toContain("event_at >= {earliestRangeStart:DateTime}");
    expect(query).toContain("countIf(event_at >= {rangeStart0:DateTime})");
    expect(query).toContain("countIf(event_at >= {rangeStart1:DateTime})");
    expect(query).toContain("countIf(event_at >= {rangeStart2:DateTime})");
  });
});

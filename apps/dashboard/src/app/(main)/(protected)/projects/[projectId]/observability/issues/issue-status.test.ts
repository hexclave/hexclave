import { describe, expect, it } from "vitest";
import {
  adjustIssueStatusCounts,
  applyOptimisticStatus,
  clearOptimisticStatus,
  issueStatusBadge,
  NO_ISSUE_STATUS_OVERRIDES,
  nextStatusForAction,
  primaryIssueStatusAction,
  reconcileIssueStatusOverrides,
  resolveIssueRowStatus,
} from "./issue-status";
import type { IssueListItem } from "./issues-data";

function issue(overrides: Partial<IssueListItem> = {}): IssueListItem {
  return {
    id: "issue-1",
    short_id: "1",
    type: "TypeError",
    value: "boom",
    culprit: "app/x.ts",
    level: "error",
    status: "unresolved",
    substatus: "ongoing",
    first_seen_at_millis: 1_000,
    last_seen_at_millis: 2_000,
    times_seen: "5",
    window_occurrences: 5,
    window_users: 2,
    service_name: null,
    environment: null,
    release: null,
    handled: true,
    synthetic: false,
    counters_truncated_at_millis: null,
    updated_at_millis: 2_000,
    issue_hashes: ["hash-1"],
    ...overrides,
  };
}

describe("nextStatusForAction", () => {
  it("maps every action", () => {
    expect(nextStatusForAction("resolve")).toBe("resolved");
    expect(nextStatusForAction("unresolve")).toBe("unresolved");
    expect(nextStatusForAction("ignore")).toBe("ignored");
  });
});

describe("issueStatusBadge", () => {
  it("returns null for a plain unresolved issue so the column isn't noise", () => {
    expect(issueStatusBadge({ status: "unresolved", substatus: "ongoing" })).toBeNull();
  });

  it("badges the states that change how you triage", () => {
    expect(issueStatusBadge({ status: "unresolved", substatus: "regressed" }))
      .toEqual({ label: "Regressed", color: "orange" });
    expect(issueStatusBadge({ status: "unresolved", substatus: "new" }))
      .toEqual({ label: "New", color: "blue" });
    expect(issueStatusBadge({ status: "resolved", substatus: "ongoing" }))
      .toEqual({ label: "Resolved", color: "green" });
    expect(issueStatusBadge({ status: "ignored", substatus: "ongoing" }))
      .toEqual({ label: "Ignored", color: "zinc" });
  });
});

describe("optimistic overrides", () => {
  it("shows the override while the server row is still at the recorded version", () => {
    const row = issue({ updated_at_millis: 2_000 });
    const overrides = applyOptimisticStatus(NO_ISSUE_STATUS_OVERRIDES, row.id, "resolved", row.updated_at_millis);
    expect(resolveIssueRowStatus(row, overrides)).toEqual({ status: "resolved", isOptimistic: true });
  });

  it("is DROPPED once the server returns a newer row, so a later regression is not masked", () => {
    const clicked = issue({ updated_at_millis: 2_000 });
    const overrides = applyOptimisticStatus(NO_ISSUE_STATUS_OVERRIDES, clicked.id, "resolved", 2_000);

    const regressed = issue({ status: "unresolved", substatus: "regressed", updated_at_millis: 5_000 });
    const reconciled = reconcileIssueStatusOverrides(overrides, [regressed]);

    expect(reconciled.size).toBe(0);
    expect(resolveIssueRowStatus(regressed, reconciled)).toEqual({ status: "unresolved", isOptimistic: false });
  });

  it("survives a refetch that returns the same version", () => {
    const row = issue({ updated_at_millis: 2_000 });
    const overrides = applyOptimisticStatus(NO_ISSUE_STATUS_OVERRIDES, row.id, "resolved", 2_000);
    const reconciled = reconcileIssueStatusOverrides(overrides, [row]);
    expect(reconciled).toBe(overrides);
    expect(resolveIssueRowStatus(row, reconciled).status).toBe("resolved");
  });

  it("returns the same map reference when nothing changed", () => {
    const overrides = applyOptimisticStatus(NO_ISSUE_STATUS_OVERRIDES, "issue-1", "resolved", 2_000);
    expect(reconcileIssueStatusOverrides(overrides, [])).toBe(overrides);
    expect(reconcileIssueStatusOverrides(NO_ISSUE_STATUS_OVERRIDES, [issue()])).toBe(NO_ISSUE_STATUS_OVERRIDES);
  });

  it("clears a single override without touching the others", () => {
    const a = applyOptimisticStatus(NO_ISSUE_STATUS_OVERRIDES, "a", "resolved", 1);
    const both = applyOptimisticStatus(a, "b", "ignored", 1);
    const cleared = clearOptimisticStatus(both, "a");
    expect(cleared.has("a")).toBe(false);
    expect(cleared.get("b")?.status).toBe("ignored");
    expect(both.has("a")).toBe(true);
  });

  it("does not report an override as optimistic when it agrees with the server", () => {
    const row = issue({ status: "resolved" });
    const overrides = applyOptimisticStatus(NO_ISSUE_STATUS_OVERRIDES, row.id, "resolved", row.updated_at_millis);
    expect(resolveIssueRowStatus(row, overrides)).toEqual({ status: "resolved", isOptimistic: false });
  });

  it("reconciles only the stale override, leaving still-live siblings untouched", () => {
    const a = applyOptimisticStatus(NO_ISSUE_STATUS_OVERRIDES, "a", "resolved", 2_000);
    const both = applyOptimisticStatus(a, "b", "ignored", 2_000);

    const rowA = issue({ id: "a", updated_at_millis: 5_000 });
    const rowB = issue({ id: "b", updated_at_millis: 2_000 });
    const reconciled = reconcileIssueStatusOverrides(both, [rowA, rowB]);

    expect(reconciled.has("a")).toBe(false);
    expect(reconciled.get("b")?.status).toBe("ignored");
    expect(both.has("a")).toBe(true);
  });

  it("keeps the same map reference when the overridden rows are not in the fetched page", () => {
    const a = applyOptimisticStatus(NO_ISSUE_STATUS_OVERRIDES, "a", "resolved", 2_000);
    const both = applyOptimisticStatus(a, "b", "ignored", 2_000);

    const reconciled = reconcileIssueStatusOverrides(both, [issue({ id: "c", updated_at_millis: 9_000 })]);

    expect(reconciled).toBe(both);
    expect(reconciled.size).toBe(2);
  });
});

describe("adjustIssueStatusCounts", () => {
  it("moves one issue between buckets", () => {
    expect(adjustIssueStatusCounts({ unresolved: 5, resolved: 2, ignored: 1 }, "unresolved", "resolved"))
      .toEqual({ unresolved: 4, resolved: 3, ignored: 1 });
  });

  it("is a no-op for same-status transitions and missing counts", () => {
    const counts = { unresolved: 5, resolved: 2, ignored: 1 };
    expect(adjustIssueStatusCounts(counts, "resolved", "resolved")).toBe(counts);
    expect(adjustIssueStatusCounts(null, "unresolved", "resolved")).toBeNull();
  });

  it("never drives a count below zero, even if the server count was already stale", () => {
    expect(adjustIssueStatusCounts({ unresolved: 0, resolved: 0, ignored: 0 }, "unresolved", "ignored"))
      .toEqual({ unresolved: 0, resolved: 0, ignored: 1 });
  });

  it("telescopes across chained optimistic transitions", () => {
    const start = { unresolved: 3, resolved: 0, ignored: 0 };
    const afterResolve = adjustIssueStatusCounts(start, "unresolved", "resolved");
    const afterUndo = adjustIssueStatusCounts(afterResolve, "resolved", "unresolved");
    expect(afterUndo).toEqual(start);
  });
});

describe("primaryIssueStatusAction", () => {
  it("offers the way back from every terminal state", () => {
    expect(primaryIssueStatusAction("unresolved")).toBe("resolve");
    expect(primaryIssueStatusAction("resolved")).toBe("unresolve");
    expect(primaryIssueStatusAction("ignored")).toBe("unresolve");
  });
});

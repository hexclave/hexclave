import type { DesignBadgeColor } from "@/components/design-components";
import type { IssueListItem, IssueStatus, IssueStatusCounts, IssueSubstatus } from "./issues-data";


export type IssueStatusAction = "resolve" | "unresolve" | "ignore";

export function nextStatusForAction(action: IssueStatusAction): IssueStatus {
  switch (action) {
    case "resolve": {
      return "resolved";
    }
    case "unresolve": {
      return "unresolved";
    }
    case "ignore": {
      return "ignored";
    }
  }
}

export type IssueStatusBadge = { label: string, color: DesignBadgeColor };

export function issueStatusBadge(issue: { status: IssueStatus, substatus: IssueSubstatus }): IssueStatusBadge | null {
  switch (issue.status) {
    case "resolved": {
      return { label: "Resolved", color: "green" };
    }
    case "ignored": {
      return { label: "Ignored", color: "zinc" };
    }
    case "unresolved": {
      if (issue.substatus === "regressed") return { label: "Regressed", color: "orange" };
      if (issue.substatus === "new") return { label: "New", color: "blue" };
      return null;
    }
  }
}

export type IssueStatusOverride = {
  status: IssueStatus,
  updatedAtMillis: number,
};

export type IssueStatusOverrides = ReadonlyMap<string, IssueStatusOverride>;

export const NO_ISSUE_STATUS_OVERRIDES: IssueStatusOverrides = new Map();

export function applyOptimisticStatus(
  overrides: IssueStatusOverrides,
  issueId: string,
  status: IssueStatus,
  updatedAtMillis: number,
): Map<string, IssueStatusOverride> {
  const next = new Map(overrides);
  next.set(issueId, { status, updatedAtMillis });
  return next;
}

export function clearOptimisticStatus(
  overrides: IssueStatusOverrides,
  issueId: string,
): Map<string, IssueStatusOverride> {
  const next = new Map(overrides);
  next.delete(issueId);
  return next;
}

export function reconcileIssueStatusOverrides(
  overrides: IssueStatusOverrides,
  rows: readonly IssueListItem[],
): IssueStatusOverrides {
  if (overrides.size === 0) return overrides;
  let next: Map<string, IssueStatusOverride> | null = null;
  for (const row of rows) {
    const override = overrides.get(row.id);
    if (override == null) continue;
    if (row.updated_at_millis <= override.updatedAtMillis) continue;
    next ??= new Map(overrides);
    next.delete(row.id);
  }
  return next ?? overrides;
}

export function resolveIssueRowStatus(
  issue: IssueListItem,
  overrides: IssueStatusOverrides,
): { status: IssueStatus, isOptimistic: boolean } {
  const override = overrides.get(issue.id);
  if (override == null || issue.updated_at_millis > override.updatedAtMillis) {
    return { status: issue.status, isOptimistic: false };
  }
  return { status: override.status, isOptimistic: override.status !== issue.status };
}

export function primaryIssueStatusAction(status: IssueStatus): IssueStatusAction {
  return status === "unresolved" ? "resolve" : "unresolve";
}

export function adjustIssueStatusCounts(
  counts: IssueStatusCounts | null,
  from: IssueStatus,
  to: IssueStatus,
): IssueStatusCounts | null {
  if (counts == null || from === to) return counts;
  return {
    ...counts,
    [from]: Math.max(0, counts[from] - 1),
    [to]: counts[to] + 1,
  };
}

"use client";

import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { useMemo } from "react";
import { CALL_STATUS_OPTIONS, HUMAN_REVIEW_OPTIONS, type McpHumanReviewState, type McpQaState, QA_STATE_OPTIONS, TIME_RANGE_OPTIONS, type CallStatus } from "../../../lib/filter-options";
import { countActiveMcpFilters, DEFAULT_MCP_ANALYTICS_FILTERS, type McpAnalyticsFilters } from "../../../lib/mcp-analytics-filters";
import type { McpCallLogRow } from "../../../types";
import { ChoiceMenu, FilterMenu } from "../../ui/overlays";
import { Button } from "../../ui/primitives";

/**
 * Saved views of the MCP review list. Each is just a filter preset over the shared filter model
 * (lib/mcp-analytics-filters), so a view and a hand-built filter combination are the same thing
 * and the server-side snapshot query treats them identically.
 */
export const MCP_VIEWS = [
  { value: "all", label: "All calls", filters: DEFAULT_MCP_ANALYTICS_FILTERS },
  { value: "needs-review", label: "Needs review", filters: { ...DEFAULT_MCP_ANALYTICS_FILTERS, humanReviewStates: new Set<McpHumanReviewState>(["required"]) } },
  { value: "low-score", label: "Low score", filters: { ...DEFAULT_MCP_ANALYTICS_FILTERS, qaStates: new Set<McpQaState>(["fail"]) } },
  { value: "qa-failed", label: "QA failed", filters: { ...DEFAULT_MCP_ANALYTICS_FILTERS, qaStates: new Set<McpQaState>(["review-failed", "error"]) } },
  { value: "errors", label: "Errors", filters: { ...DEFAULT_MCP_ANALYTICS_FILTERS, statuses: new Set<CallStatus>(["error"]) } },
] as const;
export type McpViewId = typeof MCP_VIEWS[number]["value"];

export function mcpViewFilters(view: string | null): McpAnalyticsFilters {
  return MCP_VIEWS.find(candidate => candidate.value === view)?.filters ?? DEFAULT_MCP_ANALYTICS_FILTERS;
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  return a.size === b.size && [...a].every(value => b.has(value));
}

/** The view whose preset equals `filters` exactly, or null for a hand-built combination. */
export function matchingMcpView(filters: McpAnalyticsFilters): McpViewId | null {
  const match = MCP_VIEWS.find(view => view.filters.timeRange === filters.timeRange
    && sameSet(view.filters.toolNames, filters.toolNames)
    && sameSet(view.filters.statuses, filters.statuses)
    && sameSet(view.filters.qaStates, filters.qaStates)
    && sameSet(view.filters.humanReviewStates, filters.humanReviewStates));
  return match?.value ?? null;
}

export function McpFilterControls({ rows, filters, onChange }: {
  rows: readonly McpCallLogRow[],
  filters: McpAnalyticsFilters,
  onChange: (filters: McpAnalyticsFilters) => void,
}) {
  // Tool options come from loaded rows, not a hardcoded list: the MCP server's tool set changes
  // without this app being redeployed, and an option nobody can match is worse than a missing one.
  const toolOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.toolName, (counts.get(row.toolName) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => stringCompare(a, b)).map(([value, count]) => ({ value, label: value, count }));
  }, [rows]);
  const set = <Key extends keyof McpAnalyticsFilters>(key: Key, value: McpAnalyticsFilters[Key]) => onChange({ ...filters, [key]: value });
  const activeCount = countActiveMcpFilters(filters);

  return (
    <>
      <ChoiceMenu label="Time range" value={filters.timeRange} defaultValue="all" options={TIME_RANGE_OPTIONS} onChange={value => set("timeRange", value)} />
      <FilterMenu label="Tool" mono options={toolOptions} selected={filters.toolNames} onChange={value => set("toolNames", value)} />
      <FilterMenu label="Status" options={CALL_STATUS_OPTIONS} selected={filters.statuses} onChange={value => set("statuses", value)} />
      <FilterMenu label="AI review" options={QA_STATE_OPTIONS} selected={filters.qaStates} onChange={value => set("qaStates", value)} />
      <FilterMenu label="Human review" options={HUMAN_REVIEW_OPTIONS} selected={filters.humanReviewStates} onChange={value => set("humanReviewStates", value)} />
      {activeCount > 0 && <Button size="xs" variant="ghost" onClick={() => onChange(DEFAULT_MCP_ANALYTICS_FILTERS)}>Clear</Button>}
    </>
  );
}

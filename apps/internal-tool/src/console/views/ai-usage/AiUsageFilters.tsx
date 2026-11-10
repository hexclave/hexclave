"use client";

import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { useEffect, useMemo, useRef, useState } from "react";
import { countActiveAiUsageScopeFilters, DEFAULT_AI_USAGE_SCOPE_FILTERS, type AiUsageScopeFilters } from "../../../lib/ai-usage-filters";
import { AUTH_OPTIONS, type AuthState, CALL_STATUS_OPTIONS, MODE_OPTIONS, TIME_RANGE_OPTIONS } from "../../../lib/filter-options";
import { emptyUsageFilters, hasUsageFilters, KNOWN_REQUESTED_TOOLS, parseUsageRow, PRESENCE_OPTIONS, TOOL_CALL_OUTCOME_OPTIONS, type UsageFilters } from "../../../lib/usage-filters";
import type { AiQueryLogRow } from "../../../types";
import type { LogSource } from "../../data/console-data";
import { ChoiceMenu, FilterMenu } from "../../ui/overlays";
import { Button, Input, SearchInput } from "../../ui/primitives";

/** System prompts that exist in code, so they're filterable before their first logged request. */
const KNOWN_SYSTEM_PROMPTS = [
  "command-center-ask-ai",
  "docs-ask-ai",
  "wysiwyg-edit",
  "email-wysiwyg-editor",
  "email-assistant-template",
  "email-assistant-theme",
  "email-assistant-draft",
  "create-dashboard",
  "run-query",
  "rewrite-template-source",
];

function countedOptions(values: Iterable<string>, rows: readonly AiQueryLogRow[], key: (row: AiQueryLogRow) => string) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, 0);
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => stringCompare(a, b)).map(([value, count]) => ({ value, label: value, count }));
}

/**
 * Both filter layers of the AI Usage page:
 * - scope filters (range, flow, model, mode, auth, status) — the server paging procedure supports
 *   these, so the request list can query them beyond the loaded window;
 * - investigation filters (tools, project/user, full-text search) — client-side only, over loaded
 *   rows, which is why "Load all history" sits right next to them.
 */
export function AiUsageFilters({ rows, scope, onScopeChange, investigation, onInvestigationChange, history }: {
  rows: readonly AiQueryLogRow[],
  scope: AiUsageScopeFilters,
  onScopeChange: (scope: AiUsageScopeFilters) => void,
  investigation: UsageFilters,
  onInvestigationChange: (filters: UsageFilters) => void,
  history: Pick<LogSource<AiQueryLogRow>, "hasMoreHistory" | "isLoadingOlder" | "loadOlder" | "connectionState">,
}) {
  const [showMore, setShowMore] = useState(() => hasUsageFilters({ ...investigation, search: "" }));
  const setScope = <Key extends keyof AiUsageScopeFilters>(key: Key, value: AiUsageScopeFilters[Key]) => onScopeChange({ ...scope, [key]: value });
  const setInvestigation = <Key extends keyof UsageFilters>(key: Key, value: UsageFilters[Key]) => onInvestigationChange({ ...investigation, [key]: value });

  const systemPromptOptions = useMemo(() => countedOptions(KNOWN_SYSTEM_PROMPTS, rows, row => row.systemPromptId), [rows]);
  const modelOptions = useMemo(() => countedOptions([], rows, row => row.modelId), [rows]);
  const toolOptions = useMemo(() => {
    const requested = new Set(KNOWN_REQUESTED_TOOLS);
    const called = new Set<string>();
    for (const row of rows) {
      const parsed = parseUsageRow(row);
      for (const tool of parsed.requestedTools) requested.add(tool);
      for (const tool of parsed.calledTools) called.add(tool);
    }
    const asOptions = (values: Set<string>) => [...values].sort(stringCompare).map(value => ({ value, label: value }));
    return { requested: asOptions(requested), called: asOptions(called) };
  }, [rows]);

  const investigationCount = [
    investigation.requestedTools.size > 0,
    investigation.calledTools.size > 0,
    investigation.toolCalls.size > 0,
    investigation.projectPresence.size > 0 || investigation.projectId !== "",
    investigation.userPresence.size > 0 || investigation.userId !== "",
  ].filter(Boolean).length;
  const anyActive = countActiveAiUsageScopeFilters(scope) > 0 || hasUsageFilters(investigation);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          label="Search AI requests"
          placeholder="Search messages, SQL, tools, IDs, errors…"
          value={investigation.search}
          onChange={value => setInvestigation("search", value)}
          className="w-full max-w-sm"
        />
        <ChoiceMenu label="Time range" value={scope.timeRange} defaultValue="all" options={TIME_RANGE_OPTIONS} onChange={value => setScope("timeRange", value)} />
        <FilterMenu label="Flow" mono options={systemPromptOptions} selected={scope.systemPromptIds} onChange={value => setScope("systemPromptIds", value)} />
        <FilterMenu label="Model" mono options={modelOptions} selected={scope.modelIds} onChange={value => setScope("modelIds", value)} />
        <FilterMenu label="Mode" options={MODE_OPTIONS} selected={scope.modes} onChange={value => setScope("modes", value)} />
        <FilterMenu label="Auth" options={AUTH_OPTIONS} selected={scope.auth} onChange={value => setScope("auth", value)} />
        <FilterMenu label="Status" options={CALL_STATUS_OPTIONS} selected={scope.statuses} onChange={value => setScope("statuses", value)} />
        <Button size="xs" variant="ghost" icon={showMore ? "chevronUp" : "chevronDown"} onClick={() => setShowMore(previous => !previous)}>
          {investigationCount > 0 ? `Tools & identity · ${investigationCount}` : "Tools & identity"}
        </Button>
        {anyActive && (
          <Button size="xs" variant="ghost" onClick={() => {
            onScopeChange(DEFAULT_AI_USAGE_SCOPE_FILTERS);
            onInvestigationChange(emptyUsageFilters());
          }}>
            Clear
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="xs"
            onClick={() => {
              onScopeChange({ ...DEFAULT_AI_USAGE_SCOPE_FILTERS, auth: new Set<AuthState>(["anon"]) });
              onInvestigationChange({ ...emptyUsageFilters(), toolCalls: new Set(["succeeded"]) });
              setShowMore(true);
            }}
            title="Anonymous requests whose tool calls succeeded"
          >
            Anon tool calls
          </Button>
          <LoadAllHistoryButton history={history} />
        </div>
      </div>
      {showMore && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-2">
          <FilterMenu label="Requested tools" mono options={toolOptions.requested} selected={investigation.requestedTools} onChange={value => setInvestigation("requestedTools", value)} />
          <FilterMenu label="Called tools" mono options={toolOptions.called} selected={investigation.calledTools} onChange={value => setInvestigation("calledTools", value)} />
          <FilterMenu label="Tool calls" options={TOOL_CALL_OUTCOME_OPTIONS} selected={investigation.toolCalls} onChange={value => setInvestigation("toolCalls", value)} />
          <span className="mx-1 h-4 w-px bg-border" />
          <FilterMenu label="Project ID" options={PRESENCE_OPTIONS} selected={investigation.projectPresence} onChange={value => setInvestigation("projectPresence", value)} />
          <Input aria-label="Exact project ID" placeholder="Exact project ID" fullWidth={false} className="w-44 font-mono" value={investigation.projectId} onChange={event => setInvestigation("projectId", event.target.value)} />
          <FilterMenu label="User ID" options={PRESENCE_OPTIONS} selected={investigation.userPresence} onChange={value => setInvestigation("userPresence", value)} />
          <Input aria-label="Exact user ID" placeholder="Exact user ID" fullWidth={false} className="w-44 font-mono" value={investigation.userId} onChange={event => setInvestigation("userId", event.target.value)} />
          <span className="ml-auto text-[11px] text-muted-foreground">Applies to loaded history</span>
        </div>
      )}
    </div>
  );
}

/** Pages through the whole history (cancellable), so client-side filters see every request. */
function LoadAllHistoryButton({ history }: { history: Pick<LogSource<AiQueryLogRow>, "hasMoreHistory" | "isLoadingOlder" | "loadOlder" | "connectionState"> }) {
  const controller = useRef<AbortController | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);
  if (loadingAll) {
    return <Button size="xs" loading={false} icon="close" onClick={() => controller.current?.abort()}>Cancel loading</Button>;
  }
  return (
    <Button
      size="xs"
      icon="database"
      disabled={!history.hasMoreHistory || history.isLoadingOlder || history.connectionState !== "connected"}
      title={history.hasMoreHistory ? "Fetch every older request so search and tool filters cover all history" : "All history is loaded"}
      onClick={() => {
        const abortController = new AbortController();
        controller.current = abortController;
        setLoadingAll(true);
        runAsynchronouslyWithAlert(history.loadOlder({ all: true, signal: abortController.signal }).finally(() => {
          controller.current = null;
          setLoadingAll(false);
        }));
      }}
    >
      {history.hasMoreHistory ? "Load all history" : "All history loaded"}
    </Button>
  );
}

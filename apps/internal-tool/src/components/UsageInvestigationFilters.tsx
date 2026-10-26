import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useMemo, useRef, useState } from "react";
import { stringOptions } from "../lib/filter-options";
import { emptyUsageFilters, hasUsageFilters, PRESENCE_OPTIONS, TOOL_CALL_OUTCOME_OPTIONS, type UsageFilters } from "../lib/usage-filters";
import { MultiFilter } from "./FilterFields";
import type { HistoryPagingProps } from "./LoadOlderButton";
import { Button, FilterField, Input, MultiSelect, Panel, PanelRow } from "./design";

export function UsageInvestigationFilters({ filters, onChange, requestedTools, calledTools, onPreset, onClear,
  hasOtherFilters, rowCount, hasMoreHistory, isLoadingOlder, onLoadOlder, connected, children, summary, actions }: {
  filters: UsageFilters,
  onChange: (filters: UsageFilters) => void,
  requestedTools: string[],
  calledTools: string[],
  onPreset: () => void,
  onClear: () => void,
  hasOtherFilters: boolean,
  rowCount: number,
  connected: boolean,
  /**
   * View-specific scope filters (range, model, …). They share one wrapping row with the
   * investigation filters, so each view has exactly one filter surface and rows fill evenly.
   */
  children?: React.ReactNode,
  /** View-specific status text (eg. "12 of 40 calls"), shown next to the loaded-rows count. */
  summary?: React.ReactNode,
  /** View-specific actions (eg. refreshing a snapshot), shown with the panel's other actions. */
  actions?: React.ReactNode,
} & HistoryPagingProps) {
  const controller = useRef<AbortController | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);

  const requestedToolOptions = useMemo(() => stringOptions(requestedTools), [requestedTools]);
  const calledToolOptions = useMemo(() => stringOptions(calledTools), [calledTools]);
  const setFilter = <Key extends keyof UsageFilters>(key: Key, value: UsageFilters[Key]) => onChange({ ...filters, [key]: value });

  return (
    <Panel>
      <PanelRow className="gap-x-2">
        <Input aria-label="Search AI requests" placeholder="Search messages, SQL, tools, IDs, errors…" value={filters.search}
          className="min-w-64 flex-1" onChange={event => onChange({ ...filters, search: event.target.value })} />
        <div className="flex items-center gap-2">
          {actions}
          <Button onClick={onPreset}>Anon tool calls</Button>
          <Button disabled={loadingAll || isLoadingOlder || !hasMoreHistory || !connected} onClick={() => {
            if (controller.current != null) return;
            const abortController = new AbortController();
            controller.current = abortController;
            setLoadingAll(true);
            runAsynchronouslyWithAlert(onLoadOlder({ all: true, signal: abortController.signal }).finally(() => {
              controller.current = null;
              setLoadingAll(false);
            }));
          }}>{loadingAll ? "Loading history…" : "Load all history"}</Button>
          {loadingAll && <Button variant="ghost" onClick={() => controller.current?.abort()}>Cancel</Button>}
          {(hasUsageFilters(filters) || hasOtherFilters) && <Button variant="ghost" onClick={() => {
            onChange(emptyUsageFilters());
            onClear();
          }}>Clear filters</Button>}
        </div>
        <span role="status" className="whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
          {summary != null && <>{summary} · </>}{rowCount.toLocaleString()} rows · {hasMoreHistory ? "partial history" : "full history"}
        </span>
      </PanelRow>
      <PanelRow>
        {children}
        <MultiFilter label="Requested tools" mono controlClassName="w-36" options={requestedToolOptions} selected={filters.requestedTools} onChange={selected => setFilter("requestedTools", selected)} />
        <MultiFilter label="Called tools" mono controlClassName="w-36" options={calledToolOptions} selected={filters.calledTools} onChange={selected => setFilter("calledTools", selected)} />
        <MultiFilter label="Tool calls" controlClassName="w-32" options={TOOL_CALL_OUTCOME_OPTIONS} selected={filters.toolCalls} onChange={selected => setFilter("toolCalls", selected)} />
        {(["project", "user"] satisfies Array<"project" | "user">).map(kind => {
          const presenceKey = kind === "project" ? "projectPresence" : "userPresence";
          const idKey = kind === "project" ? "projectId" : "userId";
          const label = kind === "project" ? "Project ID" : "User ID";
          return <FilterField key={kind} label={label} controlClassName="w-64 gap-1.5">
            <div className="w-24 shrink-0">
              <MultiSelect label={`${label} presence`} allLabel="Any" options={PRESENCE_OPTIONS} selected={filters[presenceKey]}
                onChange={selected => setFilter(presenceKey, selected)} />
            </div>
            <Input aria-label={`Exact ${label}`} placeholder="Exact ID" className="font-mono" value={filters[idKey]}
              onChange={event => setFilter(idKey, event.target.value)} />
          </FilterField>;
        })}
      </PanelRow>
    </Panel>
  );
}

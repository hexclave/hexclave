import { captureError } from "@hexclave/shared/dist/utils/errors";
import type { AiQueryLogRow } from "../types";

export const PRESENCE_OPTIONS = [
  { value: "present", label: "Present" },
  { value: "missing", label: "Missing" },
] as const;
export type Presence = typeof PRESENCE_OPTIONS[number]["value"];

/**
 * What a request did with tools. A multi-select like every other filter: a row matches if any
 * selected outcome holds. "called" is any tool call at all (it used to be a separate "Any tool"
 * toggle); "succeeded"/"failed" look at results, scoped to the selected called tools if any.
 */
export const TOOL_CALL_OUTCOME_OPTIONS = [
  { value: "called", label: "Any call" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "none", label: "No calls" },
] as const;
export type ToolCallOutcome = typeof TOOL_CALL_OUTCOME_OPTIONS[number]["value"];

export type UsageFilters = {
  requestedTools: ReadonlySet<string>,
  calledTools: ReadonlySet<string>,
  toolCalls: ReadonlySet<ToolCallOutcome>,
  /** Empty or both = any; one value = only rows where the ID is present / missing. */
  projectPresence: ReadonlySet<Presence>,
  projectId: string,
  userPresence: ReadonlySet<Presence>,
  userId: string,
  search: string,
};

export function emptyUsageFilters(): UsageFilters {
  return {
    requestedTools: new Set(), calledTools: new Set(), toolCalls: new Set(),
    projectPresence: new Set(), projectId: "", userPresence: new Set(), userId: "", search: "",
  };
}

export const KNOWN_REQUESTED_TOOLS = [
  "docs", "sql-query", "read-config", "create-email-theme",
  "create-email-template", "create-email-draft", "update-dashboard",
];

type ToolEntry = { toolName: string, toolCallId: string };
type ToolResult = ToolEntry & { result: unknown };
type Step = { toolCalls?: ToolEntry[], toolResults?: ToolResult[] };
type Parsed = { requestedTools: ReadonlySet<string>, calledTools: ReadonlySet<string>, calls: ToolEntry[], results: ToolResult[], search: string };
type FilterRow = Pick<AiQueryLogRow, "requestedToolsJson" | "stepsJson" | "finalText" | "messagesJson" | "correlationId" | "projectId" | "userId" | "errorMessage">;
const parsedRows = new WeakMap<FilterRow, Parsed>();

function isObject(value: unknown): value is object {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function isToolEntry(value: unknown): value is ToolEntry {
  return isObject(value) && "toolName" in value && typeof value.toolName === "string"
    && "toolCallId" in value && typeof value.toolCallId === "string";
}
function isToolResult(value: unknown): value is ToolResult {
  return isToolEntry(value) && "result" in value;
}
function isStep(value: unknown): value is Step {
  return isObject(value)
    && (!("toolCalls" in value) || (Array.isArray(value.toolCalls) && value.toolCalls.every(isToolEntry)))
    && (!("toolResults" in value) || (Array.isArray(value.toolResults) && value.toolResults.every(isToolResult)));
}
function isSteps(value: unknown): value is Step[] {
  return Array.isArray(value) && value.every(isStep);
}
function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}
function parseJson<T>(json: string, validate: (value: unknown) => value is T, empty: T, field: string): T {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Do not include raw log contents in diagnostics.
    captureError("usage-filter-json", new Error(`Malformed ${field}`));
    return empty;
  }
  if (validate(value)) return value;
  captureError("usage-filter-json", new Error(`Invalid ${field} shape`));
  return empty;
}

export function parseUsageRow(row: FilterRow): Parsed {
  const cached = parsedRows.get(row);
  if (cached != null) return cached;
  const requestedTools = new Set(parseJson(row.requestedToolsJson, isStrings, [], "requestedToolsJson"));
  const steps = parseJson(row.stepsJson, isSteps, [], "stepsJson");
  const calls = steps.flatMap(step => step.toolCalls ?? []);
  const parsed = {
    requestedTools,
    calledTools: new Set(calls.map(call => call.toolName)),
    calls,
    results: steps.flatMap(step => step.toolResults ?? []),
    search: [row.finalText, row.messagesJson, row.stepsJson, row.requestedToolsJson,
      row.correlationId, row.projectId, row.userId, row.errorMessage].join("\n").toLowerCase(),
  };
  parsedRows.set(row, parsed);
  return parsed;
}

function matchesPresence(value: string | undefined, presence: ReadonlySet<Presence>, exact: string): boolean {
  const present = value != null && value !== "";
  return (presence.size === 0 || presence.has(present ? "present" : "missing"))
    && (exact === "" || value === exact);
}

function succeeded(result: unknown): boolean {
  return isObject(result) && (
    ("success" in result && result.success === true)
    || ("_truncated" in result && result._truncated === true && "preview" in result
      && typeof result.preview === "string" && /^\{"success":true(?:[,}\s]|$)/.test(result.preview))
  );
}
function failed(result: unknown): boolean {
  return isObject(result) && (("success" in result && result.success === false)
    || ("error" in result && typeof result.error === "string"));
}

function matchesToolCallOutcome(parsed: Parsed, outcome: ToolCallOutcome, calledTools: ReadonlySet<string>): boolean {
  switch (outcome) {
    case "called": { return parsed.calls.length > 0; }
    case "none": { return parsed.calls.length === 0; }
    case "succeeded":
    case "failed": {
      const classify = outcome === "succeeded" ? succeeded : failed;
      // Match call IDs as well as names: results may arrive in a later step.
      return parsed.results.some(result => classify(result.result) && parsed.calls.some(call =>
        call.toolCallId === result.toolCallId && call.toolName === result.toolName
        && (calledTools.size === 0 || calledTools.has(call.toolName))));
    }
  }
}

export function matchesUsageFilters(row: FilterRow, filters: UsageFilters): boolean {
  const parsed = parseUsageRow(row);
  if (filters.requestedTools.size > 0 && !Array.from(filters.requestedTools).some(tool => parsed.requestedTools.has(tool))) return false;
  if (filters.calledTools.size > 0 && !Array.from(filters.calledTools).some(tool => parsed.calledTools.has(tool))) return false;
  if (filters.toolCalls.size > 0 && !Array.from(filters.toolCalls).some(outcome => matchesToolCallOutcome(parsed, outcome, filters.calledTools))) return false;
  return matchesPresence(row.projectId, filters.projectPresence, filters.projectId)
    && matchesPresence(row.userId, filters.userPresence, filters.userId)
    && parsed.search.includes(filters.search.toLowerCase());
}

export function hasUsageFilters(filters: UsageFilters): boolean {
  return filters.requestedTools.size > 0 || filters.calledTools.size > 0 || filters.toolCalls.size > 0
    || filters.projectPresence.size > 0 || filters.projectId !== ""
    || filters.userPresence.size > 0 || filters.userId !== "" || filters.search !== "";
}

export function usageFilterKey(filters: UsageFilters): string {
  const sorted = (values: ReadonlySet<string>) => [...values].sort();
  return JSON.stringify({
    ...filters,
    requestedTools: sorted(filters.requestedTools),
    calledTools: sorted(filters.calledTools),
    toolCalls: sorted(filters.toolCalls),
    projectPresence: sorted(filters.projectPresence),
    userPresence: sorted(filters.userPresence),
  });
}


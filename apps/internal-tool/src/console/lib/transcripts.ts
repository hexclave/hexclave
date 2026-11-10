import { captureError } from "@hexclave/shared/dist/utils/errors";
import type { AiQueryLogRow, McpCallLogRow } from "../../types";
import { toDate } from "../../utils";
import type { TranscriptEntry, TranscriptToolCall } from "../views/shared/Transcript";

/*
 * Converts the JSON blobs stored on log rows into Transcript entries. Malformed JSON is reported
 * and rendered as an empty part of the trace rather than thrown: one bad row must not take down
 * the detail panel for every other field.
 */

function parseJsonArray(json: string | null | undefined, field: string): unknown[] {
  if (json == null || json === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Never include the raw log contents in diagnostics.
    captureError("console-transcript-json", new Error(`Malformed ${field}`));
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** Text content of a chat message part list (`[{ type: "text", text }]`), a string, or anything else as JSON. */
export function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(messageContentToText).join("");
  if (isRecord(content) && "text" in content) return messageContentToText(content.text);
  if (content == null) return "";
  return JSON.stringify(content);
}

function parseToolCalls(json: string): TranscriptToolCall[] {
  return parseJsonArray(json, "innerToolCallsJson").flatMap((call, index) => {
    if (!isRecord(call)) return [];
    const toolName = stringField(call, "toolName");
    if (toolName == null) return [];
    return [{ toolName, toolCallId: stringField(call, "toolCallId") ?? String(index), args: call.args, result: call.result ?? null }];
  });
}

/** Rows of the same MCP conversation, oldest first; just the row itself when it has no siblings. */
export function conversationRows(row: McpCallLogRow, allRows: readonly McpCallLogRow[]): McpCallLogRow[] {
  if (row.conversationId == null || row.conversationId === "") return [row];
  const related = allRows
    .filter(candidate => candidate.conversationId === row.conversationId)
    .sort((a, b) => toDate(a.createdAt).getTime() - toDate(b.createdAt).getTime());
  return related.length > 1 ? related : [row];
}

export function mcpConversationEntries(rows: readonly McpCallLogRow[]): TranscriptEntry[] {
  return rows.flatMap((callRow, index): TranscriptEntry[] => [
    ...(rows.length > 1 ? [{ kind: "divider" as const, label: `Call ${index + 1} of ${rows.length} · ${callRow.toolName}` }] : []),
    ...(callRow.userPrompt !== "" ? [{ kind: "note" as const, label: "Original prompt", text: callRow.userPrompt }] : []),
    { kind: "user", text: callRow.question },
    { kind: "assistant", text: callRow.response, toolCalls: parseToolCalls(callRow.innerToolCallsJson) },
  ]);
}

/**
 * Pairs each step's tool calls with their results: by toolCallId where present, by position for
 * older rows that predate the id.
 */
function stepToolCalls(step: Record<string, unknown>, stepIndex: number): TranscriptToolCall[] {
  const calls = Array.isArray(step.toolCalls) ? step.toolCalls.filter(isRecord) : [];
  const results = Array.isArray(step.toolResults) ? step.toolResults.filter(isRecord) : [];
  const resultsById = new Map(results.flatMap(result => {
    const id = stringField(result, "toolCallId");
    return id == null ? [] : [[id, result] as const];
  }));
  return calls.flatMap((call, index) => {
    const toolName = stringField(call, "toolName");
    if (toolName == null) return [];
    const id = stringField(call, "toolCallId");
    const result = (id == null ? undefined : resultsById.get(id)) ?? results.at(index);
    return [{ toolName, toolCallId: id ?? `${stepIndex}-${index}`, args: call.args, result: result?.result ?? null }];
  });
}

function stepEntries(json: string | null | undefined, field: string): TranscriptEntry[] {
  return parseJsonArray(json, field).flatMap((step, index): TranscriptEntry[] => {
    if (!isRecord(step)) return [];
    const text = stringField(step, "text") ?? "";
    const toolCalls = stepToolCalls(step, index);
    // A step with neither text nor tool calls (the model just stopped) would be an empty bubble.
    if (text === "" && toolCalls.length === 0) return [];
    return [{ kind: "assistant", text, toolCalls }];
  });
}

export function qaReviewerEntries(row: McpCallLogRow): TranscriptEntry[] {
  return stepEntries(row.qaConversationJson, "qaConversationJson");
}

export function aiRequestEntries(row: AiQueryLogRow): { input: TranscriptEntry[], output: TranscriptEntry[] } {
  const input = parseJsonArray(row.messagesJson, "messagesJson").flatMap((message): TranscriptEntry[] => {
    if (!isRecord(message)) return [];
    const text = messageContentToText(message.content);
    if (message.role === "user") return [{ kind: "user", text }];
    if (message.role === "assistant") return [{ kind: "assistant", text, toolCalls: [] }];
    return [{ kind: "tool", text }];
  });
  const steps = stepEntries(row.stepsJson, "stepsJson");
  const output = steps.length > 0 || row.finalText === ""
    ? steps
    : [{ kind: "assistant" as const, text: row.finalText, toolCalls: [] }];
  return { input, output };
}

// Rows are immutable snapshots from the subscription cache, so the parsed preview can be cached
// per row object; the table renders it once per visible cell and once per search keystroke.
const latestUserMessageCache = new WeakMap<AiQueryLogRow, string>();

/** The latest user-authored message of a request: the thing this row answers. */
export function latestUserMessage(row: AiQueryLogRow): string {
  const cached = latestUserMessageCache.get(row);
  if (cached != null) return cached;
  const message = computeLatestUserMessage(row);
  latestUserMessageCache.set(row, message);
  return message;
}

function computeLatestUserMessage(row: AiQueryLogRow): string {
  const messages = parseJsonArray(row.messagesJson, "messagesJson");
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = messageContentToText(message.content).trim();
    if (text !== "") return text;
  }
  return "";
}

export function requestedTools(row: AiQueryLogRow): string[] {
  return parseJsonArray(row.requestedToolsJson, "requestedToolsJson").filter((tool): tool is string => typeof tool === "string");
}

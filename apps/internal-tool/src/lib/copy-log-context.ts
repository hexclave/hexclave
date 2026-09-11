import type { AiQueryLogRow, McpCallLogRow } from "../types";
import { toDate } from "../utils";

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return value;
    throw error;
  }
}

function expandJsonFields(row: object, jsonFieldNames: ReadonlySet<string>): object {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    jsonFieldNames.has(key) && typeof value === "string" ? parseJsonValue(value) : value,
  ]));
}

export function formatStoredLogContext(kind: string, createdAt: Date, row: object, jsonFieldNames: ReadonlySet<string>): string {
  const data = expandJsonFields(row, jsonFieldNames);
  const json = JSON.stringify({
    contextType: kind,
    createdAtIso: createdAt.toISOString(),
    data,
  }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2);
  return `# Hexclave ${kind} context\n\n\`\`\`json\n${json}\n\`\`\``;
}

const MCP_JSON_FIELDS: ReadonlySet<string> = new Set(["innerToolCallsJson", "qaFlagsJson", "qaConversationJson"]);
const AI_JSON_FIELDS: ReadonlySet<string> = new Set(["requestedToolsJson", "messagesJson", "stepsJson"]);

export function formatMcpCallContext(row: McpCallLogRow): string {
  return formatStoredLogContext("MCP call", toDate(row.createdAt), row, MCP_JSON_FIELDS);
}

export function formatAiRequestContext(row: AiQueryLogRow): string {
  return formatStoredLogContext("AI request", toDate(row.createdAt), row, AI_JSON_FIELDS);
}

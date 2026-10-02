"use client";

import { DesignBadge, type DesignBadgeColor } from "@/components/design-components";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { ArrowElbowDownRightIcon, SparkleIcon, WrenchIcon, type Icon } from "@phosphor-icons/react";
import { Fragment, useState } from "react";
import type { RowData } from "../../analytics/shared";
import { tryParseJson } from "../format";

/**
 * The AI columns extracted at ingest from Vercel AI SDK (`ai.*`) and OTel
 * GenAI (`gen_ai.*`) span attributes. `operationName` doubles as the AI-span
 * discriminant: it is non-null exactly when the span is an AI span, so every
 * other field only carries meaning when a summary exists at all. All other
 * fields are legitimately nullable — producers rarely send the full set.
 */
export type AiSpanSummary = {
  operationName: string,
  providerName: string | null,
  requestModel: string | null,
  responseModel: string | null,
  toolName: string | null,
  agentName: string | null,
  conversationId: string | null,
  inputTokens: string | null,
  outputTokens: string | null,
  cacheReadInputTokens: string | null,
  reasoningOutputTokens: string | null,
};

function stringColumn(value: Json | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

const UINT64_MAX = BigInt("18446744073709551615");

function tokenCountColumn(column: string, value: Json | undefined): string | null {
  if (value == null) return null;
  // ClickHouse serializes UInt64 as a JSON string by default
  // (output_format_json_quote_64bit_integers), so both forms are expected.
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d{1,20}$/.test(value) && BigInt(value) <= UINT64_MAX) {
    return BigInt(value).toString();
  }
  throw new Error(`AI token column ${column} must be a non-negative integer, received ${JSON.stringify(value)}`);
}

export function tryAiSpanSummaryFromRaw(raw: RowData): AiSpanSummary | null {
  try {
    return aiSpanSummaryFromRaw(raw);
  } catch (error) {
    captureError("observability-ai-span-summary-invalid", error);
    return null;
  }
}

export function aiSpanSummaryFromRaw(raw: RowData): AiSpanSummary | null {
  const operationName = stringColumn(raw.gen_ai_operation_name);
  if (operationName == null) return null;
  return {
    operationName,
    providerName: stringColumn(raw.gen_ai_provider_name),
    requestModel: stringColumn(raw.gen_ai_request_model),
    responseModel: stringColumn(raw.gen_ai_response_model),
    toolName: stringColumn(raw.gen_ai_tool_name),
    agentName: stringColumn(raw.gen_ai_agent_name),
    conversationId: stringColumn(raw.gen_ai_conversation_id),
    inputTokens: tokenCountColumn("gen_ai_input_tokens", raw.gen_ai_input_tokens),
    outputTokens: tokenCountColumn("gen_ai_output_tokens", raw.gen_ai_output_tokens),
    cacheReadInputTokens: tokenCountColumn("gen_ai_cache_read_input_tokens", raw.gen_ai_cache_read_input_tokens),
    reasoningOutputTokens: tokenCountColumn("gen_ai_reasoning_output_tokens", raw.gen_ai_reasoning_output_tokens),
  };
}

export function aiSpanTokenLabel(summary: AiSpanSummary): string | null {
  if (summary.inputTokens == null && summary.outputTokens == null) return null;
  const format = (count: string | null) => count ?? "?";
  return `${format(summary.inputTokens)}→${format(summary.outputTokens)} tok`;
}

export function aiSpanChipLabel(summary: AiSpanSummary): string {
  // The model identifies most AI spans best; tool/agent invocations often
  // carry no model, so their own name is the next most useful identity.
  const subject = summary.requestModel
    ?? (summary.operationName === "execute_tool" ? summary.toolName : null)
    ?? (summary.operationName === "invoke_agent" ? summary.agentName : null)
    ?? summary.operationName;
  const tokens = aiSpanTokenLabel(summary);
  return tokens == null ? subject : `${subject} · ${tokens}`;
}

/**
 * Structured message parts, normalized from the two attribute dialects we see
 * on the wire: OTel GenAI parts (`{ type, content }`, `tool_call`,
 * `tool_call_response`) and Vercel AI SDK parts (`{ type, text }`,
 * `tool-call`, `tool-result`). The payload fields (`args`, `result`, `value`)
 * are `unknown` rather than `Json` because they come out of `isRecord`
 * narrowing; they are always JSON-derived, so serializing them for display is
 * safe.
 */
export type AiMessagePart =
  | { type: "text", text: string }
  | { type: "reasoning", text: string }
  | { type: "tool_call", name: string | null, id: string | null, args: unknown }
  | { type: "tool_result", name: string | null, id: string | null, result: unknown }
  | { type: "raw", value: unknown };

export type AiChatMessage = {
  role: string,
  parts: AiMessagePart[],
};

export type AiConversationSection = {
  kind: "input" | "output",
  /** The span attribute(s) the messages came from, e.g. `gen_ai.input.messages`. */
  source: string,
  messages: AiChatMessage[],
};

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Like `tryParseJson`, but over `unknown` values: attribute bags narrow to
 * `Record<string, unknown>` via `isRecord`, and only the string case needs
 * parsing anyway. Non-string values pass through untouched.
 */
function parseIfJsonString(value: unknown): unknown {
  return typeof value === "string" ? tryParseJson(value) : value;
}

/** OTel GenAI parts carry `content`; Vercel AI SDK parts carry `text`. */
function partText(record: Record<string, unknown>): string | null {
  if (typeof record.content === "string") return record.content;
  if (typeof record.text === "string") return record.text;
  return null;
}

function parsePart(item: unknown): AiMessagePart {
  if (typeof item === "string") return { type: "text", text: item };
  if (isRecord(item)) {
    switch (item.type) {
      case "text":
      case "reasoning": {
        const text = partText(item);
        if (text != null) return { type: item.type, text };
        break;
      }
      // OTel GenAI: { type: "tool_call", id, name, arguments }
      case "tool_call": {
        return { type: "tool_call", name: optionalString(item.name), id: optionalString(item.id), args: item.arguments ?? null };
      }
      // Vercel AI SDK: { type: "tool-call", toolCallId, toolName, args } in
      // v4, with `args` renamed to `input` in v5.
      case "tool-call": {
        return { type: "tool_call", name: optionalString(item.toolName), id: optionalString(item.toolCallId), args: item.args ?? item.input ?? null };
      }
      // OTel GenAI: { type: "tool_call_response", id, response } — some
      // pre-1.37 emitters used `result` for the payload field.
      case "tool_call_response": {
        return { type: "tool_result", name: null, id: optionalString(item.id), result: item.response ?? item.result ?? null };
      }
      // Vercel AI SDK: { type: "tool-result", toolCallId, toolName, result }
      // in v4, with `result` renamed to `output` in v5.
      case "tool-result": {
        return { type: "tool_result", name: optionalString(item.toolName), id: optionalString(item.toolCallId), result: item.result ?? item.output ?? null };
      }
      default: {
        break;
      }
    }
  }
  // Unknown part shapes (images, files, future conventions) stay visible as
  // their raw JSON instead of being dropped.
  return { type: "raw", value: item };
}

/**
 * Returns null when the value is not the expected message-list shape — that is
 * a render-skip (the raw data section still shows the attribute), not an
 * error, because producers are free to put anything into these attributes.
 */
function parseMessageList(value: unknown): AiChatMessage[] | null {
  const parsed = parseIfJsonString(value);
  if (!Array.isArray(parsed)) return null;
  const messages: AiChatMessage[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.role !== "string") return null;
    // OTel GenAI messages carry `parts`; Vercel AI SDK messages carry
    // `content` (a plain string or an array of parts).
    const content = "parts" in item ? item.parts : item.content;
    if (typeof content === "string") {
      messages.push({ role: item.role, parts: [{ type: "text", text: content }] });
    } else if (Array.isArray(content)) {
      messages.push({ role: item.role, parts: content.map(parsePart) });
    } else {
      return null;
    }
  }
  return messages;
}

/**
 * The Vercel AI SDK's outer generate/stream span stores its call arguments as
 * `ai.prompt`: a JSON object of `{ system?, prompt?, messages? }`. Only used
 * when no proper message-list attribute is present (the inner doGenerate spans
 * carry `ai.prompt.messages`, but the outer span is what users click first).
 */
function parseVercelPrompt(value: unknown): AiChatMessage[] | null {
  const parsed = parseIfJsonString(value);
  if (!isRecord(parsed)) return null;
  const messages: AiChatMessage[] = [];
  const system = optionalString(parsed.system);
  if (system != null) messages.push({ role: "system", parts: [{ type: "text", text: system }] });
  const prompt = optionalString(parsed.prompt);
  if (prompt != null) messages.push({ role: "user", parts: [{ type: "text", text: prompt }] });
  if (Array.isArray(parsed.messages) || typeof parsed.messages === "string") {
    const inner = parseMessageList(parsed.messages);
    if (inner != null) messages.push(...inner);
  }
  return messages.length > 0 ? messages : null;
}

/** `gen_ai.system_instructions` is either a plain string or a JSON list of parts. */
function systemInstructionMessages(value: unknown): AiChatMessage[] {
  if (value == null) return [];
  const parsed = parseIfJsonString(value);
  if (typeof parsed === "string" && parsed !== "") {
    return [{ role: "system", parts: [{ type: "text", text: parsed }] }];
  }
  if (Array.isArray(parsed) && parsed.length > 0) {
    return [{ role: "system", parts: parsed.map(parsePart) }];
  }
  return [];
}

/**
 * When a producer only sends the flat Vercel `ai.response.*` attributes (no
 * `gen_ai.output.messages`), reassemble them into one assistant message so
 * the output still renders as a conversation turn.
 */
function parseVercelResponseParts(record: Record<string, unknown>): AiMessagePart[] {
  const parts: AiMessagePart[] = [];
  const reasoning = optionalString(record["ai.response.reasoning"]);
  if (reasoning != null) parts.push({ type: "reasoning", text: reasoning });
  const text = optionalString(record["ai.response.text"]);
  if (text != null) parts.push({ type: "text", text });
  const objectValue = record["ai.response.object"];
  if (typeof objectValue === "string" && objectValue !== "") {
    parts.push({ type: "raw", value: tryParseJson(objectValue) });
  }
  const toolCallsValue = record["ai.response.toolCalls"];
  if (typeof toolCallsValue === "string" && toolCallsValue !== "") {
    const toolCalls = tryParseJson(toolCallsValue);
    if (Array.isArray(toolCalls)) {
      for (const item of toolCalls) {
        if (isRecord(item)) {
          parts.push({ type: "tool_call", name: optionalString(item.toolName), id: optionalString(item.toolCallId), args: item.args ?? item.input ?? null });
        }
      }
    }
  }
  return parts;
}

// First present-and-parseable source wins within each kind: a v7 Vercel app in
// LegacyOpenTelemetry mode can emit both dialects on one span, and rendering
// the same conversation twice is noise.
const INPUT_MESSAGE_SOURCES = ["gen_ai.input.messages", "ai.prompt.messages"] as const;

export function aiConversationSectionsFromData(data: Json | undefined): AiConversationSection[] {
  const record = tryParseJson(data);
  if (!isRecord(record)) return [];
  const sections: AiConversationSection[] = [];

  let input: AiConversationSection | null = null;
  for (const source of INPUT_MESSAGE_SOURCES) {
    const value = record[source];
    if (value == null) continue;
    const messages = parseMessageList(value);
    if (messages != null && messages.length > 0) {
      input = { kind: "input", source, messages };
      break;
    }
  }
  if (input == null && record["ai.prompt"] != null) {
    const messages = parseVercelPrompt(record["ai.prompt"]);
    if (messages != null) input = { kind: "input", source: "ai.prompt", messages };
  }
  // System instructions live in their own attribute per the OTel GenAI spec;
  // they belong at the top of the input conversation, not in a separate box.
  const systemMessages = systemInstructionMessages(record["gen_ai.system_instructions"]);
  if (systemMessages.length > 0) {
    input = input == null
      ? { kind: "input", source: "gen_ai.system_instructions", messages: systemMessages }
      : { ...input, source: `gen_ai.system_instructions + ${input.source}`, messages: [...systemMessages, ...input.messages] };
  }
  if (input != null) sections.push(input);

  const outputValue = record["gen_ai.output.messages"];
  const outputMessages = outputValue == null ? null : parseMessageList(outputValue);
  if (outputMessages != null && outputMessages.length > 0) {
    sections.push({ kind: "output", source: "gen_ai.output.messages", messages: outputMessages });
  } else {
    const parts = parseVercelResponseParts(record);
    if (parts.length > 0) {
      sections.push({ kind: "output", source: "ai.response.*", messages: [{ role: "assistant", parts }] });
    }
  }
  return sections;
}

export type AiToolInvocation = {
  args: { source: string, value: unknown } | null,
  result: { source: string, value: unknown } | null,
};

// Ordered current-convention-first, like the alias tables in shared gen-ai.tsx:
// OTel GenAI opt-in content attributes, then Vercel v4 names, then v5 renames.
const TOOL_ARG_SOURCES = ["gen_ai.tool.call.arguments", "ai.toolCall.args", "ai.toolCall.input"] as const;
const TOOL_RESULT_SOURCES = ["gen_ai.tool.call.result", "ai.toolCall.result", "ai.toolCall.output"] as const;

function firstToolAttribute(record: Record<string, unknown>, sources: readonly string[]): { source: string, value: unknown } | null {
  for (const source of sources) {
    const value = record[source];
    if (value == null || value === "") continue;
    return { source, value: typeof value === "string" ? tryParseJson(value) : value };
  }
  return null;
}

/**
 * The argument/result payload of an `execute_tool` span. These live in flat
 * attributes (not message lists), so they get their own section.
 */
export function aiToolInvocationFromData(data: Json | undefined): AiToolInvocation | null {
  const record = tryParseJson(data);
  if (!isRecord(record)) return null;
  const args = firstToolAttribute(record, TOOL_ARG_SOURCES);
  const result = firstToolAttribute(record, TOOL_RESULT_SOURCES);
  if (args == null && result == null) return null;
  return { args, result };
}

export function aiSpanDetailFields(summary: AiSpanSummary): { label: string, value: string }[] {
  const fields: { label: string, value: string }[] = [
    { label: "operation", value: summary.operationName },
  ];
  if (summary.providerName != null) fields.push({ label: "provider", value: summary.providerName });
  if (summary.requestModel != null) fields.push({ label: "model", value: summary.requestModel });
  if (summary.responseModel != null && summary.responseModel !== summary.requestModel) {
    fields.push({ label: "response model", value: summary.responseModel });
  }
  if (summary.agentName != null) fields.push({ label: "agent", value: summary.agentName });
  if (summary.toolName != null) fields.push({ label: "tool", value: summary.toolName });
  if (summary.conversationId != null) fields.push({ label: "conversation", value: summary.conversationId });
  const formattedTokenCount = (count: string) => BigInt(count).toLocaleString();
  const tokenParts = [
    ...summary.inputTokens == null ? [] : [`${formattedTokenCount(summary.inputTokens)} in`],
    ...summary.outputTokens == null ? [] : [`${formattedTokenCount(summary.outputTokens)} out`],
    // cache-read is a subset of input and reasoning a subset of output, so
    // they are annotations on the totals, never additional amounts.
    ...summary.cacheReadInputTokens == null ? [] : [`${formattedTokenCount(summary.cacheReadInputTokens)} cached`],
    ...summary.reasoningOutputTokens == null ? [] : [`${formattedTokenCount(summary.reasoningOutputTokens)} reasoning`],
  ];
  if (tokenParts.length > 0) fields.push({ label: "tokens", value: tokenParts.join(" · ") });
  return fields;
}

/** Compact per-row affordance for AI spans in the waterfall's name column. */
export function AiSpanChip({ summary }: { summary: AiSpanSummary }) {
  const label = aiSpanChipLabel(summary);
  return (
    <span className="min-w-0 overflow-hidden" title={label}>
      <DesignBadge label={label} color="purple" size="sm" icon={SparkleIcon} />
    </span>
  );
}

const ROLE_BADGE_COLORS: ReadonlyMap<string, DesignBadgeColor> = new Map([
  ["system", "zinc"],
  ["developer", "zinc"],
  ["user", "blue"],
  ["human", "blue"],
  ["assistant", "purple"],
  // Gemini-flavored emitters use "model" as the assistant role name.
  ["model", "purple"],
  ["ai", "purple"],
  ["tool", "orange"],
  ["function", "orange"],
]);

/**
 * Display string for a JSON-derived payload: JSON strings are parsed first so
 * double-encoded values (the common case for `args`/`result` attributes)
 * pretty-print instead of showing escaped quotes; plain strings stay verbatim.
 */
function jsonDisplayString(value: unknown): string {
  const parsed = typeof value === "string" ? tryParseJson(value) : value;
  if (typeof parsed === "string") return parsed;
  // JSON.stringify returns undefined (despite its string return type) for
  // undefined/function/symbol inputs; our values are JSON-derived so only the
  // undefined case is reachable, and only via an absent optional field.
  if (parsed === undefined) return "undefined";
  return JSON.stringify(parsed, null, 2);
}

// Content beyond this stays behind a "show more" toggle so a 100k-token prompt
// doesn't turn the dialog into an endless scroll. The slack means we never
// show a toggle that saves less than a screenful.
const COLLAPSED_MAX_CHARS = 2000;
const COLLAPSE_SLACK_CHARS = 500;

function ExpandableText({ text, mono = false, muted = false }: { text: string, mono?: boolean, muted?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > COLLAPSED_MAX_CHARS + COLLAPSE_SLACK_CHARS;
  const clamped = collapsible && !expanded;
  return (
    <div className="min-w-0">
      {/* A div, not a pre: preflight styles `pre` back to the mono stack with
          ordering that beats the font utility here, and message text should
          read as prose. whitespace-pre-wrap keeps the newlines either way. */}
      <div
        className={cn(
          "whitespace-pre-wrap break-words",
          mono ? "font-mono text-xs leading-relaxed" : "text-[13px] leading-relaxed",
          muted && "text-muted-foreground",
        )}
      >
        {clamped ? text.slice(0, COLLAPSED_MAX_CHARS) : text}
        {clamped && <span className="text-muted-foreground">…</span>}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors hover:transition-none"
        >
          {expanded ? "Show less" : `Show ${(text.length - COLLAPSED_MAX_CHARS).toLocaleString()} more characters`}
        </button>
      )}
    </div>
  );
}

function ToolBlock({ icon: BlockIcon, tone, title, meta, body }: {
  icon: Icon,
  tone: "call" | "result",
  title: string,
  meta: string | null,
  body: string | null,
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border",
        tone === "call"
          ? "border-purple-500/25 bg-purple-500/[0.06] dark:bg-purple-500/[0.08]"
          : "border-green-500/25 bg-green-500/[0.06] dark:bg-green-500/[0.08]",
      )}
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
        <BlockIcon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            tone === "call" ? "text-purple-600 dark:text-purple-400" : "text-green-600 dark:text-green-400",
          )}
          weight="bold"
        />
        <span className="truncate font-mono font-medium">{title}</span>
        {meta != null && (
          <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground" title={meta}>
            {meta}
          </span>
        )}
      </div>
      {body != null && body !== "" && (
        <div className="border-t border-inherit px-2.5 py-2">
          <ExpandableText text={body} mono />
        </div>
      )}
    </div>
  );
}

function MessagePartView({ part }: { part: AiMessagePart }) {
  switch (part.type) {
    case "text": {
      return <ExpandableText text={part.text} />;
    }
    case "reasoning": {
      return (
        <div className="border-l-2 border-border pl-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">reasoning</div>
          <ExpandableText text={part.text} muted />
        </div>
      );
    }
    case "tool_call": {
      return (
        <ToolBlock
          icon={WrenchIcon}
          tone="call"
          title={part.name ?? "tool call"}
          meta={part.id}
          body={part.args == null ? null : jsonDisplayString(part.args)}
        />
      );
    }
    case "tool_result": {
      return (
        <ToolBlock
          icon={ArrowElbowDownRightIcon}
          tone="result"
          title={part.name ?? "tool result"}
          meta={part.id}
          body={part.result == null ? null : jsonDisplayString(part.result)}
        />
      );
    }
    case "raw": {
      return <ExpandableText text={jsonDisplayString(part.value)} mono />;
    }
  }
}

function MessageCard({ message, kind }: { message: AiChatMessage, kind: "input" | "output" }) {
  return (
    <div
      className={cn(
        "space-y-1.5 rounded-md border px-3 py-2",
        // Output turns are tinted green, matching the input-plain/output-green
        // convention users know from LLM observability tools like Langfuse.
        kind === "output" ? "border-green-500/20 bg-green-500/[0.04]" : "border-border/60 bg-muted/20",
      )}
    >
      <DesignBadge label={message.role} color={ROLE_BADGE_COLORS.get(message.role) ?? "cyan"} size="sm" />
      {message.parts.map((part, index) => (
        <MessagePartView key={index} part={part} />
      ))}
    </div>
  );
}

function SectionHeader({ title, source, copyContent }: { title: string, source: string | null, copyContent: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </Label>
      <div className="flex min-w-0 items-center gap-1.5">
        {source != null && (
          <span className="truncate font-mono text-[10px] text-muted-foreground/70" title={source}>
            {source}
          </span>
        )}
        <CopyButton content={copyContent} />
      </div>
    </div>
  );
}

function ConversationSectionView({ section }: { section: AiConversationSection }) {
  return (
    <div className="space-y-1">
      <SectionHeader
        title={section.kind === "input" ? "Input" : "Output"}
        source={section.source}
        copyContent={JSON.stringify(section.messages, null, 2)}
      />
      <div className="space-y-1.5">
        {section.messages.map((message, index) => (
          <MessageCard key={index} message={message} kind={section.kind} />
        ))}
      </div>
    </div>
  );
}

function ToolInvocationSection({ summary, invocation }: { summary: AiSpanSummary, invocation: AiToolInvocation }) {
  return (
    <div className="space-y-1">
      <SectionHeader
        title="Tool call"
        source={null}
        copyContent={JSON.stringify({ args: invocation.args?.value ?? null, result: invocation.result?.value ?? null }, null, 2)}
      />
      <div className="space-y-1.5">
        {invocation.args != null && (
          <ToolBlock
            icon={WrenchIcon}
            tone="call"
            title={summary.toolName ?? "arguments"}
            meta={invocation.args.source}
            body={jsonDisplayString(invocation.args.value)}
          />
        )}
        {invocation.result != null && (
          <ToolBlock
            icon={ArrowElbowDownRightIcon}
            tone="result"
            title="result"
            meta={invocation.result.source}
            body={jsonDisplayString(invocation.result.value)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The "AI" section of the span detail dialog. Renders nothing for non-AI
 * spans (and for events, whose rows never carry `gen_ai_operation_name`), so
 * it can be mounted unconditionally next to the other extra content.
 */
export function AiSpanDetailSection({ row }: { row: RowData }) {
  const summary = tryAiSpanSummaryFromRaw(row);
  if (summary == null) return null;
  const fields = aiSpanDetailFields(summary);
  const invocation = aiToolInvocationFromData(row.data);
  const sections = aiConversationSectionsFromData(row.data);
  return (
    <>
      <div className="space-y-1">
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          AI
        </Label>
        <div className="font-mono text-sm bg-muted/30 rounded px-3 py-2 overflow-auto max-h-48">
          <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5">
            {fields.map((field) => (
              <Fragment key={field.label}>
                <span className="text-muted-foreground">{field.label}</span>
                <span className="break-all">{field.value}</span>
              </Fragment>
            ))}
          </div>
        </div>
      </div>
      {invocation != null && <ToolInvocationSection summary={summary} invocation={invocation} />}
      {sections.map((section) => (
        <ConversationSectionView key={section.kind} section={section} />
      ))}
    </>
  );
}

import { createUnifiedAiChatAdapter, type WireMessage } from "@/components/assistant-ui/chat-stream";
import { buildDashboardMessages } from "@/lib/ai-dashboard/shared-prompt";
import { buildHexclaveHeaders, type CurrentUser } from "@/lib/api-headers";
import type { AppId } from "@/lib/apps-frontend";
import {
  type ChatModelAdapter,
  type ChatModelRunOptions,
  type ChatModelRunResult,
  type ExportedMessageRepository,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { StackAdminApp } from "@hexclave/next";
import { ChatContent } from "@hexclave/shared/dist/interface/admin-interface";
import type { EditableMetadata } from "@hexclave/shared/dist/utils/jsx-editable-transpiler";
import {
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
export type ToolCallContent = Extract<ChatContent[number], { type: "tool-call" }>;

const isToolCall = (content: { type: string }): content is ToolCallContent => {
  return content.type === "tool-call";
};

export type DashboardWidgetContext = {
  kind: "widget",
  id: string,
  name: string,
  selectorPath: string,
  outerHTMLSnippet: string,
};

export type DashboardActionContext = {
  kind: "action-add-component",
  id: string,
};

export type DashboardErrorContext = {
  kind: "error",
  id: string,
  message: string,
  stack?: string,
  componentStack?: string,
};

export type DashboardChip =
  | DashboardWidgetContext
  | DashboardActionContext
  | DashboardErrorContext;

/** Maps thread messages to the backend wire format; merges `attachments` into `content`. */
function formatThreadMessagesForBackend(
  messages: readonly { role: string, content: readonly { type: string }[], attachments?: readonly { content?: readonly unknown[] }[] }[],
): Array<{ role: string, content: unknown }> {
  const formatted: Array<{ role: string, content: unknown }> = [];
  for (const msg of messages) {
    const textContent = msg.content.filter((c) => !isToolCall(c));
    const attachmentContent: unknown[] = [];
    if (msg.attachments) {
      for (const attachment of msg.attachments) {
        if (Array.isArray(attachment.content)) {
          attachmentContent.push(...attachment.content);
        }
      }
    }
    const combined = [...textContent, ...attachmentContent];
    if (combined.length > 0) {
      formatted.push({ role: msg.role, content: combined });
    }
  }
  return formatted;
}

/** Normalizes model JSX: strip fences, decode basic entities, fix `;` vs `,` between object props. */
function sanitizeGeneratedCode(code: string): string {
  let result = code.trim();

  if (result.startsWith("```")) {
    const lines = result.split("\n");
    lines.shift();
    if (lines[lines.length - 1]?.trim() === "```") {
      lines.pop();
    }
    result = lines.join("\n").trim();
  }

  result = result
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

  result = result.replace(/;(\s*\n\s*[A-Za-z_$][\w$]*\s*:)/g, ",$1");

  return result;
}

function stripCodeFences(code: string): string {
  if (!code.startsWith("```")) return code;
  const lines = code.split("\n");
  lines.shift();
  if (lines[lines.length - 1]?.trim() === "```") lines.pop();
  return lines.join("\n");
}

function sanitizeAiContent(content: ChatContent): ChatContent {
  return content.map((item) => {
    if (item.type === "tool-call" && typeof item.args?.content === "string") {
      return { ...item, args: { ...item.args, content: sanitizeGeneratedCode(item.args.content) } };
    }
    return item;
  });
}

/**
 * Sends a request to the AI query endpoint and returns the parsed content.
 */
async function sendAiRequest(
  backendBaseUrl: string,
  currentUser: CurrentUser | undefined,
  body: {
    quality: string,
    speed: string,
    systemPrompt: string,
    tools: string[],
    messages: Array<{ role: string, content: unknown }>,
    projectId?: string,
  },
  abortSignal?: AbortSignal,
): Promise<ChatContent> {
  const authHeaders = await buildHexclaveHeaders(currentUser);

  const response = await fetch(`${backendBaseUrl}/api/latest/ai/query/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    ...(abortSignal ? { signal: abortSignal } : {}),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`AI request failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as { content?: ChatContent };
  return Array.isArray(json.content) ? json.content : [];
}

/**
 * Sends a request to the AI streaming endpoint and returns a stream of UIMessageChunks
 * (as produced by the Vercel AI SDK's `streamText().toUIMessageStreamResponse()`).
 */
async function sendAiStreamRequest(
  backendBaseUrl: string,
  currentUser: CurrentUser | undefined,
  body: {
    quality: string,
    speed: string,
    systemPrompt: string,
    tools: string[],
    messages: Array<{ role: string, content: unknown }>,
    projectId?: string,
  },
  abortSignal?: AbortSignal,
): Promise<ReadableStream<UIMessageChunk>> {
  const authHeaders = await buildHexclaveHeaders(currentUser);

  const response = await fetch(`${backendBaseUrl}/api/latest/ai/query/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...authHeaders,
    },
    ...(abortSignal ? { signal: abortSignal } : {}),
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    throw new Error(`AI stream request failed: ${response.status} ${response.statusText}`);
  }

  return parseJsonEventStream({
    stream: response.body,
    schema: uiMessageChunkSchema,
  }).pipeThrough(
    new TransformStream<
      { success: true, value: UIMessageChunk, rawValue: unknown } | { success: false, error: unknown, rawValue: unknown },
      UIMessageChunk
    >({
      transform(parseResult, controller) {
        if (parseResult.success) {
          controller.enqueue(parseResult.value);
        }
      },
    }),
  );
}

/**
 * Converts a UIMessage's parts (as emitted by `readUIMessageStream`) into our
 * ChatContent shape so the existing tool UI / sanitizer pipeline keeps working.
 */
function uiPartsToChatContent(parts: UIMessage["parts"]): ChatContent {
  const result: ChatContent = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) {
        result.push({ type: "text", text: part.text });
      }
      continue;
    }

    if (part.type === "dynamic-tool") {
      const toolPart = part as { toolCallId: string, toolName: string, input?: unknown, output?: unknown };
      const input = toolPart.input ?? {};
      result.push({
        type: "tool-call",
        toolCallId: toolPart.toolCallId,
        toolName: toolPart.toolName,
        args: input,
        argsText: typeof input === "string" ? input : JSON.stringify(input),
        result: toolPart.output ?? null,
      });
      continue;
    }

    if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      const toolName = part.type.slice("tool-".length);
      const toolPart = part as { toolCallId: string, input?: unknown, output?: unknown };
      const input = toolPart.input ?? {};
      result.push({
        type: "tool-call",
        toolCallId: toolPart.toolCallId,
        toolName,
        args: input,
        argsText: typeof input === "string" ? input : JSON.stringify(input),
        result: toolPart.output ?? null,
      });
      continue;
    }
  }
  return result;
}

/**
 * Streaming dashboard generation: yields progressively updated ChatContent as the AI
 * streams text and tool-call input. Each yield represents the full current state of
 * the assistant message (not an incremental delta).
 */
export async function* streamDashboardCode(
  backendBaseUrl: string,
  currentUser: CurrentUser | undefined,
  messages: Array<{ role: string, content: unknown }>,
  options?: {
    currentTsxSource?: string,
    abortSignal?: AbortSignal,
    enabledAppIds?: AppId[],
    projectId?: string,
  },
): AsyncGenerator<ChatContent, void, undefined> {
  const contextMessages = await buildDashboardMessages(
    backendBaseUrl,
    currentUser,
    messages,
    options?.currentTsxSource,
    options?.enabledAppIds,
  );

  // Only give the agent the sql-query and read-config tools when we know which
  // project to scope them to. Without projectId, they would fall back to the
  // internal project — wrong target.
  const tools = options?.projectId
    ? ["update-dashboard", "sql-query", "read-config"]
    : ["update-dashboard"];

  const chunkStream = await sendAiStreamRequest(
    backendBaseUrl,
    currentUser,
    {
      quality: "smart",
      speed: "fast",
      systemPrompt: "create-dashboard",
      tools,
      messages: [...contextMessages, ...messages],
      projectId: options?.projectId,
    },
    options?.abortSignal,
  );

  for await (const message of readUIMessageStream({ stream: chunkStream })) {
    if (options?.abortSignal?.aborted) return;
    yield sanitizeAiContent(uiPartsToChatContent(message.parts));
  }
}

/**
 * One-shot dashboard generation: builds context, calls AI, returns the tool call content.
 * Used by both the cmd+K preview and the dashboard chat adapter.
 */
export async function generateDashboardCode(
  backendBaseUrl: string,
  currentUser: CurrentUser | undefined,
  messages: Array<{ role: string, content: unknown }>,
  options?: {
    currentTsxSource?: string,
    abortSignal?: AbortSignal,
    enabledAppIds?: AppId[],
    projectId?: string,
  },
): Promise<{ content: ChatContent, toolCall: ToolCallContent | undefined }> {
  const contextMessages = await buildDashboardMessages(
    backendBaseUrl,
    currentUser,
    messages,
    options?.currentTsxSource,
    options?.enabledAppIds,
  );
  const tools = options?.projectId
    ? ["update-dashboard", "sql-query", "read-config"]
    : ["update-dashboard"];
  const rawContent = await sendAiRequest(
    backendBaseUrl,
    currentUser,
    {
      quality: "smart",
      speed: "fast",
      systemPrompt: "create-dashboard",
      tools,
      messages: [...contextMessages, ...messages],
      projectId: options?.projectId,
    },
    options?.abortSignal,
  );

  const toolCall = rawContent.find(isToolCall);

  return { content: rawContent, toolCall };
}

const CONTEXT_MAP = {
  "email-theme": { systemPrompt: "email-assistant-theme", tools: ["create-email-theme"] },
  "email-template": { systemPrompt: "email-assistant-template", tools: ["create-email-template"] },
  "email-draft": { systemPrompt: "email-assistant-draft", tools: ["create-email-draft"] },
} as const;

export function createChatAdapter(
  backendBaseUrl: string,
  contextType: "email-theme" | "email-template" | "email-draft",
  onToolCall: (toolCall: ToolCallContent) => void,
  getCurrentSource?: () => string,
  currentUser?: CurrentUser,
  onRunStart?: () => void,
  onRunEnd?: () => void,
): ChatModelAdapter {
  const { systemPrompt, tools } = CONTEXT_MAP[contextType];

  return createUnifiedAiChatAdapter({
    backendBaseUrl,
    currentUser,
    systemPrompt,
    tools: [...tools],
    quality: "smartest",
    speed: "fast",
    sanitizeContent: sanitizeAiContent,
    transformMessages: (messages) => {
      const contextMessages: WireMessage[] = [];
      if (getCurrentSource) {
        const src = getCurrentSource();
        if (src.length > 0) {
          contextMessages.push({ role: "user", content: `Here is the current source:\n\`\`\`tsx\n${src}\n\`\`\`` });
          contextMessages.push({ role: "assistant", content: "Got it, I have the current source code." });
        }
      }
      return [...contextMessages, ...messages];
    },
    onRunStart,
    onRunEnd,
    onFinish: ({ assistantContent }) => {
      const toolCall = assistantContent.find(isToolCall);
      if (toolCall) {
        onToolCall(toolCall);
      }
    },
    onError: () => {
      throw new Error("Failed to get AI response. Please try again.");
    },
  });
}

/**
 * Chat adapter for the analytics table search bar's AI fallback. Uses the
 * `filter-analytics-table` system prompt, which constrains the AI to row
 * filters of the shape `SELECT * FROM <table> WHERE ...` so the grid's
 * columns never change. The table being viewed is injected as a leading
 * context exchange, mirroring the source-context pattern in
 * `createChatAdapter` above.
 */
export function createAnalyticsTableFilterChatAdapter(
  backendBaseUrl: string,
  currentUser: CurrentUser | undefined,
  projectId: string | undefined,
  tableName: string,
  onError?: (error: Error) => void,
): ChatModelAdapter {
  return createUnifiedAiChatAdapter({
    backendBaseUrl,
    currentUser,
    systemPrompt: "filter-analytics-table",
    tools: ["sql-query"],
    quality: "smart",
    speed: "fast",
    projectId,
    sanitizeContent: sanitizeAiContent,
    transformMessages: (messages) => [
      { role: "user", content: `The table I'm viewing is \`${tableName}\`.` },
      { role: "assistant", content: `Got it — I'll only generate row filters of the form SELECT * FROM ${tableName} WHERE ... so the grid's columns stay the same.` },
      ...messages,
    ],
    onError: () => {
      const wrapped = new Error("Failed to get AI response. Please try again.");
      onError?.(wrapped);
      throw wrapped;
    },
  });
}

export function createDashboardChatAdapter(
  backendBaseUrl: string,
  currentTsxSource: string,
  onToolCall: (toolCall: ToolCallContent) => void,
  currentUser?: CurrentUser,
  enabledAppIds?: AppId[],
  projectId?: string,
  onRunStart?: () => void,
  onRunEnd?: () => void,
  getPendingChips?: () => DashboardChip[],
  consumePendingChips?: () => void,
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }: ChatModelRunOptions): AsyncGenerator<ChatModelRunResult, void> {
      onRunStart?.();
      try {
        const formattedMessages = formatThreadMessagesForBackend(messages);
        const chips = getPendingChips?.() ?? [];
        if (chips.length > 0) {
          const chipBlock = chips.map((c) => {
            if (c.kind === "widget") {
              return `[Widget: ${c.name}]\nPath: ${c.selectorPath}\nHTML: ${c.outerHTMLSnippet}`;
            }
            if (c.kind === "action-add-component") {
              return `[Action: Add a new component to the dashboard]`;
            }
            // Bound stack/componentStack so a 5KB trace can't blow up the prompt.
            const stackSlice = c.stack ? `\nStack:\n${c.stack.slice(0, 1200)}` : "";
            const componentStackSlice = c.componentStack
              ? `\nComponent stack:${c.componentStack.slice(0, 400)}`
              : "";
            return `[Error: The dashboard crashed at runtime — please diagnose and fix.]\nMessage: ${c.message}${stackSlice}${componentStackSlice}`;
          }).join("\n\n");
          const chipPart = { type: "text" as const, text: chipBlock };
          let chipAttached = false;

          for (let i = formattedMessages.length - 1; i >= 0; i--) {
            if (formattedMessages[i].role !== "user") continue;
            const orig = formattedMessages[i].content;
            formattedMessages[i] = {
              ...formattedMessages[i],
              content: Array.isArray(orig) ? [chipPart, ...orig] : [chipPart],
            };
            chipAttached = true;
            break;
          }
          if (!chipAttached) {
            formattedMessages.push({ role: "user", content: [chipPart] });
          }
        }

        let latestContent: ChatContent = [];
        let chipsConsumed = chips.length === 0;
        for await (const content of streamDashboardCode(
          backendBaseUrl,
          currentUser,
          formattedMessages,
          {
            currentTsxSource,
            abortSignal,
            enabledAppIds,
            projectId,
          },
        )) {
          if (!chipsConsumed) {
            consumePendingChips?.();
            chipsConsumed = true;
          }
          latestContent = content;
          yield { content };
        }

        let lastFullReplacement: ToolCallContent | null = null;

        for (const item of latestContent) {
          if (!isToolCall(item)) continue;
          if (item.toolName === "updateDashboard" && typeof item.args?.content === "string") {
            lastFullReplacement = item;
          }
        }

        if (lastFullReplacement) {
          onToolCall(lastFullReplacement);
        }
      } catch (error) {
        if (abortSignal.aborted) {
          return;
        }
        throw new Error("Failed to get AI response. Please try again.");
      } finally {
        onRunEnd?.();
      }
    },
  };
}

export async function applyWysiwygEdit(
  backendBaseUrl: string,
  options: {
    sourceType: "template" | "theme" | "draft",
    sourceCode: string,
    oldText: string,
    newText: string,
    metadata: EditableMetadata,
    domPath: Array<{ tagName: string, index: number }>,
    htmlContext: string,
    currentUser?: CurrentUser,
  },
): Promise<{ updatedSource: string }> {
  if (options.oldText === options.newText) {
    return { updatedSource: options.sourceCode };
  }

  const { sourceCode, oldText, newText, metadata, domPath, htmlContext } = options;

  const userPrompt = `
## Source Code to Edit
\`\`\`tsx
${sourceCode}
\`\`\`

## Edit Request
- **Old text:** "${oldText}"
- **New text:** "${newText}"

## Location Information
- **Line:** ${metadata.loc.line}
- **Column:** ${metadata.loc.column}
- **JSX Path:** ${metadata.jsxPath.join(" > ")}
- **Parent Element:** <${metadata.parentElement.tagName}>
- **Sibling Index:** ${metadata.siblingIndex}
- **Occurrence:** ${metadata.occurrenceIndex} of ${metadata.occurrenceCount}

## Source Context (lines around the text)
Before:
\`\`\`
${metadata.sourceContext.before}
\`\`\`

After:
\`\`\`
${metadata.sourceContext.after}
\`\`\`

## Runtime DOM Path (for disambiguation)
${domPath.map((p, i) => `${i + 1}. <${p.tagName}> (index: ${p.index})`).join("\n")}

## Rendered HTML Context
\`\`\`html
${htmlContext.slice(0, 500)}
\`\`\`

Please update the source code to change "${oldText}" to "${newText}" at the specified location. Return ONLY the complete updated source code.
`;

  const { currentUser } = options;
  const authHeaders = await buildHexclaveHeaders(currentUser);

  const response = await fetch(`${backendBaseUrl}/api/latest/ai/query/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({
      quality: "smart",
      speed: "fast",
      systemPrompt: "wysiwyg-edit",
      tools: [],
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Wysiwyg edit request failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as { content?: Array<{ type: string, text?: string }> };
  const textBlock = Array.isArray(json.content)
    ? json.content.find((b) => b.type === "text" && b.text)
    : undefined;
  const updatedSource = stripCodeFences(textBlock?.text?.trim() ?? sourceCode);

  return { updatedSource };
}

export function createHistoryAdapter(
  adminApp: StackAdminApp,
  threadId: string,
): ThreadHistoryAdapter {
  return {
    async load() {
      const { messages } = await adminApp.listChatMessages(threadId);
      return { messages } as ExportedMessageRepository;
    },
    async append(message) {
      await adminApp.saveChatMessage(threadId, message);
    },
  };
}

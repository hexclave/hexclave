import { createUnifiedAiChatAdapter, type WireMessage } from "@/components/assistant-ui/chat-stream";
import { buildDashboardMessages } from "@/lib/ai-dashboard/shared-prompt";
import { buildHexclaveHeaders, type CurrentUser } from "@/lib/api-headers";
import type { AppId } from "@/lib/apps-frontend";
import {
  type ChatModelAdapter,
  type ExportedMessageRepository,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import { StackAdminApp } from "@hexclave/next";
import { ChatContent } from "@hexclave/shared/dist/interface/admin-interface";
import type { EditableMetadata } from "@hexclave/shared/dist/utils/jsx-editable-transpiler";
import { parseResponseJson } from "@hexclave/shared/dist/utils/http";

export type ToolCallContent = Extract<ChatContent[number], { type: "tool-call" }>;

const isToolCall = (content: { type: string }): content is ToolCallContent => {
  return content.type === "tool-call";
};

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
): ChatModelAdapter {
  const tools = projectId
    ? ["update-dashboard", "sql-query", "read-config"]
    : ["update-dashboard"];

  return createUnifiedAiChatAdapter({
    backendBaseUrl,
    currentUser,
    systemPrompt: "create-dashboard",
    tools,
    quality: "smart",
    speed: "fast",
    projectId,
    sanitizeContent: sanitizeAiContent,
    transformMessages: async (messages) => {
      const contextMessages = await buildDashboardMessages(
        backendBaseUrl,
        currentUser,
        messages,
        currentTsxSource,
        enabledAppIds,
      );
      return [...contextMessages, ...messages];
    },
    onRunStart,
    onRunEnd,
    onFinish: ({ assistantContent }) => {
      const finalToolCall = assistantContent.find(
        (item): item is ToolCallContent => isToolCall(item) && item.toolName === "updateDashboard",
      );
      if (finalToolCall) {
        onToolCall(finalToolCall);
      }
    },
    onError: () => {
      throw new Error("Failed to get AI response. Please try again.");
    },
  });
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

  const json = await parseResponseJson<{ content?: Array<{ type: string, text?: string }> }>(response);
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

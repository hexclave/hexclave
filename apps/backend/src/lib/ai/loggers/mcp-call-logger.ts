import { sendAskHexclaveDiscordNotification } from "@/lib/ai/ask-hexclave-discord";
import { logAskHexclaveCall } from "@/lib/ai/ask-hexclave-history";
import type { McpCallMetadata, McpLogEntry, MessageLike } from "@/lib/ai/types";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { Json } from "@hexclave/shared/dist/utils/json";
import { type StepResult, type ToolSet } from "ai";
import { callInternalTool } from "../internal-tool-client";

export async function logMcpCall(entry: McpLogEntry): Promise<void> {
  await callInternalTool("/api/backend/log-mcp-call", { body: entry });
}

function buildInnerToolCalls(steps: ReadonlyArray<StepResult<ToolSet>>): { items: Json[], json: string } {
  try {
    const items: Json[] = [];
    for (const step of steps) {
      const resultsByCallId = new Map(step.toolResults.map(r => [r.toolCallId, r]));
      for (const tc of step.toolCalls) {
        items.push({
          type: "tool-call",
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
          args: tc.input as Json,
          argsText: JSON.stringify(tc.input),
          result: (resultsByCallId.get(tc.toolCallId)?.output ?? null) as Json,
        });
      }
    }
    return { items, json: JSON.stringify(items) };
  } catch (e) {
    captureError("mcp-call-serialize", e);
    const fallback: Json[] = [{
      type: "tool-call",
      toolName: "_serializationFailed",
      toolCallId: "_serializationFailed",
      args: { stepCount: steps.length },
      argsText: JSON.stringify({ stepCount: steps.length }),
      result: null,
    }];
    return { items: fallback, json: JSON.stringify(fallback) };
  }
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "";
  } catch {
    return JSON.stringify({ _serializationFailed: true });
  }
}

export function logIfMcpToolCall(args: {
  mcpCallMetadata: McpCallMetadata | undefined,
  conversationIdForLog: string | undefined,
  correlationId: string,
  messages: ReadonlyArray<MessageLike>,
  steps: ReadonlyArray<StepResult<ToolSet>>,
  text: string,
  startedAt: number,
  modelId: string,
  errorMessage?: string,
}): void {
  const { mcpCallMetadata, conversationIdForLog, correlationId, messages, steps, text, startedAt, modelId, errorMessage } = args;
  if (mcpCallMetadata == null || conversationIdForLog == null) return;
  const lastUserMessage = messages.findLast(m => m.role === "user");
  const question = typeof lastUserMessage?.content === "string"
    ? lastUserMessage.content
    : safeStringify(lastUserMessage?.content ?? "");
  const { items: innerToolCalls, json: innerToolCallsJson } = buildInnerToolCalls(steps);
  const durationMs = Math.round(performance.now() - startedAt);
  const logPromise = logMcpCall({
    correlationId,
    toolName: mcpCallMetadata.toolName,
    reason: mcpCallMetadata.reason,
    userPrompt: mcpCallMetadata.userPrompt,
    conversationId: conversationIdForLog,
    question,
    response: text,
    stepCount: steps.length,
    innerToolCallsJson,
    durationMs,
    modelId,
    errorMessage,
  });
  runAsynchronouslyAndWaitUntil(logPromise);
  if (errorMessage != null) return;

  if (mcpCallMetadata.toolName === "ask_hexclave") {
    const firstUserMessage = messages.find(m => m.role === "user");
    const askQuestion = typeof firstUserMessage?.content === "string"
      ? firstUserMessage.content
      : safeStringify(firstUserMessage?.content ?? "");
    const askCall = {
      conversationId: conversationIdForLog,
      question: askQuestion,
      response: text,
      reason: mcpCallMetadata.reason,
      userPrompt: mcpCallMetadata.userPrompt,
      context: mcpCallMetadata.context ?? null,
      user: mcpCallMetadata.user ?? null,
      project: mcpCallMetadata.project ?? null,
      requestMetadata: mcpCallMetadata.requestMetadata,
      modelId,
      stepCount: steps.length,
      durationMs,
    };
    runAsynchronouslyAndWaitUntil(logAskHexclaveCall({ id: correlationId, ...askCall, innerToolCalls }));
    runAsynchronouslyAndWaitUntil(sendAskHexclaveDiscordNotification(askCall));
  }

  // The automated LLM QA review runs in the internal tool and updates the
  // freshly logged row, so it must only fire after the log write lands.
  runAsynchronouslyAndWaitUntil((async () => {
    try {
      await logPromise;
    } catch (err) {
      captureError("qa-reviewer-log-wait", err);
      return;
    }
    await callInternalTool("/api/backend/review-mcp-call", {
      body: {
        correlationId,
        question,
        reason: mcpCallMetadata.reason,
        response: text,
      },
    });
  })());
}

import { logAiQuery } from "@/lib/ai/loggers/ai-query-logger";
import { logIfMcpToolCall } from "@/lib/ai/loggers/mcp-call-logger";
import type { SystemPromptId } from "@/lib/ai/prompts";
import type { ContentBlock, McpCallMetadata, MessageLike, ModeContext } from "@/lib/ai/types";
import { listManagedProjectIds } from "@/lib/projects";
import type { SmartRequestAuth } from "@/route-handlers/smart-request";
import { captureError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { Json } from "@hexclave/shared/dist/utils/json";
import { generateText, stepCountIs, streamText, type StepResult, type ToolSet } from "ai";

export const USER_FACING_ERROR_MESSAGE = "The AI service is temporarily unavailable. Please try again later.";

export const OPENROUTER_PROVIDER_OPTIONS = {
  usage: { include: true },
  stream_options: { include_usage: true },
} as const;

export function getStepLimit(systemPromptId: SystemPromptId, hasTools: boolean): number {
  if (!hasTools) return 1;
  if (systemPromptId === "docs-ask-ai" || systemPromptId === "command-center-ask-ai") return 50;
  if (systemPromptId === "create-dashboard") return 12;
  return 5;
}

export async function assertProjectAccess(projectId: string, auth: SmartRequestAuth | null): Promise<void> {
  if (auth == null || auth.project.id !== "internal" || auth.user == null) {
    throw new StatusError(StatusError.Forbidden, "You do not have access to this project");
  }
  const managedProjectIds = await listManagedProjectIds(auth.user);
  if (!managedProjectIds.includes(projectId)) {
    throw new StatusError(StatusError.Forbidden, "You do not have access to this project");
  }
}

export function handleStreamMode(ctx: ModeContext & {
  messages: ReadonlyArray<MessageLike>,
  mcpCallMetadata: McpCallMetadata | undefined,
  correlationId: string,
  conversationIdForLog: string | undefined,
}) {
  const { model, messagesWithCachedSystemPrompt, toolsArg, stepLimit, common, startedAt, messages, mcpCallMetadata, correlationId, conversationIdForLog } = ctx;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);
  const completedSteps: StepResult<ToolSet>[] = [];
  // The AI SDK doesn't guarantee mutual exclusion across onFinish / onError /
  // onAbort. An aborted stream commonly fires onError(AbortError) AND onAbort
  // for the same lifecycle, which would double-log this request to
  // SpacetimeDB and trip the UNIQUE(correlation_id) constraint on the second
  // insert. Guard with a single boolean — the first terminal callback wins.
  let logged = false;
  const logStreamFailure = (err: unknown) => {
    clearTimeout(timeoutId);
    if (logged) return;
    logged = true;
    logAiQuery({ type: "failure", common, startedAt, err, partialSteps: completedSteps });
    logIfMcpToolCall({
      mcpCallMetadata,
      conversationIdForLog,
      correlationId,
      messages,
      steps: completedSteps,
      text: "",
      startedAt,
      modelId: String(model.modelId),
      errorMessage: err instanceof Error ? err.stack ?? `${err.name}: ${err.message}` : String(err),
    });
  };
  const result = streamText({
    model,
    messages: messagesWithCachedSystemPrompt,
    tools: toolsArg,
    abortSignal: controller.signal,
    stopWhen: stepCountIs(stepLimit),
    providerOptions: { openrouter: OPENROUTER_PROVIDER_OPTIONS },
    onStepFinish: (step) => { completedSteps.push(step); },
    onFinish: ({ text, steps, usage, response }) => {
      clearTimeout(timeoutId);
      if (logged) return;
      logged = true;
      logAiQuery({
        type: "success",
        common,
        startedAt,
        steps,
        text,
        usage,
        openrouterGenerationId: response.id,
      });
      logIfMcpToolCall({
        mcpCallMetadata,
        conversationIdForLog,
        correlationId,
        messages,
        steps,
        text,
        startedAt,
        modelId: String(model.modelId),
      });
    },
    onError: ({ error }) => logStreamFailure(error),
    onAbort: () => logStreamFailure(new Error("Stream aborted (client disconnect or timeout)")),
  });
  return {
    statusCode: 200,
    bodyType: "response" as const,
    body: result.toUIMessageStreamResponse({
      onError: (err) => {
        captureError("ai-query-stream-writer", err);
        return USER_FACING_ERROR_MESSAGE;
      },
    }),
  };
}

export async function handleGenerateMode(ctx: ModeContext & {
  messages: ReadonlyArray<MessageLike>,
  mcpCallMetadata: McpCallMetadata | undefined,
  correlationId: string,
  conversationIdForLog: string | undefined,
}) {
  const { model, messagesWithCachedSystemPrompt, toolsArg, stepLimit, common, startedAt, messages, mcpCallMetadata, correlationId, conversationIdForLog } = ctx;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);
  const completedSteps: StepResult<ToolSet>[] = [];
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model,
      messages: messagesWithCachedSystemPrompt,
      tools: toolsArg,
      abortSignal: controller.signal,
      stopWhen: stepCountIs(stepLimit),
      providerOptions: { openrouter: OPENROUTER_PROVIDER_OPTIONS },
      onStepFinish: (step) => { completedSteps.push(step); },
    }).finally(() => clearTimeout(timeoutId));
  } catch (err) {
    logAiQuery({ type: "failure", common, startedAt, err, partialSteps: completedSteps });
    logIfMcpToolCall({
      mcpCallMetadata,
      conversationIdForLog,
      correlationId,
      messages,
      steps: completedSteps,
      text: "",
      startedAt,
      modelId: String(model.modelId),
      errorMessage: err instanceof Error ? err.stack ?? `${err.name}: ${err.message}` : String(err),
    });
    throw new StatusError(StatusError.BadGateway, USER_FACING_ERROR_MESSAGE);
  }

  const contentBlocks: ContentBlock[] = [];
  for (const step of result.steps) {
    if (step.text) {
      contentBlocks.push({ type: "text", text: step.text });
    }
    const resultsByCallId = new Map(step.toolResults.map(r => [r.toolCallId, r]));
    for (const toolCall of step.toolCalls) {
      const toolResult = resultsByCallId.get(toolCall.toolCallId);
      contentBlocks.push({
        type: "tool-call",
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        args: toolCall.input,
        argsText: JSON.stringify(toolCall.input),
        result: (toolResult?.output ?? null) as Json,
      });
    }
  }

  logAiQuery({
    type: "success",
    common,
    startedAt,
    steps: result.steps,
    text: result.text,
    usage: result.usage,
    openrouterGenerationId: result.response.id,
  });

  const responseConversationId = mcpCallMetadata != null ? conversationIdForLog : undefined;
  logIfMcpToolCall({
    mcpCallMetadata,
    conversationIdForLog,
    correlationId,
    messages,
    steps: result.steps,
    text: result.text,
    startedAt,
    modelId: String(model.modelId),
  });

  return {
    statusCode: 200,
    bodyType: "json" as const,
    body: {
      content: contentBlocks,
      finalText: result.text,
      conversationId: responseConversationId ?? null,
    },
  };
}

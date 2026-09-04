import type { AskHexclaveRequestMetadata } from "@/lib/ai/ask-hexclave-history";
import type { selectModel } from "@/lib/ai/models";
import type { Json, JsonObject } from "@hexclave/shared/dist/utils/json";
import type { LanguageModelUsage, ModelMessage, StepResult, ToolSet } from "ai";

export type ContentBlock =
  | { type: "text", text: string }
  | {
      type: "tool-call",
      toolName: string,
      toolCallId: string,
      args: Json,
      argsText: string,
      result: Json,
    };

export type McpCallMetadata = {
  toolName: string,
  reason: string,
  userPrompt: string,
  conversationId?: string | null,
  context?: string | null,
  user?: string | null,
  project?: string | null,
  requestMetadata: AskHexclaveRequestMetadata,
};

export type MessageLike = { role: string, content: unknown };

export type SanitizedBody = {
  parsed: { model: string } & JsonObject,
  bytes: Uint8Array,
};

export type CommonLogFields = {
  correlationId: string,
  mode: "stream" | "generate",
  systemPromptId: string,
  quality: string,
  speed: string,
  modelId: string,
  isAuthenticated: boolean,
  projectId: string | undefined,
  userId: string | undefined,
  requestedToolsJson: string,
  messagesJson: string,
  conversationId: string | undefined,
};

export type AiQueryLogEntry = {
  correlationId: string,
  mode: string,
  systemPromptId: string,
  quality: string,
  speed: string,
  modelId: string,
  isAuthenticated: boolean,
  projectId: string | undefined,
  userId: string | undefined,
  requestedToolsJson: string,
  messagesJson: string,
  stepsJson: string,
  finalText: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cachedInputTokens: number | undefined,
  cacheCreationTokens: number | undefined,
  costUsd: number | undefined,
  cacheDiscountUsd: number | undefined,
  openrouterGenerationId: string | undefined,
  stepCount: number,
  durationMs: number,
  errorMessage: string | undefined,
  conversationId: string | undefined,
};

export type LogAiQueryArgs =
  | { type: "entry", entry: AiQueryLogEntry }
  | {
      type: "success",
      common: CommonLogFields,
      startedAt: number,
      steps: ReadonlyArray<StepResult<ToolSet>>,
      text: string,
      usage: LanguageModelUsage,
      openrouterGenerationId: string | undefined,
    }
  | {
      type: "failure",
      common: CommonLogFields,
      startedAt: number,
      err: unknown,
      partialSteps?: ReadonlyArray<StepResult<ToolSet>>,
    };

export type ProxyLogFields = {
  correlationId: string,
  parsed: { model: string } & JsonObject,
  apiKey: string,
  durationMs: number,
  responseStatus: number,
  openrouterGenerationId?: string,
};

export type McpLogEntry = {
  correlationId: string,
  toolName: string,
  reason: string,
  userPrompt: string,
  conversationId: string | undefined,
  question: string,
  response: string,
  stepCount: number,
  innerToolCallsJson: string,
  durationMs: number,
  modelId: string,
  errorMessage: string | undefined,
};

export type GenerationUsageFields = {
  inputTokens?: number,
  outputTokens?: number,
  cachedInputTokens?: number,
  costUsd?: number,
  cacheDiscountUsd?: number,
};

export type OpenRouterGenerationData = {
  tokens_prompt: number | null,
  tokens_completion: number | null,
  native_tokens_prompt: number | null,
  native_tokens_completion: number | null,
  native_tokens_cached: number | null,
  total_cost: number,
  cache_discount: number | null,
};

export type ModeContext = {
  model: ReturnType<typeof selectModel>,
  messagesWithCachedSystemPrompt: ModelMessage[],
  toolsArg: ToolSet | undefined,
  stepLimit: number,
  common: CommonLogFields,
  startedAt: number,
};

import { Timestamp } from "spacetimedb";
import type { AiQueryLogRow, McpCallLogRow } from "../../types";

/** Shared fixtures for the console's unit tests. Every column is spelled out so no cast is needed. */
export const FIXTURE_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

export function timestampAt(millis: number): Timestamp {
  return new Timestamp(BigInt(millis) * 1000n);
}

export function mcpRow(overrides: Partial<McpCallLogRow> = {}): McpCallLogRow {
  return {
    id: 1n,
    shard: 0,
    correlationId: "corr-1",
    conversationId: undefined,
    createdAt: timestampAt(FIXTURE_NOW),
    toolName: "ask_hexclave",
    reason: "",
    userPrompt: "",
    question: "How do I add OAuth?",
    response: "Use the OAuth providers page.",
    stepCount: 1,
    innerToolCallsJson: "[]",
    durationMs: 1200n,
    modelId: "test-model",
    errorMessage: undefined,
    qaReviewedAt: undefined,
    qaNeedsHumanReview: undefined,
    qaAnswerCorrect: undefined,
    qaAnswerRelevant: undefined,
    qaFlagsJson: undefined,
    qaImprovementSuggestions: undefined,
    qaOverallScore: undefined,
    qaReviewModelId: undefined,
    qaConversationJson: undefined,
    qaErrorMessage: undefined,
    humanReviewedAt: undefined,
    humanReviewedBy: undefined,
    humanCorrectedQuestion: undefined,
    humanCorrectedAnswer: undefined,
    publishedToQa: false,
    publishedAt: undefined,
    qaReviewRequestedAt: timestampAt(FIXTURE_NOW),
    context: "",
    user: "",
    project: "",
    ...overrides,
  };
}

export function aiRow(overrides: Partial<AiQueryLogRow> = {}): AiQueryLogRow {
  return {
    id: 1n,
    shard: 0,
    correlationId: "ai-corr-1",
    createdAt: timestampAt(FIXTURE_NOW),
    mode: "generate",
    systemPromptId: "docs-ask-ai",
    quality: "smart",
    speed: "fast",
    modelId: "test-model",
    isAuthenticated: true,
    projectId: undefined,
    userId: undefined,
    requestedToolsJson: "[]",
    messagesJson: "[]",
    stepsJson: "[]",
    finalText: "",
    inputTokens: undefined,
    outputTokens: undefined,
    cachedInputTokens: undefined,
    cacheCreationTokens: undefined,
    costUsd: undefined,
    cacheDiscountUsd: undefined,
    openrouterGenerationId: undefined,
    stepCount: 0,
    durationMs: 500n,
    errorMessage: undefined,
    conversationId: undefined,
    ...overrides,
  };
}

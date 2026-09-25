/**
 * Success-path usage baseline in `logAiQuery`: the AI SDK's token counts must
 * be written into the log entry at insert time. Rows used to be inserted with
 * all token fields undefined, relying entirely on the best-effort OpenRouter
 * /generation refinement — when that missed (it polls only a few times), the
 * row stayed permanently token-less in the analytics UI.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelUsage } from "ai";
import type { CommonLogFields } from "@/lib/ai/types";

vi.mock("../internal-tool-client", () => ({
  callInternalTool: vi.fn(),
}));

vi.mock("@/lib/ai/openrouter-usage", () => ({
  refineGenerationUsage: vi.fn(() => Promise.resolve()),
}));

// Resolve the logged promise inline so assertions can run right after the call.
vi.mock("@/utils/background-tasks", () => ({
  runAsynchronouslyAndWaitUntil: vi.fn((promiseOrFunction: Promise<unknown> | (() => Promise<unknown>)) => {
    if (typeof promiseOrFunction === "function") {
      return promiseOrFunction();
    }
    return promiseOrFunction;
  }),
}));

import { callInternalTool } from "../internal-tool-client";
import { refineGenerationUsage } from "@/lib/ai/openrouter-usage";
import { logAiQuery } from "./ai-query-logger";

const common: CommonLogFields = {
  correlationId: "corr-1",
  mode: "stream",
  systemPromptId: "create-dashboard",
  quality: "smart",
  speed: "fast",
  modelId: "openai/gpt-5.5",
  isAuthenticated: true,
  projectId: undefined,
  userId: undefined,
  requestedToolsJson: "[]",
  messagesJson: "[]",
  conversationId: undefined,
};

function makeUsage(overrides: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: 65_664,
    inputTokenDetails: {
      noCacheTokens: 56_448,
      cacheReadTokens: 9_216,
      cacheWriteTokens: undefined,
    },
    outputTokens: 5_083,
    outputTokenDetails: {
      textTokens: 5_083,
      reasoningTokens: undefined,
    },
    totalTokens: 70_747,
    ...overrides,
  };
}

async function loggedEntry(): Promise<Record<string, unknown>> {
  expect(callInternalTool).toHaveBeenCalledTimes(1);
  const [path, opts] = vi.mocked(callInternalTool).mock.calls[0] as [string, { body: Record<string, unknown> }];
  expect(path).toBe("/api/backend/log-ai-query");
  return opts.body;
}

beforeEach(() => {
  vi.mocked(callInternalTool).mockReset();
  vi.mocked(refineGenerationUsage).mockClear();
});

describe("logAiQuery success path", () => {
  it("writes the AI SDK usage as a baseline at insert time", async () => {
    logAiQuery({
      type: "success",
      common,
      startedAt: 0,
      steps: [],
      text: "done",
      usage: makeUsage(),
      openrouterGenerationId: "gen-1",
    });
    const entry = await loggedEntry();

    expect(entry.inputTokens).toBe(65_664);
    expect(entry.outputTokens).toBe(5_083);
    expect(entry.cachedInputTokens).toBe(9_216);
    expect(entry.cacheCreationTokens).toBeUndefined();
    // Cost is only known to OpenRouter; the refinement fills it in.
    expect(entry.costUsd).toBeUndefined();
    expect(entry.cacheDiscountUsd).toBeUndefined();
    expect(refineGenerationUsage).toHaveBeenCalledWith({
      generationId: "gen-1",
      correlationId: "corr-1",
    });
  });

  it("keeps token fields undefined when the SDK reports no usage", async () => {
    logAiQuery({
      type: "success",
      common,
      startedAt: 0,
      steps: [],
      text: "done",
      usage: makeUsage({
        inputTokens: undefined,
        outputTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
      }),
      openrouterGenerationId: undefined,
    });
    const entry = await loggedEntry();

    expect(entry.inputTokens).toBeUndefined();
    expect(entry.outputTokens).toBeUndefined();
    expect(entry.cachedInputTokens).toBeUndefined();
    expect(refineGenerationUsage).not.toHaveBeenCalled();
  });
});

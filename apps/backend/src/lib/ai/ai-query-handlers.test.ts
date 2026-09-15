/**
 * Repro for the double-logging hazard in `handleStreamMode`.
 *
 * The Vercel AI SDK's `streamText` exposes three terminal callbacks:
 *   - `onFinish`  — clean completion
 *   - `onError`   — model/provider/SDK error (including AbortError)
 *   - `onAbort`   — abort signal fired (client disconnect / our 120s guard)
 *
 * The SDK does NOT guarantee these are mutually exclusive: an aborted
 * request can fire `onError({ AbortError })` AND `onAbort()` for the same
 * lifecycle. Without a guard at the call site, both will invoke
 * `logAiQuery`, which schedules a SpacetimeDB `log_ai_query` insert
 * keyed by `correlationId`. The second insert violates the
 * `UNIQUE(correlation_id)` constraint, throws a SenderError that gets
 * silently swallowed via `captureError`, and we lose any signal that
 * logging is unreliable.
 *
 * The tests below encode the desired behavior: each request lifecycle
 * triggers `logAiQuery` AT MOST ONCE,
 * regardless of which subset of callbacks the SDK emits. With no fix in
 * place, the multi-callback tests fail with `Received: 2`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  capturedCallbacks: { current: undefined as unknown as Record<string, (...args: any[]) => unknown> | undefined },
}));

vi.mock("@/lib/ai/loggers/ai-query-logger", () => ({
  logAiQuery: vi.fn(),
}));

vi.mock("@/lib/ai/loggers/mcp-call-logger", () => ({
  logIfMcpToolCall: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    streamText: (opts: Record<string, (...args: any[]) => unknown>) => {
      hoisted.capturedCallbacks.current = opts;
      return {
        toUIMessageStreamResponse: () => new Response("mock"),
      };
    },
    stepCountIs: () => undefined,
  };
});

import { logAiQuery } from "@/lib/ai/loggers/ai-query-logger";
import { logIfMcpToolCall } from "@/lib/ai/loggers/mcp-call-logger";
import { handleStreamMode } from "./ai-query-handlers";
import type { CommonLogFields } from "./types";

const mockedLogAiQuery = vi.mocked(logAiQuery);
const mockedLogIfMcpToolCall = vi.mocked(logIfMcpToolCall);

const baseCommon: CommonLogFields = {
  correlationId: "test-correlation-id",
  mode: "stream",
  systemPromptId: "command-center-ask-ai",
  quality: "smart",
  speed: "fast",
  modelId: "test/model",
  isAuthenticated: false,
  projectId: undefined,
  userId: undefined,
  requestedToolsJson: "[]",
  messagesJson: "[]",
  conversationId: undefined,
};

function makeCtx(): Parameters<typeof handleStreamMode>[0] {
  return {
    // streamText is mocked, so the model object is never actually consulted.
    // Cast through unknown to bypass the LanguageModel structural type.
    model: { modelId: "test/model" } as unknown as Parameters<typeof handleStreamMode>[0]["model"],
    messagesWithCachedSystemPrompt: [],
    toolsArg: undefined,
    stepLimit: 1,
    common: baseCommon,
    startedAt: 0,
    messages: [],
    mcpCallMetadata: undefined,
    correlationId: "test-correlation-id",
    conversationIdForLog: undefined,
  };
}

beforeEach(() => {
  hoisted.capturedCallbacks.current = undefined;
  mockedLogAiQuery.mockClear();
  mockedLogIfMcpToolCall.mockClear();
});

describe("handleStreamMode terminal callback logging", () => {
  // --- Single-callback baselines (these pass today) ----------------------

  it("logs success exactly once when only onFinish fires", () => {
    handleStreamMode(makeCtx());
    hoisted.capturedCallbacks.current!.onFinish!({
      text: "ok",
      steps: [],
      usage: {},
      providerMetadata: undefined,
      response: { id: "gen-1" },
    });
    expect(mockedLogAiQuery).toHaveBeenCalledTimes(1);
    expect(mockedLogAiQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("logs failure exactly once when only onError fires", () => {
    handleStreamMode(makeCtx());
    hoisted.capturedCallbacks.current!.onError!({ error: new Error("upstream model error") });
    expect(mockedLogAiQuery).toHaveBeenCalledTimes(1);
    expect(mockedLogAiQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "failure" }));
  });

  it("logs failure exactly once when only onAbort fires", () => {
    handleStreamMode(makeCtx());
    hoisted.capturedCallbacks.current!.onAbort!();
    expect(mockedLogAiQuery).toHaveBeenCalledTimes(1);
    expect(mockedLogAiQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "failure" }));
  });

  // --- Bug repro: multi-callback firings should still log only once -------

  it("logs failure at most once when an aborted stream fires onError(AbortError) THEN onAbort", () => {
    handleStreamMode(makeCtx());
    hoisted.capturedCallbacks.current!.onError!({ error: new DOMException("aborted", "AbortError") });
    hoisted.capturedCallbacks.current!.onAbort!();
    // FAILS today: receives 2. After applying the dedup guard, receives 1.
    expect(mockedLogAiQuery).toHaveBeenCalledTimes(1);
    expect(mockedLogAiQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "failure" }));
  });

  it("logs failure at most once when an aborted stream fires onAbort THEN onError(AbortError)", () => {
    handleStreamMode(makeCtx());
    hoisted.capturedCallbacks.current!.onAbort!();
    hoisted.capturedCallbacks.current!.onError!({ error: new DOMException("aborted", "AbortError") });
    expect(mockedLogAiQuery).toHaveBeenCalledTimes(1);
    expect(mockedLogAiQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "failure" }));
  });

  it("does not log failure if onError fires after onFinish (post-completion error)", () => {
    handleStreamMode(makeCtx());
    hoisted.capturedCallbacks.current!.onFinish!({
      text: "ok",
      steps: [],
      usage: {},
      providerMetadata: undefined,
      response: { id: "gen-1" },
    });
    hoisted.capturedCallbacks.current!.onError!({ error: new Error("post-finish error") });
    // FAILS today: success=1, failure=1. After fix: success=1.
    expect(mockedLogAiQuery).toHaveBeenCalledTimes(1);
    expect(mockedLogAiQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("does not log success twice if onFinish fires twice (defensive)", () => {
    handleStreamMode(makeCtx());
    const finishArgs = {
      text: "ok",
      steps: [],
      usage: {},
      providerMetadata: undefined,
      response: { id: "gen-1" },
    };
    hoisted.capturedCallbacks.current!.onFinish!(finishArgs);
    hoisted.capturedCallbacks.current!.onFinish!(finishArgs);
    expect(mockedLogAiQuery).toHaveBeenCalledTimes(1);
  });

  it("uses the first terminal callback (idempotent on rapid-fire abort+error)", () => {
    handleStreamMode(makeCtx());
    // Race: 5 callbacks in rapid succession — only the first one's log call should land.
    hoisted.capturedCallbacks.current!.onAbort!();
    hoisted.capturedCallbacks.current!.onError!({ error: new DOMException("aborted", "AbortError") });
    hoisted.capturedCallbacks.current!.onError!({ error: new Error("trailing model error") });
    hoisted.capturedCallbacks.current!.onAbort!();
    hoisted.capturedCallbacks.current!.onAbort!();
    expect(mockedLogAiQuery).toHaveBeenCalledTimes(1);
    expect(mockedLogAiQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "failure" }));
  });

  // --- MCP call logging on stream failure ---------------------------------
  // A failed MCP-backed question must still land in mcp_call_log (with its
  // error) so it appears in the MCP Review workflow instead of vanishing.

  const mcpCtx = () => ({
    ...makeCtx(),
    mcpCallMetadata: {
      toolName: "ask_hexclave",
      reason: "test",
      userPrompt: "prompt",
      requestMetadata: {
        transport: "mcp-ask-hexclave" as const,
        requestIp: null,
        requestIpSource: null,
        userAgent: null,
        requestHost: null,
        mcpProtocolVersion: null,
      },
    },
    conversationIdForLog: "conversation-1",
  });

  it("logs the MCP call with the error when a stream with mcpCallMetadata errors", () => {
    handleStreamMode(mcpCtx());
    hoisted.capturedCallbacks.current!.onError!({ error: new Error("upstream model error") });
    expect(mockedLogIfMcpToolCall).toHaveBeenCalledTimes(1);
    expect(mockedLogIfMcpToolCall).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining("upstream model error"),
    }));
  });

  it("logs the MCP call with the error when a stream with mcpCallMetadata aborts", () => {
    handleStreamMode(mcpCtx());
    hoisted.capturedCallbacks.current!.onAbort!();
    expect(mockedLogIfMcpToolCall).toHaveBeenCalledTimes(1);
    expect(mockedLogIfMcpToolCall).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: expect.stringContaining("Stream aborted"),
    }));
  });

  it("logs the MCP call at most once on rapid-fire abort+error", () => {
    handleStreamMode(mcpCtx());
    hoisted.capturedCallbacks.current!.onAbort!();
    hoisted.capturedCallbacks.current!.onError!({ error: new DOMException("aborted", "AbortError") });
    expect(mockedLogIfMcpToolCall).toHaveBeenCalledTimes(1);
  });
});

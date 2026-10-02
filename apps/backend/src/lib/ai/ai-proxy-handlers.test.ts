/**
 * Ensures `observeAndLog` returns upstream bytes even when proxy logging throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./loggers/ai-proxy-logger", () => ({
  buildProxyLogRow: vi.fn(),
  scheduleProxyLog: vi.fn(),
}));

vi.mock("@/private", () => ({
  preprocessProxyBody: ({ parsedBody }: { parsedBody: unknown }) => parsedBody,
}));

import { buildProxyLogRow, scheduleProxyLog } from "./loggers/ai-proxy-logger";
import { observeAndLog, sanitizeBody } from "./ai-proxy-handlers";

const sanitized = sanitizeBody(new TextEncoder().encode(JSON.stringify({
  model: "anthropic/claude-sonnet-4.6",
  messages: [{ role: "user", content: "hi" }],
})).buffer as ArrayBuffer);

describe("observeAndLog body delivery", () => {
  beforeEach(() => {
    vi.mocked(buildProxyLogRow).mockReset();
    vi.mocked(scheduleProxyLog).mockReset();
  });

  it("leaves non-string metadata user ids alone instead of throwing", () => {
    const body = sanitizeBody(new TextEncoder().encode(JSON.stringify({
      model: "anthropic/claude-sonnet-4.6",
      metadata: { user_id: { length: 200 } },
      messages: [{ role: "user", content: "hi" }],
    })).buffer as ArrayBuffer);

    expect(body.parsed.metadata).toEqual({ user_id: { length: 200 } });
  });

  it("truncates string metadata user ids", () => {
    const body = sanitizeBody(new TextEncoder().encode(JSON.stringify({
      model: "anthropic/claude-sonnet-4.6",
      metadata: { user_id: "u".repeat(129) },
      messages: [{ role: "user", content: "hi" }],
    })).buffer as ArrayBuffer);

    expect(body.parsed.metadata).toEqual({ user_id: "u".repeat(128) });
  });

  it("returns the upstream bytes even if buildProxyLogRow throws", async () => {
    vi.mocked(buildProxyLogRow).mockImplementation(() => {
      throw new Error("synthetic log construction failure");
    });
    vi.mocked(scheduleProxyLog).mockClear();

    const upstreamBody = "not json, still proxied";
    const upstream = new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Generation-Id": "gen-header-1" },
    });

    const out = await observeAndLog({
      response: upstream,
      sanitizedBody: sanitized,
      callerApiKey: "stack-auth-test",
      correlationId: "corr-1",
      startedAt: 0,
      responseHeaders: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

    expect(out.status).toBe(200);
    expect(await out.text()).toBe(upstreamBody);
  });

  it("returns the upstream bytes even if scheduleProxyLog throws", async () => {
    vi.mocked(buildProxyLogRow).mockReturnValue({
      correlationId: "corr-2",
      mode: "generate",
      systemPromptId: "stack-auth-test",
      quality: "unknown",
      speed: "unknown",
      modelId: "anthropic/claude-sonnet-4.6",
      isAuthenticated: false,
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
      durationMs: 0,
      errorMessage: undefined,
      conversationId: undefined,
    });
    vi.mocked(scheduleProxyLog).mockImplementation(() => {
      throw new Error("synthetic schedule failure");
    });

    const upstreamBody = JSON.stringify({ id: "gen-2", choices: [{ message: { content: "world" } }] });
    const upstream = new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const out = await observeAndLog({
      response: upstream,
      sanitizedBody: sanitized,
      callerApiKey: "stack-auth-test",
      correlationId: "corr-2",
      startedAt: 0,
      responseHeaders: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

    expect(out.status).toBe(200);
    expect(await out.text()).toBe(upstreamBody);
  });

  it("passes X-Generation-Id through to the proxy log row without parsing the response body", async () => {
    vi.mocked(buildProxyLogRow).mockReturnValue({
      correlationId: "corr-3",
      mode: "generate",
      systemPromptId: "stack-auth-test",
      quality: "unknown",
      speed: "unknown",
      modelId: "anthropic/claude-sonnet-4.6",
      isAuthenticated: false,
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
      openrouterGenerationId: "gen-header-3",
      stepCount: 0,
      durationMs: 0,
      errorMessage: undefined,
      conversationId: undefined,
    });

    const upstreamBody = "this is not JSON";
    const upstream = new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Generation-Id": "gen-header-3" },
    });

    const out = await observeAndLog({
      response: upstream,
      sanitizedBody: sanitized,
      callerApiKey: "stack-auth-test",
      correlationId: "corr-3",
      startedAt: 0,
      responseHeaders: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

    expect(out.status).toBe(200);
    expect(await out.text()).toBe(upstreamBody);
    expect(buildProxyLogRow).toHaveBeenCalledWith(expect.objectContaining({
      openrouterGenerationId: "gen-header-3",
      responseStatus: 200,
    }));
    expect(scheduleProxyLog).toHaveBeenCalledTimes(1);
  });

  it("logs failed upstream responses without a generation id", async () => {
    vi.mocked(buildProxyLogRow).mockReturnValue({
      correlationId: "corr-4",
      mode: "generate",
      systemPromptId: "stack-auth-test",
      quality: "unknown",
      speed: "unknown",
      modelId: "anthropic/claude-sonnet-4.6",
      isAuthenticated: false,
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
      durationMs: 0,
      errorMessage: "upstream 429",
      conversationId: undefined,
    });

    const upstreamBody = JSON.stringify({ error: { message: "rate limited" } });
    const upstream = new Response(upstreamBody, {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });

    const out = await observeAndLog({
      response: upstream,
      sanitizedBody: sanitized,
      callerApiKey: "stack-auth-test",
      correlationId: "corr-4",
      startedAt: 0,
      responseHeaders: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

    expect(out.status).toBe(429);
    expect(await out.text()).toBe(upstreamBody);
    expect(buildProxyLogRow).toHaveBeenCalledWith(expect.objectContaining({
      openrouterGenerationId: undefined,
      responseStatus: 429,
    }));
  });

  it("delivers full streamed bytes without teeing a parser stream", async () => {
    vi.mocked(buildProxyLogRow).mockImplementation(() => {
      throw new Error("synthetic log failure before response delivery");
    });

    const streamPayload = "data: {\"id\":\"gen-3\"}\n\ndata: [DONE]\n\n";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(streamPayload));
        controller.close();
      },
    });
    const teeSpy = vi.spyOn(stream, "tee");
    const upstream = new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "X-Generation-Id": "gen-header-5" },
    });

    const streamingSanitized = sanitizeBody(new TextEncoder().encode(JSON.stringify({
      model: "anthropic/claude-sonnet-4.6",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })).buffer as ArrayBuffer);

    const out = await observeAndLog({
      response: upstream,
      sanitizedBody: streamingSanitized,
      callerApiKey: "stack-auth-test",
      correlationId: "corr-5",
      startedAt: 0,
      responseHeaders: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });

    expect(out.status).toBe(200);
    expect(await out.text()).toBe(streamPayload);
    expect(teeSpy).not.toHaveBeenCalled();
  });
});

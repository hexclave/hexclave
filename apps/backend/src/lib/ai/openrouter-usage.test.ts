import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hexclave/shared/dist/utils/env", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getEnvVariable: (key: string, fallback?: string) => {
      switch (key) {
        case "STACK_OPENROUTER_API_KEY": {
          return "test-openrouter-key";
        }
        default: {
          return fallback ?? "";
        }
      }
    },
  };
});

vi.mock("@/lib/ai/internal-tool-client", () => ({
  callInternalTool: vi.fn(),
}));

vi.mock("@hexclave/shared/dist/utils/errors", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  captureError: vi.fn(),
}));

import { callInternalTool } from "@/lib/ai/internal-tool-client";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { refineGenerationUsage } from "./openrouter-usage";

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.mocked(callInternalTool).mockReset();
  vi.mocked(captureError).mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("OpenRouter generation usage refinement", () => {
  it("updates AI query usage from /generation metadata", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: {
        tokens_prompt: 100,
        tokens_completion: 25,
        native_tokens_prompt: null,
        native_tokens_completion: null,
        native_tokens_cached: 80,
        total_cost: 0.0123,
        cache_discount: 0.004,
      },
    }));

    const promise = refineGenerationUsage({ generationId: "gen-1", correlationId: "corr-1" });
    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/generation?id=gen-1",
      expect.objectContaining({
        headers: { "Authorization": "Bearer test-openrouter-key" },
      }),
    );
    expect(callInternalTool).toHaveBeenCalledWith("/api/backend/update-ai-query-usage", {
      body: {
        correlationId: "corr-1",
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 80,
        costUsd: 0.0123,
        cacheDiscountUsd: 0.004,
      },
    });
  });

  it("prefers native token counts when both native and normalized are present", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: {
        tokens_prompt: 95,
        tokens_completion: 20,
        native_tokens_prompt: 130,
        native_tokens_completion: 42,
        native_tokens_cached: 50,
        total_cost: 0.02,
        cache_discount: null,
      },
    }));

    const promise = refineGenerationUsage({ generationId: "gen-both", correlationId: "corr-both" });
    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(callInternalTool).toHaveBeenCalledWith("/api/backend/update-ai-query-usage", {
      body: {
        correlationId: "corr-both",
        inputTokens: 130,
        outputTokens: 42,
        cachedInputTokens: 50,
        costUsd: 0.02,
        cacheDiscountUsd: undefined,
      },
    });
  });

  it("falls back to normalized token counts when native counts are null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: {
        tokens_prompt: 130,
        tokens_completion: 42,
        native_tokens_prompt: null,
        native_tokens_completion: null,
        native_tokens_cached: null,
        total_cost: 0.0456,
        cache_discount: null,
      },
    }));

    const promise = refineGenerationUsage({ generationId: "gen-normalized", correlationId: "corr-normalized" });
    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(callInternalTool).toHaveBeenCalledWith("/api/backend/update-ai-query-usage", {
      body: {
        correlationId: "corr-normalized",
        inputTokens: 130,
        outputTokens: 42,
        cachedInputTokens: undefined,
        costUsd: 0.0456,
        cacheDiscountUsd: undefined,
      },
    });
  });

  it("retries when generation metadata is not ready yet", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("not ready", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          tokens_prompt: 11,
          tokens_completion: 7,
          native_tokens_prompt: null,
          native_tokens_completion: null,
          native_tokens_cached: null,
          total_cost: 0.001,
          cache_discount: null,
        },
      }));

    const promise = refineGenerationUsage({ generationId: "gen-2", correlationId: "corr-2" });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(4000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callInternalTool).toHaveBeenCalledWith("/api/backend/update-ai-query-usage", {
      body: {
        correlationId: "corr-2",
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: undefined,
        costUsd: 0.001,
        cacheDiscountUsd: undefined,
      },
    });
  });

  it("keeps 429 failures best-effort, captures the last error, and does not throw into callers", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("too many requests", { status: 429 })));

    const promise = refineGenerationUsage({ generationId: "gen-3", correlationId: "corr-3" });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callInternalTool).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("succeeds on the final attempt after repeated not-ready responses", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("not ready", { status: 404 }))
      .mockResolvedValueOnce(new Response("not ready", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          tokens_prompt: 5,
          tokens_completion: 3,
          native_tokens_prompt: null,
          native_tokens_completion: null,
          native_tokens_cached: null,
          total_cost: 0.0007,
          cache_discount: null,
        },
      }));

    const promise = refineGenerationUsage({ generationId: "gen-slow", correlationId: "corr-slow" });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(10000);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callInternalTool).toHaveBeenCalledWith("/api/backend/update-ai-query-usage", {
      body: {
        correlationId: "corr-slow",
        inputTokens: 5,
        outputTokens: 3,
        cachedInputTokens: undefined,
        costUsd: 0.0007,
        cacheDiscountUsd: undefined,
      },
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("reports loudly (instead of silently giving up) when the generation never becomes ready", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("not ready", { status: 404 })));

    const promise = refineGenerationUsage({ generationId: "gen-never", correlationId: "corr-never" });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callInternalTool).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledTimes(1);
    const [location, err] = vi.mocked(captureError).mock.calls[0];
    expect(location).toBe("openrouter-generation-usage-refine");
    expect(String(err)).toContain("gen-never");
    expect(String(err)).toContain("corr-never");
  });
});

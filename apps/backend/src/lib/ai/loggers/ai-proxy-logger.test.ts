/**
 * Tool-name extraction in `buildProxyLogRow` for Anthropic and OpenAI shapes.
 */
import { describe, expect, it } from "vitest";
import { buildProxyLogRow } from "./ai-proxy-logger";

const baseInput = {
  correlationId: "corr-1",
  apiKey: "stack-auth-proxy",
  durationMs: 0,
  responseStatus: 200,
};

describe("buildProxyLogRow tool-name extraction", () => {
  it("captures Anthropic top-level tool names", () => {
    const row = buildProxyLogRow({
      ...baseInput,
      parsed: {
        model: "anthropic/claude-sonnet-4.6",
        tools: [
          { name: "get_weather", description: "...", input_schema: {} },
          { name: "send_email", description: "...", input_schema: {} },
        ],
      },
    });
    expect(JSON.parse(row.requestedToolsJson)).toEqual(["get_weather", "send_email"]);
  });

  it("captures OpenAI/OpenRouter-format function tool names", () => {
    const row = buildProxyLogRow({
      ...baseInput,
      parsed: {
        model: "anthropic/claude-sonnet-4.6",
        tools: [
          { type: "function", function: { name: "get_weather", parameters: {} } },
          { type: "function", function: { name: "send_email", parameters: {} } },
        ],
      },
    });
    expect(JSON.parse(row.requestedToolsJson)).toEqual(["get_weather", "send_email"]);
  });

  it("handles a mixed array gracefully", () => {
    const row = buildProxyLogRow({
      ...baseInput,
      parsed: {
        model: "anthropic/claude-sonnet-4.6",
        tools: [
          { name: "anthropic_tool", input_schema: {} },
          { type: "function", function: { name: "openai_tool", parameters: {} } },
          { type: "function" },
          null,
          "not an object",
        ],
      },
    });
    expect(JSON.parse(row.requestedToolsJson)).toEqual(["anthropic_tool", "openai_tool"]);
  });

  it("returns an empty array when tools is absent or malformed", () => {
    const row = buildProxyLogRow({
      ...baseInput,
      parsed: {
        model: "anthropic/claude-sonnet-4.6",
      },
    });
    expect(JSON.parse(row.requestedToolsJson)).toEqual([]);
  });

  it("stores generation id but leaves usage accounting empty for refinement", () => {
    const row = buildProxyLogRow({
      ...baseInput,
      openrouterGenerationId: "gen-header-1",
      parsed: {
        model: "anthropic/claude-sonnet-4.6",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
    });

    expect(row.openrouterGenerationId).toBe("gen-header-1");
    expect(row.inputTokens).toBeUndefined();
    expect(row.outputTokens).toBeUndefined();
    expect(row.cachedInputTokens).toBeUndefined();
    expect(row.cacheCreationTokens).toBeUndefined();
    expect(row.costUsd).toBeUndefined();
    expect(row.cacheDiscountUsd).toBeUndefined();
  });

  it("records upstream failure status even without a generation id", () => {
    const row = buildProxyLogRow({
      ...baseInput,
      responseStatus: 429,
      parsed: {
        model: "anthropic/claude-sonnet-4.6",
      },
    });

    expect(row.openrouterGenerationId).toBeUndefined();
    expect(row.errorMessage).toBe("upstream 429");
  });
});

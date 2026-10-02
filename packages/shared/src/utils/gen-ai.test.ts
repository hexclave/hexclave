import { describe, expect, it } from "vitest";
import { extractGenAiSpanInfo, GEN_AI_EXTRACTED_STRING_MAX_BYTES } from "./gen-ai";

function reader(attributes: Record<string, string | number | boolean>): (key: string) => string | number | boolean | null {
  return (key) => attributes[key] ?? null;
}

describe("extractGenAiSpanInfo", () => {
  it("returns null for spans without AI telemetry", () => {
    expect(extractGenAiSpanInfo("GET /orders", reader({ "http.request.method": "GET" }))).toBeNull();
  });

  it("does not misclassify a span merely named like a gen_ai operation", () => {
    expect(extractGenAiSpanInfo("chat message-send", reader({ "app.room": "support" }))).toBeNull();
  });

  it("extracts current OTel gen_ai conventions", () => {
    expect(extractGenAiSpanInfo("chat gpt-4.1", reader({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-4.1",
      "gen_ai.response.model": "gpt-4.1-2026-04-14",
      "gen_ai.usage.input_tokens": 811,
      "gen_ai.usage.output_tokens": "92",
      "gen_ai.usage.cache_read.input_tokens": "640",
      "gen_ai.conversation.id": "conv_0123",
    }))).toEqual({
      operationName: "chat",
      providerName: "openai",
      requestModel: "gpt-4.1",
      responseModel: "gpt-4.1-2026-04-14",
      inputTokens: "811",
      outputTokens: "92",
      cacheReadInputTokens: "640",
      reasoningOutputTokens: null,
      toolName: null,
      agentName: null,
      conversationId: "conv_0123",
    });
  });

  it("extracts agent and tool spans", () => {
    expect(extractGenAiSpanInfo("invoke_agent support-bot", reader({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "support-bot",
      "gen_ai.provider.name": "anthropic",
    }))).toMatchObject({ operationName: "invoke_agent", agentName: "support-bot", providerName: "anthropic" });
    expect(extractGenAiSpanInfo("execute_tool get_weather", reader({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "get_weather",
    }))).toMatchObject({ operationName: "execute_tool", toolName: "get_weather" });
  });

  it("maps legacy Vercel AI SDK spans onto the same canonical shape as its v7 gen_ai emitter", () => {
    expect(extractGenAiSpanInfo("ai.generateText", reader({
      "ai.operationId": "ai.generateText",
      "ai.model.id": "claude-fable-5",
      "ai.model.provider": "anthropic.messages",
      "ai.telemetry.functionId": "summarize-thread",
      "ai.usage.promptTokens": 1200,
      "ai.usage.completionTokens": 300,
    }))).toEqual({
      operationName: "invoke_agent",
      providerName: "anthropic.messages",
      requestModel: "claude-fable-5",
      responseModel: null,
      inputTokens: "1200",
      outputTokens: "300",
      cacheReadInputTokens: null,
      reasoningOutputTokens: null,
      toolName: null,
      agentName: "summarize-thread",
      conversationId: null,
    });
    expect(extractGenAiSpanInfo("ai.toolCall", reader({
      "ai.operationId": "ai.toolCall",
      "ai.toolCall.name": "get_weather",
    }))).toMatchObject({ operationName: "execute_tool", toolName: "get_weather" });
    expect(extractGenAiSpanInfo("ai.embed.doEmbed", reader({
      "ai.operationId": "ai.embed.doEmbed",
      "ai.model.id": "text-embedding-3-small",
    }))).toMatchObject({ operationName: "embeddings", requestModel: "text-embedding-3-small" });
  });

  it("prefers current spellings over deprecated aliases when both are present", () => {
    // Vercel doGenerate spans carry ai.* and a gen_ai.* subset simultaneously.
    expect(extractGenAiSpanInfo("ai.generateText.doGenerate", reader({
      "ai.operationId": "ai.generateText.doGenerate",
      "ai.model.provider": "openai.responses",
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4.1",
      "ai.model.id": "gpt-4.1-mini",
      "gen_ai.usage.input_tokens": 10,
      "ai.usage.promptTokens": 99,
    }))).toMatchObject({
      operationName: "chat",
      providerName: "openai",
      requestModel: "gpt-4.1",
      inputTokens: "10",
    });
  });

  it("recognizes pre-rename gen_ai spans via the span-name convention", () => {
    expect(extractGenAiSpanInfo("chat gpt-4o", reader({
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.usage.prompt_tokens": 5,
      "gen_ai.usage.completion_tokens": 7,
    }))).toMatchObject({
      operationName: "chat",
      providerName: "openai",
      requestModel: "gpt-4o",
      inputTokens: "5",
      outputTokens: "7",
    });
  });

  it("falls past invalid token values to the next alias and canonicalizes digits", () => {
    expect(extractGenAiSpanInfo("chat m", reader({
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": -4,
      "ai.usage.promptTokens": "007",
      "gen_ai.usage.output_tokens": 1.5,
      "gen_ai.usage.completion_tokens": "99999999999999999999999999",
    }))).toMatchObject({ inputTokens: "7", outputTokens: null });
  });

  it("canonicalizes leading zeros before enforcing the UInt64 digit limit", () => {
    expect(extractGenAiSpanInfo("chat m", reader({
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": "00000000000000000000001",
    }))).toMatchObject({ inputTokens: "1" });
  });

  it("caps extracted dimension strings without rejecting the span", () => {
    const info = extractGenAiSpanInfo("chat m", reader({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "m".repeat(4000),
    }));
    expect(info?.requestModel).toHaveLength(GEN_AI_EXTRACTED_STRING_MAX_BYTES);
  });
});

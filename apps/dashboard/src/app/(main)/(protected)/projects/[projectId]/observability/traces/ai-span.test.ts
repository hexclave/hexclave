import { describe, expect, it } from "vitest";
import {
  aiConversationSectionsFromData,
  aiSpanChipLabel,
  aiSpanDetailFields,
  aiSpanSummaryFromRaw,
  aiSpanTokenLabel,
  aiToolInvocationFromData,
  type AiSpanSummary,
} from "./ai-span";

function summary(overrides: Partial<AiSpanSummary> = {}): AiSpanSummary {
  return {
    operationName: "chat",
    providerName: null,
    requestModel: null,
    responseModel: null,
    toolName: null,
    agentName: null,
    conversationId: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    reasoningOutputTokens: null,
    ...overrides,
  };
}

describe("aiSpanSummaryFromRaw", () => {
  it("treats gen_ai_operation_name as the AI-span discriminant", () => {
    expect(aiSpanSummaryFromRaw({ span_type: "GET /api/thing" })).toBeNull();
    expect(aiSpanSummaryFromRaw({ gen_ai_operation_name: null })).toBeNull();
    expect(aiSpanSummaryFromRaw({ gen_ai_operation_name: "" })).toBeNull();
  });

  it("reads ClickHouse UInt64 token counts sent as strings or numbers", () => {
    expect(aiSpanSummaryFromRaw({
      gen_ai_operation_name: "chat",
      gen_ai_provider_name: "anthropic",
      gen_ai_request_model: "claude-sonnet-4-5",
      gen_ai_response_model: "claude-sonnet-4-5-20250929",
      gen_ai_input_tokens: "811",
      gen_ai_output_tokens: 92,
      gen_ai_cache_read_input_tokens: null,
      gen_ai_reasoning_output_tokens: "12",
      gen_ai_tool_name: null,
      gen_ai_agent_name: null,
      gen_ai_conversation_id: "conv-1",
    })).toMatchInlineSnapshot(`
      {
        "agentName": null,
        "cacheReadInputTokens": null,
        "conversationId": "conv-1",
        "inputTokens": "811",
        "operationName": "chat",
        "outputTokens": "92",
        "providerName": "anthropic",
        "reasoningOutputTokens": "12",
        "requestModel": "claude-sonnet-4-5",
        "responseModel": "claude-sonnet-4-5-20250929",
        "toolName": null,
      }
    `);
  });

  it("fails loudly on a token column value the schema cannot produce", () => {
    expect(() => aiSpanSummaryFromRaw({
      gen_ai_operation_name: "chat",
      gen_ai_input_tokens: "not-a-number",
    })).toThrowError("AI token column gen_ai_input_tokens must be a non-negative integer");
    expect(() => aiSpanSummaryFromRaw({
      gen_ai_operation_name: "chat",
      gen_ai_input_tokens: Number.MAX_SAFE_INTEGER + 1,
    })).toThrowError("AI token column gen_ai_input_tokens must be a non-negative integer");
  });

  it("preserves the full UInt64 range without converting through a JavaScript number", () => {
    const parsed = aiSpanSummaryFromRaw({
      gen_ai_operation_name: "chat",
      gen_ai_input_tokens: "18446744073709551615",
    });
    expect(parsed?.inputTokens).toBe("18446744073709551615");
    if (parsed == null) throw new Error("Expected an AI span summary");
    expect(aiSpanTokenLabel(parsed)).toBe("18446744073709551615→? tok");
  });
});

describe("aiSpanChipLabel", () => {
  it("prefers the request model and appends compact token usage", () => {
    expect(aiSpanChipLabel(summary({
      requestModel: "gpt-4o-mini",
      inputTokens: "811",
      outputTokens: "92",
    }))).toBe("gpt-4o-mini · 811→92 tok");
  });

  it("falls back to tool and agent names for their operation kinds", () => {
    expect(aiSpanChipLabel(summary({ operationName: "execute_tool", toolName: "get_weather" }))).toBe("get_weather");
    expect(aiSpanChipLabel(summary({ operationName: "invoke_agent", agentName: "support-bot" }))).toBe("support-bot");
    // A tool name never stands in for a missing model on a non-tool span.
    expect(aiSpanChipLabel(summary({ operationName: "chat", toolName: "get_weather" }))).toBe("chat");
    expect(aiSpanChipLabel(summary({ operationName: "execute_tool" }))).toBe("execute_tool");
  });

  it("marks a one-sided token count instead of hiding it", () => {
    expect(aiSpanTokenLabel(summary({ inputTokens: "811" }))).toBe("811→? tok");
    expect(aiSpanTokenLabel(summary({ outputTokens: "92" }))).toBe("?→92 tok");
    expect(aiSpanTokenLabel(summary())).toBeNull();
  });
});

describe("aiSpanDetailFields", () => {
  it("shows the response model only when it differs from the request model", () => {
    const same = aiSpanDetailFields(summary({ requestModel: "gpt-4o", responseModel: "gpt-4o" }));
    expect(same.map((field) => field.label)).toEqual(["operation", "model"]);
    const differs = aiSpanDetailFields(summary({ requestModel: "gpt-4o", responseModel: "gpt-4o-2024-08-06" }));
    expect(differs.map((field) => field.label)).toEqual(["operation", "model", "response model"]);
  });

  it("joins only the non-null token counts into one row", () => {
    expect(aiSpanDetailFields(summary({
      inputTokens: "811",
      outputTokens: "92",
      cacheReadInputTokens: "640",
    })).at(-1)).toEqual({ label: "tokens", value: "811 in · 92 out · 640 cached" });
    expect(aiSpanDetailFields(summary()).map((field) => field.label)).toEqual(["operation"]);
  });

  it("groups exact UInt64 token counts without rounding them", () => {
    expect(aiSpanDetailFields(summary({
      inputTokens: "18446744073709551615",
    })).at(-1)).toEqual({ label: "tokens", value: "18,446,744,073,709,551,615 in" });
  });
});

describe("aiConversationSectionsFromData", () => {
  it("parses OTel GenAI messages including tool calls, tool responses, and reasoning", () => {
    expect(aiConversationSectionsFromData({
      "gen_ai.input.messages": JSON.stringify([
        { role: "system", parts: [{ type: "text", content: "You are terse." }] },
        { role: "user", parts: [{ type: "text", content: "Weather in Berlin?" }] },
        { role: "assistant", parts: [{ type: "tool_call", id: "call_1", name: "get_weather", arguments: { city: "Berlin" } }] },
        { role: "tool", parts: [{ type: "tool_call_response", id: "call_1", response: { temp: 21 } }] },
      ]),
      "gen_ai.output.messages": JSON.stringify([
        { role: "assistant", parts: [{ type: "reasoning", content: "User wants weather." }, { type: "text", content: "21°C in Berlin." }] },
      ]),
    })).toMatchInlineSnapshot(`
      [
        {
          "kind": "input",
          "messages": [
            {
              "parts": [
                {
                  "text": "You are terse.",
                  "type": "text",
                },
              ],
              "role": "system",
            },
            {
              "parts": [
                {
                  "text": "Weather in Berlin?",
                  "type": "text",
                },
              ],
              "role": "user",
            },
            {
              "parts": [
                {
                  "args": {
                    "city": "Berlin",
                  },
                  "id": "call_1",
                  "name": "get_weather",
                  "type": "tool_call",
                },
              ],
              "role": "assistant",
            },
            {
              "parts": [
                {
                  "id": "call_1",
                  "name": null,
                  "result": {
                    "temp": 21,
                  },
                  "type": "tool_result",
                },
              ],
              "role": "tool",
            },
          ],
          "source": "gen_ai.input.messages",
        },
        {
          "kind": "output",
          "messages": [
            {
              "parts": [
                {
                  "text": "User wants weather.",
                  "type": "reasoning",
                },
                {
                  "text": "21°C in Berlin.",
                  "type": "text",
                },
              ],
              "role": "assistant",
            },
          ],
          "source": "gen_ai.output.messages",
        },
      ]
    `);
  });

  it("parses Vercel AI SDK v4 and v5 tool parts and assembles ai.response.* output", () => {
    expect(aiConversationSectionsFromData({
      "ai.prompt.messages": JSON.stringify([
        { role: "user", content: [{ type: "text", text: "What's the weather?" }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "get_weather", args: { city: "Berlin" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "get_weather", result: { temp: 21 } }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c2", toolName: "get_weather", input: { city: "Paris" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c2", toolName: "get_weather", output: { temp: 25 } }] },
      ]),
      "ai.response.text": "Berlin 21°C, Paris 25°C.",
      "ai.response.toolCalls": JSON.stringify([
        { toolCallId: "c3", toolName: "save_report", args: { ok: true } },
      ]),
    })).toMatchInlineSnapshot(`
      [
        {
          "kind": "input",
          "messages": [
            {
              "parts": [
                {
                  "text": "What's the weather?",
                  "type": "text",
                },
              ],
              "role": "user",
            },
            {
              "parts": [
                {
                  "args": {
                    "city": "Berlin",
                  },
                  "id": "c1",
                  "name": "get_weather",
                  "type": "tool_call",
                },
              ],
              "role": "assistant",
            },
            {
              "parts": [
                {
                  "id": "c1",
                  "name": "get_weather",
                  "result": {
                    "temp": 21,
                  },
                  "type": "tool_result",
                },
              ],
              "role": "tool",
            },
            {
              "parts": [
                {
                  "args": {
                    "city": "Paris",
                  },
                  "id": "c2",
                  "name": "get_weather",
                  "type": "tool_call",
                },
              ],
              "role": "assistant",
            },
            {
              "parts": [
                {
                  "id": "c2",
                  "name": "get_weather",
                  "result": {
                    "temp": 25,
                  },
                  "type": "tool_result",
                },
              ],
              "role": "tool",
            },
          ],
          "source": "ai.prompt.messages",
        },
        {
          "kind": "output",
          "messages": [
            {
              "parts": [
                {
                  "text": "Berlin 21°C, Paris 25°C.",
                  "type": "text",
                },
                {
                  "args": {
                    "ok": true,
                  },
                  "id": "c3",
                  "name": "save_report",
                  "type": "tool_call",
                },
              ],
              "role": "assistant",
            },
          ],
          "source": "ai.response.*",
        },
      ]
    `);
  });

  it("falls back to the outer span's ai.prompt object when no message list is present", () => {
    expect(aiConversationSectionsFromData({
      "ai.prompt": JSON.stringify({ system: "Be terse.", prompt: "Say hi." }),
      "ai.response.text": "Hi.",
    })).toEqual([
      {
        kind: "input",
        source: "ai.prompt",
        messages: [
          { role: "system", parts: [{ type: "text", text: "Be terse." }] },
          { role: "user", parts: [{ type: "text", text: "Say hi." }] },
        ],
      },
      {
        kind: "output",
        source: "ai.response.*",
        messages: [{ role: "assistant", parts: [{ type: "text", text: "Hi." }] }],
      },
    ]);
  });

  it("prepends gen_ai.system_instructions to the input conversation", () => {
    expect(aiConversationSectionsFromData({
      "gen_ai.system_instructions": "You are terse.",
      "gen_ai.input.messages": JSON.stringify([{ role: "user", content: "Hi" }]),
    })).toEqual([
      {
        kind: "input",
        source: "gen_ai.system_instructions + gen_ai.input.messages",
        messages: [
          { role: "system", parts: [{ type: "text", text: "You are terse." }] },
          { role: "user", parts: [{ type: "text", text: "Hi" }] },
        ],
      },
    ]);
    // With no input messages at all, the instructions still render as input.
    expect(aiConversationSectionsFromData({
      "gen_ai.system_instructions": JSON.stringify([{ type: "text", content: "You are terse." }]),
    })).toEqual([
      {
        kind: "input",
        source: "gen_ai.system_instructions",
        messages: [{ role: "system", parts: [{ type: "text", text: "You are terse." }] }],
      },
    ]);
  });

  it("prefers the canonical gen_ai attribute when both dialects are present", () => {
    const sections = aiConversationSectionsFromData({
      "gen_ai.input.messages": JSON.stringify([{ role: "user", content: "canonical" }]),
      "ai.prompt.messages": JSON.stringify([{ role: "user", content: "legacy" }]),
      "gen_ai.output.messages": JSON.stringify([{ role: "assistant", content: "canonical out" }]),
      "ai.response.text": "legacy out",
    });
    expect(sections.map((section) => section.source)).toEqual(["gen_ai.input.messages", "gen_ai.output.messages"]);
  });

  it("keeps unrecognized part shapes visible as raw parts", () => {
    expect(aiConversationSectionsFromData({
      "gen_ai.input.messages": JSON.stringify([
        { role: "user", parts: [{ type: "image", url: "https://example.com/cat.png" }] },
      ]),
    })).toEqual([
      {
        kind: "input",
        source: "gen_ai.input.messages",
        messages: [{ role: "user", parts: [{ type: "raw", value: { type: "image", url: "https://example.com/cat.png" } }] }],
      },
    ]);
  });

  it("skips a section that is not the expected message shape without dropping the others", () => {
    expect(aiConversationSectionsFromData({
      "gen_ai.input.messages": "not json at all",
      "gen_ai.output.messages": JSON.stringify([{ role: "assistant", content: "ok" }]),
    })).toEqual([
      {
        kind: "output",
        source: "gen_ai.output.messages",
        messages: [{ role: "assistant", parts: [{ type: "text", text: "ok" }] }],
      },
    ]);
    expect(aiConversationSectionsFromData({
      "gen_ai.input.messages": JSON.stringify([{ parts: [{ type: "text", content: "no role" }] }]),
    })).toEqual([]);
    expect(aiConversationSectionsFromData("the span data was not even an object")).toEqual([]);
    expect(aiConversationSectionsFromData(undefined)).toEqual([]);
  });
});

describe("aiToolInvocationFromData", () => {
  it("reads OTel GenAI tool call arguments and result, parsing double-encoded JSON", () => {
    expect(aiToolInvocationFromData({
      "gen_ai.tool.call.arguments": JSON.stringify({ city: "Berlin" }),
      "gen_ai.tool.call.result": JSON.stringify({ temp: 21 }),
    })).toEqual({
      args: { source: "gen_ai.tool.call.arguments", value: { city: "Berlin" } },
      result: { source: "gen_ai.tool.call.result", value: { temp: 21 } },
    });
  });

  it("reads the Vercel v4 and v5 attribute names as fallbacks", () => {
    expect(aiToolInvocationFromData({
      "ai.toolCall.args": JSON.stringify({ city: "Berlin" }),
      "ai.toolCall.result": JSON.stringify({ temp: 21 }),
    })).toEqual({
      args: { source: "ai.toolCall.args", value: { city: "Berlin" } },
      result: { source: "ai.toolCall.result", value: { temp: 21 } },
    });
    expect(aiToolInvocationFromData({
      "ai.toolCall.input": JSON.stringify({ city: "Paris" }),
      "ai.toolCall.output": "plain text result",
    })).toEqual({
      args: { source: "ai.toolCall.input", value: { city: "Paris" } },
      result: { source: "ai.toolCall.output", value: "plain text result" },
    });
  });

  it("returns null when the span carries no tool call payloads", () => {
    expect(aiToolInvocationFromData({ "gen_ai.operation.name": "chat" })).toBeNull();
    expect(aiToolInvocationFromData(undefined)).toBeNull();
    // A one-sided payload (result never arrived, e.g. the tool errored) still renders.
    expect(aiToolInvocationFromData({ "ai.toolCall.args": "{}" })).toEqual({
      args: { source: "ai.toolCall.args", value: {} },
      result: null,
    });
  });
});

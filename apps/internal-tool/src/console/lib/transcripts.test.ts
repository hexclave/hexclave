import { describe, expect, it } from "vitest";
import { aiRequestEntries, conversationRows, latestUserMessage, mcpConversationEntries, qaReviewerEntries, requestedTools } from "./transcripts";
import { aiRow, FIXTURE_NOW, mcpRow, timestampAt } from "./test-fixtures";

describe("conversationRows", () => {
  it("returns sibling calls of the conversation oldest first", () => {
    const first = mcpRow({ id: 1n, conversationId: "c", createdAt: timestampAt(FIXTURE_NOW - 1000) });
    const second = mcpRow({ id: 2n, conversationId: "c", createdAt: timestampAt(FIXTURE_NOW) });
    const other = mcpRow({ id: 3n, conversationId: "d" });
    expect(conversationRows(second, [second, other, first]).map(row => row.id)).toEqual([1n, 2n]);
  });

  it("is just the row itself without a conversation id or siblings", () => {
    const row = mcpRow({ id: 5n });
    expect(conversationRows(row, [row, mcpRow({ id: 6n })])).toEqual([row]);
    const lonely = mcpRow({ id: 7n, conversationId: "solo" });
    expect(conversationRows(lonely, [lonely])).toEqual([lonely]);
  });
});

describe("mcpConversationEntries", () => {
  it("renders prompt, question, tool calls and answer, with dividers between calls", () => {
    const rows = [
      mcpRow({ id: 1n, userPrompt: "Set up auth", innerToolCallsJson: JSON.stringify([{ toolName: "search_docs", toolCallId: "t1", args: { q: "oauth" }, result: { hits: 2 } }]) }),
      mcpRow({ id: 2n, toolName: "get_page", question: "Follow-up?", response: "Yes." }),
    ];
    expect(mcpConversationEntries(rows)).toMatchInlineSnapshot(`
      [
        {
          "kind": "divider",
          "label": "Call 1 of 2 · ask_hexclave",
        },
        {
          "kind": "note",
          "label": "Original prompt",
          "text": "Set up auth",
        },
        {
          "kind": "user",
          "text": "How do I add OAuth?",
        },
        {
          "kind": "assistant",
          "text": "Use the OAuth providers page.",
          "toolCalls": [
            {
              "args": {
                "q": "oauth",
              },
              "result": {
                "hits": 2,
              },
              "toolCallId": "t1",
              "toolName": "search_docs",
            },
          ],
        },
        {
          "kind": "divider",
          "label": "Call 2 of 2 · get_page",
        },
        {
          "kind": "user",
          "text": "Follow-up?",
        },
        {
          "kind": "assistant",
          "text": "Yes.",
          "toolCalls": [],
        },
      ]
    `);
  });

  it("survives malformed tool-call JSON", () => {
    const entries = mcpConversationEntries([mcpRow({ innerToolCallsJson: "{oops" })]);
    expect(entries.at(-1)).toEqual({ kind: "assistant", text: "Use the OAuth providers page.", toolCalls: [] });
  });
});

describe("qaReviewerEntries", () => {
  it("pairs tool results by id, falls back to position, and skips empty steps", () => {
    const row = mcpRow({
      qaConversationJson: JSON.stringify([
        // Results arrive out of order; ids must win over position.
        { step: 0, text: "Checking docs", toolCalls: [{ toolName: "a", toolCallId: "x", args: 1 }, { toolName: "c", toolCallId: "z", args: 3 }], toolResults: [{ toolName: "c", toolCallId: "z", result: "c result" }, { toolName: "a", toolCallId: "x", result: "a result" }] },
        // Older rows predate tool call ids; those pair by position.
        { step: 1, toolCalls: [{ toolName: "b", args: 2 }], toolResults: [{ toolName: "b", result: "b result" }] },
        { step: 2 },
        { step: 3, text: "Verdict: fine" },
      ]),
    });
    const entries = qaReviewerEntries(row);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ toolCalls: [{ toolName: "a", result: "a result" }, { toolName: "c", result: "c result" }] });
    expect(entries[1]).toMatchObject({ toolCalls: [{ toolName: "b", toolCallId: "1-0", result: "b result" }] });
  });
});

describe("AI request transcripts", () => {
  const row = aiRow({
    messagesJson: JSON.stringify([
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "an answer" }] },
      { role: "user", content: [{ type: "text", text: "  latest question  " }] },
      { role: "tool", content: { ok: true } },
    ]),
    requestedToolsJson: JSON.stringify(["docs", 42, "sql-query"]),
    finalText: "final",
  });

  it("finds the latest user message", () => {
    expect(latestUserMessage(row)).toBe("latest question");
    expect(latestUserMessage(aiRow())).toBe("");
  });

  it("maps message roles and falls back to the final text without steps", () => {
    const { input, output } = aiRequestEntries(row);
    expect(input.map(entry => entry.kind)).toEqual(["user", "assistant", "user", "tool"]);
    expect(output).toEqual([{ kind: "assistant", text: "final", toolCalls: [] }]);
  });

  it("keeps only string tool names", () => {
    expect(requestedTools(row)).toEqual(["docs", "sql-query"]);
  });
});

import { describe, expect, it } from "vitest";
import { isAiChatReviewer } from "./ai-chat-reviewer";

describe("isAiChatReviewer", () => {
  it("accepts only an explicit `isAiChatReviewer: true`", () => {
    expect(isAiChatReviewer({ isAiChatReviewer: true })).toBe(true);
    expect(isAiChatReviewer({ isAiChatReviewer: true, other: 1 })).toBe(true);
  });

  it.each([
    null,
    undefined,
    {},
    { isAiChatReviewer: false },
    { isAiChatReviewer: "true" },
    { isAiChatReviewer: 1 },
    { isAiChatReviewer: null },
    "isAiChatReviewer",
    true,
    [true],
  ])("rejects %j", (metadata) => {
    expect(isAiChatReviewer(metadata)).toBe(false);
  });
});

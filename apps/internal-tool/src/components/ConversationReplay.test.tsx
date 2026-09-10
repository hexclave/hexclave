// @vitest-environment jsdom

import { fireEvent, render, within } from "@testing-library/react";
import { Timestamp } from "spacetimedb";
import { describe, expect, it } from "vitest";
import { ConversationReplay } from "./ConversationReplay";

function makeCall() {
  const timestamp = new Timestamp(1_700_000_000_000_000n);
  return {
    id: 1n,
    shard: 0,
    correlationId: "call-1",
    conversationId: "conversation-1",
    createdAt: timestamp,
    toolName: "ask_hexclave",
    reason: "Answer product question",
    userPrompt: "Help the engineer",
    question: "How do I configure Hexclave?",
    response: "Use the project configuration.",
    stepCount: 2,
    innerToolCallsJson: "[]",
    durationMs: 420n,
    modelId: "model-1",
    errorMessage: undefined,
    qaReviewedAt: undefined,
    qaNeedsHumanReview: false,
    qaAnswerCorrect: true,
    qaAnswerRelevant: true,
    qaFlagsJson: "[]",
    qaImprovementSuggestions: undefined,
    qaOverallScore: 95,
    qaReviewModelId: "reviewer-1",
    qaConversationJson: undefined,
    qaErrorMessage: undefined,
    humanReviewedAt: undefined,
    humanReviewedBy: undefined,
    humanCorrectedQuestion: undefined,
    humanCorrectedAnswer: undefined,
    publishedToQa: false,
    publishedAt: undefined,
    qaReviewRequestedAt: timestamp,
    context: "Investigating project setup",
    user: "engineer@example.com",
    project: "internal-tool",
  };
}

describe("ConversationReplay", () => {
  it("shows the recorded conversation immediately and replays it in place", () => {
    const row = makeCall();
    const { container } = render(<ConversationReplay row={row} allRows={[row]} />);
    const view = within(container);

    expect(view.getByText(row.question)).not.toBeNull();
    expect(view.getByText(row.response)).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "▶ Play" }));

    expect(view.getByText(row.question)).not.toBeNull();
    expect(view.queryByText(row.response)).toBeNull();
    expect(view.getByRole("button", { name: "Skip" })).not.toBeNull();
  });
});

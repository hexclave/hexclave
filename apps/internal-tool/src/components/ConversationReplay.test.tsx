// @vitest-environment jsdom

import { act, fireEvent, render, within } from "@testing-library/react";
import { Timestamp } from "spacetimedb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * Each replay step schedules the next one from an effect, so a single long `advanceTimersByTime`
 * only fires the first; this steps the pending timer and flushes React until `done` says so.
 */
function runTimersUntil(done: () => boolean, maxSteps = 100): void {
  for (let step = 0; step < maxSteps; step++) {
    if (done()) return;
    act(() => {
      vi.runOnlyPendingTimers();
    });
  }
  throw new Error(`Replay did not reach the expected state within ${maxSteps} timer steps`);
}

describe("ConversationReplay", () => {
  // The replay is a chain of setTimeouts; fake timers let the test drive it to completion instead
  // of leaking real timers that fire (and set state) after the test has finished.
  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no layout, so the follow-along scroll is a no-op here.
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the recorded conversation immediately and replays it in place", () => {
    const row = makeCall();
    const { container, unmount } = render(<ConversationReplay row={row} allRows={[row]} />);
    const view = within(container);

    expect(view.getByText(row.question)).not.toBeNull();
    expect(view.getByText(row.response)).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "▶ Play" }));

    expect(view.getByText(row.question)).not.toBeNull();
    expect(view.queryByText(row.response)).toBeNull();
    expect(view.getByRole("button", { name: "Skip" })).not.toBeNull();

    // question (800ms) → thinking (1200ms) → response revealed three words per 20ms tick.
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(view.getByText("Thinking...")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(view.queryByText("Thinking...")).toBeNull();
    expect(view.queryByText(row.response)).toBeNull();

    runTimersUntil(() => view.queryByText(row.response) != null);
    expect(view.getByText(row.response)).not.toBeNull();
    expect(view.getByRole("button", { name: "▶ Play" })).not.toBeNull();
    expect(view.queryByRole("button", { name: "Skip" })).toBeNull();

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the animation when unmounted mid-replay", () => {
    const row = makeCall();
    const { container, unmount } = render(<ConversationReplay row={row} allRows={[row]} />);

    fireEvent.click(within(container).getByRole("button", { name: "▶ Play" }));
    act(() => {
      vi.advanceTimersByTime(800);
    });
    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

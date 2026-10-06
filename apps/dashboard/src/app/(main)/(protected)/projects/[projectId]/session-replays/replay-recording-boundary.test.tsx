// @vitest-environment jsdom

import { DASHBOARD_SESSION_REPLAY_BLOCK_CLASS } from "@/hexclave/session-replay-config";
import { cleanup, render, screen } from "@testing-library/react";
import { record } from "@rrweb/record";
import { EventType, IncrementalSource, type eventWithTime } from "@rrweb/types";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayRecordingBoundary } from "./replay-recording-boundary";

afterEach(cleanup);

describe("ReplayRecordingBoundary", () => {
  it("marks embedded rrweb players as blocked from outer recordings", () => {
    render(<ReplayRecordingBoundary data-testid="replay-player" className="absolute inset-0" />);

    const boundary = screen.getByTestId("replay-player");
    expect(boundary.classList.contains("rr-block")).toBe(true);
    expect(boundary.classList.contains(DASHBOARD_SESSION_REPLAY_BLOCK_CLASS)).toBe(true);
    expect(boundary.classList.contains("absolute")).toBe(true);
    expect(boundary.classList.contains("inset-0")).toBe(true);
    expect(boundary.getAttribute("data-hexclave-session-replay-block")).toBe("");
  });

  it("blocks live mutations while still recording mutations outside the boundary", async () => {
    render(
      <>
        <div data-testid="outside" />
        <ReplayRecordingBoundary data-testid="replay-player" />
      </>,
    );

    const events: eventWithTime[] = [];
    // Exercise the class contract directly. rrweb 1.1.3 did not apply
    // blockSelector to live mutations, which is the behavior that corrupted
    // nested replay recordings.
    const stopRecording = record({
      blockClass: DASHBOARD_SESSION_REPLAY_BLOCK_CLASS,
      emit: (event) => events.push(event),
    });
    if (stopRecording == null) throw new Error("rrweb record() did not start");

    screen.getByTestId("outside").append(document.createElement("span"));
    await flushMutationObserver();
    const mutationCountAfterOutsideChange = countMutationEvents(events);

    screen.getByTestId("replay-player").append(document.createElement("span"));
    await flushMutationObserver();
    const mutationCountAfterBoundaryChange = countMutationEvents(events);
    stopRecording();

    expect(mutationCountAfterOutsideChange).toBeGreaterThan(0);
    expect(mutationCountAfterBoundaryChange).toBe(mutationCountAfterOutsideChange);
  });
});

function countMutationEvents(events: readonly eventWithTime[]): number {
  return events.filter((event) => (
    event.type === EventType.IncrementalSnapshot
      && event.data.source === IncrementalSource.Mutation
  )).length;
}

async function flushMutationObserver(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

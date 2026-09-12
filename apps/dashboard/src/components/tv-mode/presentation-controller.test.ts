import { describe, expect, it } from "vitest";
import { createTvFixtureSnapshot, getTvProfileFixture } from "@/lib/tv-mode/fixtures";
import { getNextTvScreenIndex, selectTvPresentationView } from "./presentation-controller";

function getProfile() {
  const profile = getTvProfileFixture("company-pulse");
  if (profile == null) throw new Error("Fixture profile is missing");
  return profile;
}

describe("TV presentation controller", () => {
  it("cycles screen indices deterministically", () => {
    expect([
      getNextTvScreenIndex(0, 4),
      getNextTvScreenIndex(3, 4),
      getNextTvScreenIndex(0, 0),
    ]).toMatchInlineSnapshot(`
      [
        1,
        0,
        0,
      ]
    `);
  });

  it("prioritizes a bounded Critical takeover over the playlist", () => {
    const snapshot = createTvFixtureSnapshot("project-fixture", getProfile(), "critical-takeover");
    expect(selectTvPresentationView(snapshot, 2, false)).toMatchObject({
      type: "takeover",
      presentedTakeover: {
        variant: "critical-incident",
        endsAt: "2026-07-23T14:34:00.000Z",
        event: {
          id: "fixture-email-delivery-degradation",
          presentationClass: "critical-incident",
          status: "active",
        },
      },
    });
  });

  it("returns to the playlist after a temporary takeover is dismissed", () => {
    const snapshot = createTvFixtureSnapshot("project-fixture", getProfile(), "incident-takeover");
    expect(selectTvPresentationView(snapshot, 2, true)).toEqual({ type: "screen", screenIndex: 2 });
    expect(snapshot.presentation.highlight).toMatchObject({
      variant: "active-incident",
      event: { id: snapshot.presentation.takeover?.event.id },
    });
  });

  it("returns to the playlist after a bounded Critical takeover is dismissed", () => {
    const snapshot = createTvFixtureSnapshot("project-fixture", getProfile(), "critical-takeover");
    expect(selectTvPresentationView(snapshot, 1, true)).toEqual({ type: "screen", screenIndex: 1 });
  });

  it("surfaces fatal snapshot failures before all presentation content", () => {
    const snapshot = createTvFixtureSnapshot("project-fixture", getProfile(), "error");
    expect(selectTvPresentationView(snapshot, 0, false)).toEqual({
      type: "fatal-error",
      message: "We couldn’t prepare the latest presentation. Please try again shortly.",
    });
  });
});

import { describe, expect, it } from "vitest";
import { createTvFixtureSnapshot, getTvProfileFixture } from "./fixtures";
import { getRetainedSnapshotState } from "./live-snapshot";

const profile = getTvProfileFixture("company-pulse");
if (profile == null) throw new Error("Missing company-pulse fixture profile");

describe("TV live snapshot retention", () => {
  it("keeps a fresh retained snapshot online", () => {
    const snapshot = createTvFixtureSnapshot("project", profile);
    expect(getRetainedSnapshotState(
      snapshot,
      new Date("2026-07-23T14:32:30.000Z"),
      true,
    ).connectionStatus).toBe("online");
  });

  it("marks a retained snapshot stale at its exact deadline", () => {
    const snapshot = createTvFixtureSnapshot("project", profile);
    expect(getRetainedSnapshotState(
      snapshot,
      new Date(snapshot.staleAfter),
      true,
    ).connectionStatus).toBe("stale");
  });

  it("marks retained data offline without discarding any screen data", () => {
    const snapshot = createTvFixtureSnapshot("project", profile);
    const retained = getRetainedSnapshotState(snapshot, new Date(snapshot.generatedAt), false);
    expect(retained.connectionStatus).toBe("offline");
    expect(retained.screens).toEqual(snapshot.screens);
  });
});

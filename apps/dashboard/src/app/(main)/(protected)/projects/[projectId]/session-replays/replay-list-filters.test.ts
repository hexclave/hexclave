import { describe, expect, it } from "vitest";
import { EMPTY_REPLAY_FILTERS, replayFiltersActiveCount, replayUserKindLabel } from "./replay-list-filters";

describe("replayUserKindLabel", () => {
  it("labels anonymous and verified users", () => {
    expect(replayUserKindLabel("anonymous")).toBe("Anonymous");
    expect(replayUserKindLabel("verified")).toBe("Verified");
  });
});

describe("replayFiltersActiveCount", () => {
  it("counts user type separately from a specific user", () => {
    expect(replayFiltersActiveCount(EMPTY_REPLAY_FILTERS)).toBe(0);
    expect(replayFiltersActiveCount({ ...EMPTY_REPLAY_FILTERS, userKind: "anonymous" })).toBe(1);
    expect(replayFiltersActiveCount({
      ...EMPTY_REPLAY_FILTERS,
      userId: "user-1",
      userKind: "verified",
    })).toBe(2);
  });
});

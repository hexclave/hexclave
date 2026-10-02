import { describe, expect, it } from "vitest";
import { formatReplayCount, formatReplayDuration } from "./replay-list-formatting";

describe("replay list formatting", () => {
  it("formats long and invalid durations safely", () => {
    expect(formatReplayDuration(3_661_000)).toBe("1h 1m");
    expect(formatReplayDuration(-1)).toBe("—");
  });

  it("uses lower-case compact count suffixes with at most one fraction digit", () => {
    expect(formatReplayCount(7_512)).toBe("7.5k");
    expect(formatReplayCount(8_000_000)).toBe("8m");
  });
});

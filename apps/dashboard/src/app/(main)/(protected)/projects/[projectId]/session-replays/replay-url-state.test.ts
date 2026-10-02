import { describe, expect, it } from "vitest";
import { parseReplaySeekAt, replaySeekOffsetMs } from "./replay-url-state";

describe("replay URL seek", () => {
  it("treats 13-digit values as wall-clock epoch-ms", () => {
    expect(parseReplaySeekAt("1720000000000")).toEqual({ kind: "epoch", value: 1_720_000_000_000 });
  });

  it("treats small values as player offsets", () => {
    expect(parseReplaySeekAt("3500")).toEqual({ kind: "offset", value: 3500 });
  });

  it("rejects junk rather than seeking to NaN", () => {
    expect(parseReplaySeekAt(null)).toBeNull();
    expect(parseReplaySeekAt("")).toBeNull();
    expect(parseReplaySeekAt("nope")).toBeNull();
    expect(parseReplaySeekAt("-1")).toBeNull();
  });

  it("clamps an epoch seek into the replay's global timeline", () => {
    expect(replaySeekOffsetMs({ kind: "epoch", value: 1_000_004_000 }, 1_000_000_000, 10_000)).toBe(4000);
    expect(replaySeekOffsetMs({ kind: "epoch", value: 1 }, 1_000_000_000, 10_000)).toBe(0);
    expect(replaySeekOffsetMs({ kind: "offset", value: 99_999 }, 0, 10_000)).toBe(10_000);
  });
});

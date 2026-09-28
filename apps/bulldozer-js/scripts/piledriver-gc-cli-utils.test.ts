import { describe, expect, it } from "vitest";
import { parsePiledriverGcMaxObjects, parsePiledriverGcTimestamp } from "./piledriver-gc-cli-utils.js";

describe("Piledriver GC CLI parsing", () => {
  it("accepts non-negative epoch milliseconds", () => {
    expect(parsePiledriverGcTimestamp("0")).toBe(0);
    expect(parsePiledriverGcTimestamp("1770000000000")).toBe(1_770_000_000_000);
    expect(parsePiledriverGcTimestamp("8640000000000000")).toBe(8_640_000_000_000_000);
    expect(parsePiledriverGcTimestamp("20260806")).toBe(20_260_806);
  });

  it("rejects non-epoch timestamp formats and unrepresentable values", () => {
    for (const value of [
      "August 6, 2026",
      "2026-08-06T14:24:00Z",
      "-1",
      "1.5",
      "8640000000000001",
    ]) {
      expect(() => parsePiledriverGcTimestamp(value)).toThrow("non-negative epoch milliseconds");
    }
  });

  it("only accepts positive safe integer object limits", () => {
    expect(parsePiledriverGcMaxObjects(undefined)).toBeUndefined();
    expect(parsePiledriverGcMaxObjects("25")).toBe(25);
    for (const value of ["0", "-1", "1.5", "not-a-number"]) {
      expect(() => parsePiledriverGcMaxObjects(value)).toThrow("positive safe integer");
    }
  });
});

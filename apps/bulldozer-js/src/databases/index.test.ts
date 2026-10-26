import { describe, expect, it } from "vitest";
import { DatabaseSeq, deserializeDatabaseSeq, serializeDatabaseSeq } from "./index.js";

describe("database sequence serialization", () => {
  it("round-trips strings and finite numbers", () => {
    const sequence = deserializeDatabaseSeq("[\"replica\",0,42.5]");
    expect(deserializeDatabaseSeq(serializeDatabaseSeq(sequence))).toEqual(sequence);
  });

  it("rejects values that JSON would serialize lossy", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
      expect(() => serializeDatabaseSeq([value] as unknown as DatabaseSeq)).toThrow(
        "Database sequences must contain only strings and finite numbers other than -0 for lossless JSON serialization",
      );
      expect(() => deserializeDatabaseSeq(`[${Object.is(value, -0) ? "-0" : "null"}]`)).toThrow("Invalid database sequence");
    }
  });
});

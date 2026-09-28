import { describe, expect, it } from "vitest";
import { resolveTvFixtureVariant } from "./fixture-route";

describe("TV fixture route gating", () => {
  it("accepts synthetic fixtures only for development-enabled projects", () => {
    expect(resolveTvFixtureVariant("celebration-takeover", true)).toBe("celebration-takeover");
    expect(resolveTvFixtureVariant("celebration-takeover", false)).toBeNull();
    expect(resolveTvFixtureVariant("unknown-fixture", true)).toBeNull();
    expect(resolveTvFixtureVariant(null, true)).toBeNull();
  });
});

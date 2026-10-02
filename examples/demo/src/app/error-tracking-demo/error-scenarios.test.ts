import { describe, expect, it } from "vitest";
import { createRepeatedErrorScenario, createUniqueErrorScenario } from "./error-scenarios";

describe("error tracking demo scenarios", () => {
  it("keeps repeated captures in the same deterministic issue group", () => {
    const first = createRepeatedErrorScenario();
    const second = createRepeatedErrorScenario();

    expect(first).toEqual(second);
    expect(first.fingerprint).toEqual([
      "hexclave-error-tracking-demo",
      "repeatable-client-error",
    ]);
  });

  it("gives each unique capture its own deterministic issue group", () => {
    const first = createUniqueErrorScenario("instance-one");
    const second = createUniqueErrorScenario("instance-two");

    expect(first.fingerprint).not.toEqual(second.fingerprint);
    expect(first.message).toContain("instance-one");
    expect(second.message).toContain("instance-two");
  });

  it("rejects an empty unique instance key", () => {
    expect(() => createUniqueErrorScenario("   ")).toThrowError(
      "The unique error scenario requires a non-empty instance key",
    );
  });
});

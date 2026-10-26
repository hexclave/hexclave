import { describe, expect, it } from "vitest";
import { PROVIDER_MUTATION_TIMEOUT_MS, RECONCILIATION_TAKEOVER_GRACE_MS } from "./mutation-safety.js";

describe("provider mutation fencing", () => {
  it("never permits takeover while an old owner's bounded mutation may still be running", () => {
    expect(RECONCILIATION_TAKEOVER_GRACE_MS).toBeGreaterThan(PROVIDER_MUTATION_TIMEOUT_MS);
  });
});

import { describe, expect, test } from "vitest";
import { createFreestyleCapacityGate, isFreestyleAccountLimitError } from "./freestyle-capacity";

class FakeFreestyleApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code === "LIMIT_EXCEEDED" ? "Account resource limit exceeded" : code);
    this.name = "FreestyleApiError";
  }
}

describe("isFreestyleAccountLimitError", () => {
  test("matches the 429 LIMIT_EXCEEDED rejection from VM creation", () => {
    expect(isFreestyleAccountLimitError(new FakeFreestyleApiError(429, "LIMIT_EXCEEDED"))).toBe(true);
  });

  test("matches it inside a RetryError-style AggregateError and cause chains", () => {
    const limit = new FakeFreestyleApiError(429, "LIMIT_EXCEEDED");
    const retryError = new AggregateError([limit, limit], "Error after 2 attempts.", { cause: limit });
    expect(isFreestyleAccountLimitError(retryError)).toBe(true);
    expect(isFreestyleAccountLimitError(new Error("wrapper", { cause: new Error("inner", { cause: limit }) }))).toBe(true);
    expect(isFreestyleAccountLimitError(new AggregateError([new Error("other"), limit], "mixed"))).toBe(true);
  });

  test("does not match other Freestyle or runtime failures", () => {
    expect(isFreestyleAccountLimitError(new FakeFreestyleApiError(404, "NOT_FOUND"))).toBe(false);
    expect(isFreestyleAccountLimitError(new Error("Freestyle VM JavaScript runner exited with non-zero code"))).toBe(false);
    const fakeStatus = Object.assign(new Error("not freestyle"), { status: 429 });
    expect(isFreestyleAccountLimitError(fakeStatus)).toBe(false);
    expect(isFreestyleAccountLimitError(undefined)).toBe(false);
    expect(isFreestyleAccountLimitError("LIMIT_EXCEEDED")).toBe(false);
  });

  test("survives cyclic cause chains", () => {
    const a: any = new Error("a");
    const b: any = new Error("b", { cause: a });
    a.cause = b;
    expect(isFreestyleAccountLimitError(a)).toBe(false);
  });
});

describe("createFreestyleCapacityGate", () => {
  test("skips Freestyle only during the cooldown and reports once per cooldown", () => {
    let time = 1_000;
    const gate = createFreestyleCapacityGate({ cooldownMs: 30_000, now: () => time });

    expect(gate.shouldSkipFreestyle()).toBe(false);
    expect(gate.recordAccountLimit()).toEqual({ shouldReport: true, skippedSinceLastReport: 0 });

    time += 1_000;
    expect(gate.shouldSkipFreestyle()).toBe(true);
    expect(gate.shouldSkipFreestyle()).toBe(true);
    // An execution that was already in flight hits the limit too: no second report.
    expect(gate.recordAccountLimit().shouldReport).toBe(false);

    time += 30_001;
    expect(gate.shouldSkipFreestyle()).toBe(false);
    // Limit still exhausted after the cooldown: report again, with what was skipped.
    expect(gate.recordAccountLimit()).toEqual({ shouldReport: true, skippedSinceLastReport: 2 });

    time += 30_001;
    expect(gate.shouldSkipFreestyle()).toBe(false);
  });
});

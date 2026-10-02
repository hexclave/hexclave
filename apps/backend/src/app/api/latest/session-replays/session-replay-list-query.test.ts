import { describe, expect, it } from "vitest";
import { parseSessionReplayUserKind, sessionReplayUserKindIsAnonymous } from "./session-replay-list-query";

describe("parseSessionReplayUserKind", () => {
  it("treats missing and empty values as no filter", () => {
    expect(parseSessionReplayUserKind(undefined)).toBeNull();
    expect(parseSessionReplayUserKind("")).toBeNull();
  });

  it("accepts anonymous and verified", () => {
    expect(parseSessionReplayUserKind("anonymous")).toBe("anonymous");
    expect(parseSessionReplayUserKind("verified")).toBe("verified");
  });

  it("rejects unknown values", () => {
    expect(() => parseSessionReplayUserKind("email_verified")).toThrowError("user_kind must be anonymous or verified");
  });
});

describe("sessionReplayUserKindIsAnonymous", () => {
  it("maps verified to non-anonymous users", () => {
    expect(sessionReplayUserKindIsAnonymous("anonymous")).toBe(true);
    expect(sessionReplayUserKindIsAnonymous("verified")).toBe(false);
  });
});

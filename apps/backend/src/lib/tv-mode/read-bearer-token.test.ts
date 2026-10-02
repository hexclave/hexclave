import { describe, expect, it } from "vitest";
import { readTvDisplayBearerToken } from "./read-bearer-token";

describe("readTvDisplayBearerToken", () => {
  it("accepts a case-insensitive scheme without changing the token", () => {
    expect(readTvDisplayBearerToken("bearer AbC.token")).toBe("AbC.token");
  });

  it("rejects a missing or malformed authorization value", () => {
    expect(() => readTvDisplayBearerToken(undefined)).toThrow("tv_display_access_required");
    expect(() => readTvDisplayBearerToken("Basic token")).toThrow("tv_display_access_required");
    expect(() => readTvDisplayBearerToken("Bearer\ttoken")).toThrow("tv_display_access_required");
    expect(() => readTvDisplayBearerToken("Bearer ")).toThrow("tv_display_access_required");
    expect(() => readTvDisplayBearerToken("Bearer  token")).toThrow("tv_display_access_required");
  });
});

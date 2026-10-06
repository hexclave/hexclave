import { describe, expect, it } from "vitest";
import { clickhouseEventTypesToInsert, SystemEventTypes } from "./events";

describe("clickhouseEventTypesToInsert", () => {
  it("writes only the requested ClickHouse system types, not inherited ancestors", () => {
    expect(clickhouseEventTypesToInsert([
      SystemEventTypes.TokenRefresh,
      SystemEventTypes.SessionActivity,
    ]).map((eventType) => eventType.id)).toEqual(["$token-refresh"]);
  });

  it("skips product-adjacent types that used to be a catch-all insert", () => {
    expect(clickhouseEventTypesToInsert([
      SystemEventTypes.UserActivity,
      SystemEventTypes.Project,
    ])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { parseSavedIssueSearchViewListLimit } from "./api";

describe("saved issue search view API helpers", () => {
  it("keeps list pagination bounded", () => {
    expect(parseSavedIssueSearchViewListLimit(undefined)).toBe(50);
    expect(parseSavedIssueSearchViewListLimit("1")).toBe(1);
    expect(parseSavedIssueSearchViewListLimit("100")).toBe(100);
  });

  it("rejects malformed list limits", () => {
    expect(() => parseSavedIssueSearchViewListLimit("0")).toThrow("between 1 and 100");
    expect(() => parseSavedIssueSearchViewListLimit("101")).toThrow("between 1 and 100");
    expect(() => parseSavedIssueSearchViewListLimit("1.5")).toThrow("between 1 and 100");
  });
});

import { describe, expect, it } from "vitest";
import { getInputMessagePreview } from "./UsageDataGrid";

describe("getInputMessagePreview", () => {
  it("uses the latest user-authored message", () => {
    expect(getInputMessagePreview(JSON.stringify([
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Current question" },
    ]))).toBe("Current question");
  });

  it("joins text parts in structured message content", () => {
    expect(getInputMessagePreview(JSON.stringify([
      { role: "user", content: [{ type: "text", text: "First " }, { type: "text", text: "second" }] },
    ]))).toBe("First second");
  });

  it("returns an empty preview for malformed or missing user messages", () => {
    expect(getInputMessagePreview("not json")).toBe("");
    expect(getInputMessagePreview(JSON.stringify([{ role: "assistant", content: "Answer" }]))).toBe("");
  });
});

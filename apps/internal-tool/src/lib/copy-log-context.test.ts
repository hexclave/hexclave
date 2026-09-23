import { describe, expect, it } from "vitest";
import { formatStoredLogContext } from "./copy-log-context";

describe("formatStoredLogContext", () => {
  it("keeps bigint values exact and expands embedded JSON for AI consumption", () => {
    const text = formatStoredLogContext("AI request", new Date("2023-11-14T22:13:20.000Z"), {
      id: 9_007_199_254_740_993n,
      requestedToolsJson: '["docs"]',
      messagesJson: '[{"role":"user","content":"help"}]',
      stepsJson: "not valid json",
    }, new Set(["requestedToolsJson", "messagesJson", "stepsJson"]));

    expect(text).toContain('"id": "9007199254740993"');
    expect(text).toContain('"requestedToolsJson": [');
    expect(text).toContain('"content": "help"');
    expect(text).toContain('"stepsJson": "not valid json"');
  });
});

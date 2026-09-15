import { describe, expect, it } from "vitest";
import { TOOL_NAMES, validateToolNames } from "./index";

describe("validateToolNames stays in sync with TOOL_NAMES", () => {
  it("accepts the full TOOL_NAMES list", () => {
    expect(validateToolNames([...TOOL_NAMES])).toBe(true);
  });

  it("accepts each tool name individually", () => {
    for (const name of TOOL_NAMES) {
      expect(validateToolNames([name])).toBe(true);
    }
  });

  it("rejects unknown names", () => {
    expect(validateToolNames(["does-not-exist"])).toBe(false);
    expect(validateToolNames([...TOOL_NAMES, "does-not-exist"])).toBe(false);
  });

  it("rejects non-array inputs", () => {
    expect(validateToolNames("docs")).toBe(false);
    expect(validateToolNames(null)).toBe(false);
    expect(validateToolNames(undefined)).toBe(false);
    expect(validateToolNames({})).toBe(false);
  });
});

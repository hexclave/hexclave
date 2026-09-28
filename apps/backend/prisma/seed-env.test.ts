import { describe, expect, it } from "vitest";
import { resolveInternalProjectKeyAlias } from "./seed-env";

describe("internal project key aliases", () => {
  it("uses the canonical value", () => {
    expect(resolveInternalProjectKeyAlias("canonical", "alias", "canonical-value", "")).toBe("canonical-value");
  });

  it("uses the documented alias", () => {
    expect(resolveInternalProjectKeyAlias("canonical", "alias", "", "alias-value")).toBe("alias-value");
  });

  it("rejects conflicting values", () => {
    expect(() => resolveInternalProjectKeyAlias("canonical", "alias", "canonical-value", "alias-value")).toThrow(/canonical and alias.*different/);
  });

  it("returns an empty value when neither spelling is set", () => {
    expect(resolveInternalProjectKeyAlias("canonical", "alias", "", "")).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { isAppNavigationItemVisible } from "./app-navigation-visibility";

describe("isAppNavigationItemVisible", () => {
  it("shows regular navigation items for every project", () => {
    expect(isAppNavigationItemVisible("customer-project", {})).toBe(true);
    expect(isAppNavigationItemVisible("internal", {})).toBe(true);
  });

  it("hides internal-only navigation items from customer projects", () => {
    expect(isAppNavigationItemVisible("customer-project", { internalOnly: true })).toBe(false);
  });

  it("shows internal-only navigation items in the internal project", () => {
    expect(isAppNavigationItemVisible("internal", { internalOnly: true })).toBe(true);
  });
});

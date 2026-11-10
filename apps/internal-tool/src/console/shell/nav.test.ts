import { describe, expect, it } from "vitest";
import { activeConsolePage, CONSOLE_PAGES, navSections } from "./nav";

describe("activeConsolePage", () => {
  it("matches the page that owns a path, keeping /console for the overview only", () => {
    expect(activeConsolePage("/console")?.id).toBe("overview");
    expect(activeConsolePage("/console/mcp")?.id).toBe("mcp");
    expect(activeConsolePage("/console/mcp/anything")?.id).toBe("mcp");
    expect(activeConsolePage("/console/unknown")).toBeNull();
    expect(activeConsolePage("/")).toBeNull();
  });
});

describe("navSections", () => {
  it("groups consecutive pages by section without dropping or reordering any", () => {
    const sections = navSections();
    expect(sections.map(section => section.label)).toMatchInlineSnapshot(`
      [
        null,
        "MCP",
        "Unified AI",
        "Content",
        "Tools",
      ]
    `);
    expect(sections.flatMap(section => section.pages)).toEqual([...CONSOLE_PAGES]);
  });
});

import { describe, expect, it } from "vitest";
import { appSetupPrompts } from "../ai/unified-prompts/skill-site-prompt-parts/ai-setup-prompt";
import { ALL_APPS, expandAppSoftRequirements, getParentAppId } from "./apps-config";

describe("app hierarchy", () => {
  it("keeps Observability and Warehouse independent from Analytics", () => {
    expect(getParentAppId("observability")).toBeNull();
    expect(getParentAppId("warehouse")).toBeNull();
    expect(getParentAppId("clickmaps")).toBe("analytics");
    expect(getParentAppId("session-replays")).toBe("analytics");
  });
});

describe("app soft requirements", () => {
  it("expands requirements recursively without adding unrelated apps", () => {
    expect([...expandAppSoftRequirements(["teams"])]).toEqual([
      "teams",
      "authentication",
      "emails",
    ]);
  });

  it("keeps apps without requirements independent", () => {
    expect([...expandAppSoftRequirements(["analytics"])]).toEqual(["analytics"]);
  });

  it("deduplicates requirements shared by multiple selected apps", () => {
    expect([...expandAppSoftRequirements(["teams", "authentication"])]).toEqual([
      "authentication",
      "emails",
      "teams",
    ]);
  });

  it("defines softRequirements for every app", () => {
    for (const [appId, app] of Object.entries(ALL_APPS)) {
      expect(Array.isArray(app.softRequirements), `${appId} is missing softRequirements`).toBe(true);
    }
  });

  it("only references standalone apps", () => {
    for (const app of Object.values(ALL_APPS)) {
      for (const requirementId of app.softRequirements) {
        expect(ALL_APPS[requirementId]).not.toHaveProperty("parentAppId");
      }
    }
  });

  it("explains soft requirements in the AI setup prompt", () => {
    expect(appSetupPrompts).toContain(
      "Soft requirements (strongly recommended, but not enforced): emails. Enable these apps alongside this one unless the user explicitly opts out.",
    );
    expect(appSetupPrompts).toContain("Soft requirements: none.");
  });
});

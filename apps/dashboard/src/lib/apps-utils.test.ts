import { describe, expect, it } from "vitest";
import { ALL_APPS } from "@hexclave/shared/dist/apps/apps-config";

import { getAppEnableConfigUpdate, getAppIdsForListing, getEnabledAppIds, getEnabledNavigableAppIds, isAppEnabled } from "./apps-utils";

describe("app enablement", () => {
  it("enables Warehouse and Observability independently as top-level apps", () => {
    const installed = {
      analytics: { enabled: true },
      warehouse: { enabled: true },
      observability: { enabled: true },
    };
    expect(getEnabledAppIds({ analytics: { enabled: true } })).not.toContain("observability");
    expect(getEnabledAppIds({ analytics: { enabled: true } })).not.toContain("warehouse");
    expect(getEnabledAppIds(installed)).toContain("observability");
    expect(getEnabledAppIds(installed)).toContain("warehouse");
    expect(getEnabledNavigableAppIds(installed)).toEqual([
      "analytics",
      "observability",
      "warehouse",
    ]);
  });
});

describe("getAppIdsForListing", () => {
  it("hides alpha apps unless they are enabled", () => {
    const alphaAppIds = Object.entries(ALL_APPS)
      .filter(([, app]) => app.stage === "alpha")
      .map(([appId]) => appId);

    expect(getAppIdsForListing()).not.toEqual(expect.arrayContaining(alphaAppIds));
    expect(getAppIdsForListing(["support"])).toContain("support");
  });
});

describe("getAppEnableConfigUpdate", () => {
  it("enables recursively recommended apps", () => {
    expect(getAppEnableConfigUpdate("teams")).toEqual({
      "apps.installed.teams.enabled": true,
      "apps.installed.authentication.enabled": true,
      "apps.installed.emails.enabled": true,
    });
  });

  it("does not add unrelated apps", () => {
    expect(getAppEnableConfigUpdate("analytics")).toEqual({
      "apps.installed.analytics.enabled": true,
    });
  });
});

describe("sub-app enablement", () => {
  it("continues to use the parent app in the dashboard", () => {
    const independentlyEnabledClickmaps = {
      analytics: { enabled: false },
      clickmaps: { enabled: true },
    };

    expect(isAppEnabled(independentlyEnabledClickmaps, "clickmaps")).toBe(false);
    expect(getEnabledAppIds(independentlyEnabledClickmaps)).not.toContain("clickmaps");

    const enabledThroughParent = {
      analytics: { enabled: true },
      clickmaps: { enabled: false },
    };
    expect(isAppEnabled(enabledThroughParent, "clickmaps")).toBe(true);
    expect(getEnabledAppIds(enabledThroughParent)).toContain("clickmaps");
  });
});

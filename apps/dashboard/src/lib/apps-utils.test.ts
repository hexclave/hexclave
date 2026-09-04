import { describe, expect, it } from "vitest";
import { ALL_APPS } from "@hexclave/shared/dist/apps/apps-config";

import { getAppEnableConfigUpdate, getAppIdsForListing, getEnabledAppIds, isAppEnabled } from "./apps-utils";

describe("getAppIdsForListing", () => {
  it("hides alpha apps unless they are enabled", () => {
    const alphaAppIds = Object.entries(ALL_APPS)
      .filter(([, app]) => app.stage === "alpha")
      .map(([appId]) => appId);

    expect(getAppIdsForListing()).not.toEqual(expect.arrayContaining(alphaAppIds));
    expect(getAppIdsForListing()).not.toContain("feature-flags");
    expect(getAppIdsForListing(["support"])).toContain("support");
    expect(getAppIdsForListing(["feature-flags"])).toContain("feature-flags");
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

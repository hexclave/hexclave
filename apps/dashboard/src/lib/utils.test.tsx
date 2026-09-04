import { beforeEach, describe, expect, it, vi } from "vitest";

const publicEnvironment = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/env", () => ({
  getPublicEnvVar: (name: string) => publicEnvironment.get(name),
}));

import { devFeaturesEnabledForProject } from "./utils";

beforeEach(() => {
  publicEnvironment.clear();
});

describe("development feature project gating", () => {
  it("always enables the internal project", () => {
    expect(devFeaturesEnabledForProject("internal")).toBe(true);
  });

  it("enables only explicitly allowlisted project IDs", () => {
    publicEnvironment.set(
      "NEXT_PUBLIC_STACK_ENABLE_DEVELOPMENT_FEATURES_PROJECT_IDS",
      JSON.stringify(["project-a", "project-b"]),
    );

    expect(devFeaturesEnabledForProject("project-a")).toBe(true);
    expect(devFeaturesEnabledForProject("project-c")).toBe(false);
  });

  it.each([undefined, "", "not-json", JSON.stringify({ project: "project-a" })])(
    "fails closed for missing or invalid configuration: %s",
    (configuredValue) => {
      if (configuredValue != null) {
        publicEnvironment.set("NEXT_PUBLIC_STACK_ENABLE_DEVELOPMENT_FEATURES_PROJECT_IDS", configuredValue);
      }
      expect(devFeaturesEnabledForProject("project-a")).toBe(false);
    },
  );
});

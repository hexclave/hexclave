import { describe, expect, it } from "vitest";

import {
  CLOUD_ONBOARDING_STEPS,
  createInitialCloudOnboardingState,
  isCloudProjectOnboardingState,
  normalizeCloudProjectOnboardingState,
  type CloudProjectOnboardingState,
} from "./cloud-project-onboarding";

describe("cloud project onboarding state", () => {
  it("starts every new project at the welcome screen", () => {
    expect(createInitialCloudOnboardingState()).toMatchInlineSnapshot(`
      {
        "additional_app_ids": [],
        "journey": "add",
        "primary_app_id": null,
        "project_location": null,
        "selected_apps": [],
        "selected_email_theme_id": "1df07ae6-abf3-4a40-83a5-a1a2cbe336ac",
        "selected_sign_in_methods": [
          "credential",
          "magicLink",
          "google",
          "github",
        ],
        "step": "welcome-to-hexclave",
        "version": 1,
      }
    `);
  });

  it.each(CLOUD_ONBOARDING_STEPS)("resumes the exact persisted %s step", (step) => {
    const state: CloudProjectOnboardingState = {
      ...createInitialCloudOnboardingState(),
      step,
      journey: "add",
      primary_app_id: "authentication",
      selected_apps: ["authentication", "analytics"],
    };

    expect(normalizeCloudProjectOnboardingState(state, "config_choice")).toEqual(state);
  });

  it("normalizes ordering and duplicate selections without changing the step", () => {
    const state: CloudProjectOnboardingState = {
      ...createInitialCloudOnboardingState(),
      step: "select-email-theme",
      primary_app_id: "authentication",
      selected_apps: ["analytics", "authentication", "analytics"],
      selected_sign_in_methods: ["github", "credential", "github"],
    };

    expect(normalizeCloudProjectOnboardingState(state, "config_choice")).toMatchObject({
      step: "select-email-theme",
      selected_apps: ["authentication", "analytics"],
      selected_sign_in_methods: ["credential", "github"],
    });
  });

  it("upgrades legacy progress into the corresponding cloud step", () => {
    expect(normalizeCloudProjectOnboardingState({
      selected_config_choice: "create-new",
      selected_apps: ["authentication", "analytics"],
      selected_sign_in_methods: ["credential"],
      selected_email_theme_id: "default",
      selected_payments_country: "US",
    }, "auth_setup")).toMatchObject({
      version: 1,
      step: "configure-authentication",
      journey: "add",
      selected_apps: ["authentication", "analytics"],
      selected_sign_in_methods: ["credential"],
    });
  });

  it("rejects unknown versions and steps", () => {
    expect(isCloudProjectOnboardingState({
      ...createInitialCloudOnboardingState(),
      version: 2,
    })).toBe(false);
    expect(isCloudProjectOnboardingState({
      ...createInitialCloudOnboardingState(),
      step: "unknown",
    })).toBe(false);
  });
});

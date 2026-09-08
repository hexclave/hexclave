import { describe, expect, it } from "vitest";
import { getGrowthAdminLifecycleStep, GROWTH_ADMIN_LIFECYCLE_STEPS } from "./lifecycle-routes";

describe("Growth admin lifecycle routes", () => {
  it("ends onboarding at the report instead of presenting ongoing work as a setup step", () => {
    expect(GROWTH_ADMIN_LIFECYCLE_STEPS.map((step) => step.id)).toEqual([
      "set-up",
      "compute-metrics",
      "integrations",
      "analysis",
      "interview",
      "report",
    ]);
    expect(getGrowthAdminLifecycleStep("ongoing")).toBeNull();
  });
});

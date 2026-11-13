import { describe, expect, it } from "vitest";
import { BASE_PLAN_IDS_BY_TIER, PLAN_DISPLAY_NAMES, PLAN_LIMITS, PLAN_MONTHLY_PRICES_USD, isPaidPlanId, isPlanUpgrade } from "./plans";

describe("isPaidPlanId", () => {
  it("accepts exactly the paid plans", () => {
    expect(isPaidPlanId("team")).toBe(true);
    expect(isPaidPlanId("growth")).toBe(true);
    expect(isPaidPlanId("free")).toBe(false);
    expect(isPaidPlanId("extra-seat")).toBe(false);
    expect(isPaidPlanId("")).toBe(false);
  });
});

describe("isPlanUpgrade", () => {
  it("is true only for a higher tier", () => {
    expect(isPlanUpgrade("free", "team")).toBe(true);
    expect(isPlanUpgrade("free", "growth")).toBe(true);
    expect(isPlanUpgrade("team", "growth")).toBe(true);
    expect(isPlanUpgrade("team", "team")).toBe(false);
    expect(isPlanUpgrade("growth", "team")).toBe(false);
    expect(isPlanUpgrade("growth", "growth")).toBe(false);
  });
});

describe("plan tables", () => {
  it("cover every plan", () => {
    expect(Object.keys(PLAN_DISPLAY_NAMES).sort()).toEqual(Object.keys(PLAN_LIMITS).sort());
    expect([...BASE_PLAN_IDS_BY_TIER].sort()).toEqual(Object.keys(PLAN_LIMITS).sort());
    expect(Object.keys(PLAN_MONTHLY_PRICES_USD).sort()).toEqual(Object.keys(PLAN_LIMITS).filter((id) => id !== "free").sort());
  });

  it("price higher tiers higher", () => {
    expect(PLAN_MONTHLY_PRICES_USD.growth).toBeGreaterThan(PLAN_MONTHLY_PRICES_USD.team);
  });
});

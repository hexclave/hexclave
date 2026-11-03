import { PLAN_LIMITS } from "@hexclave/shared/dist/plans";
import { describe, expect, it } from "vitest";
import { getPlanUpgradeLabel, getPlanUpgradeSummary, parseTargetPlanId } from "./plan-upgrade";

describe("getPlanUpgradeLabel", () => {
  it("names the plan and its monthly price", () => {
    expect(getPlanUpgradeLabel("team")).toMatchInlineSnapshot(`"Upgrade to Team — $49/mo"`);
    expect(getPlanUpgradeLabel("growth")).toMatchInlineSnapshot(`"Upgrade to Growth — $299/mo"`);
  });
});

describe("getPlanUpgradeSummary", () => {
  it("is built from the plan's limits", () => {
    expect(getPlanUpgradeSummary("team")).toMatchInlineSnapshot(`"Team gives you 4 dashboard admins, 50,000 auth users, 25,000 emails a month, 60s analytics queries, and an onboarding call."`);
    expect(getPlanUpgradeSummary("team")).toContain(`${PLAN_LIMITS.team.seats} dashboard admins`);
    expect(getPlanUpgradeSummary("growth")).toContain(`${PLAN_LIMITS.growth.analyticsTimeoutSeconds}s analytics queries`);
  });
});

describe("parseTargetPlanId", () => {
  it("accepts the paid plans", () => {
    expect(parseTargetPlanId("team")).toBe("team");
    expect(parseTargetPlanId("growth")).toBe("growth");
  });

  it("falls back to Team for anything else", () => {
    expect(parseTargetPlanId(null)).toBe("team");
    expect(parseTargetPlanId("")).toBe("team");
    expect(parseTargetPlanId("free")).toBe("team");
    expect(parseTargetPlanId("enterprise")).toBe("team");
    expect(parseTargetPlanId("TEAM")).toBe("team");
  });
});

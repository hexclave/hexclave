import { describe, expect, it } from "vitest";
import { formatAdminSeatUsage, getAdminSeatPurchase } from "./admin-seat-usage";

describe("formatAdminSeatUsage", () => {
  it("shows count and limit when plan limits are enforced", () => {
    expect(formatAdminSeatUsage({ activeSeats: 1, seatLimit: 4, arePlanLimitsEnforced: true })).toBe("1/4");
  });

  it("still shows a zero limit when plan limits are enforced", () => {
    expect(formatAdminSeatUsage({ activeSeats: 1, seatLimit: 0, arePlanLimitsEnforced: true })).toBe("1/0");
  });

  it("hides the limit when plan limits are not enforced", () => {
    expect(formatAdminSeatUsage({ activeSeats: 1, seatLimit: 0, arePlanLimitsEnforced: false })).toBe("1");
  });
});

describe("getAdminSeatPurchase", () => {
  it("sells paid teams the live extra-seat product at its live price", () => {
    expect(getAdminSeatPurchase({ hasPaidPlan: true })).toMatchInlineSnapshot(`
      {
        "buttonLabel": "Add seat ($49/mo)",
        "description": "Add an extra seat for $49/month to invite another dashboard admin.",
        "productId": "extra-seat",
      }
    `);
  });

  it("sends free teams to the Team plan", () => {
    expect(getAdminSeatPurchase({ hasPaidPlan: false })).toMatchInlineSnapshot(`
      {
        "buttonLabel": "Upgrade plan",
        "description": "Upgrade your plan to invite more dashboard admins.",
        "productId": "team",
      }
    `);
  });
});

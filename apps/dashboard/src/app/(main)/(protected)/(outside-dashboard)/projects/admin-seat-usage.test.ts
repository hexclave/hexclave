import { describe, expect, it } from "vitest";
import { formatAdminSeatUsage } from "./admin-seat-usage";

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

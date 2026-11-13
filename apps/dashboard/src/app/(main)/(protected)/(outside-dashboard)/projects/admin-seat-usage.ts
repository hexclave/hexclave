import { EXTRA_SEAT_MONTHLY_PRICE_USD, EXTRA_SEAT_PRODUCT_ID } from "@hexclave/shared/dist/plans";

/**
 * The seat limit comes from the team's `dashboard_admins` item, which reads 0 for a free team that has no
 * subscription row in Bulldozer. While plan limits are off that number is meaningless and nothing enforces it, so
 * we show only the count: otherwise the dialog would display a nonsensical "1/0" next to a working Invite button.
 */
export function formatAdminSeatUsage(options: { activeSeats: number, seatLimit: number, arePlanLimitsEnforced: boolean }): string {
  return options.arePlanLimitsEnforced ? `${options.activeSeats}/${options.seatLimit}` : `${options.activeSeats}`;
}

/**
 * What the invite dialog sells a team that has no admin seats left: paid teams
 * buy one more seat, free teams upgrade to Team (which includes more seats).
 * The ids are the internal project's products; the labels show the price
 * those products charge.
 */
export function getAdminSeatPurchase(options: { hasPaidPlan: boolean }): { productId: string, buttonLabel: string, description: string } {
  if (options.hasPaidPlan) {
    return {
      productId: EXTRA_SEAT_PRODUCT_ID,
      buttonLabel: `Add seat ($${EXTRA_SEAT_MONTHLY_PRICE_USD}/mo)`,
      description: `Add an extra seat for $${EXTRA_SEAT_MONTHLY_PRICE_USD}/month to invite another dashboard admin.`,
    };
  }
  return {
    productId: "team",
    buttonLabel: "Upgrade plan",
    description: "Upgrade your plan to invite more dashboard admins.",
  };
}

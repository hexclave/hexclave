/**
 * The seat limit comes from the team's `dashboard_admins` item, which reads 0 for a free team that has no
 * subscription row in Bulldozer. While plan limits are off that number is meaningless and nothing enforces it, so
 * we show only the count: otherwise the dialog would display a nonsensical "1/0" next to a working Invite button.
 */
export function formatAdminSeatUsage(options: { activeSeats: number, seatLimit: number, arePlanLimitsEnforced: boolean }): string {
  return options.arePlanLimitsEnforced ? `${options.activeSeats}/${options.seatLimit}` : `${options.activeSeats}`;
}

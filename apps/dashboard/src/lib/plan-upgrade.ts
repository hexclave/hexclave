import { PLAN_DISPLAY_NAMES, PLAN_LIMITS, PLAN_MONTHLY_PRICES_USD, isPaidPlanId, type PaidPlanId } from "@hexclave/shared/dist/plans";

/**
 * The minimal team shape needed to start a Hexclave plan checkout. Structural
 * so callers can pass the dashboard's `Team` objects as well as test doubles.
 */
export type PlanCheckoutTeam = {
  createCheckoutUrl: (options: { productId: string, returnUrl: string }) => Promise<string>,
};

/**
 * Label of the button that starts checkout for `planId`, e.g.
 * "Upgrade to Team — $49/mo".
 */
export function getPlanUpgradeLabel(planId: PaidPlanId): string {
  return `Upgrade to ${PLAN_DISPLAY_NAMES[planId]} — $${PLAN_MONTHLY_PRICES_USD[planId]}/mo`;
}

/**
 * One line naming what `planId` adds, built from `PLAN_LIMITS` so it never
 * drifts from the quotas the plan actually grants.
 */
export function getPlanUpgradeSummary(planId: PaidPlanId): string {
  const limits = PLAN_LIMITS[planId];
  const format = (value: number) => new Intl.NumberFormat("en-US").format(value);
  return `${PLAN_DISPLAY_NAMES[planId]} gives you ${format(limits.seats)} dashboard admins, ${format(limits.authUsers)} auth users, ${format(limits.emailsPerMonth)} emails a month, ${format(limits.analyticsTimeoutSeconds)}s analytics queries, and an onboarding call.`;
}

/**
 * Creates a checkout for `planId` (the product of the same id in the internal
 * project's payments config) and sends the browser there.
 */
export async function startPlanCheckout(options: {
  team: PlanCheckoutTeam,
  planId: PaidPlanId,
  returnUrl: string,
}): Promise<void> {
  const checkoutUrl = await options.team.createCheckoutUrl({
    productId: options.planId,
    returnUrl: options.returnUrl,
  });
  window.location.assign(checkoutUrl);
}

/**
 * Reads the `plan` query parameter of `/upgrade`. Anything that isn't a paid
 * plan id falls back to Team, the plan most developers start with.
 */
export function parseTargetPlanId(planParam: string | null): PaidPlanId {
  return planParam != null && isPaidPlanId(planParam) ? planParam : "team";
}

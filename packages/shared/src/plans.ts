/**
 * Plan configuration for Hexclave pricing tiers.
 *
 * This file defines the limits for each plan and the item IDs used to track them.
 * Import these constants in seed.ts and backend code for limit enforcement.
 */

export const UNLIMITED = 1_000_000_000;

/**
 * Item IDs used across the codebase for tracking plan limits.
 */
export const ITEM_IDS = {
  seats: "dashboard_admins",
  authUsers: "auth_users",
  emailsPerMonth: "emails_per_month",
  analyticsTimeoutSeconds: "analytics_timeout_seconds",
  analyticsEvents: "analytics_events",
  sessionReplays: "session_replays",
  onboardingCall: "onboarding_call",
} as const;

export type ItemId = typeof ITEM_IDS[keyof typeof ITEM_IDS];

/**
 * The offerings/limits included in a plan.
 */
export type PlanProductOfferings = {
  seats: number,
  authUsers: number,
  emailsPerMonth: number,
  analyticsTimeoutSeconds: number,
  analyticsEvents: number,
  sessionReplays: number,
};

/**
 * Plan limits by plan ID.
 */
export const PLAN_LIMITS: {
  free: PlanProductOfferings,
  team: PlanProductOfferings,
  growth: PlanProductOfferings,
} = {
  free: {
    seats: 1,
    authUsers: 10_000,
    emailsPerMonth: 1_000,
    analyticsTimeoutSeconds: 10,
    analyticsEvents: 100_000,
    sessionReplays: 2_500,
  },
  team: {
    seats: 4,
    authUsers: 50_000,
    emailsPerMonth: 25_000,
    analyticsTimeoutSeconds: 60,
    analyticsEvents: 500_000,
    sessionReplays: 2_500,
  },
  growth: {
    seats: 4,
    authUsers: UNLIMITED,
    emailsPerMonth: 25_000,
    analyticsTimeoutSeconds: 300,
    analyticsEvents: 1_000_000,
    sessionReplays: 2_500,
  },
};

export type PlanId = keyof typeof PLAN_LIMITS;

/**
 * Base plan IDs ordered from highest to lowest tier. Use this (instead of
 * string literals) whenever code needs to pick a customer's "current" plan
 * from their product list, so the choice stays in sync with `PLAN_LIMITS`.
 */
export const BASE_PLAN_IDS_BY_TIER = ["growth", "team", "free"] as const satisfies readonly PlanId[];

/**
 * Minimal shape of a product entry as it comes out of `team.useProducts()` /
 * `customer.useProducts()` on both the SDK and dashboard sides. Structural so
 * we don't pull SDK types into `stack-shared`.
 */
type PlanResolutionProduct = { id: string | null, type?: string };

/**
 * Picks the customer's highest-tier active base plan (growth → team → free),
 * falling back to `"free"` if none of the known plans appear as a
 * subscription. Single source of truth for plan gating in the dashboard —
 * do not reintroduce ad-hoc `p.id === "team" || p.id === "growth"` checks.
 */
export function resolvePlanId(products: ReadonlyArray<PlanResolutionProduct>): PlanId {
  const activeSubscriptionPlanIds = new Set(
    products.filter(p => p.type === "subscription" && p.id != null).map(p => p.id),
  );
  return BASE_PLAN_IDS_BY_TIER.find(id => activeSubscriptionPlanIds.has(id)) ?? "free";
}

/**
 * Convenience predicate for "is this customer on a paid plan?". Anything
 * above free counts, so new paid tiers added to `PLAN_LIMITS` are picked up
 * automatically.
 */
export function isPaidPlan(products: ReadonlyArray<PlanResolutionProduct>): boolean {
  return resolvePlanId(products) !== "free";
}

export type PaidPlanId = Exclude<PlanId, "free">;

/**
 * Monthly USD list price of each paid plan: the `monthly` price of the
 * internal project's `team` / `growth` products. The seed uses these, and
 * production's payments config matches them; the dashboard shows them on
 * upgrade buttons, and the checkout page always charges whatever the live
 * product config says.
 */
export const PLAN_MONTHLY_PRICES_USD: Record<PaidPlanId, number> = {
  team: 49,
  growth: 299,
};

export const PLAN_DISPLAY_NAMES: Record<PlanId, string> = {
  free: "Free",
  team: "Team",
  growth: "Growth",
};

export function isPaidPlanId(value: string): value is PaidPlanId {
  return value === "team" || value === "growth";
}

/**
 * Whether a team on `currentPlanId` would gain anything by buying `targetPlanId`.
 */
export function isPlanUpgrade(currentPlanId: PlanId, targetPlanId: PaidPlanId): boolean {
  return BASE_PLAN_IDS_BY_TIER.indexOf(targetPlanId) < BASE_PLAN_IDS_BY_TIER.indexOf(currentPlanId);
}

import { isActiveSubscription } from "@/lib/payments";
import { getItemQuantityForCustomer, getSubscriptionMapForCustomer } from "@/lib/payments/customer-data";
import { getPrismaClientForTenancy, globalPrismaClient, type PrismaClientTransaction } from "@/prisma-client";
import { BASE_PLAN_IDS_BY_TIER, ITEM_IDS, type PlanId } from "@hexclave/shared/dist/plans";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch, type Tenancy } from "./tenancies";

/**
 * Whether Hexclave's own plan-limit enforcement (quotas like `analytics_events`,
 * `session_replays`, `emails_per_month`, the `auth_users` soft cap, and the
 * `dashboard_admins` seat check) should be enforced for billing teams in the
 * internal tenancy.
 *
 * Setting `STACK_DISABLE_PLAN_LIMITS=true` short-circuits every enforcement
 * site BEFORE the underlying `getItem` lookup, so missing item config (e.g.
 * a deploy where the internal tenancy hasn't been migrated to include the
 * new items yet) cannot cascade into 500s either.
 *
 * Intended as a temporary cutover safety net while the plan-limits
 * infrastructure rolls out to prod; the flag should be removed once we trust
 * enforcement to behave correctly in every environment.
 *
 * Customer projects' own item APIs (`/payments/items/.../update-quantity`)
 * are unaffected by this flag.
 */
export function arePlanLimitsEnforced(): boolean {
  return getEnvVariable("STACK_DISABLE_PLAN_LIMITS", "false") !== "true";
}

type GlobalPrismaLike = {
  project: {
    findMany: (args: { where: { ownerTeamId: string }, select: { id: true } }) => Promise<Array<{ id: string }>>,
  },
  tenancy: {
    findMany: (args: { where: { projectId: { in: string[] } }, select: { id: true } }) => Promise<Array<{ id: string }>>,
  },
  projectUser: {
    count: (args: { where: { tenancyId: { in: string[] }, isAnonymous: boolean } }) => Promise<number>,
  },
};

type OwnedBillingScope = {
  projectIds: string[],
  tenancyIds: string[],
};

type ItemCapacityReaders = {
  getPrismaForTenancy: (tenancy: Tenancy) => Promise<PrismaClientTransaction>,
  getItemQuantityForCustomer: (options: {
    prisma: PrismaClientTransaction,
    tenancyId: string,
    customerId: string,
    customerType: "team",
    itemId: string,
  }) => Promise<number>,
};

const TEAM_WIDE_CAPACITY_ITEM_IDS = new Set<string>([
  ITEM_IDS.authUsers,
  ITEM_IDS.seats,
]);

/**
 * Sentinel "no effective limit" capacity used when a bulldozer outage forces us
 * to skip an entitlement check (see `getTeamWideItemCapacity`). A large finite
 * number rather than `Infinity` on purpose: capacities flow into `usage > cap`
 * comparisons and into Sentry detail objects, and `Infinity` JSON-serializes to
 * `null` and yields `NaN` under subtraction — a finite sentinel avoids both.
 */
export const UNLIMITED_ITEM_CAPACITY = Number.MAX_SAFE_INTEGER;

export function getBillingTeamId(project: { id: string, ownerTeamId?: string | null, owner_team_id?: string | null }): string | null {
  return project.ownerTeamId ?? project.owner_team_id ?? null;
}

async function getInternalBillingTenancy(): Promise<Tenancy> {
  const tenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID, true);
  if (tenancy == null) {
    throw new HexclaveAssertionError("Internal billing tenancy not found", {
      billingProjectId: "internal",
      branchId: DEFAULT_BRANCH_ID,
    });
  }
  return tenancy;
}

export async function getOwnedProjectIdsForBillingTeam(
  billingTeamId: string,
  globalPrisma: GlobalPrismaLike = globalPrismaClient,
): Promise<string[]> {
  const projects = await globalPrisma.project.findMany({
    where: {
      ownerTeamId: billingTeamId,
    },
    select: {
      id: true,
    },
  });
  return projects.map((project) => project.id);
}

export async function getOwnedProjectAndTenancyIdsForBillingTeam(
  billingTeamId: string,
  globalPrisma: GlobalPrismaLike = globalPrismaClient,
): Promise<OwnedBillingScope> {
  const projectIds = await getOwnedProjectIdsForBillingTeam(billingTeamId, globalPrisma);
  if (projectIds.length === 0) {
    return {
      projectIds,
      tenancyIds: [],
    };
  }
  const tenancies = await globalPrisma.tenancy.findMany({
    where: {
      projectId: {
        in: projectIds,
      },
    },
    select: {
      id: true,
    },
  });
  return {
    projectIds,
    tenancyIds: tenancies.map((tenancy) => tenancy.id),
  };
}

export async function getOwnedTenancyIdsForBillingTeam(
  billingTeamId: string,
  globalPrisma: GlobalPrismaLike = globalPrismaClient,
): Promise<string[]> {
  return (await getOwnedProjectAndTenancyIdsForBillingTeam(billingTeamId, globalPrisma)).tenancyIds;
}

export async function getNonAnonymousUserCountForTenancies(
  tenancyIds: string[],
  globalPrisma: GlobalPrismaLike = globalPrismaClient,
): Promise<number> {
  if (tenancyIds.length === 0) {
    return 0;
  }
  return await globalPrisma.projectUser.count({
    where: {
      tenancyId: {
        in: tenancyIds,
      },
      isAnonymous: false,
    },
  });
}

export async function getTeamWideNonAnonymousUserCount(
  billingTeamId: string,
  globalPrisma: GlobalPrismaLike = globalPrismaClient,
): Promise<number> {
  // Usage metric: how many non-anonymous users are currently consumed by this billing team.
  // This is compared against auth user capacity to determine over-limit conditions.
  const tenancyIds = await getOwnedTenancyIdsForBillingTeam(billingTeamId, globalPrisma);
  return await getNonAnonymousUserCountForTenancies(tenancyIds, globalPrisma);
}

async function getTeamWideItemCapacity(
  billingTeamId: string,
  itemId: string,
  readers: ItemCapacityReaders = {
    getPrismaForTenancy: getPrismaClientForTenancy,
    getItemQuantityForCustomer: async (readerOptions) => (
      await getItemQuantityForCustomer(readerOptions as Parameters<typeof getItemQuantityForCustomer>[0])
    ),
  },
): Promise<number> {
  // Capacity metric: entitlement from Hexclave payments for a specific item.
  if (!TEAM_WIDE_CAPACITY_ITEM_IDS.has(itemId)) {
    throw new HexclaveAssertionError("Unsupported team-wide capacity item id", { itemId });
  }
  const internalBillingTenancy = await getInternalBillingTenancy();
  const billingPrisma = await readers.getPrismaForTenancy(internalBillingTenancy);
  try {
    return await readers.getItemQuantityForCustomer({
      prisma: billingPrisma,
      tenancyId: internalBillingTenancy.id,
      customerId: billingTeamId,
      customerType: "team",
      itemId,
    });
  } catch (error) {
    // Bulldozer is the only source for this capacity, but it must not be a hard
    // dependency for the flows that read it (auth sign-ups via auth-user caps,
    // team invites via seat checks). If bulldozer is unreachable, report it and
    // treat capacity as unlimited so the gated flow isn't blocked by a bulldozer
    // outage — the cap is re-enforced on the next request once bulldozer is back.
    captureError("plan-entitlements:team-wide-item-capacity", error);
    return UNLIMITED_ITEM_CAPACITY;
  }
}

export async function getTeamWideItemCapacityForTests(
  billingTeamId: string,
  itemId: string,
  readers: ItemCapacityReaders,
): Promise<number> {
  return await getTeamWideItemCapacity(billingTeamId, itemId, readers);
}

export async function getTeamWideAuthUsersCapacity(
  billingTeamId: string,
): Promise<number> {
  return await getTeamWideItemCapacity(billingTeamId, ITEM_IDS.authUsers);
}

export async function getTeamWideDashboardAdminsCapacity(
  billingTeamId: string,
): Promise<number> {
  return await getTeamWideItemCapacity(billingTeamId, ITEM_IDS.seats);
}

export async function getTeamWideAuthUsersCapacityForProjectTenancy(
  projectTenancy: Tenancy,
): Promise<number> {
  const billingTeamId = getBillingTeamId(projectTenancy.project);
  if (billingTeamId == null) {
    throw new HexclaveAssertionError("Project owner team missing; cannot resolve billing team", {
      projectId: projectTenancy.project.id,
    });
  }
  return await getTeamWideAuthUsersCapacity(billingTeamId);
}

/**
 * The base plan a project's billing team is on, or null when no plan gate
 * should apply to it.
 *
 * A lightweight sibling of `getPlanUsageForProject` in ./plan-usage: that one
 * exists to RENDER the usage page and counts users, emails and analytics
 * events to do it. Gates that only need the tier shouldn't pay for any of it.
 *
 * Null — meaning "do not gate this project" — in three cases, all of which
 * must fail OPEN:
 *
 *   - Plan limits are disabled (`STACK_DISABLE_PLAN_LIMITS`, read by
 *     `arePlanLimitsEnforced()`). This is the intended escape hatch for
 *     self-hosted instances, which are not billed by Hexclave at all.
 *   - The project has no owner team. Note this is NOT what protects
 *     self-hosters: projects created through the internal projects API get an
 *     `ownerTeamId` on every deployment, self-hosted included, so a self-hosted
 *     project WILL resolve to "free" if bulldozer is reachable. Today that is
 *     masked only because the self-host stack ships no bulldozer, which makes
 *     the read fail and land in the catch below. Use the flag above.
 *   - The plan could not be read. Bulldozer (the subscription store) is not a
 *     hard dependency of the flows that gate on plans, so an outage must not
 *     start refusing requests. Mirrors how `getTeamWideItemCapacity` degrades
 *     to unlimited capacity. This also swallows a misconfigured internal
 *     tenancy (`getInternalBillingTenancy` asserting), which would disable the
 *     gate persistently behind a single captured error — acceptable, because
 *     the alternative is refusing every deploy.
 *
 * A team with no active base subscription but a real billing team DOES resolve
 * to "free" — that is the actual free tier, and gating it is the point.
 *
 * NOTE the deliberate divergence from `readBillingSubscriptionMapOrSkip` in
 * ./plan-usage: that one degrades a bulldozer outage to `{}`, which resolves to
 * "free" (fail CLOSED, so the usage page under-reports rather than 500s). This
 * one fails OPEN. During the same outage the usage page may show a paying
 * customer as Free while this gate stops enforcing Free — intended in both
 * directions, since neither should turn an outage into a user-facing block.
 */
export async function getPlanIdForProjectOrNull(project: { id: string, ownerTeamId?: string | null, owner_team_id?: string | null }): Promise<PlanId | null> {
  if (!arePlanLimitsEnforced()) return null;
  const billingTeamId = getBillingTeamId(project);
  if (billingTeamId == null) return null;
  try {
    const internalBillingTenancy = await getInternalBillingTenancy();
    const billingPrisma = await getPrismaClientForTenancy(internalBillingTenancy);
    const subscriptions = await getSubscriptionMapForCustomer({
      prisma: billingPrisma,
      tenancyId: internalBillingTenancy.id,
      customerType: "team",
      customerId: billingTeamId,
    });
    const active = Object.values(subscriptions).filter(isActiveSubscription);
    // BASE_PLAN_IDS_BY_TIER is ordered highest-tier-first, so a team holding
    // several base subscriptions resolves to the most generous one.
    for (const planId of BASE_PLAN_IDS_BY_TIER) {
      if (active.some((subscription) => subscription.productId === planId)) return planId;
    }
    return "free";
  } catch (error) {
    captureError("plan-entitlements:plan-id-unavailable", error);
    return null;
  }
}

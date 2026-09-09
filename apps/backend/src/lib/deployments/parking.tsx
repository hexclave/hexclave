// The Free plan's 24-hour deployment limit.
//
// A Free-plan project's services run for a fixed window after each deploy and are
// then PARKED: stopped, with the platform's parked page served in their place on
// every hostname they hold (see parkService in apps/marshal/src/services.ts, and
// apps/deployment-parked-page for what a visitor sees). Redeploying restarts the
// window; upgrading to a paid plan lifts it and unparks whatever is parked.
//
// This closes the gap assertServicesAllowedByPlan's doc comment names: that gate
// refuses a Free project's always-on DEPLOY, but nothing until now stopped a Free
// project from deploying something ordinary and leaving it running forever.
//
// Everything here is a sweep rather than a scheduled action per service. There is
// no timer to lose, no job row to leak, and a service that should be parked and
// is not gets parked on the next tick whatever went wrong on the last one — which
// is the same reason the reverse direction (unparking after an upgrade) is a
// sweep too, rather than a hook on the billing webhook.

import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { arePlanLimitsEnforced, getPlanIdForProjectOrNull } from "@/lib/plan-entitlements";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { getMarshalClientOrThrow, getMarshalDeploymentsConfigOrNull } from "./marshal-client";
import { getDeploymentsPlatformConfig } from "./platform-config";
import { marshalNamespaceForTenancy } from "./index";

/**
 * Why a service parked by this sweeper is parked.
 *
 * Written to DeploymentService.parkedReason, passed to Marshal, and from there to
 * the parked page, which picks its copy from it. It is also what the reverse
 * sweep matches on, so a service parked for some OTHER reason later (a platform
 * pause, an abuse suspension) is never unparked by an upgrade.
 */
export const FREE_PLAN_PARK_REASON = "free_plan_24h";

/**
 * How many services one tick may act on, per direction.
 *
 * Parking is an apply per service — it rolls machines exactly the way a deploy
 * does — so an unbounded tick would be a fleet-wide rollout in one HTTP request.
 * The sweep is ordered oldest-first and runs every few minutes, so a backlog
 * drains over a handful of ticks instead of one very long one.
 */
export const MAX_SERVICES_PER_SWEEP = 25;

export type ParkingSweepSummary = {
  // Null when the sweep ran. Otherwise why it did nothing, which is the only
  // thing an operator reading the cron's response wants from a quiet tick.
  skipped: "parking_disabled" | "plan_limits_not_enforced" | "runtime_not_configured" | null,
  parked: number,
  unparked: number,
  failed: number,
};

type CandidateRow = {
  tenancyId: string,
  serviceId: string,
  runningSince: Date | null,
  provisionedAt: Date | null,
};

/**
 * When a service's window started.
 *
 * `runningSince` is written by every successful deploy. It is null on rows that
 * were already deployed when the column shipped, and those fall back to
 * `provisionedAt` — the moment the service first reached the runtime. That
 * fallback is what makes a backfill unnecessary: without it, existing rows would
 * either be exempt forever (null sorts as "no limit") or parked on the very first
 * tick, and both are wrong.
 *
 * Null from BOTH — a row that was never provisioned — is not a candidate at all;
 * the query already excludes it, and this returning null keeps that true if the
 * query ever loosens.
 */
export function windowStartedAt(row: Pick<CandidateRow, "runningSince" | "provisionedAt">): Date | null {
  return row.runningSince ?? row.provisionedAt ?? null;
}

/**
 * Which candidate rows have outlived the limit. Pure, so the rule is testable
 * without a database, a plan, or a runtime.
 */
export function servicesPastFreePlanLimit<T extends Pick<CandidateRow, "runningSince" | "provisionedAt">>(
  rows: T[],
  options: { now: Date, parkAfterHours: number },
): T[] {
  const cutoff = options.now.getTime() - options.parkAfterHours * 60 * 60 * 1000;
  return rows.filter((row) => {
    const startedAt = windowStartedAt(row);
    return startedAt !== null && startedAt.getTime() <= cutoff;
  });
}

/**
 * Whether a project on this plan should have its services parked by this sweeper.
 *
 * Null is the plan of a project that is not plan-gated at all (self-hosted, plan
 * limits disabled) or whose plan could not be read (the billing store was
 * unreachable). All of those FAIL OPEN — exactly as assertServicesAllowedByPlan
 * fails open on the same value — because a billing outage must never stop
 * customers' running services. It is the one direction of this feature that
 * cannot be undone by trying again later.
 */
export function planShouldBeParked(planId: string | null): boolean {
  return planId === "free";
}

/**
 * What to tell a project's author, at deploy time, about the window their new
 * deployment has. Null when there is nothing to say.
 *
 * Said on the way IN rather than only discovered on the way out. A limit nobody
 * was told about reads as an outage, and the difference between "Hexclave broke
 * my site" and "my site is on the free tier" is entirely whether this line was
 * printed 24 hours earlier.
 *
 * Best-effort by construction: it fails open to silence (an unreadable plan says
 * nothing), because a deploy must never fail over a message about a deploy.
 */
export async function freePlanDeployNoticeOrNull(project: { id: string, ownerTeamId?: string | null, owner_team_id?: string | null }): Promise<string | null> {
  if (!arePlanLimitsEnforced()) return null;
  const config = await getDeploymentsPlatformConfig();
  if (!config.freePlanParkingEnabled) return null;
  if (!planShouldBeParked(await getPlanIdForProjectOrNull(project))) return null;
  const hours = config.freePlanParkAfterHours;
  return [
    `On the Free plan this deployment stops running after ${hours} ${hours === 1 ? "hour" : "hours"}, and visitors then see a page saying the site is unavailable.`,
    "Deploy again to restart it, or upgrade to the Team plan at https://app.hexclave.com/projects/-selector-/project-settings/usage to remove the limit.",
  ].join("\n");
}

/**
 * One pass: park what has outlived the limit, unpark what has been upgraded.
 *
 * Reads candidates from the GLOBAL database across every tenancy, and shares the
 * known limitation of every other cross-tenant deployments read (see
 * platform-stats.tsx): a tenancy whose config names its own `sourceOfTruth` keeps
 * its rows elsewhere and is invisible here. Writes go through the TENANCY's own
 * client, so if such a tenancy ever does become visible the write lands in the
 * right database.
 */
export async function sweepFreePlanParking(options?: { now?: Date }): Promise<ParkingSweepSummary> {
  const now = options?.now ?? new Date();
  const empty = { parked: 0, unparked: 0, failed: 0 };

  // A self-hoster runs no plans, and an instance with limits disabled has opted
  // out of exactly this kind of enforcement.
  if (!arePlanLimitsEnforced()) return { skipped: "plan_limits_not_enforced", ...empty };
  // No Marshal, no services to park — and getMarshalClientOrThrow would 400.
  if (getMarshalDeploymentsConfigOrNull() == null) return { skipped: "runtime_not_configured", ...empty };
  const config = await getDeploymentsPlatformConfig();
  if (!config.freePlanParkingEnabled) return { skipped: "parking_disabled", ...empty };

  const parked = await parkExpiredFreePlanServices({ now, parkAfterHours: config.freePlanParkAfterHours });
  const unparked = await unparkUpgradedProjects();
  return {
    skipped: null,
    parked: parked.acted,
    unparked: unparked.acted,
    failed: parked.failed + unparked.failed,
  };
}

/**
 * Parks the services of Free-plan projects whose window has closed.
 *
 * The plan is read once per TENANCY rather than once per service: a project's
 * services are parked as a unit, which is not merely an optimization. Services
 * reference each other through `{ref}` connection env vars, so parking one and
 * leaving its sibling running would leave a live service with a dead dependency —
 * a harder failure to understand than the whole project stopping, and one the
 * parked page could not explain because the broken service is not the parked one.
 */
async function parkExpiredFreePlanServices(options: { now: Date, parkAfterHours: number }): Promise<{ acted: number, failed: number }> {
  const candidates = await globalPrismaClient.deploymentService.findMany({
    where: { provisionedAt: { not: null }, parkedAt: null },
    select: { tenancyId: true, serviceId: true, runningSince: true, provisionedAt: true },
    // Oldest window first, so a backlog drains in the order it built up rather
    // than starving whichever project happens to sort last.
    orderBy: [{ runningSince: { sort: "asc", nulls: "first" } }, { provisionedAt: "asc" }],
    // Read more than a tick will act on: most candidates are filtered out here by
    // the clock, and taking exactly MAX_SERVICES_PER_SWEEP rows would let a page
    // of not-yet-expired services hide the expired ones behind them.
    take: MAX_SERVICES_PER_SWEEP * 20,
  });
  const expired = servicesPastFreePlanLimit(candidates, options);
  return await actOnCandidates(expired, {
    shouldAct: planShouldBeParked,
    act: async (tenancy, serviceIds) => await parkServices(tenancy, serviceIds),
  });
}

/**
 * Unparks the services of projects that are no longer on the Free plan.
 *
 * This is how an upgrade takes effect. A sweep rather than a hook on the checkout
 * or the billing webhook: those fire once and can be missed, while this converges
 * within a tick of whatever the billing store says — including for a project that
 * was upgraded while this instance was down.
 *
 * Only rows parked by THIS sweeper are considered. A service parked for another
 * reason has nothing to do with the customer's plan, and paying should not lift
 * it.
 */
async function unparkUpgradedProjects(): Promise<{ acted: number, failed: number }> {
  const candidates = await globalPrismaClient.deploymentService.findMany({
    where: { parkedAt: { not: null }, parkedReason: FREE_PLAN_PARK_REASON },
    select: { tenancyId: true, serviceId: true, runningSince: true, provisionedAt: true },
    orderBy: { parkedAt: "asc" },
    take: MAX_SERVICES_PER_SWEEP * 20,
  });
  return await actOnCandidates(candidates, {
    // Anything that is not the Free plan gets its services back — INCLUDING the
    // null that means "no plan could be read". Failing open in this direction is
    // the same choice made when parking, seen from the other side: a billing
    // outage un-stops services rather than keeping them stopped.
    shouldAct: (planId) => !planShouldBeParked(planId),
    act: async (tenancy, serviceIds) => await unparkServices(tenancy, serviceIds),
  });
}

/**
 * Groups candidates by tenancy, reads each one's plan once, and acts on the
 * tenancies that qualify — up to the per-tick cap.
 *
 * Per tenancy rather than per service throughout: the plan read is the expensive
 * part, and acting on a project by halves is the failure mode this whole module
 * is shaped to avoid.
 */
async function actOnCandidates(
  candidates: CandidateRow[],
  options: {
    shouldAct: (planId: string | null) => boolean,
    act: (tenancy: Tenancy, serviceIds: string[]) => Promise<{ acted: number, failed: number }>,
  },
): Promise<{ acted: number, failed: number }> {
  const byTenancy = new Map<string, string[]>();
  for (const candidate of candidates) {
    const existing = byTenancy.get(candidate.tenancyId);
    if (existing === undefined) byTenancy.set(candidate.tenancyId, [candidate.serviceId]);
    else existing.push(candidate.serviceId);
  }

  let acted = 0;
  let failed = 0;
  for (const [tenancyId, serviceIds] of byTenancy) {
    // Checked between tenancies, never inside one: a tenancy with more services
    // than the remaining budget is finished rather than split, because a project
    // parked by halves is the state this module exists to avoid. So the cap is a
    // floor on how much work a tick does, not a ceiling.
    if (acted + failed >= MAX_SERVICES_PER_SWEEP) break;
    try {
      const tenancy = await getTenancy(tenancyId);
      // A tenancy that has been deleted out from under its deployment rows. Its
      // services are Marshal's problem (the delete path tears them down), not
      // this sweep's.
      if (tenancy === null) continue;
      if (!options.shouldAct(await getPlanIdForProjectOrNull(tenancy.project))) continue;
      const result = await options.act(tenancy, serviceIds);
      acted += result.acted;
      failed += result.failed;
    } catch (error) {
      // One project's failure must not end the tick: the next tenancy in this
      // pass is unrelated, and the next tick retries this one.
      failed += 1;
      captureError("deployments-parking-sweep-tenancy", error);
    }
  }
  return { acted, failed };
}

async function parkServices(tenancy: Tenancy, serviceIds: string[]): Promise<{ acted: number, failed: number }> {
  const client = getMarshalClientOrThrow();
  const prisma = await getPrismaClientForTenancy(tenancy);
  const ns = marshalNamespaceForTenancy(tenancy);
  let acted = 0;
  let failed = 0;
  for (const serviceId of serviceIds) {
    try {
      await client.parkService(ns, serviceId, FREE_PLAN_PARK_REASON);
      // Recorded only after the runtime accepted it. The other order would let a
      // failed park read as a stopped service in the dashboard, and the next tick
      // would skip it because the row already said it was parked.
      await prisma.deploymentService.updateMany({
        where: { tenancyId: tenancy.id, serviceId },
        data: { parkedAt: new Date(), parkedReason: FREE_PLAN_PARK_REASON },
      });
      acted += 1;
    } catch (error) {
      failed += 1;
      captureError("deployments-parking-park-failed", error);
    }
  }
  return { acted, failed };
}

async function unparkServices(tenancy: Tenancy, serviceIds: string[]): Promise<{ acted: number, failed: number }> {
  const client = getMarshalClientOrThrow();
  const prisma = await getPrismaClientForTenancy(tenancy);
  const ns = marshalNamespaceForTenancy(tenancy);
  let acted = 0;
  let failed = 0;
  for (const serviceId of serviceIds) {
    try {
      await client.unparkService(ns, serviceId);
      // `runningSince` moves with it: unparking is the moment this service went
      // back to running the tenant's own image, which is what the column records.
      // It also means a project that upgrades and later downgrades gets a fresh
      // window rather than being parked again the instant it stops paying.
      await prisma.deploymentService.updateMany({
        where: { tenancyId: tenancy.id, serviceId },
        data: { parkedAt: null, parkedReason: null, runningSince: new Date() },
      });
      acted += 1;
    } catch (error) {
      failed += 1;
      captureError("deployments-parking-unpark-failed", error);
    }
  }
  return { acted, failed };
}

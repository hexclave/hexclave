// The Free plan's 24-hour deployment limit.
//
// A Free-plan project's services run for a fixed window after each deploy and are
// then PARKED: stopped, with the platform's parked page served in their place on
// every hostname they hold (see parkService in apps/marshal/src/services.ts, and
// apps/deployment-gateway/parked-page for what a visitor sees). Redeploying restarts
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
import { HexclaveAssertionError, captureError } from "@hexclave/shared/dist/utils/errors";
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
  // Null when the whole sweep ran. Otherwise why it did nothing, which is the
  // only thing an operator reading the cron's response wants from a quiet tick.
  //
  // "parking_paused" is the one value that does NOT mean a quiet tick: it says
  // the PARK half was skipped, while the unpark half ran and its counts below
  // are real. See sweepFreePlanParking for why the switch only gates one
  // direction.
  skipped: "parking_paused" | "plan_limits_not_enforced" | "runtime_not_configured" | null,
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
 * When a service's window started, or null when it has none and is never parked.
 *
 * `runningSince` is written by every successful deploy, and ONLY by a deploy. It
 * is null on every row that was already deployed when the column shipped, and
 * that null is deliberately load-bearing: those services are grandfathered.
 *
 * This is what makes the limit apply to deployments made from here on rather than
 * retroactively. Turning it on otherwise would stop, within one sweep, every Free
 * -plan service whose last deploy was more than a day ago — which is most of
 * them, none of whose authors were ever told about a window.
 *
 * A grandfathered service opts in the moment it is redeployed, because that is
 * when `runningSince` is first written. So the exempt set only shrinks, and the
 * author who opts in is the one who just saw the deploy-time notice explaining
 * the limit. A project that never deploys again keeps running, which is the
 * accepted cost of not applying a new rule to work that predates it.
 */
export function windowStartedAt(row: Pick<CandidateRow, "runningSince">): Date | null {
  return row.runningSince ?? null;
}

/**
 * Which candidate rows have outlived the limit. Pure, so the rule is testable
 * without a database, a plan, or a runtime.
 */
export function servicesPastFreePlanLimit<T extends Pick<CandidateRow, "runningSince">>(
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
 * Whether a project's window has closed, given every service of it that is
 * running and could be parked.
 *
 * A project's window starts at its MOST RECENT deploy, and "every one of these
 * has expired" is how that is said in terms of the rows: max(runningSince) is
 * past the cutoff exactly when all of them are.
 *
 * The alternative — parking as soon as ANY service expires — breaks the promise
 * the feature makes. `hexclave deploy` and the dashboard both say a deploy
 * restarts the window, so a project whose sibling was deployed an hour ago would
 * be stopped anyway, minutes after its author deployed it. It buys nothing
 * either: redeploying already restarts the window by design, so anyone willing
 * to redeploy every window keeps a project running under either rule, and
 * whether they redeploy one service or all of them is immaterial.
 *
 * The consequence to know about is grandfathering. A service with no
 * `runningSince` has no window, so a project holding one never parks until that
 * service is redeployed — the exempt set drains per PROJECT, not per service.
 * That is the right way round: parking the project would stop a service that was
 * promised it would be left alone, and parking only its siblings is exactly the
 * half-parked project this rule exists to prevent.
 */
export function projectWindowClosed<T extends Pick<CandidateRow, "runningSince">>(
  rows: T[],
  options: { now: Date, parkAfterHours: number },
): boolean {
  return rows.length > 0 && servicesPastFreePlanLimit(rows, options).length === rows.length;
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

  // The switch gates the PARK direction ONLY, and the asymmetry is the point: a
  // switch that pauses enforcement must never pause the escape hatch from it.
  // Unparking is how an upgrade takes effect and the only automatic way back for
  // a service that is already stopped, so gating it here would strand a paying
  // customer's site until they happened to redeploy — while the Deploy Admin page
  // is on screen promising the opposite ("services already stopped stay stopped
  // until their projects redeploy or upgrade").
  const parked = config.freePlanParkingEnabled
    ? await parkExpiredFreePlanServices({ now, parkAfterHours: config.freePlanParkAfterHours })
    : { acted: 0, failed: 0 };
  const unparked = await unparkUpgradedProjects();
  return {
    skipped: config.freePlanParkingEnabled ? null : "parking_paused",
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
    // `runningSince: { not: null }` is the grandfathering, done in the query so
    // pre-existing rows are not even fetched: see windowStartedAt for why a null
    // there means this service has no window rather than an unknown one.
    where: { provisionedAt: { not: null }, parkedAt: null, runningSince: { not: null } },
    select: { tenancyId: true, serviceId: true, runningSince: true, provisionedAt: true },
    // Oldest window first, so a backlog drains in the order it built up rather
    // than starving whichever project happens to sort last.
    orderBy: { runningSince: "asc" },
    // Read more than a tick will act on: most candidates are filtered out here by
    // the clock, and taking exactly MAX_SERVICES_PER_SWEEP rows would let a page
    // of not-yet-expired services hide the expired ones behind them.
    take: MAX_SERVICES_PER_SWEEP * 20,
  });
  // The expired rows only say WHICH PROJECTS are worth looking at. Whether a
  // project's window has actually closed is a question about all of its
  // services, and this list holds only the expired ones — so the decision is
  // made per project in servicesToParkForTenancy, against a fresh read.
  const expired = servicesPastFreePlanLimit(candidates, options);
  return await actOnCandidates(expired, {
    shouldAct: planShouldBeParked,
    servicesFor: async (tenancy) => await servicesToParkForTenancy(tenancy, options),
    act: async (tenancy, serviceIds) => await parkServices(tenancy, serviceIds),
  });
}

/**
 * Every service of this project to park, or nothing if its window is still open.
 *
 * The re-read is what makes parking whole-project rather than per service. The
 * sweep's candidate query returns only rows whose own window has closed, so
 * grouping THOSE by project would park a project by halves the moment its
 * services were last deployed at different times — which two ordinary things
 * cause: a project with more than one deployment source, and a deploy in which
 * one service failed while its siblings went out.
 *
 * Scoped to provisioned, NOT-yet-parked services. Excluding the already-parked
 * ones is what keeps a project that was half-parked before this rule existed from
 * deadlocking: a parked sibling has no window to expire, and counting it would
 * block its siblings from ever being parked.
 */
async function servicesToParkForTenancy(tenancy: Tenancy, options: { now: Date, parkAfterHours: number }): Promise<string[]> {
  const rows = await globalPrismaClient.deploymentService.findMany({
    where: { tenancyId: tenancy.id, provisionedAt: { not: null }, parkedAt: null },
    select: { serviceId: true, runningSince: true },
  });
  if (!projectWindowClosed(rows, options)) return [];
  return rows.map((row) => row.serviceId);
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
    // Which of the tenancy's services to act on, when the candidate rows are only
    // a hint at that. The park direction re-reads the project here; the unpark
    // direction omits it, because "this row is parked" is already the whole
    // answer for the row in front of it.
    servicesFor?: (tenancy: Tenancy) => Promise<string[]>,
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
  for (const [tenancyId, candidateServiceIds] of byTenancy) {
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
      const serviceIds = options.servicesFor === undefined ? candidateServiceIds : await options.servicesFor(tenancy);
      // Nothing to do for this project after the closer look — its window is
      // still open because something was deployed more recently than whatever
      // put it on this list.
      if (serviceIds.length === 0) continue;
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
      const state = await client.parkService(ns, serviceId, FREE_PLAN_PARK_REASON);
      // A call that did not throw is NOT a park that happened. Marshal catches an
      // ordinary provider failure and answers 200 with a failed state rather than
      // an error, so the returned status is the only thing that says whether the
      // machines really run the parked page: serviceStateWith checks
      // `last_apply_error` BEFORE the park branch, so a park whose apply failed
      // reports "degraded" or "failed" with the park state still attached, and
      // "parked" is unambiguous.
      //
      // Erring towards NOT recording it is the safe direction, and the only one
      // that heals itself. The row keeps a null `parkedAt`, so it stays a
      // candidate and the next tick tries again — and Marshal re-applies rather
      // than trusting its own stored park state once `last_apply_error` is set.
      // Recording a park that did not happen is permanent in the other direction:
      // both candidate queries key off `parkedAt`, so the row would leave this
      // sweep for good with the tenant's app still serving.
      if (state.status !== "parked") {
        failed += 1;
        captureError("deployments-parking-park-not-applied", new HexclaveAssertionError(
          `Marshal accepted the park of service ${JSON.stringify(serviceId)} in namespace ${JSON.stringify(ns)} but reported status ${JSON.stringify(state.status)}, so the tenant's app is still running. Leaving the row unparked so the next sweep retries.`,
        ));
        continue;
      }
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
      const state = await client.unparkService(ns, serviceId);
      // The same asymmetry as parkServices, seen from the other side, and here
      // the park state alone cannot answer it: the apply CLEARS the park state
      // before it runs (claimDesiredSpec), so an unpark whose apply failed leaves
      // a spec that is no longer parked while the machines still serve the parked
      // page. The status is what separates the two.
      //
      // "degraded" is treated as a failure even though it is also what a healthy
      // rollout looks like before it is ready, because the two costs are not
      // comparable. Being wrong that way costs one more tick: the row keeps its
      // `parkedAt`, and on the next pass the service has settled and the write
      // commits then. Being wrong the other way strands a customer who has just
      // PAID on the parked page for good, because the row leaves the sweep.
      if (state.parked !== null || state.status === "failed" || state.status === "degraded") {
        failed += 1;
        captureError("deployments-parking-unpark-not-applied", new HexclaveAssertionError(
          `Marshal accepted the unpark of service ${JSON.stringify(serviceId)} in namespace ${JSON.stringify(ns)} but reported status ${JSON.stringify(state.status)}, so the parked page may still be serving. Leaving the row parked so the next sweep retries.`,
        ));
        continue;
      }
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

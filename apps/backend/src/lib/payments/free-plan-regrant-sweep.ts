import { CustomerType } from "@/generated/prisma/client";
import { ensureFreePlanForBillingTeam, getInternalBillingTenancy } from "@/lib/payments/ensure-free-plan";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { captureError } from "@hexclave/shared/dist/utils/errors";

/**
 * Regrants the free plan to internal billing teams whose last plan subscription
 * has just expired.
 *
 * Why this needs to exist at all: the free-plan regrant is otherwise entirely
 * event-driven. Canceling a subscription writes `endedAt` at the end of the
 * current period and calls `ensureFreePlanForBillingTeam` immediately — which
 * correctly no-ops, because the sub is still in effect until `endedAt`. For a
 * Stripe-backed sub the period-end transition then arrives as a webhook, and
 * `syncStripeSubscriptions` calls the regrant again at the right moment. A
 * non-Stripe sub (test-mode purchase, admin grant, or a switch to a $0 price)
 * emits no such event, so nothing ever fires at `endedAt` and the team is left
 * with no plan at all.
 *
 * That state is not merely cosmetic: `emails_per_month`, `analytics_events` and
 * `session_replays` are enforced against Bulldozer item quantities and reject
 * outright at zero, so an orphaned team loses analytics ingestion, session
 * replays and email delivery until someone notices.
 *
 * This sweep is the timer that the non-Stripe path lacks. It deliberately does
 * NOT scan every billing team the way `backfill-internal-free-plans` does —
 * that shape is right for a one-shot deploy backfill and wrong for a job that
 * repeats, because its cost grows with the number of teams rather than with the
 * amount of work. Querying by `endedAt` instead means a run with nothing to do
 * costs exactly one query, which is what every run looks like in steady state.
 *
 * TODO(default-plans): once the free plan is granted implicitly by config
 * rather than as a Subscription row, delete this along with the rest of the
 * regrant dance (see `ensure-free-plan.ts`).
 */

/**
 * How often the cron invokes this sweep (see `vercel.json`). Kept here next to
 * the lookback it derives, so the two can't drift apart silently.
 */
const FREE_PLAN_REGRANT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * How far back a run looks for subscriptions that ended.
 *
 * Twice the cron interval, so a single skipped or failed run doesn't drop the
 * teams that expired during it — the next run still covers that window. Overlap
 * between consecutive runs is free: `ensureFreePlanForBillingTeam` is
 * idempotent and no-ops once the team has a plan again, which is also why this
 * needs no watermark or cursor state.
 */
const FREE_PLAN_REGRANT_SWEEP_LOOKBACK_MS = 2 * FREE_PLAN_REGRANT_SWEEP_INTERVAL_MS;

export type FreePlanRegrantSweepResult = {
  candidates: number,
  granted: number,
  failed: number,
};

export async function runFreePlanRegrantSweep(): Promise<FreePlanRegrantSweepResult> {
  // Deliberately not parameterised with an injectable clock: the candidate
  // query is only half the picture — `ensureFreePlanForBillingTeam` decides
  // occupancy against its own `Date.now()`, so a shifted window here would
  // widen the superset without moving the boundary that actually matters, and
  // read as more configurable than it is.
  const now = new Date();
  const internalTenancy = await getInternalBillingTenancy();
  const internalPrisma = await getPrismaClientForTenancy(internalTenancy);

  // Every internal-tenancy team subscription that ended inside the lookback
  // window, whatever its status or product — `ensureFreePlanForBillingTeam` is
  // the authority on whether the team is actually orphaned, so this only has to
  // be a cheap superset. In particular it must NOT filter on `status` or
  // `productId`: a team can be orphaned by any plans-line sub ending, and the
  // predicate that decides occupancy is endedAt-based for exactly that reason.
  const endedSubscriptions = await internalPrisma.subscription.findMany({
    where: {
      tenancyId: internalTenancy.id,
      customerType: CustomerType.TEAM,
      endedAt: {
        gt: new Date(now.getTime() - FREE_PLAN_REGRANT_SWEEP_LOOKBACK_MS),
        lte: now,
      },
    },
    select: { customerId: true },
  });

  // Deduped in memory rather than with Prisma's `distinct`: the window holds a
  // handful of rows at most, and a team that ended two subs at once must only
  // be considered once.
  const billingTeamIds = [...new Set(endedSubscriptions.map((subscription) => subscription.customerId))];

  let granted = 0;
  let failed = 0;
  for (const billingTeamId of billingTeamIds) {
    try {
      if (await ensureFreePlanForBillingTeam(billingTeamId)) {
        granted++;
        // Orphaned teams should be rare enough that every repair is worth a
        // line to grep. If this starts firing steadily, something upstream is
        // dropping the regrant and the sweep is papering over it.
        console.log(`[FreePlanRegrantSweep] Regranted the free plan to billing team ${billingTeamId}`);
      }
    } catch (error) {
      // Per-team isolation, same as `backfill-internal-free-plans`: one team's
      // transient failure must not skip every team after it. The next run
      // retries it — the lookback window is wide enough to still include it.
      failed++;
      captureError("free-plan-regrant-sweep", error);
    }
  }

  return { candidates: billingTeamIds.length, granted, failed };
}

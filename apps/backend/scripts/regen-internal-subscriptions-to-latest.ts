/**
 * Brings every active subscription on Hexclave's own billing project up
 * to the latest version of its plan. Runs at deploy / db init time.
 *
 * Why we need it: each Subscription stores a frozen JSON copy of the plan
 * it was bought on. When we edit a plan (raise a quota, add an
 * entitlement), existing customers don't see the change until something
 * rewrites that copy. Subs paid through Stripe also store a version
 * pointer in Stripe metadata, and we update that first — otherwise the
 * next webhook would put the DB right back to the old version.
 *
 * Safe to re-run: subs already on the latest version do nothing.
 *
 */

import { Prisma } from "@/generated/prisma/client";
import { bulldozerWriteSubscription } from "@/lib/payments/bulldozer-dual-write";
import { getSubscriptionMapForCustomer } from "@/lib/payments/customer-data";
import type { ProductSnapshot, SubscriptionRow } from "@/lib/payments/schema/types";
import { canonicalJsonStringify, computeProductVersionId, upsertProductVersion } from "@/lib/product-versions";
import { getStripeForAccount } from "@/lib/stripe";
// eslint-disable-next-line @typescript-eslint/no-deprecated -- idiomatic way to get the internal tenancy today (see plan-entitlements.ts)
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch, type Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, globalPrismaClient, retryTransaction } from "@/prisma-client";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { getOrUndefined } from "@hexclave/shared/dist/utils/objects";
import type Stripe from "stripe";

// Page size for streaming teams. Big enough to amortise round-trips,
// small enough to not blow up memory on a million-team tenancy.
const TEAM_BATCH_SIZE = 500;

// Just the slice of the Stripe SDK we use, so tests can pass a tiny mock.
// Real Stripe clients are structurally compatible.
export type StripeSubscriptionsClient = {
  retrieve(id: string): Promise<{ metadata: Stripe.Metadata | null }>,
  update(id: string, params: { metadata: Record<string, string | null> }): Promise<Stripe.Response<Stripe.Subscription>>,
};
export type StripeClientForRegen = {
  subscriptions: StripeSubscriptionsClient,
};

// Per-path tallies for the deploy log. Every scanned sub falls into
// exactly one bucket (alreadyCurrent / one of the skipped-*'s) or into
// `mutated`; subs in `mutated` may also tick `dbWrites` and/or
// `stripeMetadataWrites` depending on which side(s) were stale.
type Counters = {
  scannedTeams: number,
  scannedSubs: number,
  /** at least one write happened (DB and/or Stripe metadata). */
  mutated: number,
  /** the stored snapshot was rewritten to the latest plan. */
  dbWrites: number,
  /** the version pointer Stripe holds for this sub was updated. */
  stripeMetadataWrites: number,
  /** already on the latest plan; nothing to do. */
  alreadyCurrent: number,
  /** sub already ended, nothing to regenerate. */
  skippedEnded: number,
  /** sub has no productId (legacy / inline product); can't address. */
  skippedNullProductId: number,
  /** productId no longer exists in tenancy config (renamed/deleted plan). */
  skippedMissingProduct: number,
  /** per-sub try/catch fired; sub left as-is, next run will retry. */
  skippedFailures: number,
};

function log(msg: string) {
  console.log(`[Regen][InternalSubs] ${msg}`);
}

/**
 * Should we update the prod version metadata Stripe holds for this sub?
 * Only for real Stripe-backed subs. We never call live Stripe for
 * `TEST_MODE` subs even if they happen to have a Stripe id (dummy seed
 * data sometimes does this) — a fake id would just blow up
 * `subscriptions.retrieve` against real Stripe.
 *
 * The DB snapshot rewrite below happens regardless of this gate.
 */
function needsStripeMetadataRebase(sub: SubscriptionRow): boolean {
  return sub.stripeSubscriptionId != null && sub.creationSource !== "TEST_MODE";
}

/**
 * Yields every billing team in the internal tenancy, page by page.
 * Same shape as the iterator in `backfill-internal-free-plans.ts`; kept
 * separate because the two scripts share nothing else.
 *
 * If `filter` is given, just yield those ids and skip the DB scan —
 * tests use this to scope to their own seeded teams.
 */
async function* iterateInternalTeamIds(
  internalTenancy: Tenancy,
  batchSize: number,
  filter?: ReadonlyArray<string>,
): AsyncIterable<string> {
  if (filter != null) {
    for (const id of filter) yield id;
    return;
  }
  let cursor: string | null = null;
  while (true) {
    const batch: { teamId: string }[] = await globalPrismaClient.team.findMany({
      where: {
        tenancyId: internalTenancy.id,
        ...(cursor != null ? { teamId: { gt: cursor } } : {}),
      },
      select: { teamId: true },
      orderBy: { teamId: "asc" },
      take: batchSize,
    });
    if (batch.length === 0) return;
    for (const { teamId } of batch) {
      yield teamId;
    }
    cursor = batch[batch.length - 1].teamId;
  }
}

export async function runRegenInternalSubscriptionsToLatest(options: {
  /**
   * Test override. In production we lazily build one from the internal
   * tenancy on first need, so deploys without any Stripe-backed subs
   * don't need `STACK_STRIPE_SECRET_KEY` set.
   */
  stripeClient?: StripeClientForRegen,
  /**
   * Test scope: process only these team ids and skip the DB enumeration.
   * Production callers omit this.
   */
  teamIdsFilter?: ReadonlyArray<string>,
} = {}): Promise<Counters> {
  const { teamIdsFilter } = options;

  log("Starting...");
  const internalTenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID, true);
  if (internalTenancy == null) {
    throw new HexclaveAssertionError("Internal billing tenancy not found", {
      billingProjectId: "internal",
      branchId: DEFAULT_BRANCH_ID,
    });
  }

  const counters: Counters = {
    scannedTeams: 0,
    scannedSubs: 0,
    mutated: 0,
    dbWrites: 0,
    stripeMetadataWrites: 0,
    alreadyCurrent: 0,
    skippedEnded: 0,
    skippedNullProductId: 0,
    skippedMissingProduct: 0,
    skippedFailures: 0,
  };

  // Lazy, memoized Stripe client. We don't build it until we actually
  // hit a Stripe-backed sub. We cache the PROMISE (not its resolved
  // value), so if construction fails once (e.g. missing
  // STACK_STRIPE_SECRET_KEY), every later Stripe-backed sub trips the
  // per-sub failure handler instead of repeating the lookup N times.
  let stripePromise: Promise<StripeClientForRegen> | null = options.stripeClient != null
    ? Promise.resolve(options.stripeClient)
    : null;
  const getStripe = () => stripePromise ??= getStripeForAccount({ tenancy: internalTenancy });

  for await (const teamId of iterateInternalTeamIds(internalTenancy, TEAM_BATCH_SIZE, teamIdsFilter)) {
    counters.scannedTeams++;

    const subMap = await getSubscriptionMapForCustomer({
      prisma: globalPrismaClient,
      tenancyId: internalTenancy.id,
      customerType: "team",
      customerId: teamId,
    });

    for (const sub of Object.values(subMap)) {
      counters.scannedSubs++;
      try {
        const stripe: StripeClientForRegen | null = needsStripeMetadataRebase(sub)
          ? await getStripe()
          : null;
        await regenSingleSubscription({
          internalTenancy,
          sub,
          stripe,
          counters,
        });
      } catch (e) {
        // Per-sub isolation: log and keep going. One broken sub should
        // never abort the whole migration. The most likely failure
        // here is a post-Prisma-commit Bulldozer dual-write — the next
        // run of this script heals it on its own (`sub.product` is
        // read from Bulldozer, so the equality check downstream sees
        // the stale snapshot and re-issues the write).
        counters.skippedFailures++;
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(
          `[Regen][InternalSubs][sub=${sub.id}] Failed: ${err.message}`,
          err,
        );
      }
    }

    if (counters.scannedTeams % 100 === 0) {
      log(`Progress: ${counters.scannedTeams} teams (subs scanned=${counters.scannedSubs}, mutated=${counters.mutated})`);
    }
  }

  log("Done.");
  log(`  Scanned         : ${counters.scannedTeams} teams, ${counters.scannedSubs} subscriptions`);
  log(`  Mutated         : ${counters.mutated} subs (${counters.dbWrites} DB snapshot rewrites, ${counters.stripeMetadataWrites} Stripe metadata rebases)`);
  log(`  Already current : ${counters.alreadyCurrent}`);
  log(`  Skipped         : ${counters.skippedEnded} ended, ${counters.skippedNullProductId} with null productId, ${counters.skippedMissingProduct} with productId not in config, ${counters.skippedFailures} per-sub failures`);
  return counters;
}

/**
 * The per-sub unit of work. Exported so tests can exercise each code
 * path (stale snapshot, stale Stripe pointer, fresh, missing plan, etc.)
 * directly. May throw — the outer loop owns failure isolation.
 */
export async function regenSingleSubscription(args: {
  internalTenancy: Tenancy,
  sub: SubscriptionRow,
  /** Required whenever `needsStripeMetadataRebase(sub)` is true. */
  stripe: StripeClientForRegen | null,
  counters: Counters,
}): Promise<void> {
  const { internalTenancy, sub, stripe, counters } = args;

  const nowMillis = Date.now();
  if (sub.endedAtMillis != null && sub.endedAtMillis <= nowMillis) {
    counters.skippedEnded++;
    return;
  }
  if (sub.productId == null) {
    counters.skippedNullProductId++;
    return;
  }

  const isStripeBacked = needsStripeMetadataRebase(sub);
  if (isStripeBacked && stripe == null) {
    throw new HexclaveAssertionError(
      "regenSingleSubscription called for Stripe-backed sub without a stripe client",
      { subId: sub.id, stripeSubscriptionId: sub.stripeSubscriptionId, creationSource: sub.creationSource },
    );
  }

  const latestProduct = getOrUndefined(internalTenancy.config.payments.products, sub.productId);
  if (latestProduct == null) {
    counters.skippedMissingProduct++;
    console.warn(
      `[Regen][InternalSubs][sub=${sub.id}] productId=${sub.productId} no longer exists in internal tenancy config; skipping.`,
    );
    return;
  }

  const newVersionId = computeProductVersionId(sub.productId, latestProduct);

  // Snapshot equality via canonical JSON (sorted keys, undefineds
  // dropped). For pure-JSON ProductSnapshot this is a deep-equal. A
  // false negative would just cause one harmless extra rewrite.
  const dbSnapshotIsCurrent = canonicalJsonStringify(sub.product as unknown)
    === canonicalJsonStringify(latestProduct);

  // For Stripe-backed subs, also check the version pointer Stripe holds.
  // If it's stale, the next webhook would overwrite our DB rewrite by
  // re-pinning the sub to the old ProductVersion, so we have to rebase
  // it too.
  let stripeMetadataIsCurrent = true;
  let stripeExistingMetadata: Stripe.Metadata | Record<string, string | undefined> | null = null;
  if (isStripeBacked) {
    const stripeSub = await stripe!.subscriptions.retrieve(sub.stripeSubscriptionId!);
    stripeExistingMetadata = stripeSub.metadata ?? {};
    const existingVersionId = (stripeExistingMetadata as Record<string, string | undefined>).productVersionId;
    stripeMetadataIsCurrent = existingVersionId === newVersionId;
  }

  if (dbSnapshotIsCurrent && stripeMetadataIsCurrent) {
    counters.alreadyCurrent++;
    return;
  }

  // We're going to write at least one side, so make sure the
  // ProductVersion row exists first — the Stripe pointer below and any
  // downstream reader will dereference it. The id is a content hash, so
  // upsert is idempotent.
  await upsertProductVersion({
    prisma: globalPrismaClient,
    tenancyId: internalTenancy.id,
    productId: sub.productId,
    productJson: latestProduct,
  });

  // Stripe FIRST, then DB. If the DB write throws afterwards, the next
  // webhook reads our updated Stripe pointer and re-pins the DB to the
  // new version — i.e. it self-heals. The opposite order would not.
  if (isStripeBacked && !stripeMetadataIsCurrent) {
    // Spread existing metadata and only override the version pointer.
    // Other write paths (purchase-session, switch) set metadata
    // wholesale because they own all the keys at create time. We don't,
    // so we preserve whatever is there (customerId, etc.).
    const merged: Record<string, string | null> = {
      ...((stripeExistingMetadata ?? {}) as Record<string, string>),
      productVersionId: newVersionId,
    };
    await stripe!.subscriptions.update(sub.stripeSubscriptionId!, { metadata: merged });
    counters.stripeMetadataWrites++;
    log(`Updated Stripe metadata for sub=${sub.id} stripeSub=${sub.stripeSubscriptionId} productVersionId=${newVersionId}`);
  }

  if (!dbSnapshotIsCurrent) {
    // Use the tenancy-aware prisma so we stay correct if `internal`
    // ever moves off the host DB.
    const internalPrisma = await getPrismaClientForTenancy(internalTenancy);
    const updated = await retryTransaction(internalPrisma, async (tx) => {
      return await tx.subscription.update({
        where: { tenancyId_id: { tenancyId: internalTenancy.id, id: sub.id } },
        data: { product: latestProduct as unknown as Prisma.InputJsonValue },
      });
    });
    // Bulldozer dual-write runs OUTSIDE the Prisma tx — it executes raw
    // SQL with its own BEGIN/COMMIT and would otherwise commit our
    // outer tx prematurely. Same pattern as `ensureFreePlanForBillingTeam`.
    //
    // If this raw write fails after the Prisma commit, the Bulldozer
    // stored row is left at the old snapshot. The NEXT run of this
    // script will detect and fix it: `subMap` is read from Bulldozer,
    // so the equality check above sees the stale snapshot and falls
    // into this branch again. The outer per-sub catch additionally
    // captures the failure to Sentry so the intermittent issue is
    // visible while it's happening.
    //
    // TODO(bulldozer-dual-write): this script hand-rolls a per-sub Prisma
    // update + single-row dual-write and predates both the batch backfill
    // path and the current single-arg `bulldozerWrite*` helpers (they no
    // longer take a Prisma client — the write goes straight to bulldozer-js).
    // When internal-sub regen is next revisited, rewrite it to route through
    // the shared backfill/dual-write abstraction instead of duplicating the
    // conversion + POST here. For now we just call the current single-arg form.
    await bulldozerWriteSubscription(updated);
    counters.dbWrites++;
    log(`Regenerated DB snapshot + bulldozer for sub=${sub.id} productId=${sub.productId} productVersionId=${newVersionId}`);
  }

  counters.mutated++;
}

// Exposed for tests that want to assert the equality semantics directly.
export function isProductSnapshotCurrent(stored: ProductSnapshot, latest: ProductSnapshot): boolean {
  return canonicalJsonStringify(stored) === canonicalJsonStringify(latest);
}

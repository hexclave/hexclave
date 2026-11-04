import { CustomerType, PrismaClient, PurchaseCreationSource, Subscription, SubscriptionStatus } from "@/generated/prisma/client";
import { isAddOnProduct, isSubscriptionInEffect } from "@/lib/payments";
import { bulldozerWriteSubscription } from "@/lib/payments/bulldozer-dual-write";
import { getSubscriptionMapForCustomer } from "@/lib/payments/customer-data";
import type { ProductSnapshot } from "@/lib/payments/schema/types";
// eslint-disable-next-line @typescript-eslint/no-deprecated -- idiomatic way to get the internal tenancy today (see plan-entitlements.ts)
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch, type Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, retryTransaction, type PrismaClientTransaction } from "@/prisma-client";
import { addInterval } from "@hexclave/shared/dist/utils/dates";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { getOrUndefined, typedEntries } from "@hexclave/shared/dist/utils/objects";

/**
 * Free/team/growth plans live on the internal tenancy; the "customer" is a
 * team in the internal project (a billing team). This file owns the two
 * writes that touch the free-plan sub for such a team:
 *
 *   - `createFreePlanSubscriptionRow` — Prisma-only insert. Callers run the
 *     subsequent `bulldozerWriteSubscription` themselves, so they can keep
 *     the Prisma insert inside whatever outer transaction they own while
 *     the Bulldozer write (which issues its own BEGIN/COMMIT) happens
 *     after the tx commits.
 *   - `ensureFreePlanForBillingTeam` — the regrant path. Idempotent; no-op
 *     if the team already owns a plan in the same product line.
 */

// Exported for `free-plan-regrant-sweep.ts`, which needs the same tenancy to
// scope its query before delegating each candidate team back to this file.
export async function getInternalBillingTenancy(): Promise<Tenancy> {
  const tenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID, true);
  if (tenancy == null) {
    throw new HexclaveAssertionError("Internal billing tenancy not found");
  }
  return tenancy;
}

/**
 * Writes the `free` Subscription row. Caller is responsible for a subsequent
 * `bulldozerWriteSubscription(sub)` after any outer transaction
 * commits, and for verifying there's no conflicting plan in the same line.
 *
 * `prisma` is deliberately typed as the union — the helper does a single
 * `subscription.create` that works identically with a full client or a tx
 * client. When called with a full client, the Prisma insert and the
 * downstream `bulldozerWriteSubscription` are NOT atomic; same trade-off as
 * every other dual-write call site.
 *
 * `creationSource` is a parameter because the right value depends on context
 * (auto-regrant vs team-creation vs a hypothetical test-mode seed). Throws
 * on a misconfigured `free` product so broken deploys fail loudly.
 */
export async function createFreePlanSubscriptionRow(options: {
  prisma: PrismaClient | PrismaClientTransaction,
  internalTenancy: Tenancy,
  billingTeamId: string,
  creationSource: PurchaseCreationSource,
}): Promise<Subscription> {
  const { prisma, internalTenancy, billingTeamId, creationSource } = options;
  const freePlanProduct = getOrUndefined(internalTenancy.config.payments.products, "free");
  if (freePlanProduct == null || freePlanProduct.customerType !== "team" || freePlanProduct.productLineId == null) {
    throw new HexclaveAssertionError(
      "Internal tenancy `free` product is not configured as a team-typed, product-line-tagged plan; cannot grant",
      { freePlanProduct },
    );
  }

  // First price, same as validatePurchaseSession's default when no priceId
  // is supplied. The `length` check is needed because TS types `[0]` as
  // non-undefined (no noUncheckedIndexedAccess in our tsconfig).
  const priceEntries = typedEntries(freePlanProduct.prices);
  if (priceEntries.length === 0) {
    throw new HexclaveAssertionError("Free plan has no prices configured");
  }
  const [firstPriceId, firstPrice] = priceEntries[0];
  const priceInterval = firstPrice.interval;

  const now = new Date();
  return await prisma.subscription.create({
    data: {
      tenancyId: internalTenancy.id,
      customerId: billingTeamId,
      customerType: CustomerType.TEAM,
      status: SubscriptionStatus.active,
      productId: "free",
      priceId: firstPriceId,
      product: freePlanProduct,
      quantity: 1,
      currentPeriodStart: now,
      // No interval only happens if the free plan is misconfigured as one-off;
      // fall back to a 2099 sentinel so the sub never naturally ends.
      currentPeriodEnd: priceInterval != null ? addInterval(now, priceInterval) : new Date("2099-12-31T23:59:59Z"),
      cancelAtPeriodEnd: false,
      creationSource,
    },
  });
}

/**
 * Regrants the `free` plan if the billing team has no active plan in the
 * free plan's product line. Callers can fire this speculatively — it silently
 * no-ops on misconfiguration, when a plan is already owned, or when a
 * concurrent caller already established the free sub.
 *
 * Returns `true` iff this call actually inserted a new free-plan subscription
 * row (i.e. the team really was orphaned in the source of truth and we held
 * the SERIALIZABLE slot that wrote the row). All other paths — misconfig,
 * fast-path occupancy hit, slow-path occupancy hit, lost-race concurrent
 * insert — return `false`. The deploy-time backfill uses this to count
 * orphaned-and-actually-granted teams accurately rather than maintaining its
 * own (LFold-lagging) predicate.
 *
 * Two-phase concurrency story:
 *
 *   1. Fast path — O(1) read against the `subscriptionMapByCustomer`
 *      LFold. That LFold is a `GroupBy → Sort → LFold` chain with no
 *      TimeFold in its dependencies, so its row-change triggers cascade
 *      synchronously during `bulldozerWriteSubscription`'s `setRow`
 *      (unlike `ownedProducts`, which sits downstream of a TimeFold and
 *      only catches up when bulldozer-js's in-process tick loop drains
 *      the queue). That means
 *      callers that just committed a sub mutation upstream (the DELETE
 *      cancel route, the Stripe webhook handler) see their own writes
 *      here and we don't spuriously regrant on stale data.
 *
 *   2. Slow path — if the fast path found nothing, re-check against the
 *      Prisma Subscription source-of-truth under SERIALIZABLE isolation
 *      and insert atomically so two concurrent callers can't both create
 *      a duplicate free sub. `retryTransaction` handles P2028
 *      serialization failures by retrying; on the retry the other
 *      caller's row is visible and we skip the insert.
 *
 * TODO: once "default products" lands and the free plan is granted
 * implicitly by config rather than a DB row, this whole regrant dance
 * goes away. The slow-path Prisma write is also a pre-Bulldozer-
 * deprecation artefact — when Bulldozer owns subscription writes
 * directly, the SERIALIZABLE Prisma tx becomes a Bulldozer insert with
 * its own concurrency story.
 */
export async function ensureFreePlanForBillingTeam(billingTeamId: string): Promise<boolean> {
  const internalTenancy = await getInternalBillingTenancy();
  const freePlanProduct = getOrUndefined(internalTenancy.config.payments.products, "free");
  if (freePlanProduct == null || freePlanProduct.customerType !== "team" || freePlanProduct.productLineId == null) {
    return false;
  }
  const freeProductLineId = freePlanProduct.productLineId;

  const internalPrisma = await getPrismaClientForTenancy(internalTenancy);

  // Snapshot-based "occupies the free plan's product line" predicate. We
  // treat a sub as occupying the line iff its captured product snapshot
  // lives in that line, isn't an add-on, and is still in effect
  // (`isSubscriptionInEffect` — status-agnostic, endedAt-based; see its doc
  // comment for why gating on `status` here would (and did) cause the free
  // plan to be double-granted on top of a just-created incomplete paid sub).
  const nowMillis = Date.now();
  const productLineStillOccupiedBy = (sub: { product: ProductSnapshot } & ({ endedAtMillis: number | null } | { endedAt: Date | null })): boolean => {
    if (sub.product.productLineId !== freeProductLineId) return false;
    if (isAddOnProduct(sub.product)) return false;
    return isSubscriptionInEffect(sub, nowMillis);
  };

  // Fast path: read the customer's synchronous subscription LFold. Note
  // that Bulldozer SubscriptionRow uses the schema-side lowercase
  // CustomerType (`"team"`), not the Prisma enum — see
  // `bulldozer-dual-write.ts:subscriptionToStoredRow` which
  // `.toLowerCase()`s on write.
  const subscriptionMap = await getSubscriptionMapForCustomer({
    prisma: internalPrisma,
    tenancyId: internalTenancy.id,
    customerType: "team",
    customerId: billingTeamId,
  });
  if (Object.values(subscriptionMap).some(productLineStillOccupiedBy)) {
    return false;
  }

  // Slow path: the team appears to have no occupying sub. Re-check under
  // SERIALIZABLE isolation against the Prisma source-of-truth and insert
  // atomically so concurrent callers can't both produce a duplicate free
  // sub. Prisma here (not Bulldozer) because the insert is a Prisma write
  // and we want the check and insert to serialize on the same row. We
  // filter `endedAt IS NULL OR endedAt > NOW()` at the SQL level and
  // apply the snapshot predicate in-memory — per-customer sub counts are
  // tiny, and the `(tenancyId, customerId, customerType)` index is used.
  const now = new Date();
  const createdSub = await retryTransaction(internalPrisma, async (tx) => {
    const unendedSubs = await tx.subscription.findMany({
      where: {
        tenancyId: internalTenancy.id,
        customerId: billingTeamId,
        customerType: CustomerType.TEAM,
        OR: [{ endedAt: null }, { endedAt: { gt: now } }],
      },
      select: { product: true, endedAt: true },
    });
    const existing = unendedSubs.some((sub) =>
      productLineStillOccupiedBy({
        product: sub.product as ProductSnapshot,
        endedAt: sub.endedAt,
      }),
    );
    if (existing) {
      return null;
    }
    return await createFreePlanSubscriptionRow({
      prisma: tx,
      internalTenancy,
      billingTeamId,
      // Free is always paymentProvider=stripe (via the non-TEST_MODE CASE),
      // regardless of testMode. API_GRANT is the closest semantic fit.
      creationSource: PurchaseCreationSource.API_GRANT,
    });
  }, { level: "serializable" });

  if (createdSub == null) {
    return false;
  }
  // Bulldozer write happens outside the tx — it issues its own BEGIN/
  // COMMIT and can't nest. If it fails after the Prisma insert committed,
  // the sub exists in Prisma but not yet in Bulldozer; same trade-off as
  // all other dual-write call sites, reconciled by the next sync.
  await bulldozerWriteSubscription(createdSub);
  return true;
}

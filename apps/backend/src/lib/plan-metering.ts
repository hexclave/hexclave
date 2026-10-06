import { ensureCustomerExists } from "@/lib/payments";
import { bulldozerWriteItemQuantityChanges } from "@/lib/payments/bulldozer-dual-write";
import { getItemQuantitiesForCustomer } from "@/lib/payments/customer-data";
import { getPrismaClientForTenancy, retryTransaction, type PrismaClientTransaction } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { getOrUndefined } from "@hexclave/shared/dist/utils/objects";
import { Result } from "@hexclave/shared/dist/utils/results";
import { typedToUppercase } from "@hexclave/shared/dist/utils/strings";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch } from "./tenancies";

export type MeteredPlanItemId =
  | typeof ITEM_IDS.analyticsEvents
  | typeof ITEM_IDS.analyticsSpans
  | typeof ITEM_IDS.sessionReplays;

export type AnalyticsPlanItemId =
  | MeteredPlanItemId
  | typeof ITEM_IDS.analyticsTimeoutSeconds;

export type PlanItemDebit = {
  itemId: MeteredPlanItemId,
  quantity: number,
  idempotency?: {
    key: string,
    createdAt: Date,
  },
};

type PlanItemQuantityChange = {
  id: string,
  tenancyId: string,
  customerId: string,
  customerType: "TEAM",
  itemId: MeteredPlanItemId,
  quantity: number,
  description: string | null,
  expiresAt: Date | null,
  createdAt: Date,
};

const inFlightPlanQuantityReads = new Map<string, Promise<Map<AnalyticsPlanItemId, number>>>();

async function lockPlanMeteringCustomer(
  tx: PrismaClientTransaction,
  tenancyId: string,
  billingTeamId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plan-metering:${tenancyId}:${billingTeamId}`}, 0))`;
}

const planMeteringCustomerQueues = new Map<string, Promise<unknown>>();

async function withPlanMeteringCustomerQueue<T>(
  tenancyId: string,
  billingTeamId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${tenancyId}\0${billingTeamId}`;
  const previous = planMeteringCustomerQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  const tail = current.catch(() => {});
  planMeteringCustomerQueues.set(key, tail);
  try {
    return await current;
  } finally {
    if (planMeteringCustomerQueues.get(key) === tail) {
      planMeteringCustomerQueues.delete(key);
    }
  }
}

// Bulldozer is written before the Postgres transaction commits so the advisory
// lock covers the whole read-check-write. If the transaction ultimately fails,
// zero out any posted rows that did not commit so Bulldozer never keeps a debit
// that Postgres does not have.
async function withPostedChangeCompensation<T>(
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  getPostedChanges: () => readonly PlanItemQuantityChange[],
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const posted = getPostedChanges();
    if (posted.length > 0) {
      const compensation = await Result.fromPromise((async () => {
        const committed = await prisma.itemQuantityChange.findMany({
          where: { tenancyId: posted[0].tenancyId, id: { in: posted.map(({ id }) => id) } },
          select: { id: true },
        });
        const committedIds = new Set(committed.map(({ id }) => id));
        const uncommitted = posted.filter(({ id }) => !committedIds.has(id));
        if (uncommitted.length > 0) {
          await bulldozerWriteItemQuantityChanges(uncommitted.map((change) => ({ ...change, quantity: 0 })));
        }
      })());
      if (compensation.status === "error") {
        captureError("plan-metering-bulldozer-compensation", compensation.error);
      }
    }
    throw error;
  }
}

function deterministicPlanChangeId(parts: readonly string[]): string {
  const hex = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
  const variantNibble = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function getBillingContext(billingTeamId: string, itemIds: readonly AnalyticsPlanItemId[]) {
  const tenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID, true);
  if (tenancy == null) {
    throw new HexclaveAssertionError("Internal billing tenancy not found", {
      billingProjectId: "internal",
      branchId: DEFAULT_BRANCH_ID,
    });
  }

  for (const itemId of itemIds) {
    const itemConfig = getOrUndefined(tenancy.config.payments.items, itemId);
    if (itemConfig == null) {
      throw new KnownErrors.ItemNotFound(itemId);
    }
    if (itemConfig.customerType !== "team") {
      throw new KnownErrors.ItemCustomerTypeDoesNotMatch(itemId, billingTeamId, itemConfig.customerType, "team");
    }
  }

  const prisma = await getPrismaClientForTenancy(tenancy);
  await ensureCustomerExists({
    prisma,
    tenancyId: tenancy.id,
    customerType: "team",
    customerId: billingTeamId,
  });
  return { tenancy, prisma };
}

export async function getAnalyticsPlanItemQuantities(
  billingTeamId: string,
  itemIds: readonly AnalyticsPlanItemId[],
): Promise<Map<AnalyticsPlanItemId, number>> {
  if (itemIds.length === 0) {
    return new Map();
  }
  const key = `${billingTeamId}\0${[...itemIds].sort().join("\0")}`;
  const existingRead = inFlightPlanQuantityReads.get(key);
  if (existingRead != null) {
    return new Map(await existingRead);
  }

  const newRead = (async () => {
    const { tenancy, prisma } = await getBillingContext(billingTeamId, itemIds);
    const quantities = await getItemQuantitiesForCustomer({
      prisma,
      tenancyId: tenancy.id,
      customerType: "team",
      customerId: billingTeamId,
    });
    return new Map(itemIds.map((itemId) => [itemId, quantities[itemId] ?? 0]));
  })();
  inFlightPlanQuantityReads.set(key, newRead);
  try {
    return new Map(await newRead);
  } finally {
    if (inFlightPlanQuantityReads.get(key) === newRead) {
      inFlightPlanQuantityReads.delete(key);
    }
  }
}

export async function tryDecreasePlanItemQuantities(
  billingTeamId: string,
  debits: readonly PlanItemDebit[],
): Promise<{ insufficientItemId: MeteredPlanItemId | null, createdChangeIds: string[] }> {
  const nonZeroDebits = debits.filter(({ quantity }) => quantity !== 0);
  for (const debit of nonZeroDebits) {
    if (!Number.isSafeInteger(debit.quantity) || debit.quantity < 0) {
      throw new HexclaveAssertionError("Plan item debit must be a non-negative safe integer", {
        itemId: debit.itemId,
        quantity: debit.quantity,
      });
    }
    if (debit.idempotency != null) {
      if (debit.idempotency.key.length === 0) {
        throw new HexclaveAssertionError("Plan item debit idempotency key must not be empty", {
          itemId: debit.itemId,
        });
      }
      if (!Number.isFinite(debit.idempotency.createdAt.getTime())) {
        throw new HexclaveAssertionError("Plan item debit idempotency timestamp must be a valid date", {
          itemId: debit.itemId,
        });
      }
    }
  }
  if (nonZeroDebits.length === 0) {
    return { insufficientItemId: null, createdChangeIds: [] };
  }

  const { tenancy, prisma } = await getBillingContext(billingTeamId, nonZeroDebits.map(({ itemId }) => itemId));
  const changes: PlanItemQuantityChange[] = nonZeroDebits.map((debit) => ({
    id: debit.idempotency == null
      ? randomUUID()
      : deterministicPlanChangeId([
        "hexclave-plan-debit-v1",
        tenancy.id,
        billingTeamId,
        debit.itemId,
        debit.idempotency.key,
      ]),
    tenancyId: tenancy.id,
    customerId: billingTeamId,
    customerType: typedToUppercase("team"),
    itemId: debit.itemId,
    quantity: -debit.quantity,
    description: null,
    expiresAt: null,
    createdAt: debit.idempotency?.createdAt ?? new Date(),
  }));

  return await enqueuePlanDebit(tenancy, prisma, billingTeamId, changes);
}

type PlanDebitResult = { insufficientItemId: MeteredPlanItemId | null, createdChangeIds: string[] };

type PendingPlanDebit = {
  changes: PlanItemQuantityChange[],
  resolve: (result: PlanDebitResult) => void,
  reject: (error: unknown) => void,
};

const pendingPlanDebitBatches = new Map<string, PendingPlanDebit[]>();
const MAX_PLAN_DEBIT_BATCH_SIZE = 256;

// The debit transaction holds the advisory lock across Bulldozer round-trips
// (balance read, stale-row revert, and write), so Prisma's 5s default expires
// it under load ("Transaction not found"). Every retry then re-runs the whole
// batch and every queued debit for the customer waits behind it.
const PLAN_DEBIT_TRANSACTION_TIMEOUT_MS = 30_000;

// Debits for one customer that arrive while an earlier transaction holds the
// per-process queue are coalesced into a single advisory-locked transaction, so
// throughput does not degrade to one transaction plus Bulldozer round-trip per
// event. The advisory lock still provides cross-instance serialization.
function enqueuePlanDebit(
  tenancy: Awaited<ReturnType<typeof getBillingContext>>["tenancy"],
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  billingTeamId: string,
  changes: PlanItemQuantityChange[],
): Promise<PlanDebitResult> {
  return new Promise<PlanDebitResult>((resolve, reject) => {
    const key = `${tenancy.id}\0${billingTeamId}`;
    const existingBatch = pendingPlanDebitBatches.get(key);
    if (existingBatch != null && existingBatch.length < MAX_PLAN_DEBIT_BATCH_SIZE) {
      existingBatch.push({ changes, resolve, reject });
      return;
    }
    const batch: PendingPlanDebit[] = [{ changes, resolve, reject }];
    pendingPlanDebitBatches.set(key, batch);
    const flushed = withPlanMeteringCustomerQueue(tenancy.id, billingTeamId, async () => {
      if (pendingPlanDebitBatches.get(key) === batch) {
        pendingPlanDebitBatches.delete(key);
      }
      await settlePlanDebitBatch(tenancy.id, prisma, billingTeamId, batch);
    });
    flushed.catch((error: unknown) => {
      for (const pending of batch) pending.reject(error);
    });
  });
}

async function settlePlanDebitBatch(
  tenancyId: string,
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  billingTeamId: string,
  batch: readonly PendingPlanDebit[],
): Promise<void> {
  const batchResult = await Result.fromPromise(applyPlanDebits(tenancyId, prisma, billingTeamId, batch.map(({ changes }) => changes)));
  if (batchResult.status === "ok") {
    batch.forEach((pending, index) => pending.resolve(batchResult.data[index]));
    return;
  }
  if (batch.length === 1) {
    batch[0].reject(batchResult.error);
    return;
  }
  // Isolate the failure so one bad request cannot fail every coalesced caller.
  for (const pending of batch) {
    const singleResult = await Result.fromPromise(applyPlanDebits(tenancyId, prisma, billingTeamId, [pending.changes]));
    if (singleResult.status === "ok") {
      pending.resolve(singleResult.data[0]);
    } else {
      pending.reject(singleResult.error);
    }
  }
}

async function applyPlanDebits(
  tenancyId: string,
  prisma: Awaited<ReturnType<typeof getPrismaClientForTenancy>>,
  billingTeamId: string,
  requests: readonly PlanItemQuantityChange[][],
): Promise<PlanDebitResult[]> {
  let postedChanges: PlanItemQuantityChange[] = [];
  let finalBulldozerIds = new Set<string>();
  const results = await withPostedChangeCompensation(prisma, () => postedChanges, async () => await retryTransaction(prisma, async (tx) => {
    await lockPlanMeteringCustomer(tx, tenancyId, billingTeamId);

    const existingChanges = await tx.itemQuantityChange.findMany({
      where: { tenancyId, id: { in: requests.flatMap((changes) => changes.map(({ id }) => id)) } },
    });
    const existingById = new Map(existingChanges.map((change) => [change.id, change]));
    const claimedIds = new Set(existingById.keys());

    // A retried attempt runs after the previous one rolled back, but Bulldozer
    // still holds the rows that attempt posted. Revert them before reading the
    // balance so this attempt does not see its own uncommitted debits.
    const staleChanges = postedChanges.filter(({ id }) => !existingById.has(id));
    if (staleChanges.length > 0) {
      await bulldozerWriteItemQuantityChanges(staleChanges.map((change) => ({ ...change, quantity: 0 })));
      const staleIds = new Set(staleChanges.map(({ id }) => id));
      postedChanges = postedChanges.filter(({ id }) => !staleIds.has(id));
    }

    let remainingQuantities: Map<string, number> | null = null;
    const results: PlanDebitResult[] = [];
    const acceptedChanges: PlanItemQuantityChange[] = [];
    const replayedChanges: typeof existingChanges = [];
    for (const changes of requests) {
      const ownedChanges = changes.filter(({ id }) => !claimedIds.has(id));
      if (ownedChanges.length === 0) {
        // Prisma-first dual-write can leave a committed row whose Bulldozer set
        // never landed. Re-POST the same row id through the existing set API.
        for (const { id } of changes) {
          const existing = existingById.get(id);
          if (existing != null) replayedChanges.push(existing);
        }
        results.push({ insufficientItemId: null, createdChangeIds: [] });
        continue;
      }

      remainingQuantities ??= new Map(Object.entries(await getItemQuantitiesForCustomer({
        prisma: tx,
        tenancyId,
        customerType: "team",
        customerId: billingTeamId,
      })));
      const nextQuantities: Map<string, number> = new Map(remainingQuantities);
      let insufficientItemId: MeteredPlanItemId | null = null;
      for (const change of ownedChanges) {
        const remaining = (nextQuantities.get(change.itemId) ?? 0) + change.quantity;
        if (remaining < 0) {
          insufficientItemId = change.itemId;
          break;
        }
        nextQuantities.set(change.itemId, remaining);
      }
      if (insufficientItemId != null) {
        results.push({ insufficientItemId, createdChangeIds: [] });
        continue;
      }
      remainingQuantities = nextQuantities;
      for (const { id } of ownedChanges) claimedIds.add(id);
      acceptedChanges.push(...ownedChanges);
      results.push({ insufficientItemId: null, createdChangeIds: ownedChanges.map(({ id }) => id) });
    }

    if (acceptedChanges.length > 0) {
      const persistResult = await Result.fromPromise(tx.itemQuantityChange.createMany({
        data: acceptedChanges,
        skipDuplicates: true,
      }));
      if (persistResult.status === "error") {
        throw persistResult.error;
      }
      const postedIds = new Set(postedChanges.map(({ id }) => id));
      postedChanges = [...postedChanges, ...acceptedChanges.filter(({ id }) => !postedIds.has(id))];
    }
    const bulldozerChanges = [...replayedChanges, ...acceptedChanges];
    if (bulldozerChanges.length > 0) {
      await bulldozerWriteItemQuantityChanges(bulldozerChanges);
    }
    finalBulldozerIds = new Set(bulldozerChanges.map(({ id }) => id));
    return results;
  }, { timeout: PLAN_DEBIT_TRANSACTION_TIMEOUT_MS }));

  // A retried transaction attempt may have posted rows that the committed
  // attempt no longer accepted (e.g. the balance changed in between).
  const abandoned = postedChanges.filter(({ id }) => !finalBulldozerIds.has(id));
  if (abandoned.length > 0) {
    const compensation = await Result.fromPromise(bulldozerWriteItemQuantityChanges(abandoned.map((change) => ({ ...change, quantity: 0 }))));
    if (compensation.status === "error") {
      captureError("plan-metering-bulldozer-compensation", compensation.error);
    }
  }
  return results;
}

export async function rollbackPlanItemDebits(
  billingTeamId: string,
  debits: readonly PlanItemDebit[],
  ownedChangeIds: ReadonlySet<string>,
): Promise<void> {
  const idempotentDebits = debits.filter(({ quantity }) => quantity !== 0);
  if (idempotentDebits.some((debit) => debit.idempotency == null)) {
    throw new HexclaveAssertionError("Only retry-stable plan item debits can be rolled back", {
      itemIds: idempotentDebits.map(({ itemId }) => itemId),
    });
  }
  if (idempotentDebits.length === 0) return;

  const { tenancy, prisma } = await getBillingContext(billingTeamId, idempotentDebits.map(({ itemId }) => itemId));
  const changes: PlanItemQuantityChange[] = idempotentDebits.map((debit) => {
    if (debit.idempotency == null) {
      throw new HexclaveAssertionError("Plan debit idempotency was validated but is missing", { itemId: debit.itemId });
    }
    return {
      id: deterministicPlanChangeId([
        "hexclave-plan-debit-v1",
        tenancy.id,
        billingTeamId,
        debit.itemId,
        debit.idempotency.key,
      ]),
      tenancyId: tenancy.id,
      customerId: billingTeamId,
      customerType: typedToUppercase("team"),
      itemId: debit.itemId,
      quantity: -debit.quantity,
      description: null,
      expiresAt: null,
      createdAt: debit.idempotency.createdAt,
    };
  });
  const ownedChanges = changes.filter(({ id }) => ownedChangeIds.has(id));
  if (ownedChanges.length === 0) return;

  await withPlanMeteringCustomerQueue(tenancy.id, billingTeamId, async () => await retryTransaction(prisma, async (tx) => {
    await lockPlanMeteringCustomer(tx, tenancy.id, billingTeamId);
    // The public item-quantity set API replaces a row. Writing quantity 0
    // undoes the debit without a delete route, and keeps the same id so a
    // later retry can set the debit again.
    await bulldozerWriteItemQuantityChanges(ownedChanges.map((change) => ({
      ...change,
      quantity: 0,
    })));
    await tx.itemQuantityChange.deleteMany({
      where: {
        tenancyId: tenancy.id,
        id: { in: ownedChanges.map(({ id }) => id) },
      },
    });
  }, { timeout: PLAN_DEBIT_TRANSACTION_TIMEOUT_MS }));
}

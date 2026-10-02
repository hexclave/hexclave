import { ensureCustomerExists } from "@/lib/payments";
import { bulldozerWriteItemQuantityChanges } from "@/lib/payments/bulldozer-dual-write";
import { getItemQuantitiesForCustomer } from "@/lib/payments/customer-data";
import { getPrismaClientForTenancy, retryTransaction, type PrismaClientTransaction } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
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

  return await withPlanMeteringCustomerQueue(tenancy.id, billingTeamId, async () => {
    // Bulldozer reads and writes are HTTP round-trips; keep them outside the
    // Postgres transaction so a slow Bulldozer cannot pin pool connections.
    const quantities = await getItemQuantitiesForCustomer({
      prisma,
      tenancyId: tenancy.id,
      customerType: "team",
      customerId: billingTeamId,
    });

    const persisted = await retryTransaction(prisma, async (tx) => {
      await lockPlanMeteringCustomer(tx, tenancy.id, billingTeamId);

      const existingChanges = await tx.itemQuantityChange.findMany({
        where: { tenancyId: tenancy.id, id: { in: changes.map(({ id }) => id) } },
      });
      const existingIds = new Set(existingChanges.map(({ id }) => id));
      const ownedChanges = changes.filter(({ id }) => !existingIds.has(id));
      if (ownedChanges.length === 0) {
        return { status: "replay" as const, existingChanges };
      }

      const remainingQuantities = new Map(Object.entries(quantities));
      for (const change of ownedChanges) {
        const remaining = (remainingQuantities.get(change.itemId) ?? 0) + change.quantity;
        if (remaining < 0) {
          return { status: "insufficient" as const, itemId: change.itemId };
        }
        remainingQuantities.set(change.itemId, remaining);
      }

      const persistResult = await Result.fromPromise(tx.itemQuantityChange.createMany({
        data: ownedChanges,
        skipDuplicates: true,
      }));
      if (persistResult.status === "error") {
        throw persistResult.error;
      }
      return { status: "created" as const, ownedChanges };
    });

    if (persisted.status === "insufficient") {
      return { insufficientItemId: persisted.itemId, createdChangeIds: [] };
    }
    if (persisted.status === "replay") {
      // Prisma-first dual-write can leave a committed row whose Bulldozer set
      // never landed. Re-POST the same row id through the existing set API.
      await bulldozerWriteItemQuantityChanges(persisted.existingChanges);
      return { insufficientItemId: null, createdChangeIds: [] };
    }
    await bulldozerWriteItemQuantityChanges(persisted.ownedChanges);
    return { insufficientItemId: null, createdChangeIds: persisted.ownedChanges.map(({ id }) => id) };
  });
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

  await withPlanMeteringCustomerQueue(tenancy.id, billingTeamId, async () => {
    // The public item-quantity set API replaces a row. Writing quantity 0
    // undoes the debit without a delete route, and keeps the same id so a
    // later retry can set the debit again.
    await bulldozerWriteItemQuantityChanges(ownedChanges.map((change) => ({
      ...change,
      quantity: 0,
    })));
    await retryTransaction(prisma, async (tx) => {
      await lockPlanMeteringCustomer(tx, tenancy.id, billingTeamId);
      await tx.itemQuantityChange.deleteMany({
        where: {
          tenancyId: tenancy.id,
          id: { in: ownedChanges.map(({ id }) => id) },
        },
      });
    });
  });
}

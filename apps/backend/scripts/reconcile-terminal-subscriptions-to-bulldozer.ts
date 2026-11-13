/**
 * Re-emits terminal Subscription rows after the endedAt data migration.
 *
 * The SQL migration only updates Postgres. Bulldozer is an explicitly
 * dual-written read model, so it otherwise keeps endedAtMillis=null and keeps
 * historical grants alive forever. This command deliberately reads the
 * primary: reading the replica immediately after the migration can publish the
 * pre-migration null back into Bulldozer.
 *
 * After Bulldozer has processed the corrected end times, the command also
 * revisits expired internal billing-team subscriptions. Those rows can be
 * older than the recurring free-plan sweep's bounded lookback, so this is their
 * only opportunity to receive a replacement free plan during rollout.
 *
 * Safe to re-run: Bulldozer row writes and free-plan grants are idempotent.
 */

import { CustomerType, SubscriptionStatus } from "@/generated/prisma/client";
import { bulldozerWriteSubscriptions } from "@/lib/payments/bulldozer-dual-write";
import { ensureFreePlanForBillingTeam, getInternalBillingTenancy } from "@/lib/payments/ensure-free-plan";
import { globalPrismaClient } from "@/prisma-client";
import { wait } from "@hexclave/shared/dist/utils/promises";

const DEFAULT_BATCH_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TERMINAL_SUBSCRIPTION_STATUSES = [
  SubscriptionStatus.canceled,
  SubscriptionStatus.incomplete_expired,
  SubscriptionStatus.unpaid,
] as const;

type Cursor = { tenancyId: string, id: string };
type SubscriptionRow = Parameters<typeof bulldozerWriteSubscriptions>[0][number];
type ExpiredInternalSubscription = { id: string, customerId: string };

export type ReconcileTerminalSubscriptionsOptions = {
  batchSize?: number,
  resumeCursor?: Cursor,
};

export type ReconcileTerminalSubscriptionsResult = {
  subscriptionsReconciled: number,
  freePlanCandidates: number,
  freePlansGranted: number,
};

export type ReconcileTerminalSubscriptionsDependencies = {
  countTerminalSubscriptionsWithoutEndedAt: () => Promise<number>,
  fetchTerminalSubscriptionBatch: (cursor: Cursor | null, batchSize: number) => Promise<SubscriptionRow[]>,
  writeSubscriptions: (rows: SubscriptionRow[]) => Promise<void>,
  settleBulldozerTimeFolds: () => Promise<void>,
  getInternalBillingTenancyId: () => Promise<string>,
  fetchExpiredInternalSubscriptionBatch: (
    internalTenancyId: string,
    endedAtOrBefore: Date,
    cursorId: string | null,
    batchSize: number,
  ) => Promise<ExpiredInternalSubscription[]>,
  filterExistingBillingTeamIds: (internalTenancyId: string, billingTeamIds: string[]) => Promise<string[]>,
  ensureFreePlan: (billingTeamId: string) => Promise<boolean>,
  now: () => Date,
};

function log(message: string): void {
  console.log(`[ReconcileTerminalSubscriptions] ${message}`);
}

function terminalSubscriptionCursorWhere(cursor: Cursor | null) {
  if (cursor === null) return {};
  return {
    OR: [
      { tenancyId: { gt: cursor.tenancyId } },
      { tenancyId: cursor.tenancyId, id: { gt: cursor.id } },
    ],
  };
}

const defaultDependencies: ReconcileTerminalSubscriptionsDependencies = {
  countTerminalSubscriptionsWithoutEndedAt: async () => {
    return await globalPrismaClient.subscription.count({
      where: {
        status: { in: [...TERMINAL_SUBSCRIPTION_STATUSES] },
        endedAt: null,
      },
    });
  },
  fetchTerminalSubscriptionBatch: async (cursor, batchSize) => {
    // This correctness repair must observe the migration commit. Do not change
    // this to `$replica()` without first adding an explicit WAL/LSN barrier.
    return await globalPrismaClient.subscription.findMany({
      where: {
        status: { in: [...TERMINAL_SUBSCRIPTION_STATUSES] },
        endedAt: { not: null },
        ...terminalSubscriptionCursorWhere(cursor),
      },
      orderBy: [{ tenancyId: "asc" }, { id: "asc" }],
      take: batchSize,
    });
  },
  writeSubscriptions: bulldozerWriteSubscriptions,
  settleBulldozerTimeFolds: async () => await wait(1500),
  getInternalBillingTenancyId: async () => (await getInternalBillingTenancy()).id,
  fetchExpiredInternalSubscriptionBatch: async (internalTenancyId, endedAtOrBefore, cursorId, batchSize) => {
    return await globalPrismaClient.subscription.findMany({
      where: {
        tenancyId: internalTenancyId,
        customerType: CustomerType.TEAM,
        status: { in: [...TERMINAL_SUBSCRIPTION_STATUSES] },
        endedAt: { lte: endedAtOrBefore },
        ...(cursorId === null ? {} : { id: { gt: cursorId } }),
      },
      select: { id: true, customerId: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
  },
  filterExistingBillingTeamIds: async (internalTenancyId, billingTeamIds) => {
    const teams = await globalPrismaClient.team.findMany({
      where: {
        tenancyId: internalTenancyId,
        teamId: { in: billingTeamIds },
      },
      select: { teamId: true },
    });
    return teams.map((team) => team.teamId);
  },
  ensureFreePlan: ensureFreePlanForBillingTeam,
  now: () => new Date(),
};

function readFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const equalsForm = args.find((arg) => arg.startsWith(prefix));
  if (equalsForm !== undefined) return equalsForm.slice(prefix.length);

  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  if (index + 1 >= args.length) {
    throw new Error(`--${name} requires a value`);
  }
  const value = args[index + 1];
  if (value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

export function parseReconcileTerminalSubscriptionsArgs(args: string[]): ReconcileTerminalSubscriptionsOptions {
  const batchSizeRaw = readFlag(args, "batch-size");
  let batchSize: number | undefined;
  if (batchSizeRaw !== undefined) {
    const parsed = Number(batchSizeRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--batch-size must be a positive integer (got ${JSON.stringify(batchSizeRaw)})`);
    }
    batchSize = parsed;
  }

  const resumeCursorRaw = readFlag(args, "resume-cursor");
  let resumeCursor: Cursor | undefined;
  if (resumeCursorRaw !== undefined) {
    const separator = resumeCursorRaw.indexOf(",");
    const tenancyId = separator === -1 ? "" : resumeCursorRaw.slice(0, separator).toLowerCase();
    const id = separator === -1 ? "" : resumeCursorRaw.slice(separator + 1).toLowerCase();
    if (!UUID_RE.test(tenancyId) || !UUID_RE.test(id)) {
      throw new Error("--resume-cursor must be <tenancyId>,<subscriptionId> with two UUIDs");
    }
    resumeCursor = { tenancyId, id };
  }

  return {
    ...(batchSize === undefined ? {} : { batchSize }),
    ...(resumeCursor === undefined ? {} : { resumeCursor }),
  };
}

export async function runReconcileTerminalSubscriptionsToBulldozer(
  options: ReconcileTerminalSubscriptionsOptions = {},
  dependencies: ReconcileTerminalSubscriptionsDependencies = defaultDependencies,
): Promise<ReconcileTerminalSubscriptionsResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const remainingNullRows = await dependencies.countTerminalSubscriptionsWithoutEndedAt();
  if (remainingNullRows !== 0) {
    throw new Error(
      `Refusing to reconcile Bulldozer: ${remainingNullRows} terminal Subscription row(s) still have endedAt=NULL. `
      + "Apply the terminal-subscription endedAt migration completely before running this command.",
    );
  }

  let cursor = options.resumeCursor ?? null;
  let subscriptionsReconciled = 0;
  let subscriptionBatchNumber = 0;
  log(`Starting subscription reconciliation (batchSize=${batchSize}${cursor === null ? "" : `, resumeAfter=${cursor.tenancyId},${cursor.id}`})`);

  for (;;) {
    const batch = await dependencies.fetchTerminalSubscriptionBatch(cursor, batchSize);
    if (batch.length === 0) break;

    await dependencies.writeSubscriptions(batch);

    const last = batch[batch.length - 1];
    const nextCursor = { tenancyId: last.tenancyId, id: last.id };
    if (cursor !== null && nextCursor.tenancyId === cursor.tenancyId && nextCursor.id === cursor.id) {
      throw new Error(`Subscription cursor failed to advance at ${cursor.tenancyId},${cursor.id}`);
    }
    cursor = nextCursor;
    subscriptionsReconciled += batch.length;
    subscriptionBatchNumber++;
    log(`Subscription batch=${subscriptionBatchNumber} rows=${batch.length} total=${subscriptionsReconciled} cursor=${cursor.tenancyId},${cursor.id}`);

    if (batch.length < batchSize) break;
  }

  // End events introduced by a rewrite can require bulldozer-js's one-second
  // TimeFold tick. Free-plan occupancy checks must run after that convergence.
  await dependencies.settleBulldozerTimeFolds();

  const endedAtOrBefore = dependencies.now();
  const internalTenancyId = await dependencies.getInternalBillingTenancyId();
  let expiredCursorId: string | null = null;
  let freePlanCandidates = 0;
  let freePlansGranted = 0;
  let freePlanBatchNumber = 0;

  for (;;) {
    const batch = await dependencies.fetchExpiredInternalSubscriptionBatch(
      internalTenancyId,
      endedAtOrBefore,
      expiredCursorId,
      batchSize,
    );
    if (batch.length === 0) break;

    // A team can have multiple historical terminal subscriptions. Deduping each
    // page keeps memory bounded; duplicate calls across pages are harmless
    // because ensureFreePlanForBillingTeam is idempotent.
    const candidateBillingTeamIds = [...new Set(batch.map((subscription) => subscription.customerId))];
    // Subscription.customerId is intentionally not foreign-keyed to Team. A
    // historical row can therefore outlive its team; do not manufacture an
    // orphaned free Subscription for such a deleted customer.
    const existingBillingTeamIds = await dependencies.filterExistingBillingTeamIds(
      internalTenancyId,
      candidateBillingTeamIds,
    );
    for (const billingTeamId of existingBillingTeamIds) {
      freePlanCandidates++;
      if (await dependencies.ensureFreePlan(billingTeamId)) {
        freePlansGranted++;
      }
    }

    const last = batch[batch.length - 1];
    if (last.id === expiredCursorId) {
      throw new Error(`Expired-subscription cursor failed to advance at ${last.id}`);
    }
    expiredCursorId = last.id;
    freePlanBatchNumber++;
    log(`Free-plan batch=${freePlanBatchNumber} rows=${batch.length} candidates=${freePlanCandidates} granted=${freePlansGranted} cursor=${expiredCursorId}`);

    if (batch.length < batchSize) break;
  }

  log(`Done. subscriptionsReconciled=${subscriptionsReconciled} freePlanCandidates=${freePlanCandidates} freePlansGranted=${freePlansGranted}`);
  return { subscriptionsReconciled, freePlanCandidates, freePlansGranted };
}

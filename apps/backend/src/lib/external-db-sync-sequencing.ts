import { Prisma } from "@/generated/prisma/client";
import { SEQUENCE_ALLOCATION_ADVISORY_LOCK_KEY } from "@hexclave/shared/dist/config/db-sync-mappings";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

/**
 * Runs one set-based sequence allocation while holding the global transaction-scoped lock.
 *
 * Sequence allocation must commit in allocation order: the sync's `> watermark` filter
 * permanently skips a lower value if a higher value becomes visible first. The lock is global
 * because each batch statement can span multiple tenancies.
 */
export async function runSequenceAllocationInTransaction<T>(
  tx: Prisma.TransactionClient,
  allocation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T | null> {
  const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(${SEQUENCE_ALLOCATION_ADVISORY_LOCK_KEY}::int) AS locked
  `;
  const locked = lockRows[0]?.locked ?? throwErr(
    "Sequence allocation advisory lock query must return exactly one row",
  );
  if (!locked) return null;
  return await allocation(tx);
}

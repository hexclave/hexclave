import { globalPrismaClient } from "@/prisma-client";

export const EXPOSURE_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPOSURE_RECEIPT_CLEANUP_BATCH_SIZE = 1_000;

/**
 * Deletes one globally ordered retention page. This runs from the existing
 * feature-flag cron so receipts from a project that stops sending traffic do
 * not remain forever. The createdAt index keeps every tick bounded even when
 * the ledger contains millions of rows.
 */
export async function cleanupExpiredFeatureFlagExposureReceipts(now: Date): Promise<number> {
  const expiresBefore = new Date(now.getTime() - EXPOSURE_RECEIPT_RETENTION_MS);
  return await globalPrismaClient.$executeRaw`
    DELETE FROM "FeatureFlagExposureReceipt"
    WHERE "id" IN (
      SELECT "id"
      FROM "FeatureFlagExposureReceipt"
      WHERE "createdAt" < ${expiresBefore}
      ORDER BY "createdAt" ASC
      LIMIT ${EXPOSURE_RECEIPT_CLEANUP_BATCH_SIZE}
    )
  `;
}

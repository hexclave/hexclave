import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EmailOutboxCreatedWith, Prisma } from "@/generated/prisma/client";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { runSequenceAllocationInTransaction } from "@/lib/external-db-sync-sequencing";
import { getSoleTenancyFromProjectBranch } from "./tenancies";
import { recordExternalDbSyncDeletion } from "./external-db-sync";

type SequencedRow = {
  tenancyId: string,
  id: string,
  sequenceId: bigint,
};

async function createEmailOutbox(tenancyId: string, id: string): Promise<void> {
  await globalPrismaClient.emailOutbox.create({
    data: {
      id,
      tenancyId,
      tsxSource: `/* sequence-visibility-test-${id} */`,
      themeId: null,
      isHighPriority: false,
      to: { type: "custom-emails", emails: [`sequence-visibility-${id}@example.com`] },
      extraRenderVariables: {},
      shouldSkipDeliverabilityCheck: true,
      createdWith: EmailOutboxCreatedWith.PROGRAMMATIC_CALL,
      scheduledAt: new Date(),
      isQueued: true,
      renderedByWorkerId: "00000000-0000-0000-0000-000000000000",
      startedRenderingAt: new Date(),
      finishedRenderingAt: new Date(),
      renderedHtml: "<p>sequence visibility test</p>",
      renderedText: "sequence visibility test",
      renderedSubject: "sequence visibility test",
      renderedIsTransactional: false,
      shouldUpdateSequenceId: false,
      startedSendingAt: null,
      finishedSendingAt: null,
      sendRetries: 0,
      nextSendRetryAt: null,
      isPaused: true,
    },
  });
}

async function allocateEmailOutboxSequence(
  tx: Prisma.TransactionClient,
  row: { tenancyId: string, id: string },
): Promise<{ sequenceId: bigint }[] | null> {
  return await runSequenceAllocationInTransaction(tx, async (lockedTx) =>
    await lockedTx.$queryRaw<{ sequenceId: bigint }[]>`
      WITH rows_to_update AS (
        SELECT "tenancyId", "id"
        FROM "EmailOutbox"
        WHERE "tenancyId" = ${row.tenancyId}::uuid
          AND "id" = ${row.id}::uuid
          AND "shouldUpdateSequenceId" = TRUE
        FOR UPDATE SKIP LOCKED
      ),
      updated_rows AS (
        UPDATE "EmailOutbox" eo
        SET "sequenceId" = nextval('global_seq_id'),
            "shouldUpdateSequenceId" = FALSE
        FROM rows_to_update r
        WHERE eo."tenancyId" = r."tenancyId"
          AND eo."id" = r."id"
        RETURNING eo."sequenceId"
      )
      SELECT "sequenceId" FROM updated_rows
    `,
  );
}

describe("external DB sync sequence visibility", () => {
  it("requires visible higher sequence IDs to imply visibility of all lower assigned IDs", async () => {
    const tenancyId = (await getSoleTenancyFromProjectBranch("internal", "main")).id;
    const rowA: SequencedRow = { tenancyId, id: randomUUID(), sequenceId: 0n };
    const rowB: SequencedRow = { tenancyId, id: randomUUID(), sequenceId: 0n };
    let releaseTransactionA: () => void = () => undefined;
    let resolveTransactionAAllocated: () => void = () => undefined;
    const transactionAReleased = new Promise<void>((resolve) => {
      releaseTransactionA = resolve;
    });
    const transactionAAllocated = new Promise<void>((resolve) => {
      resolveTransactionAAllocated = resolve;
    });
    let transactionA: Promise<void> | undefined;
    let allocationA: bigint | undefined;
    let testError: unknown;
    let cleanupError: unknown;

    try {
      await createEmailOutbox(tenancyId, rowA.id);
      await createEmailOutbox(tenancyId, rowB.id);
      // This raw interactive transaction is deliberately held open to test visibility before commit.
      // retryTransaction cannot be used here because its injected failures would make the gate flaky.
      // eslint-disable-next-line no-restricted-syntax
      transactionA = globalPrismaClient.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE "EmailOutbox"
          SET "shouldUpdateSequenceId" = TRUE
          WHERE "tenancyId" = ${tenancyId}::uuid
            AND "id" = ${rowA.id}::uuid
        `;
        const allocationDeadline = performance.now() + 10_000;
        let allocation: { sequenceId: bigint }[] | null = null;
        while (allocation == null && performance.now() < allocationDeadline) {
          allocation = await allocateEmailOutboxSequence(tx, rowA);
          if (allocation == null) await wait(50);
        }
        if (allocation == null) {
          throwErr(
            "Sequence allocation lock remained unavailable while acquiring row A in the regression test",
          );
        }
        allocationA = allocation[0]?.sequenceId ?? throwErr(
          `Sequence allocation must return row A's sequence ID for EmailOutbox ${rowA.id}`,
        );
        resolveTransactionAAllocated();
        await transactionAReleased;
      }, { maxWait: 10_000, timeout: 60_000 });
      await Promise.race([
        transactionAAllocated,
        transactionA.then(() => throwErr("Allocation transaction exited before reaching its gate")),
      ]);

      const transactionBAttempt = await retryTransaction(globalPrismaClient, async (tx) => {
        await tx.$executeRaw`
          UPDATE "EmailOutbox"
          SET "shouldUpdateSequenceId" = TRUE
          WHERE "tenancyId" = ${tenancyId}::uuid
            AND "id" = ${rowB.id}::uuid
        `;
        return await allocateEmailOutboxSequence(tx, rowB);
      }, { timeout: 5_000 });
      expect(
        transactionBAttempt,
        "A second allocation must skip while the first allocation transaction is still open",
      ).toBeNull();

      releaseTransactionA();
      await transactionA;

      const sequenceBDeadline = performance.now() + 10_000;
      let sequenceB: bigint | undefined;
      while (sequenceB == null && performance.now() < sequenceBDeadline) {
        sequenceB = await retryTransaction(
          globalPrismaClient,
          async (tx) => {
            const existingRow = await tx.emailOutbox.findUnique({
              where: { tenancyId_id: { tenancyId, id: rowB.id } },
              select: { sequenceId: true },
            });
            if (existingRow?.sequenceId != null) return existingRow.sequenceId;

            await allocateEmailOutboxSequence(tx, rowB);
            const allocatedRow = await tx.emailOutbox.findUnique({
              where: { tenancyId_id: { tenancyId, id: rowB.id } },
              select: { sequenceId: true },
            });
            return allocatedRow?.sequenceId;
          },
          { timeout: 10_000 },
        ) ?? undefined;
        if (sequenceB == null) await wait(50);
      }
      rowA.sequenceId = allocationA ?? throwErr(`Sequencer did not update EmailOutbox ${rowA.id}`);
      rowB.sequenceId = sequenceB ?? throwErr(`Sequencer did not update EmailOutbox ${rowB.id}`);
      expect(rowA.sequenceId).toBeLessThan(rowB.sequenceId);

      const visibleRows = await globalPrismaClient.emailOutbox.findMany({
        where: { tenancyId, id: { in: [rowA.id, rowB.id] }, sequenceId: { not: null } },
        select: { id: true, sequenceId: true },
        orderBy: { sequenceId: "asc" },
      });
      expect(visibleRows).toEqual([
        { id: rowA.id, sequenceId: rowA.sequenceId },
        { id: rowB.id, sequenceId: rowB.sequenceId },
      ]);
    } catch (error) {
      testError = error;
    } finally {
      try {
        releaseTransactionA();
        if (transactionA != null) await transactionA;

        await retryTransaction(globalPrismaClient, async (tx) => {
          await recordExternalDbSyncDeletion(tx, {
            tableName: "EmailOutbox",
            tenancyId,
            emailOutboxId: rowA.id,
          });
          await recordExternalDbSyncDeletion(tx, {
            tableName: "EmailOutbox",
            tenancyId,
            emailOutboxId: rowB.id,
          });
          await tx.emailOutbox.deleteMany({
            where: { tenancyId, id: { in: [rowA.id, rowB.id] } },
          });
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (testError != null) throw testError;
    if (cleanupError != null) throw cleanupError;
  });
});

import { randomUUID } from "node:crypto";
import { EmailOutboxCreatedWith, PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globalPrismaClient, globalPrismaSchema, retryTransaction, sqlQuoteIdent } from "@/prisma-client";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { enqueueExternalDbSync, enqueueExternalDbSyncBatch } from "./external-db-sync-queue";
import { recordExternalDbSyncDeletion } from "./external-db-sync";
import { getSoleTenancyFromProjectBranch } from "./tenancies";

const DEDUP_PREFIX = "sentinel-sync-key-";

// Use a scratch schema because the real OutgoingRequest table is a live queue
// consumed by the poller, which can claim or delete rows while these tests run.
const scratchSchema = `external_db_sync_test_${randomUUID().replaceAll("-", "")}`;

let scratchPool: Pool | undefined;
let scratchClient: PrismaClient | undefined;

function getScratchClient() {
  return scratchClient ?? throwErr("Scratch Prisma client has not been initialized");
}

function freshTenancyIds(count: number): string[] {
  return Array.from({ length: count }, () => randomUUID());
}

async function findRowsForTenancies(tenancyIds: string[]) {
  return await getScratchClient().outgoingRequest.findMany({
    where: { deduplicationKey: { in: tenancyIds.map((id) => DEDUP_PREFIX + id) } },
    orderBy: { deduplicationKey: "asc" },
  });
}

beforeAll(async () => {
  const databaseConnectionString = getEnvVariable("STACK_DATABASE_CONNECTION_STRING", "") || throwErr("Missing database connection string for external DB sync queue tests");
  await globalPrismaClient.$executeRaw`CREATE SCHEMA ${sqlQuoteIdent(scratchSchema)}`;
  await globalPrismaClient.$executeRaw`
    CREATE TABLE ${sqlQuoteIdent(scratchSchema)}."OutgoingRequest"
    (LIKE ${sqlQuoteIdent(globalPrismaSchema)}."OutgoingRequest" INCLUDING ALL)
  `;

  const indexes = await globalPrismaClient.$queryRaw<{ indexname: string, indexdef: string }[]>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = ${scratchSchema}
      AND tablename = 'OutgoingRequest'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%startedFulfillingAt%'
  `;
  expect(indexes).toHaveLength(1);

  // Pool search_path covers the enqueue's unqualified raw SQL; PrismaPg's schema covers model API queries.
  scratchPool = new Pool({
    connectionString: databaseConnectionString,
    max: 10,
    options: `-c search_path=${scratchSchema}`,
  });
  scratchClient = new PrismaClient({
    adapter: new PrismaPg(scratchPool, { schema: scratchSchema }),
  });
  await scratchClient.$connect();

  const modelApiSentinel = `sentinel-sync-key-model-api-${randomUUID()}`;
  const client = getScratchClient();
  // Verify the model API uses the scratch table rather than the live public table.
  await client.outgoingRequest.create({
    data: {
      qstashOptions: { modelApiSentinel },
      deduplicationKey: modelApiSentinel,
    },
  });
  const scratchRows = await client.outgoingRequest.findMany({
    where: { deduplicationKey: modelApiSentinel },
  });
  const realRows = await globalPrismaClient.outgoingRequest.findMany({
    where: { deduplicationKey: modelApiSentinel },
  });
  expect(scratchRows).toHaveLength(1);
  expect(realRows).toHaveLength(0);
  await client.outgoingRequest.deleteMany({
    where: { deduplicationKey: modelApiSentinel },
  });
});

afterAll(async () => {
  await globalPrismaClient.$executeRaw`DROP SCHEMA IF EXISTS ${sqlQuoteIdent(scratchSchema)} CASCADE`;
  if (scratchClient != null) await scratchClient.$disconnect();
  if (scratchPool != null) await scratchPool.end();
});

describe("enqueueExternalDbSyncBatch (real DB, isolated schema)", () => {
  it("inserts one pending row per tenancy with the expected qstash options", async ({ expect }) => {
    const [tenancyId] = freshTenancyIds(1);

    await enqueueExternalDbSync(tenancyId, getScratchClient());

    const rows = await findRowsForTenancies([tenancyId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].startedFulfillingAt).toBeNull();
    expect(rows[0].qstashOptions).toMatchObject({
      url: "/api/latest/internal/external-db-sync/sync-engine",
      body: { tenancyId },
      job: {
        schemaVersion: 1,
        jobId: `${DEDUP_PREFIX}${tenancyId}`,
        jobType: "external-db-sync",
        tenancyId,
        deduplicationKey: `${DEDUP_PREFIX}${tenancyId}`,
        payload: { tenancyId },
      },
      flowControl: { key: "sentinel-sync-key", parallelism: 20 },
    });
  });

  it("produces the same rows regardless of input order and deduplicates within the batch", async ({ expect }) => {
    const ids = freshTenancyIds(5);
    const shuffled = [...ids].reverse();
    // Duplicates within one call must collapse to a single row per tenancy.
    const withDuplicates = [...shuffled, ...ids, ids[2]];

    await enqueueExternalDbSyncBatch(withDuplicates, getScratchClient());

    const rows = await findRowsForTenancies(ids);
    expect(rows).toHaveLength(ids.length);
    expect(new Set(rows.map((r) => r.deduplicationKey))).toEqual(new Set(ids.map((id) => DEDUP_PREFIX + id)));
  });

  it("skips tenancies that already have a pending row, even when re-enqueued in a different order", async ({ expect }) => {
    const ids = freshTenancyIds(4);

    await enqueueExternalDbSyncBatch(ids, getScratchClient());
    await enqueueExternalDbSyncBatch([...ids].reverse(), getScratchClient());

    const rows = await findRowsForTenancies(ids);
    expect(rows).toHaveLength(ids.length);
  });

  it("enqueues a new pending row once the previous one has been claimed", async ({ expect }) => {
    const [tenancyId] = freshTenancyIds(1);

    await enqueueExternalDbSync(tenancyId, getScratchClient());
    // Simulate the poller claiming the row: the partial unique index only
    // covers rows WHERE startedFulfillingAt IS NULL, so a claimed row must not
    // block a fresh sync request for the same tenancy.
    await getScratchClient().outgoingRequest.updateMany({
      where: { deduplicationKey: DEDUP_PREFIX + tenancyId },
      data: { startedFulfillingAt: new Date() },
    });

    await enqueueExternalDbSync(tenancyId, getScratchClient());

    const rows = await findRowsForTenancies([tenancyId]);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.startedFulfillingAt === null)).toHaveLength(1);
  });

  it("rejects non-UUID tenancy IDs", async ({ expect }) => {
    await expect(enqueueExternalDbSyncBatch(["not-a-uuid"], getScratchClient())).rejects.toThrow("tenancyId must be a valid UUID");
    await expect(enqueueExternalDbSyncBatch([randomUUID(), "'; DROP TABLE \"OutgoingRequest\"; --"], getScratchClient())).rejects.toThrow("tenancyId must be a valid UUID");
  });

  // Regression test for a production deadlock (SQLSTATE 40P01): two concurrent
  // batches inserting overlapping tenancies in different orders acquired the
  // partial unique index locks in opposite orders. The fix canonicalizes the
  // insert order (JS sort + SQL ORDER BY), so concurrent batches always lock
  // in the same order and can never deadlock against each other. This test
  // hammers exactly that scenario; without the sort it deadlocks flakily,
  // with it a deadlock is impossible, so the test cannot be flaky post-fix.
  it("does not deadlock when concurrent batches enqueue the same tenancies in opposite orders", async ({ expect }) => {
    const ITERATIONS = 10;
    const BATCH_SIZE = 50;

    for (let i = 0; i < ITERATIONS; i++) {
      const ids = freshTenancyIds(BATCH_SIZE);
      await Promise.all([
        enqueueExternalDbSyncBatch(ids, getScratchClient()),
        enqueueExternalDbSyncBatch([...ids].reverse(), getScratchClient()),
      ]);

      const rows = await findRowsForTenancies(ids);
      expect(rows).toHaveLength(BATCH_SIZE);
    }
  });
});

describe("recordExternalDbSyncDeletion", () => {
  it("writes an EmailOutbox tombstone with the complete primary key in the delete transaction", async () => {
    const tenancyId = (await getSoleTenancyFromProjectBranch("internal", "main")).id;
    const id = randomUUID();

    await retryTransaction(globalPrismaClient, async (tx) => {
      await tx.emailOutbox.create({
        data: {
          id,
          tenancyId,
          tsxSource: `/* external-db-sync-test-${id} */`,
          themeId: null,
          isHighPriority: false,
          to: { type: "custom-emails", emails: ["external-db-sync-test@example.com"] },
          extraRenderVariables: {},
          shouldSkipDeliverabilityCheck: true,
          createdWith: EmailOutboxCreatedWith.PROGRAMMATIC_CALL,
          scheduledAt: new Date(),
          isQueued: true,
          renderedByWorkerId: "00000000-0000-0000-0000-000000000000",
          startedRenderingAt: new Date(),
          finishedRenderingAt: new Date(),
          renderedHtml: "<p>external DB sync test</p>",
          renderedText: "external DB sync test",
          renderedSubject: "external DB sync test",
          renderedIsTransactional: false,
          startedSendingAt: null,
          finishedSendingAt: null,
          sendRetries: 0,
          nextSendRetryAt: null,
          isPaused: true,
        },
      });
    });

    try {
      await retryTransaction(globalPrismaClient, async (tx) => {
        await recordExternalDbSyncDeletion(tx, {
          tableName: "EmailOutbox",
          tenancyId,
          emailOutboxId: id,
        });
        await tx.emailOutbox.delete({
          where: { tenancyId_id: { tenancyId, id } },
        });
      });

      // Read from primary because the tombstone was just committed and replica lag would make this assertion flaky.
      const tombstones = await globalPrismaClient.$queryRaw<{
        primaryKey: { tenancyId: string, id: string },
        shouldUpdateSequenceId: boolean,
      }[]>`
        SELECT "primaryKey", "shouldUpdateSequenceId"
        FROM "DeletedRow"
        WHERE "tableName" = 'EmailOutbox'
          AND "tenancyId" = ${tenancyId}::uuid
          AND "primaryKey"->>'id' = ${id}
        ORDER BY "sequenceId" DESC
        LIMIT 1
      `;
      expect(tombstones).toHaveLength(1);
      expect(tombstones[0]).toMatchObject({
        primaryKey: { tenancyId, id },
        shouldUpdateSequenceId: true,
      });
      expect(await globalPrismaClient.emailOutbox.findUnique({
        where: { tenancyId_id: { tenancyId, id } },
      })).toBeNull();
    } finally {
      await retryTransaction(globalPrismaClient, async (tx) => {
        await recordExternalDbSyncDeletion(tx, {
          tableName: "EmailOutbox",
          tenancyId,
          emailOutboxId: id,
        });
        await tx.emailOutbox.deleteMany({
          where: { tenancyId, id },
        });
      });
    }
  });
});

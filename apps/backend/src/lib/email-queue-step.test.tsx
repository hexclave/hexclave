import { BooleanTrue, EmailOutboxCreatedWith } from "@/generated/prisma/client";
import { globalPrismaClient, retryTransaction, type PrismaClientTransaction } from "@/prisma-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { recordExternalDbSyncDeletion } from "./external-db-sync";
import { _forTesting } from "./email-queue-step";
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch } from "./tenancies";

const {
  claimEmailsForSending,
  claimEmailsForSendingWithinLock,
  failEmailsStuckInSending,
  STUCK_EMAIL_TIMEOUT_MS,
  updateLastExecutionTime,
  withTenancyClaimLock,
} = _forTesting;

describe.sequential("updateLastExecutionTime", () => {
  const metadataKeys: string[] = [];

  afterAll(async () => {
    await globalPrismaClient.emailOutboxProcessingMetadata.deleteMany({
      where: { key: { in: metadataKeys } },
    });
  });

  it("does not move lastExecutedAt backwards when the stored timestamp is ahead", async () => {
    const key = `email-queue-step-delta-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    metadataKeys.push(key);

    const futureTimestamp = new Date(Date.now() + 60_000);
    await globalPrismaClient.emailOutboxProcessingMetadata.create({
      data: {
        key,
        lastExecutedAt: futureTimestamp,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const delta = await updateLastExecutionTime(key);

      expect(delta).toBe(0);
      expect(warnSpy).not.toHaveBeenCalled();

      const after = await globalPrismaClient.emailOutboxProcessingMetadata.findUniqueOrThrow({
        where: { key },
      });
      expect(after.lastExecutedAt?.toISOString()).toBe(futureTimestamp.toISOString());
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// These tests connect to the real dev DB (like payments.test.tsx) and create real EmailOutbox
// rows against the seeded `internal` tenancy. Each row is tagged with a unique tsxSource so we
// can find and clean up just our test rows.
describe.sequential("failEmailsStuckInSending", () => {
  const testRunTag = `stuck-in-sending-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdIds: { tenancyId: string, id: string }[] = [];

  const recoveryTestFilter = { tsxSource: `/* ${testRunTag} */` };

  const makeRow = async (params: {
    startedSendingAt: Date | null,
    finishedSendingAt?: Date | null,
    isPaused?: boolean,
    sendRetries?: number,
    nextSendRetryAt?: Date | null,
  }) => {
    const tenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID);
    const created = await globalPrismaClient.emailOutbox.create({
      data: {
        tenancyId: tenancy.id,
        tsxSource: recoveryTestFilter.tsxSource,
        themeId: null,
        isHighPriority: false,
        to: { type: "custom-emails", emails: ["stuck-test@example.com"] },
        extraRenderVariables: {},
        shouldSkipDeliverabilityCheck: true,
        createdWith: EmailOutboxCreatedWith.PROGRAMMATIC_CALL,
        scheduledAt: new Date(0),
        isQueued: true,
        renderedByWorkerId: "00000000-0000-0000-0000-000000000000",
        startedRenderingAt: new Date(0),
        finishedRenderingAt: new Date(0),
        renderedHtml: "<p>stuck</p>",
        renderedText: "stuck",
        renderedSubject: "stuck",
        renderedIsTransactional: false,
        startedSendingAt: params.startedSendingAt,
        finishedSendingAt: params.finishedSendingAt ?? null,
        sendRetries: params.sendRetries ?? 0,
        nextSendRetryAt: params.nextSendRetryAt ?? null,
        isPaused: params.isPaused ?? false,
      },
    });
    createdIds.push({ tenancyId: created.tenancyId, id: created.id });
    return created;
  };

  afterAll(async () => {
    await retryTransaction(globalPrismaClient, async (tx) => {
      for (const { tenancyId, id } of createdIds) {
        // Deletions of synced tables only reach ClickHouse through DeletedRow.
        await recordExternalDbSyncDeletion(tx, {
          tableName: "EmailOutbox",
          tenancyId,
          emailOutboxId: id,
        });
        await tx.emailOutbox.deleteMany({ where: { tenancyId, id } });
      }
    });
  });

  it("marks a row as failed when startedSendingAt is older than the stuck timeout", async () => {
    const longAgo = new Date(Date.now() - STUCK_EMAIL_TIMEOUT_MS - 60_000);
    const row = await makeRow({
      startedSendingAt: longAgo,
      sendRetries: 1,
      nextSendRetryAt: new Date(Date.now() + 60_000),
    });

    await failEmailsStuckInSending(recoveryTestFilter);

    const after = await globalPrismaClient.emailOutbox.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: row.tenancyId, id: row.id } },
    });
    expect(after.finishedSendingAt).not.toBeNull();
    expect(after.startedSendingAt?.toISOString()).toBe(row.startedSendingAt?.toISOString());
    expect(after.canHaveDeliveryInfo).toBe(false);
    expect(after.sendServerErrorExternalMessage).toMatch(/timed out/i);
    expect(after.sendServerErrorInternalMessage).toMatch(/stuck in sending/i);
    expect(after.sendServerErrorInternalMessage).toMatch(/terminal server error/i);
    // Must be a terminal state — no retry scheduled.
    expect(after.nextSendRetryAt).toBeNull();
    // sendRetries is not bumped by this path (we never attempted the send again).
    expect(after.sendRetries).toBe(row.sendRetries);
    // Status must be SERVER_ERROR, not SENDING.
    expect(after.status).toBe("SERVER_ERROR");
  });

  it("does not touch a row that started sending recently", async () => {
    const recently = new Date(Date.now() - 1000);
    const row = await makeRow({ startedSendingAt: recently });

    await failEmailsStuckInSending(recoveryTestFilter);

    const after = await globalPrismaClient.emailOutbox.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: row.tenancyId, id: row.id } },
    });
    expect(after.finishedSendingAt).toBeNull();
    expect(after.sendServerErrorExternalMessage).toBeNull();
    expect(after.status).toBe("SENDING");
  });

  it("does not re-queue rows already marked failed for another send attempt", async () => {
    const longAgo = new Date(Date.now() - STUCK_EMAIL_TIMEOUT_MS - 60_000);
    const row = await makeRow({ startedSendingAt: longAgo });

    await failEmailsStuckInSending(recoveryTestFilter);
    // A second pass should be a no-op for this row: it's already terminal, so it must not
    // become a candidate for re-sending (which could duplicate an already-accepted delivery).
    await failEmailsStuckInSending(recoveryTestFilter);

    const after = await globalPrismaClient.emailOutbox.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: row.tenancyId, id: row.id } },
    });
    expect(after.nextSendRetryAt).toBeNull();
    expect(after.isQueued).toBe(true); // unchanged: we do not unclaim stuck rows
    expect(after.status).toBe("SERVER_ERROR");
  });
});

describe.sequential("claimEmailsForSending burst allowance", () => {
  const BURST_SEND_LIMIT = 10;
  const testRunTag = `claim-send-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const testFilter = { tsxSource: `/* ${testRunTag} */` };
  const testProjectId = randomUUID();
  let testTenancyId: string;

  beforeAll(async () => {
    await globalPrismaClient.project.create({
      data: {
        id: testProjectId,
        displayName: "Email queue burst test",
        isProductionMode: false,
      },
    });
    const tenancy = await globalPrismaClient.tenancy.create({
      data: {
        projectId: testProjectId,
        branchId: DEFAULT_BRANCH_ID,
        hasNoOrganization: BooleanTrue.TRUE,
      },
    });
    testTenancyId = tenancy.id;
  });

  afterAll(async () => {
    await globalPrismaClient.project.delete({ where: { id: testProjectId } });
  });

  const makeRow = async (tx: PrismaClientTransaction, startedSendingAt: Date | null) => {
    return await tx.emailOutbox.create({
      data: {
        tenancyId: testTenancyId,
        tsxSource: testFilter.tsxSource,
        themeId: null,
        isHighPriority: false,
        to: { type: "custom-emails", emails: ["claim-test@example.com"] },
        extraRenderVariables: {},
        shouldSkipDeliverabilityCheck: true,
        createdWith: EmailOutboxCreatedWith.PROGRAMMATIC_CALL,
        scheduledAt: new Date(0),
        isQueued: true,
        renderedByWorkerId: "00000000-0000-0000-0000-000000000000",
        startedRenderingAt: new Date(0),
        finishedRenderingAt: new Date(0),
        renderedHtml: "<p>claim</p>",
        renderedText: "claim",
        renderedSubject: "claim",
        renderedIsTransactional: false,
        startedSendingAt,
      },
    });
  };

  afterEach(async () => {
    await retryTransaction(globalPrismaClient, async (tx) => {
      const rows = await tx.emailOutbox.findMany({
        where: testFilter,
        select: { tenancyId: true, id: true },
      });
      for (const row of rows) {
        // Deletions of synced tables only reach ClickHouse through DeletedRow.
        await recordExternalDbSyncDeletion(tx, {
          tableName: "EmailOutbox",
          tenancyId: row.tenancyId,
          emailOutboxId: row.id,
        });
        await tx.emailOutbox.deleteMany({ where: { tenancyId: row.tenancyId, id: row.id } });
      }
    });
  });

  it("claims up to the burst limit when the rate quota is zero", async () => {
    const claimed = await withTenancyClaimLock(testTenancyId, async (tx) => {
      await Promise.all(Array.from({ length: BURST_SEND_LIMIT }, () => makeRow(tx, null)));
      return await claimEmailsForSendingWithinLock(tx, testTenancyId, 0);
    });

    expect(claimed).toHaveLength(BURST_SEND_LIMIT);
  });

  it("does not claim more after the burst limit has been reached", async () => {
    const [firstClaim, secondClaim] = await withTenancyClaimLock(testTenancyId, async (tx) => {
      await Promise.all(Array.from({ length: BURST_SEND_LIMIT + 1 }, () => makeRow(tx, null)));
      const firstClaim = await claimEmailsForSendingWithinLock(tx, testTenancyId, 0);
      const secondClaim = await claimEmailsForSendingWithinLock(tx, testTenancyId, 0);
      return [firstClaim, secondClaim];
    });

    expect(firstClaim).toHaveLength(BURST_SEND_LIMIT);
    expect(secondClaim).toHaveLength(0);
  });

  it("does not count claims older than the burst window", async () => {
    const { claimed, oldRows } = await withTenancyClaimLock(testTenancyId, async (tx) => {
      const oldRows = await Promise.all(Array.from({ length: BURST_SEND_LIMIT }, () => makeRow(tx, new Date(Date.now() - 11 * 60 * 1000))));
      await Promise.all(Array.from({ length: 3 }, () => makeRow(tx, null)));
      const claimed = await claimEmailsForSendingWithinLock(tx, testTenancyId, 0);
      return { claimed, oldRows };
    });

    expect(claimed).toHaveLength(3);
    expect(oldRows).toHaveLength(BURST_SEND_LIMIT);
  });

  it("keeps two concurrent claimers within one burst allowance", async () => {
    await Promise.all(
      Array.from({ length: BURST_SEND_LIMIT * 2 }, () => makeRow(globalPrismaClient, null)),
    );
    const [firstClaim, secondClaim] = await Promise.all([
      claimEmailsForSending(testTenancyId, 0),
      claimEmailsForSending(testTenancyId, 0),
    ]);

    // Both claimers can see the committed rows; without the advisory-lock guard, they could each
    // claim a full burst. A background worker can only reduce what these two calls return.
    expect(firstClaim.length + secondClaim.length).toBeLessThanOrEqual(BURST_SEND_LIMIT);
  });

  it("claims nothing when contending for the tenancy lock", async () => {
    await Promise.all(
      Array.from({ length: BURST_SEND_LIMIT * 2 }, () => makeRow(globalPrismaClient, null)),
    );

    await withTenancyClaimLock(testTenancyId, async () => {
      // Committed rows are visible to the claimer, but the held lock makes it deliberately bail.
      const claim = await claimEmailsForSending(testTenancyId, 0);
      expect(claim).toHaveLength(0);
    });
  });

  it("uses the rate quota when it exceeds the burst allowance", async () => {
    const claimed = await withTenancyClaimLock(testTenancyId, async (tx) => {
      await Promise.all(Array.from({ length: 12 }, () => makeRow(tx, null)));
      return await claimEmailsForSendingWithinLock(tx, testTenancyId, 12);
    });

    expect(claimed).toHaveLength(12);
  });
});

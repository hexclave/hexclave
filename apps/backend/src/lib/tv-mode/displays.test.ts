import { BooleanTrue, Prisma } from "@/generated/prisma/client";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { getPrismaSchemaForTenancy, globalPrismaClient, retryTransaction, sqlQuoteIdent } from "@/prisma-client";
import { flushInFlightPromises } from "@/utils/background-tasks";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureErrorMock, logEventMock } = vi.hoisted(() => ({ captureErrorMock: vi.fn(), logEventMock: vi.fn() }));
vi.mock("@/lib/events", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/events")>(),
  logEvent: logEventMock,
}));
vi.mock("@hexclave/shared/dist/utils/errors", async (importOriginal) => ({
  ...await importOriginal<typeof import("@hexclave/shared/dist/utils/errors")>(),
  captureError: captureErrorMock,
}));
import {
  approveTvDisplayPairing,
  consumeTvDisplayPairingRateLimit,
  createTvDisplayPairingChallenge,
  decodeDisplayAccessToken,
  deleteTvDisplay,
  getAuthorizedTvDisplay,
  getTvDisplayResource,
  listTvDisplays,
  pollTvDisplayPairing,
  refundTvDisplayPairingRateLimit,
  refreshTvDisplayCredential,
  updateTvDisplay,
} from "./displays";
import { createTvProfile, deleteTvProfile, TvProfileAssignedToDisplaysError } from "./profiles";
import { getTvBuiltInProfile } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { signJWT } from "@hexclave/shared/dist/utils/jwt";

describe.sequential("independent TV display persistence", () => {
  const projectIds: string[] = [];
  const challengeIds: string[] = [];
  let tenancy: Tenancy;
  let otherTenancy: Tenancy;

  async function createTenancy(): Promise<Tenancy> {
    const projectId = `tv-display-${randomUUID()}`;
    const tenancyId = randomUUID();
    projectIds.push(projectId);
    await globalPrismaClient.project.create({
      data: { id: projectId, displayName: "TV Display Test", description: "", isProductionMode: false },
    });
    await globalPrismaClient.tenancy.create({
      data: { id: tenancyId, projectId, branchId: "main", hasNoOrganization: BooleanTrue.TRUE },
    });
    const created = await getTenancy(tenancyId);
    if (created == null) throw new Error("Test tenancy was not created.");
    return created;
  }

  beforeEach(async () => {
    captureErrorMock.mockClear();
    logEventMock.mockClear();
    tenancy = await createTenancy();
    otherTenancy = await createTenancy();
  });

  afterEach(async () => {
    await flushInFlightPromises();
    await globalPrismaClient.project.deleteMany({ where: { id: { in: projectIds.splice(0) } } });
    for (const challengeId of challengeIds.splice(0)) {
      await globalPrismaClient.$executeRaw`
        DELETE FROM "TvDisplayPairingChallenge" WHERE "id" = ${challengeId}::UUID
      `;
    }
  });

  async function createChallenge(now?: Date) {
    const challenge = await createTvDisplayPairingChallenge(now);
    challengeIds.push(challenge.challengeId);
    return challenge;
  }

  async function pairDisplay(options: { tenancy?: Tenancy, now?: Date, profileId?: string } = {}) {
    const targetTenancy = options.tenancy ?? tenancy;
    const challenge = await createChallenge(options.now);
    await approveTvDisplayPairing({
      tenancy: targetTenancy,
      pairingCode: challenge.pairingCode,
      profileId: options.profileId ?? "company-pulse",
      displayName: "Lobby Display",
      adminUserId: randomUUID(),
      acknowledgeExactFinancials: false,
      now: options.now,
    });
    const result = await pollTvDisplayPairing({
      challengeId: challenge.challengeId,
      deviceSecret: challenge.deviceSecret,
      now: options.now,
    });
    if (result.status !== "paired") throw new Error(`Expected paired result, received ${result.status}.`);
    return result;
  }

  it("requires the high-entropy device secret and consumes an approved challenge once", async () => {
    const challenge = await createChallenge();
    await approveTvDisplayPairing({
      tenancy,
      pairingCode: challenge.pairingCode,
      profileId: "company-pulse",
      displayName: "Reception Display",
      adminUserId: randomUUID(),
      acknowledgeExactFinancials: false,
    });

    await expect(pollTvDisplayPairing({
      challengeId: challenge.challengeId,
      deviceSecret: "not-the-device-secret",
    })).resolves.toEqual({ status: "rejected" });
    await expect(globalPrismaClient.tvDisplayPairingChallenge.findUniqueOrThrow({
      where: { id: challenge.challengeId },
      select: { invalidAttempts: true, state: true },
    })).resolves.toEqual({ invalidAttempts: 0, state: "APPROVED" });

    const paired = await pollTvDisplayPairing({ challengeId: challenge.challengeId, deviceSecret: challenge.deviceSecret });
    expect(paired.status).toBe("paired");
    await expect(pollTvDisplayPairing({
      challengeId: challenge.challengeId,
      deviceSecret: challenge.deviceSecret,
    })).resolves.toEqual({ status: "used" });
  });

  it("expires pairing challenges without issuing a display credential", async () => {
    const createdAt = new Date("2026-08-14T12:00:00.000Z");
    const challenge = await createChallenge(createdAt);
    await expect(pollTvDisplayPairing({
      challengeId: challenge.challengeId,
      deviceSecret: challenge.deviceSecret,
      now: new Date("2026-08-14T12:10:01.000Z"),
    })).resolves.toEqual({ status: "expired" });
  });

  it("retries a pairing-code collision without surfacing a server error", async () => {
    const first = await createChallenge();
    const generatedCodes = [first.pairingCode, "ZXCVBNM2"];
    const second = await createTvDisplayPairingChallenge(
      new Date("2026-08-14T12:00:00.000Z"),
      () => generatedCodes.shift() ?? "ZXCVBNM3",
    );
    challengeIds.push(second.challengeId);

    expect(second.pairingCode).toBe("ZXCVBNM2");
    expect(second.challengeId).not.toBe(first.challengeId);
  });

  it("rejects display tokens issued for another audience", async () => {
    const token = await signJWT({
      issuer: "hexclave-tv-display",
      audience: "another-service",
      expirationTime: "10min",
      payload: {
        displayId: randomUUID(),
        credentialVersion: 1,
        credentialId: randomUUID(),
      },
    });
    await expect(decodeDisplayAccessToken(token)).resolves.toBeNull();
  });

  it("rejects an approved challenge cleanly if its tenancy was deleted", async () => {
    const challenge = await createChallenge();
    await approveTvDisplayPairing({
      tenancy,
      pairingCode: challenge.pairingCode,
      profileId: "company-pulse",
      displayName: "Deleted Project Display",
      adminUserId: randomUUID(),
      acknowledgeExactFinancials: false,
    });
    await globalPrismaClient.project.delete({ where: { id: tenancy.project.id } });

    await expect(pollTvDisplayPairing({
      challengeId: challenge.challengeId,
      deviceSecret: challenge.deviceSecret,
    })).resolves.toEqual({ status: "rejected" });
  });

  it("enforces distributed pairing limits and can refund a successful approval attempt", async () => {
    const identity = randomUUID();
    const now = new Date("2026-08-14T12:00:00.000Z");
    const operation: "approval-admin" = "approval-admin";
    const options = {
      identity,
      operation,
      windowMs: 60_000,
      limit: 2,
      now,
    };
    await expect(consumeTvDisplayPairingRateLimit(options)).resolves.toBe(true);
    await refundTvDisplayPairingRateLimit(options);
    await expect(consumeTvDisplayPairingRateLimit(options)).resolves.toBe(true);
    await expect(consumeTvDisplayPairingRateLimit(options)).resolves.toBe(true);
    await expect(consumeTvDisplayPairingRateLimit(options)).resolves.toBe(false);
  });

  it("keeps the rate-limit verdict when opportunistic cleanup fails", async () => {
    const identity = randomUUID();
    const now = new Date("2026-08-14T12:00:00.000Z");
    const originalExecuteRaw = globalPrismaClient.$executeRaw;
    Object.defineProperty(globalPrismaClient, "$executeRaw", {
      configurable: true,
      writable: true,
      value: vi.fn().mockRejectedValueOnce(new Error("cleanup failed")),
    });
    try {
      await expect(consumeTvDisplayPairingRateLimit({
        identity,
        operation: "approval-admin",
        windowMs: 60_000,
        limit: 1,
        now,
      })).resolves.toBe(true);
      expect(captureErrorMock).toHaveBeenCalledWith(
        "tv-display-rate-limit-cleanup-failed",
        expect.any(HexclaveAssertionError),
      );
    } finally {
      Object.defineProperty(globalPrismaClient, "$executeRaw", {
        configurable: true,
        writable: true,
        value: originalExecuteRaw,
      });
      await globalPrismaClient.$executeRaw`
        DELETE FROM "TvDisplayPairingRateLimitBucket"
        WHERE "operation" = ${"approval-admin"}
          AND "windowStart" = ${now}
      `;
    }
  });

  it("hard-deletes only the exact tenancy-scoped display and its credentials", async () => {
    const paired = await pairDisplay();
    const sibling = await pairDisplay();
    const otherTenantDisplay = await pairDisplay({ tenancy: otherTenancy });
    const payload = await decodeDisplayAccessToken(paired.accessToken);
    expect(payload?.displayId).toBe(paired.display.id);
    const authorized = await getAuthorizedTvDisplay(paired.accessToken);
    expect(authorized?.tenancy.id).toBe(tenancy.id);
    expect(authorized?.display.profileId).toBe("company-pulse");

    await expect(deleteTvDisplay(tenancy, randomUUID())).resolves.toBe(false);
    await expect(deleteTvDisplay(otherTenancy, paired.display.id)).resolves.toBe(false);
    await expect(getAuthorizedTvDisplay(paired.accessToken)).resolves.not.toBeNull();
    // PostgreSQL returns UUIDs in canonical lowercase even when a valid route
    // parameter uses uppercase hexadecimal characters.
    await expect(deleteTvDisplay(tenancy, paired.display.id.toUpperCase())).resolves.toBe(true);
    await expect(getAuthorizedTvDisplay(paired.accessToken)).resolves.toBeNull();
    await expect(refreshTvDisplayCredential(paired.refreshToken)).resolves.toBeNull();
    await expect(globalPrismaClient.tvDisplay.findUnique({ where: { id: paired.display.id } })).resolves.toBeNull();
    await expect(globalPrismaClient.tvDisplayCredential.count({ where: { displayId: paired.display.id } })).resolves.toBe(0);
    await expect(getAuthorizedTvDisplay(sibling.accessToken)).resolves.not.toBeNull();
    await expect(getAuthorizedTvDisplay(otherTenantDisplay.accessToken)).resolves.not.toBeNull();
    await expect(globalPrismaClient.tvDisplayCredential.count({ where: { displayId: sibling.display.id } })).resolves.toBe(1);
    await expect(globalPrismaClient.tvDisplayCredential.count({ where: { displayId: otherTenantDisplay.display.id } })).resolves.toBe(1);
    await expect(listTvDisplays(tenancy)).resolves.toEqual([
      expect.objectContaining({ id: sibling.display.id }),
    ]);
  });

  it("supports immediate re-pairing with a new display and credential family", async () => {
    const first = await pairDisplay();
    const firstCredential = await globalPrismaClient.tvDisplayCredential.findFirstOrThrow({
      where: { displayId: first.display.id },
      select: { familyId: true },
    });
    await expect(deleteTvDisplay(tenancy, first.display.id)).resolves.toBe(true);

    const second = await pairDisplay();
    const secondCredential = await globalPrismaClient.tvDisplayCredential.findFirstOrThrow({
      where: { displayId: second.display.id },
      select: { familyId: true },
    });
    expect(second.display.id).not.toBe(first.display.id);
    expect(secondCredential.familyId).not.toBe(firstCredential.familyId);
    await expect(getAuthorizedTvDisplay(second.accessToken)).resolves.not.toBeNull();
  });

  it("leaves no usable credential when refresh and hard deletion race", async () => {
    const paired = await pairDisplay();
    const [refreshResult, deletionResult] = await Promise.all([
      refreshTvDisplayCredential(paired.refreshToken),
      deleteTvDisplay(tenancy, paired.display.id),
    ]);

    expect(deletionResult).toBe(true);
    await expect(globalPrismaClient.tvDisplay.findUnique({ where: { id: paired.display.id } })).resolves.toBeNull();
    await expect(globalPrismaClient.tvDisplayCredential.count({ where: { displayId: paired.display.id } })).resolves.toBe(0);
    await expect(getAuthorizedTvDisplay(paired.accessToken)).resolves.toBeNull();
    await expect(refreshTvDisplayCredential(paired.refreshToken)).resolves.toBeNull();
    if (refreshResult != null) {
      await expect(getAuthorizedTvDisplay(refreshResult.accessToken)).resolves.toBeNull();
      await expect(refreshTvDisplayCredential(refreshResult.refreshToken)).resolves.toBeNull();
    }
  });

  it("supports multiple displays and applies profile reassignment server-side", async () => {
    const first = await pairDisplay();
    const second = await pairDisplay();
    expect(first.display.id).not.toBe(second.display.id);
    await expect(updateTvDisplay({
      tenancy,
      displayId: first.display.id,
      displayName: "Engineering Display",
      profileId: "engineering-office",
      adminUserId: randomUUID(),
      acknowledgeExactFinancials: false,
    })).resolves.toBe(true);
    await expect(getAuthorizedTvDisplay(first.accessToken)).resolves.toMatchObject({
      display: {
        id: first.display.id,
        displayName: "Engineering Display",
        profileId: "engineering-office",
      },
    });
    await expect(getAuthorizedTvDisplay(second.accessToken)).resolves.toMatchObject({
      display: { id: second.display.id, profileId: "company-pulse" },
    });
  });

  it("rotates refresh credentials and treats later reuse as family compromise", async () => {
    const paired = await pairDisplay();
    const rotated = await refreshTvDisplayCredential(paired.refreshToken);
    expect(rotated).not.toBeNull();
    if (rotated == null) throw new Error("Refresh credential did not rotate.");
    await expect(getAuthorizedTvDisplay(rotated.accessToken)).resolves.not.toBeNull();

    await expect(refreshTvDisplayCredential(paired.refreshToken)).resolves.toBeNull();
    await expect(getAuthorizedTvDisplay(rotated.accessToken)).resolves.toBeNull();
    await expect(refreshTvDisplayCredential(rotated.refreshToken)).resolves.toBeNull();
  });

  it("uses a rolling 30-day idle lifetime for refresh credentials", async () => {
    const pairedAt = new Date("2026-08-31T12:00:00.000Z");
    const paired = await pairDisplay({ now: pairedAt });
    const initialPayload = await decodeDisplayAccessToken(paired.accessToken);
    if (initialPayload == null) throw new Error("Initial display access token was invalid.");
    await expect(globalPrismaClient.tvDisplayCredential.findUniqueOrThrow({
      where: { id: initialPayload.credentialId },
      select: { expiresAt: true },
    })).resolves.toEqual({ expiresAt: new Date("2026-09-30T12:00:00.000Z") });

    const refreshAt = new Date("2026-09-29T12:00:00.000Z");
    const rotated = await refreshTvDisplayCredential(paired.refreshToken, refreshAt);
    if (rotated == null) throw new Error("Active display credential did not renew.");
    const rotatedPayload = await decodeDisplayAccessToken(rotated.accessToken);
    if (rotatedPayload == null) throw new Error("Rotated display access token was invalid.");
    await expect(globalPrismaClient.tvDisplayCredential.findUniqueOrThrow({
      where: { id: rotatedPayload.credentialId },
      select: { expiresAt: true },
    })).resolves.toEqual({ expiresAt: new Date("2026-10-29T12:00:00.000Z") });

    const idleDisplay = await pairDisplay({ now: pairedAt });
    await expect(refreshTvDisplayCredential(
      idleDisplay.refreshToken,
      new Date("2026-09-30T12:00:00.001Z"),
    )).resolves.toBeNull();
  });

  it("keeps exactly 24 hours of replay detection without revoking older descendants", async () => {
    const pairedAt = new Date("2026-08-31T12:00:00.000Z");
    const paired = await pairDisplay({ now: pairedAt });
    const rotated = await refreshTvDisplayCredential(paired.refreshToken, new Date("2026-08-31T12:10:00.000Z"));
    if (rotated == null) throw new Error("Display credential did not rotate.");

    await expect(refreshTvDisplayCredential(
      paired.refreshToken,
      new Date("2026-09-01T12:10:00.001Z"),
    )).resolves.toBeNull();
    await expect(refreshTvDisplayCredential(
      rotated.refreshToken,
      new Date("2026-09-01T12:11:00.000Z"),
    )).resolves.not.toBeNull();

    const replayProtected = await pairDisplay({ now: pairedAt });
    const replayProtectedRotation = await refreshTvDisplayCredential(
      replayProtected.refreshToken,
      new Date("2026-08-31T12:10:00.000Z"),
    );
    if (replayProtectedRotation == null) throw new Error("Replay-protected credential did not rotate.");
    await expect(refreshTvDisplayCredential(
      replayProtected.refreshToken,
      new Date("2026-09-01T12:10:00.000Z"),
    )).resolves.toBeNull();
    await expect(getAuthorizedTvDisplay(replayProtectedRotation.accessToken)).resolves.toBeNull();
  });

  it("detects recent replay even after the used credential's original idle expiry", async () => {
    const pairedAt = new Date("2026-08-01T12:00:00.000Z");
    const paired = await pairDisplay({ now: pairedAt });
    const rotationAt = new Date("2026-08-31T11:00:00.000Z");
    const rotated = await refreshTvDisplayCredential(paired.refreshToken, rotationAt);
    if (rotated == null) throw new Error("Near-expiry display credential did not rotate.");

    // The consumed token's Clock A ended at noon, but its independent replay
    // window remains active until 24 hours after the successful rotation.
    await expect(refreshTvDisplayCredential(
      paired.refreshToken,
      new Date("2026-08-31T13:00:00.000Z"),
    )).resolves.toBeNull();
    await expect(getAuthorizedTvDisplay(rotated.accessToken)).resolves.toBeNull();
    await expect(refreshTvDisplayCredential(rotated.refreshToken)).resolves.toBeNull();
  });

  it("bounds expired replay-history cleanup to the exact display and family", async () => {
    const pairedAt = new Date("2026-08-31T12:00:00.000Z");
    const now = new Date("2026-09-01T13:00:00.000Z");
    const paired = await pairDisplay({ now: pairedAt });
    const sibling = await pairDisplay({ now: pairedAt });
    const currentCredential = await globalPrismaClient.tvDisplayCredential.findFirstOrThrow({
      where: { displayId: paired.display.id },
      select: { familyId: true },
    });
    const unrelatedFamilyId = randomUUID();
    const oldUsedAt = new Date("2026-08-31T12:00:00.000Z");
    const expiresAt = new Date("2026-09-30T12:00:00.000Z");
    await globalPrismaClient.tvDisplayCredential.createMany({
      data: [
        ...Array.from({ length: 105 }, () => ({
          id: randomUUID(),
          displayId: paired.display.id,
          familyId: currentCredential.familyId,
          tokenHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
          expiresAt,
          usedAt: oldUsedAt,
        })),
        ...Array.from({ length: 2 }, () => ({
          id: randomUUID(),
          displayId: paired.display.id,
          familyId: unrelatedFamilyId,
          tokenHash: randomUUID().replaceAll("-", "").padEnd(64, "1"),
          expiresAt,
          usedAt: oldUsedAt,
        })),
        ...Array.from({ length: 2 }, () => ({
          id: randomUUID(),
          displayId: sibling.display.id,
          familyId: randomUUID(),
          tokenHash: randomUUID().replaceAll("-", "").padEnd(64, "2"),
          expiresAt,
          usedAt: oldUsedAt,
        })),
      ],
    });

    await expect(refreshTvDisplayCredential(paired.refreshToken, now)).resolves.not.toBeNull();
    await expect(globalPrismaClient.tvDisplayCredential.count({
      where: { displayId: paired.display.id, familyId: currentCredential.familyId, usedAt: oldUsedAt },
    })).resolves.toBe(5);
    await expect(globalPrismaClient.tvDisplayCredential.count({
      where: { displayId: paired.display.id, familyId: unrelatedFamilyId },
    })).resolves.toBe(2);
    await expect(globalPrismaClient.tvDisplayCredential.count({
      where: { displayId: sibling.display.id, usedAt: oldUsedAt },
    })).resolves.toBe(2);
  });

  it("logs replay detection but not routine successful credential rotation", async () => {
    const paired = await pairDisplay();
    await flushInFlightPromises();
    logEventMock.mockClear();

    const rotated = await refreshTvDisplayCredential(paired.refreshToken);
    if (rotated == null) throw new Error("Display credential did not rotate.");
    await flushInFlightPromises();
    expect(logEventMock).not.toHaveBeenCalled();

    await refreshTvDisplayCredential(paired.refreshToken);
    await flushInFlightPromises();
    expect(logEventMock.mock.calls.map((call) => call[1])).toContainEqual(expect.objectContaining({
      action: "refresh-reuse-detected",
      displayId: paired.display.id,
    }));
  });

  it("fails closed when two requests concurrently exchange one refresh credential", async () => {
    const paired = await pairDisplay();
    const results = await Promise.all([
      refreshTvDisplayCredential(paired.refreshToken),
      refreshTvDisplayCredential(paired.refreshToken),
    ]);
    expect(results.filter((result) => result != null)).toHaveLength(1);
    const rotated = results.find((result) => result != null);
    if (rotated == null) throw new Error("Concurrent refresh produced no rotated credential.");
    await expect(getAuthorizedTvDisplay(rotated.accessToken)).resolves.toBeNull();
    await expect(refreshTvDisplayCredential(rotated.refreshToken)).resolves.toBeNull();
  });

  it("allows only one concurrent exchange to create a display credential", async () => {
    const challenge = await createChallenge();
    await approveTvDisplayPairing({
      tenancy,
      pairingCode: challenge.pairingCode,
      profileId: "company-pulse",
      displayName: "Concurrent Display",
      adminUserId: randomUUID(),
      acknowledgeExactFinancials: false,
    });
    const results = await Promise.all([
      pollTvDisplayPairing({ challengeId: challenge.challengeId, deviceSecret: challenge.deviceSecret }),
      pollTvDisplayPairing({ challengeId: challenge.challengeId, deviceSecret: challenge.deviceSecret }),
    ]);
    expect(results.filter((result) => result.status === "paired")).toHaveLength(1);
    const rows = await globalPrismaClient.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::BIGINT AS "count" FROM "TvDisplay" WHERE "tenancyId" = ${tenancy.id}::UUID
    `;
    expect(Number(rows[0].count)).toBe(1);
  });

  it("blocks saved-profile deletion while an active display is assigned", async () => {
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse profile is missing.");
    const profile = await createTvProfile(tenancy, {
      ...template.configuration,
      displayName: "Assigned Display Profile",
    });
    if (profile == null) throw new Error("TV profile persistence is unavailable.");
    const challenge = await createChallenge();
    await approveTvDisplayPairing({
      tenancy,
      pairingCode: challenge.pairingCode,
      profileId: profile.id,
      displayName: "Assigned Display",
      adminUserId: randomUUID(),
      acknowledgeExactFinancials: false,
    });
    const paired = await pollTvDisplayPairing({ challengeId: challenge.challengeId, deviceSecret: challenge.deviceSecret });
    if (paired.status !== "paired") throw new Error("Display was not paired.");

    await expect(deleteTvProfile(tenancy, profile.id, profile.version)).rejects.toBeInstanceOf(TvProfileAssignedToDisplaysError);
    await deleteTvDisplay(tenancy, paired.display.id);
    await expect(deleteTvProfile(tenancy, profile.id, profile.version)).resolves.toBe(true);
  });

  it("blocks saved-profile deletion while an approved display is still completing pairing", async () => {
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse profile is missing.");
    const profile = await createTvProfile(tenancy, {
      ...template.configuration,
      displayName: "Pending Display Profile",
    });
    if (profile == null) throw new Error("TV profile persistence is unavailable.");
    const challenge = await createChallenge();
    await approveTvDisplayPairing({
      tenancy,
      pairingCode: challenge.pairingCode,
      profileId: profile.id,
      displayName: "Pending Display",
      adminUserId: randomUUID(),
      acknowledgeExactFinancials: false,
    });

    await expect(deleteTvProfile(tenancy, profile.id, profile.version)).rejects.toBeInstanceOf(TvProfileAssignedToDisplaysError);
  });

  it("serializes saved-profile deletion with a concurrent display approval", async () => {
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse profile is missing.");
    const profile = await createTvProfile(tenancy, {
      ...template.configuration,
      displayName: "Concurrent Assignment Profile",
    });
    if (profile == null) throw new Error("TV profile persistence is unavailable.");
    const challenge = await createChallenge();
    const schema = await getPrismaSchemaForTenancy(tenancy);
    const rowLocked = Promise.withResolvers<void>();
    const releaseRow = Promise.withResolvers<void>();
    let profileWasLocked = false;
    const blocker = retryTransaction(globalPrismaClient, async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM ${sqlQuoteIdent(schema)}."TvPresentationProfile"
        WHERE "tenancyId" = ${tenancy.id}::UUID
          AND "id" = ${profile.id}::UUID
        FOR UPDATE
      `);
      // retryTransaction deliberately retries some development/test transactions.
      // Once this attempt has supplied the synchronization point, a later retry may
      // legitimately observe the row already deleted by the operation under test.
      if (rows.length !== 1) {
        if (profileWasLocked) return;
        throw new Error("Concurrent-assignment profile row was not found.");
      }
      profileWasLocked = true;
      rowLocked.resolve();
      await releaseRow.promise;
    });
    await rowLocked.promise;

    const deletion = deleteTvProfile(tenancy, profile.id, profile.version);
    // Let deletion reach the row lock after acquiring the shared assignment lock.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const approval = approveTvDisplayPairing({
      tenancy,
      pairingCode: challenge.pairingCode,
      profileId: profile.id,
      displayName: "Concurrent Display",
      adminUserId: randomUUID(),
      acknowledgeExactFinancials: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const [deletionResult, approvalResult] = await Promise.allSettled([deletion, approval]);
      expect([deletionResult, approvalResult].filter((result) => result.status === "fulfilled")).toHaveLength(1);
      if (deletionResult.status === "fulfilled") {
        expect(deletionResult.value).toBe(true);
        expect(approvalResult.status).toBe("rejected");
        if (approvalResult.status !== "rejected") throw new Error("Display approval unexpectedly succeeded after profile deletion.");
        expect(approvalResult.reason).toBeInstanceOf(Error);
        expect(approvalResult.reason).toMatchObject({ message: "tv_display_profile_not_found" });
      } else {
        expect(deletionResult.reason).toBeInstanceOf(TvProfileAssignedToDisplaysError);
        expect(approvalResult.status).toBe("fulfilled");
      }
    } finally {
      releaseRow.resolve();
      await blocker;
    }
  });

  it("serializes saved-profile deletion with a concurrent display reassignment", async () => {
    const paired = await pairDisplay();
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse profile is missing.");
    const profile = await createTvProfile(tenancy, {
      ...template.configuration,
      displayName: "Concurrent Reassignment Profile",
    });
    if (profile == null) throw new Error("TV profile persistence is unavailable.");
    const schema = await getPrismaSchemaForTenancy(tenancy);
    const rowLocked = Promise.withResolvers<void>();
    const releaseRow = Promise.withResolvers<void>();
    let profileWasLocked = false;
    const blocker = retryTransaction(globalPrismaClient, async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM ${sqlQuoteIdent(schema)}."TvPresentationProfile"
        WHERE "tenancyId" = ${tenancy.id}::UUID
          AND "id" = ${profile.id}::UUID
        FOR UPDATE
      `);
      if (rows.length !== 1) {
        if (profileWasLocked) return;
        throw new Error("Concurrent-reassignment profile row was not found.");
      }
      profileWasLocked = true;
      rowLocked.resolve();
      await releaseRow.promise;
    });
    await rowLocked.promise;

    const deletion = deleteTvProfile(tenancy, profile.id, profile.version);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reassignment = updateTvDisplay({
      tenancy,
      displayId: paired.display.id,
      displayName: "Reassigned Display",
      profileId: profile.id,
      adminUserId: randomUUID(),
      acknowledgeExactFinancials: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const [deletionResult, reassignmentResult] = await Promise.allSettled([deletion, reassignment]);
      expect([deletionResult, reassignmentResult].filter((result) => result.status === "fulfilled")).toHaveLength(1);
      if (deletionResult.status === "fulfilled") {
        expect(deletionResult.value).toBe(true);
        expect(reassignmentResult.status).toBe("rejected");
        if (reassignmentResult.status !== "rejected") throw new Error("Display reassignment unexpectedly succeeded after profile deletion.");
        expect(reassignmentResult.reason).toMatchObject({ message: "tv_display_profile_not_found" });
        await expect(getAuthorizedTvDisplay(paired.accessToken)).resolves.toMatchObject({
          display: { profileId: "company-pulse" },
        });
      } else {
        expect(deletionResult.reason).toBeInstanceOf(TvProfileAssignedToDisplaysError);
        expect(reassignmentResult.status).toBe("fulfilled");
        await expect(getAuthorizedTvDisplay(paired.accessToken)).resolves.toMatchObject({
          display: { profileId: profile.id },
        });
      }
    } finally {
      releaseRow.resolve();
      await blocker;
    }
  });

  it("requires explicit exact-financial acknowledgement and invalidates it after a profile edit", async () => {
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse profile is missing.");
    const profile = await createTvProfile(tenancy, {
      ...template.configuration,
      displayName: "Exact Financial Display Profile",
      financialVisibility: "exact",
    });
    if (profile == null) throw new Error("TV profile persistence is unavailable.");
    const challenge = await createChallenge();
    const acknowledgedAt = new Date(Date.now() + 60_000);

    await expect(approveTvDisplayPairing({
      tenancy,
      pairingCode: challenge.pairingCode,
      profileId: profile.id,
      displayName: "Finance Display",
      adminUserId: randomUUID(),
      acknowledgeExactFinancials: false,
      now: acknowledgedAt,
    })).rejects.toThrow("tv_display_exact_financials_acknowledgement_required");

    await approveTvDisplayPairing({
      tenancy,
      pairingCode: challenge.pairingCode,
      profileId: profile.id,
      displayName: "Finance Display",
      adminUserId: randomUUID(),
      acknowledgeExactFinancials: true,
      now: acknowledgedAt,
    });
    const paired = await pollTvDisplayPairing({
      challengeId: challenge.challengeId,
      deviceSecret: challenge.deviceSecret,
      now: new Date(acknowledgedAt.getTime() + 1_000),
    });
    if (paired.status !== "paired") throw new Error("Display was not paired.");
    await expect(getTvDisplayResource(tenancy, paired.display, acknowledgedAt)).resolves.toMatchObject({
      profileFinancialVisibility: "exact",
      exactFinancialsAcknowledged: true,
    });

    await globalPrismaClient.$executeRaw`
      UPDATE "TvPresentationProfile"
      SET "updatedAt" = ${new Date(acknowledgedAt.getTime() + 2_000)}
      WHERE "tenancyId" = ${tenancy.id}::UUID AND "id" = ${profile.id}::UUID
    `;
    await expect(getTvDisplayResource(tenancy, paired.display, new Date(acknowledgedAt.getTime() + 3_000))).resolves.toMatchObject({
      profileFinancialVisibility: "exact",
      exactFinancialsAcknowledged: false,
    });
  });

  it("reports redacted profiles as already acknowledged", async () => {
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse profile is missing.");
    const profile = await createTvProfile(tenancy, {
      ...template.configuration,
      displayName: "Redacted Financial Display Profile",
      financialVisibility: "redacted",
    });
    if (profile == null) throw new Error("TV profile persistence is unavailable.");
    const paired = await pairDisplay({ profileId: profile.id });
    await expect(getTvDisplayResource(tenancy, paired.display)).resolves.toMatchObject({
      profileFinancialVisibility: "redacted",
      exactFinancialsAcknowledged: true,
    });
  });
});
